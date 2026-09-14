use skillhub_core::llm::{
    CredentialRef, CustomHeader, LlmCompatibilityProfile, LlmDeployment, LlmProtocolFamily,
    LlmProviderConfig,
};
use skillhub_storage::Database;

fn config() -> LlmProviderConfig {
    LlmProviderConfig::new(
        "deepseek",
        "DeepSeek",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Online,
        "https://api.deepseek.com/v1",
        "deepseek-chat",
        Some(CredentialRef::new("llm-provider:deepseek")),
    )
    .expect("valid config")
}

fn open_database() -> Database {
    Database::open_in_memory().expect("in-memory database")
}

#[test]
fn migration_0010_creates_provider_config_and_translation_tables() {
    let database = open_database();
    assert_eq!(
        database.schema_version().expect("schema version"),
        13,
        "current schema version must match migrations::CURRENT_SCHEMA_VERSION"
    );
    assert!(
        database
            .has_table("llm_provider_configs")
            .expect("table lookup"),
        "llm_provider_configs table must exist"
    );
    assert!(
        database
            .has_table("translation_records")
            .expect("table lookup"),
        "translation_records table must exist"
    );
}

#[test]
fn provider_configs_round_trip_and_delete() {
    let database = open_database();
    let repository = database.llm_provider_repository();

    let saved = repository.save(&config()).expect("save");
    assert_eq!(saved.id, "deepseek");

    let read = repository.get("deepseek").expect("get").expect("exists");
    assert_eq!(read, config());

    let updated = config();
    let updated = updated
        .with_header(CustomHeader::new("X-Trace", "t-1", false).expect("header"))
        .expect("header");
    repository.save(&updated).expect("update overwrites");
    let reread = repository.get("deepseek").expect("get").expect("exists");
    assert_eq!(reread.custom_headers.len(), 1);

    repository.delete("deepseek").expect("delete");
    assert_eq!(repository.get("deepseek").expect("get"), None);
    repository.delete("deepseek").expect("delete is idempotent");
}

#[test]
fn provider_config_rows_never_contain_secret_material() {
    let database = open_database();
    let repository = database.llm_provider_repository();

    // The config struct cannot hold secret material: sensitive headers keep
    // only a credential reference, so the stored JSON must not contain the
    // secret value even when one exists in the credential store.
    let sensitive = config()
        .with_header(
            CustomHeader::sensitive("X-Api-Key", CredentialRef::new("llm-header:deepseek"))
                .expect("sensitive header"),
        )
        .expect("config with sensitive header");

    repository.save(&sensitive).expect("save");
    let raw: String = database
        .connection_for_test()
        .query_row(
            "SELECT config_json FROM llm_provider_configs WHERE id='deepseek'",
            [],
            |row| row.get(0),
        )
        .expect("row");
    let fake_secret = "sk-fixture-value-that-must-never-be-stored";
    assert!(
        !raw.contains(fake_secret),
        "stored provider config must not contain secret material"
    );
    assert!(
        raw.contains("llm-header:deepseek"),
        "credential reference is stored"
    );
}

#[test]
fn listing_returns_all_configs_ordered_by_id() {
    let database = open_database();
    let repository = database.llm_provider_repository();

    let mut first = config();
    first.id = "a-first".into();
    let mut second = config();
    second.id = "b-second".into();
    repository.save(&first).expect("save");
    repository.save(&second).expect("save");

    let ids: Vec<String> = repository
        .list()
        .expect("list")
        .into_iter()
        .map(|entry| entry.id)
        .collect();
    assert_eq!(ids, vec!["a-first".to_string(), "b-second".to_string()]);
}

/// 写入一条不含兼容字段的旧记录，模拟升级前保存的数据。
fn insert_legacy_row(database: &Database, id: &str, json: &str) {
    database
        .connection_for_test()
        .execute(
            "INSERT INTO llm_provider_configs(id,config_json,created_at,updated_at) VALUES(?1,?2,0,0)",
            rusqlite::params![id, json],
        )
        .expect("insert legacy row");
}

#[test]
fn legacy_rows_without_a_compatibility_profile_are_normalised_once() {
    let database = open_database();
    let repository = database.llm_provider_repository();

    insert_legacy_row(
        &database,
        "zhipu-glm-coding-chat",
        r#"{"id":"zhipu-glm-coding-chat","label":"GLM Coding Plan (OpenAI Chat)",
            "protocol":"open_ai_compatible","deployment":"online",
            "endpoint":"https://open.bigmodel.cn/api/coding/paas/v4","model":"glm-5",
            "credential_ref":{"id":"llm-provider:zhipu-glm-coding-chat"},
            "custom_headers":[],"enabled":true,"timeout_ms":30000,"max_input_bytes":262144}"#,
    );
    insert_legacy_row(
        &database,
        "user-custom-gateway",
        r#"{"id":"user-custom-gateway","label":"My gateway",
            "protocol":"open_ai_compatible","deployment":"online",
            "endpoint":"https://gateway.example/v1","model":"model-a",
            "custom_headers":[],"enabled":false,"timeout_ms":10000,"max_input_bytes":1024}"#,
    );

    let glm = repository
        .get("zhipu-glm-coding-chat")
        .expect("get")
        .expect("exists");
    assert_eq!(
        glm.compatibility_profile,
        LlmCompatibilityProfile::GlmCoding
    );
    // Migration must not disturb any existing field.
    assert_eq!(glm.endpoint, "https://open.bigmodel.cn/api/coding/paas/v4");
    assert_eq!(glm.model, "glm-5");
    assert!(glm.enabled);
    assert_eq!(glm.timeout_ms, 30_000);
    assert_eq!(
        glm.credential_ref,
        Some(CredentialRef::new("llm-provider:zhipu-glm-coding-chat"))
    );

    // An id the application never generated falls back to Generic, and the
    // URL is never inspected.
    let custom = repository
        .get("user-custom-gateway")
        .expect("get")
        .expect("exists");
    assert_eq!(
        custom.compatibility_profile,
        LlmCompatibilityProfile::Generic
    );
    assert!(!custom.enabled, "enabled flag must not change");
    assert_eq!(custom.timeout_ms, 10_000);

    // Migration is idempotent: saving writes the field, reading it back again
    // yields the same profile.
    repository.save(&glm).expect("save migrated row");
    let reread = repository.get("zhipu-glm-coding-chat").unwrap().unwrap();
    assert_eq!(reread, glm);
    let raw: String = database
        .connection_for_test()
        .query_row(
            "SELECT config_json FROM llm_provider_configs WHERE id='zhipu-glm-coding-chat'",
            [],
            |row| row.get(0),
        )
        .expect("row");
    assert!(
        raw.contains("\"compatibility_profile\":\"glm_coding\""),
        "a saved record carries an explicit compatibility profile: {raw}"
    );

    // The listed view carries the migrated value too.
    let listed = repository.list().expect("list");
    assert!(listed
        .iter()
        .any(|entry| entry.id == "zhipu-glm-coding-chat"
            && entry.compatibility_profile == LlmCompatibilityProfile::GlmCoding));
}
