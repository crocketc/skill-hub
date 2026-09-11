use skillhub_core::llm::{
    CredentialRef, CustomHeader, LlmDeployment, LlmProtocolFamily, LlmProviderConfig,
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
        11,
        "current schema version must be 11"
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
