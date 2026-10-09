//! T16：局部运行名改为派生主体，只替换明确选中的使用关系，并保留复用修改追溯。

use std::path::PathBuf;

use skillhub_adapters::deployment::DeploymentFilesystem;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, CommitUsageChange, GetSkill,
    ListDeployments, PrepareDeleteSkill, PrepareUsageChange, ReadMarkdownFile, SaveMarkdownAsCopy,
};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::deployment::{observed_path_key, ObservedMatchState, ObservedOrigin};
use skillhub_core::relationship::{
    DeploymentRelationFact, FileRepresentation, OwnershipState, RelationshipType,
};
use skillhub_core::{
    physical_id_for_path, ApplicationFacade, DeploymentId, OperationId, SkillId, VersionId,
};
use skillhub_storage::{CentralLibrary, Database, VersionStore};

const SOURCE_MARKDOWN: &str =
    "---\nname: Notebook\ndescription: Shared notebook\n---\n# Notebook\n\nOriginal body.\n";

struct Fixture {
    database_path: PathBuf,
    library_root: tempfile::TempDir,
    roots: Vec<tempfile::TempDir>,
}

impl Fixture {
    fn new() -> Self {
        let library_root = tempfile::tempdir().expect("library root");
        let database_root = tempfile::tempdir().expect("database root");
        let database_path = database_root.path().join("skillhub.sqlite");
        Self {
            database_path,
            library_root,
            roots: vec![database_root],
        }
    }

    fn facade(&self) -> LocalApplicationFacade {
        LocalApplicationFacade::new_with_library(
            Database::open(&self.database_path).expect("database"),
            self.library_root.path(),
        )
    }

    fn database(&self) -> Database {
        Database::open(&self.database_path).expect("database")
    }

    fn root(&mut self) -> PathBuf {
        let root = tempfile::tempdir().expect("target root");
        let path = root.path().to_path_buf();
        self.roots.push(root);
        path
    }
}

struct Source {
    id: SkillId,
    version_id: VersionId,
    identity: String,
}

fn seed_source(fixture: &Fixture) -> Source {
    let skill = Skill::new(SkillId::new(), "Notebook");
    let database = fixture.database();
    database
        .catalog_repository()
        .expect("catalog")
        .insert_sync(&skill)
        .expect("insert skill");
    let source_dir = tempfile::tempdir().expect("source directory");
    std::fs::write(source_dir.path().join("SKILL.md"), SOURCE_MARKDOWN).expect("write source");
    let library = CentralLibrary::initialize(fixture.library_root.path()).expect("library");
    let store = VersionStore::from_library(&library);
    let version = store
        .capture(skill.id(), source_dir.path())
        .expect("capture source");
    store
        .set_current(skill.id(), &version.id)
        .expect("set current version");
    database
        .record_current_version(skill.id(), &version)
        .expect("record current version");
    let (identity, _) = store
        .read_file(&version.id, "SKILL.md", 1_048_576)
        .expect("read source identity");
    Source {
        id: skill.id(),
        version_id: version.id,
        identity,
    }
}

fn seed_managed_target(
    fixture: &mut Fixture,
    source: &Source,
    runtime_name: &str,
    corrupt_after_recording: bool,
) -> (DeploymentId, PathBuf) {
    let target_root = fixture.root();
    let target_id = physical_id_for_path(&target_root).expect("target identity");
    let database = fixture.database();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'agent-fixture', 'global', ?2, 0)",
            rusqlite::params![target_id, target_root.to_string_lossy().into_owned()],
        )
        .expect("insert target");
    seed_managed_target_in_root(
        fixture,
        source,
        &target_id,
        &target_root,
        runtime_name,
        corrupt_after_recording,
    )
}

fn seed_managed_target_in_root(
    fixture: &Fixture,
    source: &Source,
    target_id: &str,
    target_root: &std::path::Path,
    runtime_name: &str,
    corrupt_after_recording: bool,
) -> (DeploymentId, PathBuf) {
    let entry = target_root.join(runtime_name);
    std::fs::create_dir_all(&entry).expect("create deployed entry");
    std::fs::write(entry.join("SKILL.md"), SOURCE_MARKDOWN).expect("write deployed skill");
    let expected_hash = DeploymentFilesystem::hash_tree(&entry).expect("hash deployed entry");
    if corrupt_after_recording {
        std::fs::write(
            entry.join("SKILL.md"),
            "tampered after ownership snapshot\n",
        )
        .expect("corrupt deployed skill");
    }
    let database = fixture.database();
    let deployment_id = DeploymentId::new();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO deployments (id, skill_id, version_id, target_id, state, method, managed, runtime_name, expected_hash, observed_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'deployed', 'managed_copy', 1, ?5, ?6, ?6, 0, 0)",
            rusqlite::params![
                deployment_id.to_string(),
                source.id.to_string(),
                source.version_id.to_string(),
                target_id,
                runtime_name,
                expected_hash,
            ],
        )
        .expect("insert deployment");
    let entry_path = entry.to_string_lossy().into_owned();
    database
        .relationship_repository()
        .upsert_deployment_relation(&DeploymentRelationFact {
            relation_id: format!("managed:{deployment_id}"),
            skill_id: Some(source.id),
            agent_client_id: "agent-fixture".to_owned(),
            path: entry_path.clone(),
            path_key: observed_path_key(&entry_path),
            directory_node_id: Some(target_id.to_owned()),
            relationship: RelationshipType::ManagedCopy,
            file_representation: FileRepresentation::Copy,
            ownership: OwnershipState::SkillhubManaged,
            link_target_path: None,
            link_target_path_key: None,
            link_target_directory_id: None,
            content_fingerprint: expected_hash,
            origin: ObservedOrigin::Import,
            match_state: ObservedMatchState::ContentVerified,
            health_reasons: Some(Vec::new()),
            active: true,
            observed_at: 0,
            released_at: None,
        })
        .expect("record verified managed relation");
    (deployment_id, entry)
}

fn derive_request(
    source: &Source,
    runtime_name: &str,
    selected: &[DeploymentId],
    operation_id: OperationId,
) -> PrepareUsageChange {
    derive_request_confirming_shared(source, runtime_name, selected, &[], operation_id)
}

fn derive_request_confirming_shared(
    source: &Source,
    runtime_name: &str,
    selected: &[DeploymentId],
    confirmed_shared: &[DeploymentId],
    operation_id: OperationId,
) -> PrepareUsageChange {
    let relation_ids = selected
        .iter()
        .map(|id| format!("managed:{id}"))
        .collect::<Vec<_>>();
    let confirmed_shared_relation_ids = confirmed_shared
        .iter()
        .map(|id| format!("managed:{id}"))
        .collect::<Vec<_>>();
    serde_json::from_value(serde_json::json!({
        "operation_id": operation_id,
        "action": "derive_and_replace",
        "relation_ids": [],
        "selected_relation_ids": relation_ids,
        "confirmed_shared_relation_ids": confirmed_shared_relation_ids,
        "problem_id": null,
        "skill_id": source.id,
        "requested_form": null,
        "copy_disposition": null,
        "content_basis": null,
        "retain_entry_key": null,
        "selected_entry_keys": [],
        "runtime_name": runtime_name,
        "base_version_id": source.version_id,
        "non_recognized_destination": null
    }))
    .expect("the unified usage-change contract must accept derived rename")
}

async fn prepare_and_commit(
    facade: &LocalApplicationFacade,
    request: PrepareUsageChange,
) -> (
    skillhub_core::relationship::PreparedUsageChange,
    serde_json::Value,
) {
    let prepared = facade
        .prepare_usage_change(request.clone())
        .expect("prepare derived rename");
    let result = facade
        .commit_usage_change(CommitUsageChange {
            operation_id: request.operation_id,
            prepared_id: prepared.prepared_id,
        })
        .expect("commit derived rename");
    (
        prepared,
        serde_json::to_value(result).expect("serialize receipt"),
    )
}

async fn deployments(
    facade: &LocalApplicationFacade,
    skill_id: SkillId,
) -> Vec<skillhub_core::DeploymentRecord> {
    let result = facade
        .query(AppQuery::ListDeployments(ListDeployments {
            skill_id: Some(skill_id),
        }))
        .await
        .expect("list deployments");
    let AppQueryResult::Deployments(result) = result else {
        panic!("expected deployments");
    };
    result
}

async fn skill_view(
    facade: &LocalApplicationFacade,
    skill_id: SkillId,
) -> skillhub_core::api::SkillResult {
    let result = facade
        .query(AppQuery::GetSkill(GetSkill { skill_id }))
        .await
        .expect("get skill");
    let AppQueryResult::Skill(result) = result else {
        panic!("expected skill");
    };
    result
}

async fn delete_skill(facade: &LocalApplicationFacade, skill_id: SkillId) {
    let prepared = facade
        .execute(AppCommand::PrepareDeleteSkill(PrepareDeleteSkill {
            skill_id,
        }))
        .await
        .expect("prepare deletion");
    let AppCommandResult::RemovalImpact(impact) = prepared else {
        panic!("expected removal impact");
    };
    facade
        .execute(AppCommand::CommitDeleteSkill(
            skillhub_core::api::CommitDeleteSkill {
                prepared_delete_id: impact.operation_id,
                decisions: vec![],
            },
        ))
        .await
        .expect("delete skill");
}

async fn save_as_copy(facade: &LocalApplicationFacade, source: &Source, markdown: &str) -> SkillId {
    let result = facade
        .execute(AppCommand::SaveMarkdownAsCopy(SaveMarkdownAsCopy {
            skill_id: source.id,
            path: "SKILL.md".to_owned(),
            markdown: markdown.to_owned(),
            expected_identity: source.identity.clone(),
            target_display_name: None,
            target_runtime_name: None,
            origin: Some(skillhub_core::api::SaveAsCopyOrigin {
                source_skill_id: source.id,
                source_version_id: source.version_id.clone(),
            }),
            inheritance: Default::default(),
        }))
        .await
        .expect("save as copy");
    let AppCommandResult::SavedSkillCopy(copy) = result else {
        panic!("expected saved copy");
    };
    copy.skill_id
}

#[tokio::test]
async fn derive_replaces_only_selected_targets() {
    let mut fixture = Fixture::new();
    let source = seed_source(&fixture);
    let (selected, _) = seed_managed_target(&mut fixture, &source, "Notebook", false);
    let (untouched, _) = seed_managed_target(&mut fixture, &source, "Notebook-other", false);
    let facade = fixture.facade();

    let (_, receipt) = prepare_and_commit(
        &facade,
        derive_request(&source, "Notebook-local", &[selected], OperationId::new()),
    )
    .await;
    let derived_id: SkillId = serde_json::from_value(receipt["derived_skill_id"].clone())
        .expect("receipt includes the new subject id");
    let derived = deployments(&facade, derived_id).await;
    assert_eq!(derived.len(), 1);
    assert_eq!(derived[0].id, selected);
    assert_eq!(derived[0].runtime_name, "Notebook-local");
    let original = deployments(&facade, source.id).await;
    assert_eq!(original.len(), 1);
    assert_eq!(original[0].id, untouched);
    let relationships = fixture
        .database()
        .relationship_repository()
        .list_relations()
        .expect("relations");
    let selected_relation = relationships
        .iter()
        .find(|relation| relation.relation_id == format!("managed:{selected}"))
        .expect("selected relation remains queryable");
    assert_eq!(selected_relation.skill_id, Some(derived_id));
    assert!(selected_relation.path.ends_with("Notebook-local"));
}

#[tokio::test]
async fn derived_rename_preserves_the_source_display_alias() {
    let mut fixture = Fixture::new();
    let source = seed_source(&fixture);
    let (selected, _) = seed_managed_target(&mut fixture, &source, "Notebook", false);
    let database = fixture.database();
    let mut skill = database
        .catalog_repository()
        .expect("catalog")
        .get_sync(source.id)
        .expect("read source skill")
        .expect("source skill exists");
    skill
        .set_metadata(
            Some("My notebook alias".to_owned()),
            skill.note().map(str::to_owned),
            skill.tags().clone(),
            skill.author().map(str::to_owned),
            skill.license().map(str::to_owned),
            skill.user_purpose().map(str::to_owned),
        )
        .expect("set source display alias");
    database
        .catalog_repository()
        .expect("catalog")
        .insert_sync(&skill)
        .expect("persist source display alias");
    let facade = fixture.facade();

    let (_, receipt) = prepare_and_commit(
        &facade,
        derive_request(&source, "Notebook-local", &[selected], OperationId::new()),
    )
    .await;
    let derived_id: SkillId = serde_json::from_value(receipt["derived_skill_id"].clone())
        .expect("receipt includes the new subject id");
    let derived = skill_view(&facade, derived_id).await;

    assert_eq!(derived.runtime_name, "Notebook-local");
    assert_eq!(derived.display_name, "My notebook alias");
}

#[test]
fn shared_target_requires_explicit_confirmation_before_prepare() {
    let mut fixture = Fixture::new();
    let source = seed_source(&fixture);
    let target_root = fixture.root();
    let target_id = physical_id_for_path(&target_root).expect("target identity");
    fixture
        .database()
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'agent-fixture', 'global', ?2, 0)",
            rusqlite::params![target_id, target_root.to_string_lossy().into_owned()],
        )
        .expect("insert shared target");
    let (selected, _) = seed_managed_target_in_root(
        &fixture,
        &source,
        &target_id,
        &target_root,
        "Notebook",
        false,
    );
    seed_managed_target_in_root(
        &fixture,
        &source,
        &target_id,
        &target_root,
        "Notebook-other",
        false,
    );
    let facade = fixture.facade();
    let error = facade
        .prepare_usage_change(derive_request(
            &source,
            "Notebook-local",
            &[selected],
            OperationId::new(),
        ))
        .expect_err("shared target requires explicit confirmation");
    assert_eq!(
        error
            .params
            .get("reason")
            .and_then(serde_json::Value::as_str),
        Some("derived_rename_shared_confirmation_required")
    );
    let prepared = facade
        .prepare_usage_change(derive_request_confirming_shared(
            &source,
            "Notebook-local",
            &[selected],
            &[selected],
            OperationId::new(),
        ))
        .expect("explicit shared target confirmation permits prepare");
    assert!(prepared.derived_rename.is_some());
}

#[tokio::test]
async fn lineage_records_starting_version_once() {
    let mut fixture = Fixture::new();
    let source = seed_source(&fixture);
    let (selected, _) = seed_managed_target(&mut fixture, &source, "Notebook", false);
    let facade = fixture.facade();
    let request = derive_request(&source, "Notebook-local", &[selected], OperationId::new());
    let prepared = facade
        .prepare_usage_change(request.clone())
        .expect("prepare derived rename");
    let commit = CommitUsageChange {
        operation_id: request.operation_id,
        prepared_id: prepared.prepared_id,
    };

    let first = facade
        .commit_usage_change(commit.clone())
        .expect("first commit");
    let second = facade
        .commit_usage_change(commit)
        .expect("idempotent retry");
    let first: serde_json::Value = serde_json::to_value(first).expect("serialize first receipt");
    let second: serde_json::Value = serde_json::to_value(second).expect("serialize retry receipt");
    let derived_id: SkillId = serde_json::from_value(first["derived_skill_id"].clone())
        .expect("receipt includes new subject id");
    assert_eq!(second["derived_skill_id"], first["derived_skill_id"]);

    let audit = fixture.database();
    let count: i64 = audit
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM skill_lineage WHERE skill_id=?1",
            [derived_id.to_string()],
            |row| row.get(0),
        )
        .expect("count lineage rows");
    assert_eq!(count, 1, "retry must not duplicate the lineage fact");
    let lineage = skill_view(&facade, derived_id)
        .await
        .upstream_lineage
        .expect("lineage is queryable");
    assert_eq!(lineage.source_skill_id, source.id);
    assert_eq!(lineage.source_version_id, source.version_id);
}

#[tokio::test]
async fn derived_skill_has_no_inherited_update_source() {
    let mut fixture = Fixture::new();
    let source = seed_source(&fixture);
    let database = fixture.database();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO sources (id, kind, locator, revision, metadata_json, created_at) VALUES ('source-net', 'https', 'https://example.com/notebook.git', NULL, '{}', 0)",
            [],
        )
        .expect("insert update source");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO skill_sources (skill_id, source_id, relation) VALUES (?1, 'source-net', 'origin')",
            [source.id.to_string()],
        )
        .expect("link source");
    let (selected, _) = seed_managed_target(&mut fixture, &source, "Notebook", false);
    let facade = fixture.facade();

    let (_, receipt) = prepare_and_commit(
        &facade,
        derive_request(&source, "Notebook-local", &[selected], OperationId::new()),
    )
    .await;
    let derived_id: SkillId = serde_json::from_value(receipt["derived_skill_id"].clone())
        .expect("receipt includes new subject id");
    let derived = skill_view(&facade, derived_id).await;
    assert!(derived.upstream_lineage.is_some());
    assert_eq!(
        derived.source_kind, None,
        "network update source is not inherited"
    );
}

#[tokio::test]
async fn partial_failure_is_recoverable() {
    let mut fixture = Fixture::new();
    let source = seed_source(&fixture);
    let (successful, _) = seed_managed_target(&mut fixture, &source, "Notebook-one", false);
    let (failing, _) = seed_managed_target(&mut fixture, &source, "Notebook-two", true);
    let facade = fixture.facade();

    let (_, receipt) = prepare_and_commit(
        &facade,
        derive_request(
            &source,
            "Notebook-local",
            &[successful, failing],
            OperationId::new(),
        ),
    )
    .await;
    let derived_id: SkillId = serde_json::from_value(receipt["derived_skill_id"].clone())
        .expect("partial result keeps the new subject");
    assert_eq!(receipt["recovery_required"], true);
    assert!(receipt["item_results"]
        .as_array()
        .is_some_and(|items| !items.is_empty()));
    assert!(skill_view(&facade, derived_id)
        .await
        .upstream_lineage
        .is_some());
    let current = deployments(&facade, source.id).await;
    assert!(current.iter().any(|deployment| deployment.id == failing));
    assert!(!current.iter().any(|deployment| deployment.id == successful));
}

#[tokio::test]
async fn parent_deletion_keeps_child_without_parent_body() {
    let fixture = Fixture::new();
    let source = seed_source(&fixture);
    let facade = fixture.facade();
    let child_id = save_as_copy(&facade, &source, SOURCE_MARKDOWN).await;

    delete_skill(&facade, source.id).await;

    let child = skill_view(&facade, child_id).await;
    let lineage = child
        .upstream_lineage
        .expect("source deletion preserves an explanatory lineage reference");
    assert_eq!(lineage.source_skill_id, source.id);
    assert_eq!(lineage.source_version_id, source.version_id);
    assert_eq!(lineage.source_display_name.as_deref(), Some("Notebook"));
    let parent_body = facade
        .query(AppQuery::ReadMarkdownFile(ReadMarkdownFile {
            skill_id: source.id,
            path: "SKILL.md".to_owned(),
            version_id: Some(source.version_id),
        }))
        .await;
    assert!(
        parent_body.is_err(),
        "deleted source content must not remain queryable"
    );
}

#[tokio::test]
async fn child_deletion_does_not_redispatch_parent() {
    let mut fixture = Fixture::new();
    let source = seed_source(&fixture);
    let (parent_deployment, target_entry) =
        seed_managed_target(&mut fixture, &source, "Notebook", false);
    let facade = fixture.facade();
    let child_id = save_as_copy(&facade, &source, SOURCE_MARKDOWN).await;

    delete_skill(&facade, child_id).await;

    let parent_deployments = deployments(&facade, source.id).await;
    assert_eq!(parent_deployments.len(), 1);
    assert_eq!(parent_deployments[0].id, parent_deployment);
    assert!(target_entry.join("SKILL.md").is_file());
    assert!(skill_view(&facade, source.id)
        .await
        .upstream_lineage
        .is_none());
}
