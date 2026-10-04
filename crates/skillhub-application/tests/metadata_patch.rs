use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{GetSkill, PatchSkillMetadata as PatchRequest};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::{
    AppCommand, AppQuery, AppQueryResult, ApplicationFacade, PatchField, SkillId,
    SkillMetadataPatch,
};
use skillhub_storage::Database;
use std::collections::BTreeSet;

#[tokio::test]
async fn facade_persists_patch_and_clears_alias_to_runtime_name() {
    let directory = tempfile::tempdir().expect("temporary database directory");
    let database_path = directory.path().join("metadata-patch.sqlite");
    let database = Database::open(&database_path).expect("database");
    let mut skill = Skill::new(SkillId::new(), "pdf-reader")
        .with_note("retain note")
        .with_tag("documents");
    skill
        .set_metadata(
            Some("PDF helper".to_owned()),
            Some("retain note".to_owned()),
            BTreeSet::from(["documents".to_owned()]),
            Some("Author".to_owned()),
            Some("MIT".to_owned()),
            Some("Extract tables".to_owned()),
        )
        .expect("alias metadata");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let facade = LocalApplicationFacade::new_with_today(database, (2026, 10, 4));

    facade
        .execute(AppCommand::PatchSkillMetadata(PatchRequest {
            skill_id: skill.id(),
            patch: SkillMetadataPatch {
                display_name: PatchField::Clear,
                ..Default::default()
            },
        }))
        .await
        .expect("clear alias");

    let AppQueryResult::Skill(detail) = facade
        .query(AppQuery::GetSkill(GetSkill {
            skill_id: skill.id(),
        }))
        .await
        .expect("load skill")
    else {
        panic!("expected skill detail");
    };
    assert_eq!(detail.display_name, "pdf-reader");
    assert_eq!(detail.runtime_name, "pdf-reader");
    assert_eq!(detail.user_note.as_deref(), Some("retain note"));
    assert_eq!(detail.tags, vec!["documents"]);
    assert_eq!(detail.author.as_deref(), Some("Author"));
    assert_eq!(detail.license.as_deref(), Some("MIT"));
    assert_eq!(detail.user_purpose.as_deref(), Some("Extract tables"));

    let (note_update, tags_update) = tokio::join!(
        facade.execute(AppCommand::PatchSkillMetadata(PatchRequest {
            skill_id: skill.id(),
            patch: SkillMetadataPatch {
                note: PatchField::Set("updated note".to_owned()),
                ..Default::default()
            },
        })),
        facade.execute(AppCommand::PatchSkillMetadata(PatchRequest {
            skill_id: skill.id(),
            patch: SkillMetadataPatch {
                tags: PatchField::Set(vec!["documents".to_owned(), "tables".to_owned()]),
                ..Default::default()
            },
        }))
    );
    note_update.expect("concurrent note patch");
    tags_update.expect("concurrent tag patch");

    let AppQueryResult::Skill(detail) = facade
        .query(AppQuery::GetSkill(GetSkill {
            skill_id: skill.id(),
        }))
        .await
        .expect("reload skill")
    else {
        panic!("expected skill detail");
    };
    assert_eq!(detail.user_note.as_deref(), Some("updated note"));
    assert_eq!(detail.display_name, "pdf-reader");
    assert_eq!(detail.runtime_name, "pdf-reader");
    assert_eq!(detail.tags, vec!["documents", "tables"]);
    assert_eq!(detail.author.as_deref(), Some("Author"));

    drop(facade);
    let reopened = Database::open(&database_path).expect("reopen SQLite database");
    let reopened_facade = LocalApplicationFacade::new_with_today(reopened, (2026, 10, 4));
    let AppQueryResult::Skill(persisted) = reopened_facade
        .query(AppQuery::GetSkill(GetSkill {
            skill_id: skill.id(),
        }))
        .await
        .expect("load persisted skill after database reopen")
    else {
        panic!("expected persisted skill detail");
    };
    assert_eq!(persisted.user_note.as_deref(), Some("updated note"));
    assert_eq!(persisted.tags, vec!["documents", "tables"]);
    assert_eq!(persisted.display_name, "pdf-reader");
    assert_eq!(persisted.runtime_name, "pdf-reader");
}

#[tokio::test]
async fn facade_rejects_invalid_patch_without_persisting_partial_fields() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(SkillId::new(), "pdf")
        .with_note("existing")
        .with_tag("documents");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let facade = LocalApplicationFacade::new_with_today(database, (2026, 10, 4));

    let error = facade
        .execute(AppCommand::PatchSkillMetadata(PatchRequest {
            skill_id: skill.id(),
            patch: SkillMetadataPatch {
                display_name: PatchField::Set(" ".to_owned()),
                note: PatchField::Clear,
                ..Default::default()
            },
        }))
        .await
        .expect_err("blank alias is invalid");
    assert_eq!(error.code, skillhub_core::ErrorCode::InvalidInput);

    let AppQueryResult::Skill(detail) = facade
        .query(AppQuery::GetSkill(GetSkill {
            skill_id: skill.id(),
        }))
        .await
        .expect("load original skill")
    else {
        panic!("expected skill detail");
    };
    assert_eq!(detail.display_name, "pdf");
    assert_eq!(detail.user_note.as_deref(), Some("existing"));
    assert_eq!(detail.tags, vec!["documents"]);
}
