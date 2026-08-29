use skillhub_core::import::{CandidateOwnership, ImportCandidate, ImportDecision};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{SkillId, VersionId};
use skillhub_storage::Database;

#[test]
fn projects_existing_skill_identity_version_source_and_builtin_ownership() {
    let database = Database::open_in_memory().unwrap();
    let skill_id = SkillId::new();
    let version_id =
        VersionId::parse("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .unwrap();
    let source_id = "source-builtin";
    let connection = database.connection_for_test();
    connection
        .execute(
            "INSERT INTO skills (id, display_name, runtime_name, ownership, created_at, updated_at) VALUES (?1, 'PDF', 'pdf', 'read_only_builtin_or_plugin', 0, 0)",
            [skill_id.to_string()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'sha256:tree', '{}', 0)",
            rusqlite::params![version_id.to_string(), skill_id.to_string()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO current_pointers (skill_id, version_id, updated_at) VALUES (?1, ?2, 0)",
            rusqlite::params![skill_id.to_string(), version_id.to_string()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO sources (id, kind, locator, created_at) VALUES (?1, 'git', 'https://github.com/example/pdf', 0)",
            [source_id],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO skill_sources (skill_id, source_id) VALUES (?1, ?2)",
            rusqlite::params![skill_id.to_string(), source_id],
        )
        .unwrap();

    let records = database.import_repository().list_existing().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].skill_id, skill_id);
    assert_eq!(records[0].tree_hash.as_deref(), Some("sha256:tree"));
    assert_eq!(
        records[0].ownership,
        CandidateOwnership::ReadOnlyBuiltinOrPlugin
    );
    assert_eq!(
        records[0].source,
        Some(SourceDescriptor::new(
            SourceKind::Git,
            SourceLocator::git_url("https://github.com/example/pdf"),
        ))
    );

    let candidate = ImportCandidate::detected(
        SourceDescriptor::new(
            SourceKind::Git,
            SourceLocator::git_url("https://github.com/example/pdf"),
        ),
        "C:/incoming/pdf",
        ".",
        "SKILL.md",
        "pdf",
    );
    let analysis = database
        .import_repository()
        .analyze(candidate, Some("sha256:tree"))
        .unwrap();
    assert!(analysis
        .actions
        .contains(&ImportDecision::CopyAsIndependentManagedSkill));
}
