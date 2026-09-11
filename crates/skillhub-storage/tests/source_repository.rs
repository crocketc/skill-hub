use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{SkillId, SourceRole};
use skillhub_storage::Database;

fn insert_skill(database: &Database, skill_id: SkillId) {
    database
        .connection_for_test()
        .execute(
            "INSERT INTO skills (id, display_name, runtime_name, ownership, created_at, updated_at) VALUES (?1, 'Notes', 'notes', 'user_created', 0, 0)",
            [skill_id.to_string()],
        )
        .unwrap();
}

#[test]
fn relink_replaces_active_source_relation_without_rewriting_versions() {
    let database = Database::open_in_memory().unwrap();
    let skill_id = SkillId::new();
    let connection = database.connection_for_test();
    connection
        .execute(
            "INSERT INTO skills (id, display_name, runtime_name, ownership, created_at, updated_at) VALUES (?1, 'Notes', 'notes', 'user_created', 0, 0)",
            [skill_id.to_string()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES ('version-1', ?1, 'sha256:tree', '{}', 0)",
            [skill_id.to_string()],
        )
        .unwrap();

    let first = SourceDescriptor::new(
        SourceKind::Git,
        SourceLocator::git_url("https://github.com/example/old"),
    );
    let second = SourceDescriptor::new(
        SourceKind::Git,
        SourceLocator::git_url("https://github.com/example/new"),
    );
    database
        .source_repository()
        .relink(skill_id, first.clone())
        .unwrap();
    database
        .source_repository()
        .relink(skill_id, second.clone())
        .unwrap();

    assert_eq!(
        database.source_repository().for_skill(skill_id).unwrap(),
        Some(second)
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM versions WHERE skill_id=?1",
                [skill_id.to_string()],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM sources", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

/// P1-05：relink 本地来源 = local_only；relink 远端 URL 与 record_upstream
/// 都是显式确认动作 = verified_upstream。
#[test]
fn source_roles_follow_the_confirmation_semantics() {
    let database = Database::open_in_memory().unwrap();
    let skill_id = SkillId::new();
    insert_skill(&database, skill_id);

    // 本地目录 relink：仅本地。
    database
        .source_repository()
        .relink(
            skill_id,
            SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path("C:/tmp/notes")),
        )
        .unwrap();
    assert_eq!(
        database
            .source_repository()
            .role_for_skill(skill_id)
            .unwrap(),
        SourceRole::LocalOnly
    );
    let record = database
        .source_repository()
        .source_record_for_skill(skill_id)
        .unwrap()
        .expect("local record");
    assert_eq!(record.role, SourceRole::LocalOnly);
    assert!(record.upstream.is_none());
    assert_eq!(record.skill_id, skill_id);

    // record_upstream（导入管线/显式绑定）：可验证上游，且覆盖 local_only。
    database
        .source_repository()
        .record_upstream(
            skill_id,
            &skillhub_core::UpstreamOrigin {
                url: "https://github.com/anthropics/skills".into(),
                branch: "main".into(),
                directory: "pdf".into(),
            },
        )
        .unwrap();
    let record = database
        .source_repository()
        .source_record_for_skill(skill_id)
        .unwrap()
        .expect("upstream record");
    assert_eq!(record.role, SourceRole::VerifiedUpstream);
    let upstream = record.upstream.expect("upstream coordinates");
    assert_eq!(upstream.branch, "main");
    assert_eq!(upstream.directory, "pdf");
    assert_eq!(
        database
            .source_repository()
            .role_for_skill(skill_id)
            .unwrap(),
        SourceRole::VerifiedUpstream
    );

    // 手动 relink 回本地：角色回到 local_only，上游坐标不再读出。
    database
        .source_repository()
        .relink(
            skill_id,
            SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path("C:/tmp/notes")),
        )
        .unwrap();
    assert_eq!(
        database
            .source_repository()
            .role_for_skill(skill_id)
            .unwrap(),
        SourceRole::LocalOnly
    );
    assert!(database
        .source_repository()
        .upstream_for_skill(skill_id)
        .unwrap()
        .is_none());
}

/// 无来源记录的 Skill 视为 local_only（诚实缺省），来源投影返回 None。
#[test]
fn skills_without_source_rows_default_to_local_only() {
    let database = Database::open_in_memory().unwrap();
    let skill_id = SkillId::new();
    insert_skill(&database, skill_id);
    assert_eq!(
        database
            .source_repository()
            .role_for_skill(skill_id)
            .unwrap(),
        SourceRole::LocalOnly
    );
    assert!(database
        .source_repository()
        .source_record_for_skill(skill_id)
        .unwrap()
        .is_none());
}

/// 手动 relink 的 git 来源（无 branch/directory 坐标）是 verified_upstream，
/// 但 upstream_for_skill 仍因坐标缺失返回 None（N7 语义不变）。
#[test]
fn manually_relinked_git_source_stays_unreadable_without_coordinates() {
    let database = Database::open_in_memory().unwrap();
    let skill_id = SkillId::new();
    insert_skill(&database, skill_id);
    database
        .source_repository()
        .relink(
            skill_id,
            SourceDescriptor::new(
                SourceKind::Git,
                SourceLocator::git_url("https://github.com/example/repo"),
            ),
        )
        .unwrap();
    assert_eq!(
        database
            .source_repository()
            .role_for_skill(skill_id)
            .unwrap(),
        SourceRole::VerifiedUpstream
    );
    assert!(database
        .source_repository()
        .upstream_for_skill(skill_id)
        .unwrap()
        .is_none());
}
