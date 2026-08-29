use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::SkillId;
use skillhub_storage::Database;

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
