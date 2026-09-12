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

    assert_eq!(db.schema_version().unwrap(), 12);
    assert!(db.has_table("skills_fts").unwrap());
    assert!(db.has_table("search_candidates").unwrap());
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
    assert_eq!(report.to_version, 12);
    assert_eq!(
        report.applied_versions,
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
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
    assert_eq!(db.schema_version().unwrap(), 12);
    assert_eq!(
        db.migration_report().applied_versions,
        vec![5, 6, 7, 8, 9, 10, 11, 12]
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
    assert_eq!(db.schema_version().unwrap(), 12);

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
    assert_eq!(db.schema_version().unwrap(), 12);

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
