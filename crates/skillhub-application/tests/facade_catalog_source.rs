use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommandResult, ApplySourceUpdate, CheckSourceUpdate, CreateCombination, CreateSkill,
    DeleteCombination, GetSkill, ListCombinations, PinProjectSkillVersion, RelinkSource,
    SaveSkillContent, UpdateCombination,
};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::project::Project;
use skillhub_core::source::{
    SourceDescriptor, SourceKind, SourceLocator, SourceState, UpdateDecision,
};
use skillhub_core::{AppCommand, AppQuery, AppQueryResult, ApplicationFacade, ErrorCode};
use skillhub_storage::{CentralLibrary, Database, VersionStore};

fn source_with(contents: &str) -> tempfile::TempDir {
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), contents).expect("skill marker");
    source
}

#[tokio::test]
async fn create_skill_command_captures_version_and_registers_local_source() {
    let database = Database::open_in_memory().expect("database");
    let library = tempfile::tempdir().expect("library");
    let source = source_with("# Notes\n");
    let facade = LocalApplicationFacade::new_with_library(database, library.path());

    let result = facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Notes".into(),
            source_path: source.path().to_string_lossy().into_owned(),
        }))
        .await
        .expect("create skill");
    let AppCommandResult::OperationSummary(summary) = result else {
        panic!("expected operation summary");
    };
    assert_eq!(summary.message_code, "catalog.skill_created");
    let skills = facade
        .query(AppQuery::ListSkills(skillhub_core::api::ListSkills {
            text: String::new(),
            page: 1,
            page_size: 10,

            filters: Default::default(),

            sort: Default::default(),
        }))
        .await
        .expect("list skills");
    let AppQueryResult::SkillPage(page) = skills else {
        panic!("expected skill page")
    };
    assert_eq!(page.items.len(), 1);
    assert!(facade
        .query(AppQuery::GetSkill(GetSkill {
            skill_id: page.items[0].skill_id
        }))
        .await
        .is_ok());
}

#[tokio::test]
async fn combinations_are_created_and_listed_with_stable_members() {
    let database = Database::open_in_memory().expect("database");
    let first = Skill::new(skillhub_core::SkillId::new(), "First");
    let second = Skill::new(skillhub_core::SkillId::new(), "Second");
    database
        .catalog_repository()
        .expect("catalog")
        .insert(&first)
        .await
        .expect("insert");
    database
        .catalog_repository()
        .expect("catalog")
        .insert(&second)
        .await
        .expect("insert");
    let facade = LocalApplicationFacade::new(database);

    facade
        .execute(AppCommand::CreateCombination(CreateCombination {
            name: "Writing stack".into(),
            members: vec![second.id(), first.id()],
        }))
        .await
        .expect("create combination");
    let result = facade
        .query(AppQuery::ListCombinations(ListCombinations))
        .await
        .expect("list combinations");
    let AppQueryResult::Combinations(items) = result else {
        panic!("expected combinations")
    };
    assert_eq!(items[0].name, "Writing stack");
    assert_eq!(items[0].members, vec![second.id(), first.id()]);
}

#[tokio::test]
async fn combinations_can_update_members_and_be_deleted() {
    let database = Database::open_in_memory().expect("database");
    let first = Skill::new(skillhub_core::SkillId::new(), "First");
    let second = Skill::new(skillhub_core::SkillId::new(), "Second");
    for skill in [&first, &second] {
        database
            .catalog_repository()
            .expect("catalog")
            .insert(skill)
            .await
            .expect("insert");
    }
    let facade = LocalApplicationFacade::new(database);

    facade
        .execute(AppCommand::CreateCombination(CreateCombination {
            name: "Writing stack".into(),
            members: vec![first.id()],
        }))
        .await
        .expect("create combination");

    let result = facade
        .execute(AppCommand::UpdateCombination(UpdateCombination {
            name: "Writing stack".into(),
            members: vec![first.id(), second.id()],
        }))
        .await
        .expect("update combination");
    let AppCommandResult::OperationSummary(summary) = result else {
        panic!("expected operation summary");
    };
    assert_eq!(summary.message_code, "catalog.combination_updated");

    let listed = facade
        .query(AppQuery::ListCombinations(ListCombinations))
        .await
        .expect("list combinations");
    let AppQueryResult::Combinations(items) = listed else {
        panic!("expected combinations")
    };
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].members, vec![first.id(), second.id()]);

    let missing = facade
        .execute(AppCommand::UpdateCombination(UpdateCombination {
            name: "No such combination".into(),
            members: vec![first.id()],
        }))
        .await
        .expect_err("updating a missing combination must fail");
    assert_eq!(missing.code, ErrorCode::ObjectNotFound);

    let result = facade
        .execute(AppCommand::DeleteCombination(DeleteCombination {
            name: "Writing stack".into(),
        }))
        .await
        .expect("delete combination");
    let AppCommandResult::OperationSummary(summary) = result else {
        panic!("expected operation summary");
    };
    assert_eq!(summary.message_code, "catalog.combination_deleted");

    let listed = facade
        .query(AppQuery::ListCombinations(ListCombinations))
        .await
        .expect("list combinations");
    let AppQueryResult::Combinations(items) = listed else {
        panic!("expected combinations")
    };
    assert!(items.is_empty());

    let missing = facade
        .execute(AppCommand::DeleteCombination(DeleteCombination {
            name: "Writing stack".into(),
        }))
        .await
        .expect_err("deleting a missing combination must fail");
    assert_eq!(missing.code, ErrorCode::ObjectNotFound);
}

#[tokio::test]
async fn pin_project_skill_version_validates_project_and_version() {
    let database = Database::open_in_memory().expect("database");
    let library = tempfile::tempdir().expect("library");
    let source = source_with("# Notes\n");
    let central = CentralLibrary::initialize(library.path()).expect("central");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Notes");
    database
        .catalog_repository()
        .expect("catalog")
        .insert(&skill)
        .await
        .expect("insert");
    let version = VersionStore::from_library(&central)
        .capture(skill.id(), source.path())
        .expect("version");
    VersionStore::from_library(&central)
        .set_current(skill.id(), &version.id)
        .expect("current");
    let project_root = tempfile::tempdir().expect("project");
    let project = Project::new(skillhub_core::ProjectId::new(), "Demo", project_root.path());
    let facade = LocalApplicationFacade::new_with_library(database, library.path());
    facade
        .execute(AppCommand::RegisterProject(
            skillhub_core::api::RegisterProject {
                project: project.clone(),
            },
        ))
        .await
        .expect("project");

    facade
        .execute(AppCommand::PinProjectSkillVersion(PinProjectSkillVersion {
            project_id: project.id,
            skill_id: skill.id(),
            version_id: version.id,
        }))
        .await
        .expect("pin version");
}

#[tokio::test]
async fn source_relink_check_and_take_upstream_create_new_version() {
    let database = Database::open_in_memory().expect("database");
    let library = tempfile::tempdir().expect("library");
    let source_a = source_with("# Original\n");
    let source_b = source_with("# Upstream\n");
    let facade = LocalApplicationFacade::new_with_library(database, library.path());
    let created = facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Notes".into(),
            source_path: source_a.path().to_string_lossy().into_owned(),
        }))
        .await
        .expect("create");
    let _ = created;
    let skill_id = match facade
        .query(AppQuery::ListSkills(skillhub_core::api::ListSkills {
            text: String::new(),
            page: 1,
            page_size: 10,

            filters: Default::default(),

            sort: Default::default(),
        }))
        .await
        .expect("skills")
    {
        AppQueryResult::SkillPage(page) => page.items[0].skill_id,
        _ => panic!("expected page"),
    };
    facade
        .execute(AppCommand::RelinkSource(RelinkSource {
            skill_id,
            source: SourceDescriptor::new(
                SourceKind::Local,
                SourceLocator::local_path(source_b.path()),
            ),
        }))
        .await
        .expect("relink");
    let check = facade
        .execute(AppCommand::CheckSourceUpdate(CheckSourceUpdate {
            skill_id,
        }))
        .await
        .expect("check");
    let AppCommandResult::UpstreamCheckResult(check) = check else {
        panic!("expected check")
    };
    assert_eq!(check.state, SourceState::UpdateAvailable);
    let applied = facade
        .execute(AppCommand::ApplySourceUpdate(ApplySourceUpdate {
            skill_id,
            decision: UpdateDecision::TakeUpstream,
        }))
        .await
        .expect("apply");
    let AppCommandResult::AppliedSourceUpdate(applied) = applied else {
        panic!("expected update")
    };
    assert!(applied.new_version.is_some());
}

#[tokio::test]
async fn applying_upstream_update_rejects_local_modifications_without_choice() {
    let database = Database::open_in_memory().expect("database");
    let library = tempfile::tempdir().expect("library");
    let source = source_with("# Upstream\n");
    let local = source_with("# Local\n");
    let facade = LocalApplicationFacade::new_with_library(database, library.path());
    let _ = facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Notes".into(),
            source_path: source.path().to_string_lossy().into_owned(),
        }))
        .await
        .expect("create");
    let skill_id = match facade
        .query(AppQuery::ListSkills(skillhub_core::api::ListSkills {
            text: String::new(),
            page: 1,
            page_size: 10,

            filters: Default::default(),

            sort: Default::default(),
        }))
        .await
        .expect("skills")
    {
        AppQueryResult::SkillPage(page) => page.items[0].skill_id,
        _ => panic!("page"),
    };
    facade
        .execute(AppCommand::SaveSkillContent(SaveSkillContent {
            skill_id,
            source_path: local.path().to_string_lossy().into_owned(),
        }))
        .await
        .expect("save local version");
    std::fs::write(source.path().join("SKILL.md"), "# New upstream\n").expect("upstream change");
    let error = facade
        .execute(AppCommand::ApplySourceUpdate(ApplySourceUpdate {
            skill_id,
            decision: UpdateDecision::TakeUpstream,
        }))
        .await
        .expect_err("must require choice");
    assert_eq!(error.code, ErrorCode::OperationConflict);
}
