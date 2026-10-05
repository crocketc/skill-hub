use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::RelinkSource;
use skillhub_core::catalog::Skill;
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator, UpstreamOrigin};
use skillhub_core::{AppCommand, ApplicationFacade, ErrorCode, SkillId};
use skillhub_storage::Database;

#[tokio::test]
async fn relink_rejects_an_unverified_source_without_replacing_the_existing_origin() {
    let workspace = tempfile::tempdir().expect("test workspace");
    let library_root = workspace.path().join("library");
    let database_path = workspace.path().join("skillhub.sqlite");
    let skill_id = SkillId::new();
    let original = UpstreamOrigin {
        url: "https://example.invalid/owner/repository".into(),
        branch: "main".into(),
        directory: "skills/demo".into(),
    };

    let database = Database::open(&database_path).expect("database");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert_sync(&Skill::new(skill_id, "Relink source"))
        .expect("skill");
    database
        .source_repository()
        .record_upstream(skill_id, &original)
        .expect("original upstream");
    assert_eq!(
        database
            .source_repository()
            .upstream_for_skill(skill_id)
            .expect("read original source"),
        Some(original.clone())
    );

    let facade = LocalApplicationFacade::new_with_library(database, &library_root);
    let error = facade
        .execute(AppCommand::RelinkSource(RelinkSource {
            skill_id,
            source: SourceDescriptor::new(
                SourceKind::Https,
                SourceLocator::https_url("this is not a URL"),
            ),
        }))
        .await
        .expect_err("an unverified source must not replace the current origin");
    assert_eq!(error.code, ErrorCode::InvalidInput);
    drop(facade);

    let database = Database::open(&database_path).expect("reopen database");
    assert_eq!(
        database
            .source_repository()
            .upstream_for_skill(skill_id)
            .expect("read source after rejected relink"),
        Some(original),
        "failed source validation must leave the original verified source untouched"
    );
}
