use rusqlite::Connection;
use skillhub_storage::Database;
use tempfile::NamedTempFile;

fn fixture_database_with_schema_version(version: u32) -> NamedTempFile {
    let file = NamedTempFile::new().unwrap();
    let connection = Connection::open(file.path()).unwrap();
    connection
        .pragma_update(None, "user_version", version)
        .unwrap();
    connection.close().unwrap();
    file
}

#[test]
fn empty_database_migrates_to_current_schema_and_enables_fts5() {
    let db = Database::open_in_memory().unwrap();

    assert_eq!(db.schema_version().unwrap(), 16);
    assert!(db.has_table("skills_fts").unwrap());
    assert!(db.has_table("search_candidates").unwrap());
}

#[test]
fn v15_upgrade_initializes_one_safe_relationship_projection_state() {
    let file = NamedTempFile::new().unwrap();
    drop(Database::open(file.path()).unwrap());
    let connection = Connection::open(file.path()).unwrap();
    connection
        .execute_batch("DROP TABLE relationship_projection_state; PRAGMA user_version=15;")
        .unwrap();
    connection.close().unwrap();

    let database = Database::open(file.path()).unwrap();
    assert_eq!(database.schema_version().unwrap(), 16);
    assert_eq!(
        database
            .relationship_repository()
            .relationship_revision()
            .unwrap(),
        0
    );
    assert_eq!(
        database
            .relationship_repository()
            .last_verified_at()
            .unwrap(),
        None
    );
    let state_rows: i64 = database
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM relationship_projection_state",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state_rows, 1);
}

#[test]
fn v13_database_upgrades_relationships_without_losing_legacy_facts() {
    let file = NamedTempFile::new().unwrap();
    let connection = Connection::open(file.path()).unwrap();
    for sql in [
        include_str!("../migrations/0001_initial.sql"),
        include_str!("../migrations/0002_fts.sql"),
        include_str!("../migrations/0003_catalog_metadata.sql"),
        include_str!("../migrations/0004_search_tokenizer.sql"),
        include_str!("../migrations/0005_check_run_metadata.sql"),
        include_str!("../migrations/0006_llm_profiles.sql"),
        include_str!("../migrations/0007_ui_preferences.sql"),
        include_str!("../migrations/0008_version_labels.sql"),
        include_str!("../migrations/0009_skill_user_purpose.sql"),
        include_str!("../migrations/0010_llm_providers_translations.sql"),
        include_str!("../migrations/0011_source_roles.sql"),
        include_str!("../migrations/0012_combination_name_unique.sql"),
        include_str!("../migrations/0013_observed_deployments.sql"),
    ] {
        connection.execute_batch(sql).unwrap();
    }
    connection
        .execute_batch(
            "INSERT INTO skills(id, display_name, runtime_name, created_at, updated_at)
                 VALUES ('00000000-0000-0000-0000-0000000000a1', 'Legacy', 'legacy', 1, 1);
             INSERT INTO versions(id, skill_id, content_hash, manifest_json, created_at)
                 VALUES ('sha256:0000000000000000000000000000000000000000000000000000000000000001', '00000000-0000-0000-0000-0000000000a1', 'sha256:legacy', '{}', 1);
             INSERT INTO import_provenance(skill_id, agent_client_id, original_path, source_kind, source_locator, ownership, content_fingerprint, imported_at)
                 VALUES ('00000000-0000-0000-0000-0000000000a1', 'legacy.agent', 'C:/legacy/skills/demo', 'local', 'C:/legacy/skills/demo', 'known_agent_target', 'sha256:legacy', 10);
             INSERT INTO observed_deployments(id, skill_id, client_id, original_path, path_key, content_fingerprint, match_state, origin, status, observed_at)
                 VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'legacy.agent', 'C:/legacy/skills/demo', 'c:/legacy/skills/demo', 'sha256:legacy', 'name_only', 'scan', 'active', 11);
             INSERT INTO targets(id, agent_id, scope, path, created_at)
                 VALUES ('target-legacy', 'legacy.agent', 'global', 'C:/legacy/skills', 1);
             INSERT INTO deployments(id, skill_id, version_id, target_id, state, method, managed, runtime_name, expected_hash, created_at, updated_at)
                 VALUES ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', 'sha256:0000000000000000000000000000000000000000000000000000000000000001', 'target-legacy', 'deployed', 'symbolic_link', 1, 'legacy', 'sha256:legacy', 12, 12);
             INSERT INTO pending_dismissals(id, scope_type, scope_id, reason_code, created_at)
                 VALUES ('todo-legacy', 'skill', '00000000-0000-0000-0000-0000000000a1', 'review', 13);",
        )
        .unwrap();
    connection.pragma_update(None, "user_version", 13).unwrap();
    drop(connection);

    let database = Database::open(file.path()).unwrap();
    assert_eq!(database.schema_version().unwrap(), 16);
    assert_eq!(
        database
            .provenance_repository()
            .list_provenance_for_skill("00000000-0000-0000-0000-0000000000a1".parse().unwrap())
            .unwrap()
            .len(),
        1
    );
    let legacy_provenance_id: String = database.connection_for_test().query_row(
        "SELECT provenance_id FROM source_relations WHERE skill_id='00000000-0000-0000-0000-0000000000a1'",
        [],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(
        legacy_provenance_id,
        "legacy-provenance:00000000-0000-0000-0000-0000000000a1"
    );
    assert_ne!(legacy_provenance_id, "00000000-0000-0000-0000-0000000000a1");
    let observed_count: i64 = database.connection_for_test().query_row(
        "SELECT COUNT(*) FROM observed_deployments WHERE id='00000000-0000-0000-0000-0000000000b1'", [], |row| row.get(0)
    ).unwrap();
    assert_eq!(observed_count, 1);
    let normalized_unreliable_skill: Option<String> = database.connection_for_test().query_row(
        "SELECT skill_id FROM deployment_relations WHERE relation_id='legacy-observed:00000000-0000-0000-0000-0000000000b1'", [], |row| row.get(0)
    ).unwrap();
    assert_eq!(normalized_unreliable_skill, None);
    assert_eq!(
        database.deployment_repository().list_all().unwrap().len(),
        1
    );
    let migrated_path: String = database
        .connection_for_test()
        .query_row(
            "SELECT path FROM deployment_relations WHERE relation_id='legacy-managed:00000000-0000-0000-0000-0000000000b2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let expected_migrated_path = std::path::Path::new("C:/legacy/skills")
        .join("legacy")
        .to_string_lossy()
        .into_owned();
    assert_eq!(migrated_path, expected_migrated_path);
    let migrated_path_key: String = database
        .connection_for_test()
        .query_row(
            "SELECT path_key FROM deployment_relations WHERE relation_id='legacy-managed:00000000-0000-0000-0000-0000000000b2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        migrated_path_key,
        skillhub_core::deployment::observed_path_key(&migrated_path)
    );
    let pending_count: i64 = database
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM pending_dismissals WHERE id='todo-legacy'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pending_count, 1);
}

#[test]
fn v13_backfill_keeps_managed_relation_when_observed_row_has_the_same_path() {
    let file = NamedTempFile::new().unwrap();
    let connection = Connection::open(file.path()).unwrap();
    for sql in [
        include_str!("../migrations/0001_initial.sql"),
        include_str!("../migrations/0002_fts.sql"),
        include_str!("../migrations/0003_catalog_metadata.sql"),
        include_str!("../migrations/0004_search_tokenizer.sql"),
        include_str!("../migrations/0005_check_run_metadata.sql"),
        include_str!("../migrations/0006_llm_profiles.sql"),
        include_str!("../migrations/0007_ui_preferences.sql"),
        include_str!("../migrations/0008_version_labels.sql"),
        include_str!("../migrations/0009_skill_user_purpose.sql"),
        include_str!("../migrations/0010_llm_providers_translations.sql"),
        include_str!("../migrations/0011_source_roles.sql"),
        include_str!("../migrations/0012_combination_name_unique.sql"),
        include_str!("../migrations/0013_observed_deployments.sql"),
    ] {
        connection.execute_batch(sql).unwrap();
    }
    connection
        .execute_batch(
            "INSERT INTO skills(id, display_name, runtime_name, created_at, updated_at)
                 VALUES ('00000000-0000-0000-0000-0000000000c1', 'Legacy', 'legacy', 1, 1);
             INSERT INTO versions(id, skill_id, content_hash, manifest_json, created_at)
                 VALUES ('sha256:0000000000000000000000000000000000000000000000000000000000000007', '00000000-0000-0000-0000-0000000000c1', 'sha256:legacy', '{}', 1);
             INSERT INTO observed_deployments(id, skill_id, client_id, original_path, path_key, content_fingerprint, match_state, origin, status, observed_at)
                 VALUES ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'legacy.agent', 'C:\\legacy\\skills\\legacy', 'C:\\legacy\\skills\\legacy', 'sha256:observed', 'content_verified', 'scan', 'active', 11);
             INSERT INTO targets(id, agent_id, scope, path, created_at)
                 VALUES ('target-legacy-windows', 'legacy.agent', 'global', 'C:\\legacy\\skills', 1);
             INSERT INTO deployments(id, skill_id, version_id, target_id, state, method, managed, runtime_name, expected_hash, created_at, updated_at)
                 VALUES ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c1', 'sha256:0000000000000000000000000000000000000000000000000000000000000007', 'target-legacy-windows', 'deployed', 'managed_copy', 1, 'legacy', 'sha256:legacy', 12, 12);",
        )
        .unwrap();
    connection.pragma_update(None, "user_version", 13).unwrap();
    drop(connection);

    let database = Database::open(file.path()).unwrap();
    let relations = database.relationship_repository().list_relations().unwrap();
    assert_eq!(relations.len(), 1);
    assert_eq!(
        relations[0].relation_id,
        "legacy-managed:00000000-0000-0000-0000-0000000000c3"
    );
    assert_eq!(
        relations[0].ownership,
        skillhub_core::OwnershipState::SkillhubManaged
    );
    assert_eq!(
        relations[0].relationship,
        skillhub_core::RelationshipType::ManagedCopy
    );
    assert_eq!(relations[0].path, r"C:\legacy\skills\legacy");
}

#[test]
fn database_newer_than_application_is_rejected_with_read_only_recovery() {
    let db = fixture_database_with_schema_version(999);
    let error = Database::open(db.path()).unwrap_err();

    assert_eq!(error.code.as_str(), "database.newer_schema");
    assert!(error
        .actions
        .iter()
        .any(|action| action.as_str() == "open_read_only"));
}

#[test]
fn open_exposes_the_migration_report() {
    let db = Database::open_in_memory().unwrap();
    let report = db.migration_report();

    assert_eq!(report.from_version, 0);
    assert_eq!(report.to_version, 16);
    assert_eq!(
        report.applied_versions,
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
    );
}

#[test]
fn v4_database_upgrades_check_run_metadata_in_v5() {
    let file = NamedTempFile::new().unwrap();
    let connection = Connection::open(file.path()).unwrap();
    connection
        .execute_batch(include_str!("../migrations/0001_initial.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../migrations/0002_fts.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../migrations/0003_catalog_metadata.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../migrations/0004_search_tokenizer.sql"))
        .unwrap();
    connection.pragma_update(None, "user_version", 4).unwrap();
    drop(connection);

    let db = Database::open(file.path()).unwrap();
    assert_eq!(db.schema_version().unwrap(), 16);
    assert_eq!(
        db.migration_report().applied_versions,
        vec![5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
    );
    let generation: String = db
        .connection_for_test()
        .query_row(
            "SELECT name FROM pragma_table_info('check_runs') WHERE name='generation'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let allowed: String = db
        .connection_for_test()
        .query_row(
            "SELECT name FROM pragma_table_info('check_findings') WHERE name='allowed_dispositions_json'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(generation, "generation");
    assert_eq!(allowed, "allowed_dispositions_json");
}

/// P1-05 迁移回归：版本 10 的旧库升级到 11 后——
/// 1) 旧行默认 `local_only`（向后兼容的诚实缺省）；
/// 2) 旧 git+完整坐标行（导入管线确认过的上游）回填为 `verified_upstream`，
///    `upstream_for_skill` 继续可读；
/// 3) `search_candidates` 候选表就位。
#[test]
fn v10_database_upgrades_source_roles_and_keeps_legacy_upstreams_readable() {
    use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};

    let file = NamedTempFile::new().unwrap();
    let connection = Connection::open(file.path()).unwrap();
    for sql in [
        include_str!("../migrations/0001_initial.sql"),
        include_str!("../migrations/0002_fts.sql"),
        include_str!("../migrations/0003_catalog_metadata.sql"),
        include_str!("../migrations/0004_search_tokenizer.sql"),
        include_str!("../migrations/0005_check_run_metadata.sql"),
        include_str!("../migrations/0006_llm_profiles.sql"),
        include_str!("../migrations/0007_ui_preferences.sql"),
        include_str!("../migrations/0008_version_labels.sql"),
        include_str!("../migrations/0009_skill_user_purpose.sql"),
        include_str!("../migrations/0010_llm_providers_translations.sql"),
    ] {
        connection.execute_batch(sql).unwrap();
    }
    connection
        .execute_batch(
            "INSERT INTO skills(id,display_name,runtime_name,created_at,updated_at) VALUES
                 ('00000000-0000-0000-0000-0000000000a1','Remote','remote',1,1),
                 ('00000000-0000-0000-0000-0000000000a2','Local','local',1,1);
             INSERT INTO sources(id,kind,locator,metadata_json,created_at) VALUES
                 ('source-git','git','https://github.com/anthropics/skills','{\"branch\":\"main\",\"directory\":\"pdf\"}',1),
                 ('source-local','local','C:/tmp/notes','{}',1);
             INSERT INTO skill_sources(skill_id,source_id,relation) VALUES
                 ('00000000-0000-0000-0000-0000000000a1','source-git','origin'),
                 ('00000000-0000-0000-0000-0000000000a2','source-local','origin');",
        )
        .unwrap();
    connection.pragma_update(None, "user_version", 10).unwrap();
    drop(connection);

    let db = Database::open(file.path()).unwrap();
    assert_eq!(db.schema_version().unwrap(), 16);

    let remote_skill: skillhub_core::SkillId =
        "00000000-0000-0000-0000-0000000000a1".parse().unwrap();
    let local_skill: skillhub_core::SkillId =
        "00000000-0000-0000-0000-0000000000a2".parse().unwrap();
    let upstream = db
        .source_repository()
        .upstream_for_skill(remote_skill)
        .unwrap()
        .expect("旧 git+完整坐标行升级后必须仍可作为上游读取");
    assert_eq!(upstream.url, "https://github.com/anthropics/skills");
    assert_eq!(upstream.branch, "main");
    assert_eq!(upstream.directory, "pdf");

    let role: String = db
        .connection_for_test()
        .query_row(
            "SELECT role FROM sources WHERE id='source-git'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(role, "verified_upstream");
    let role: String = db
        .connection_for_test()
        .query_row(
            "SELECT role FROM sources WHERE id='source-local'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(role, "local_only");

    let remote_record = db
        .source_repository()
        .source_record_for_skill(remote_skill)
        .unwrap()
        .expect("remote source record");
    assert_eq!(
        remote_record.role,
        skillhub_core::SourceRole::VerifiedUpstream
    );
    assert_eq!(
        remote_record.source,
        SourceDescriptor::new(
            SourceKind::Git,
            SourceLocator::git_url("https://github.com/anthropics/skills")
        )
    );
    assert!(remote_record.upstream.is_some());
    let local_record = db
        .source_repository()
        .source_record_for_skill(local_skill)
        .unwrap()
        .expect("local source record");
    assert_eq!(local_record.role, skillhub_core::SourceRole::LocalOnly);
    assert!(local_record.upstream.is_none());
}

#[test]
fn v2_database_upgrades_catalog_metadata_table() {
    let file = NamedTempFile::new().unwrap();
    let connection = Connection::open(file.path()).unwrap();
    connection
        .execute_batch(include_str!("../migrations/0001_initial.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../migrations/0002_fts.sql"))
        .unwrap();
    connection.pragma_update(None, "user_version", 2).unwrap();
    connection.execute("INSERT INTO skills(id,display_name,runtime_name,created_at,updated_at) VALUES ('legacy','Legacy','legacy',1,1)", []).unwrap();
    drop(connection);
    let db = Database::open(file.path()).unwrap();
    assert!(db.has_table("catalog_skill_metadata").unwrap());
    assert_eq!(
        db.connection_for_test()
            .query_row(
                "SELECT display_name FROM skills WHERE id='legacy'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "Legacy"
    );
}

#[test]
fn v3_database_upgrade_backfills_original_search_display_names() {
    let file = NamedTempFile::new().unwrap();
    let connection = Connection::open(file.path()).unwrap();
    connection
        .execute_batch(include_str!("../migrations/0001_initial.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../migrations/0002_fts.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../migrations/0003_catalog_metadata.sql"))
        .unwrap();
    connection
        .execute("INSERT INTO skills(id,display_name,runtime_name,created_at,updated_at) VALUES ('00000000-0000-0000-0000-000000000008','PDF Extractor','pdf-extractor',1,1)", [])
        .unwrap();
    connection
        .execute("INSERT INTO skills_fts(skill_id,display_name,runtime_name) VALUES ('00000000-0000-0000-0000-000000000008','pdf extractor','pdf-extractor')", [])
        .unwrap();
    connection.pragma_update(None, "user_version", 3).unwrap();
    drop(connection);
    let db = Database::open(file.path()).unwrap();
    let repo = db.search_repository();
    let hit = repo
        .search("pdf")
        .unwrap()
        .into_iter()
        .find(|hit| hit.skill_name == "PDF Extractor");
    assert!(hit.is_some());
}

/// 0012：combinations.name 唯一约束（终审挂账的防御性加固）。
///
/// 1) 正常路径不可能重名（facade 互斥 + TargetExists 前置），同名行属于历史
///    异常或外部篡改：迁移确定性去重——同名保留最老（created_at,id）一行，
///    其余按年龄序追加 '-2'、'-3'…；
/// 2) 追加后若与既有名冲突（例如库中已有 'pdf-2'），冲突组整体改为
///    'name (id)' 以 UUID 兜底保证唯一；
/// 3) 迁移后唯一索引生效：直接 INSERT 重复名必须被拒绝。
#[test]
fn v11_database_dedupes_combination_names_and_enforces_uniqueness() {
    let file = NamedTempFile::new().unwrap();
    let connection = Connection::open(file.path()).unwrap();
    for sql in [
        include_str!("../migrations/0001_initial.sql"),
        include_str!("../migrations/0002_fts.sql"),
        include_str!("../migrations/0003_catalog_metadata.sql"),
        include_str!("../migrations/0004_search_tokenizer.sql"),
        include_str!("../migrations/0005_check_run_metadata.sql"),
        include_str!("../migrations/0006_llm_profiles.sql"),
        include_str!("../migrations/0007_ui_preferences.sql"),
        include_str!("../migrations/0008_version_labels.sql"),
        include_str!("../migrations/0009_skill_user_purpose.sql"),
        include_str!("../migrations/0010_llm_providers_translations.sql"),
        include_str!("../migrations/0011_source_roles.sql"),
    ] {
        connection.execute_batch(sql).unwrap();
    }
    connection
        .execute_batch(
            "INSERT INTO combinations(id,name,created_at,updated_at) VALUES
                 ('c-1','pdf',100,100),
                 ('c-2','pdf',200,200),
                 ('c-3','pdf',300,300),
                 ('c-4','notes',100,100),
                 ('c-5','pdf-2',50,50);",
        )
        .unwrap();
    connection.pragma_update(None, "user_version", 11).unwrap();
    drop(connection);

    let db = Database::open(file.path()).unwrap();
    assert_eq!(db.schema_version().unwrap(), 16);

    let name_of = |id: &str| -> String {
        db.connection_for_test()
            .query_row("SELECT name FROM combinations WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .unwrap()
    };
    // 最老同名行保持原名；其余按年龄序加后缀。
    assert_eq!(name_of("c-1"), "pdf");
    assert_eq!(name_of("c-3"), "pdf-3");
    assert_eq!(name_of("c-4"), "notes");
    // 'pdf-2' 既是 c-2 的追加结果又是既有名 c-5：冲突组整体 UUID 兜底。
    let renamed_c2 = name_of("c-2");
    let renamed_c5 = name_of("c-5");
    assert_eq!(renamed_c2, "pdf-2 (c-2)");
    assert_eq!(renamed_c5, "pdf-2 (c-5)");

    let unique_index: i64 = db
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='combinations_name_unique'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(unique_index, 1, "唯一索引必须存在");

    let duplicate_insert = db
        .connection_for_test()
        .execute(
            "INSERT INTO combinations(id,name,created_at,updated_at) VALUES('c-x','pdf',1,1)",
            [],
        )
        .unwrap_err();
    assert!(
        duplicate_insert
            .to_string()
            .contains("UNIQUE constraint failed"),
        "重复名必须被唯一索引拒绝，实际：{duplicate_insert}"
    );
}
