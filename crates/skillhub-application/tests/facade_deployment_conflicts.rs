use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommandResult, AppQueryResult, CommitDeployment, CommitDeploymentPreview,
    DeploymentBatchPreview, DeploymentBatchPreviewRequestItem, DeploymentPairSelection,
    GetDeploymentBatchPreview, GetDeploymentPlan, ListDeployments, PrepareDeployment,
};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::deployment::{
    DeploymentConflictAction, DeploymentMode, DeploymentPairDisposition, DeploymentPreference,
};
use skillhub_core::{AppCommand, AppQuery as RootAppQuery, ApplicationFacade};
use skillhub_storage::{CentralLibrary, Database, VersionStore};

fn skill_markdown(name: &str, body: &str) -> String {
    format!("---\nname: {name}\ndescription: deployment conflict test\n---\n\n{body}\n")
}

struct Harness {
    facade: LocalApplicationFacade,
    database_dir: tempfile::TempDir,
    _library_root: tempfile::TempDir,
    target_root: tempfile::TempDir,
    other_target_root: tempfile::TempDir,
    source_skill: Skill,
    source_version: skillhub_core::VersionId,
    occupant_skill: Skill,
    occupant_version: skillhub_core::VersionId,
}

async fn harness() -> Harness {
    use skillhub_core::deployment::{RegisteredTargetIndex, TargetFact, TargetFactSource};
    use skillhub_core::{AllowedRoot, PathPolicy};

    let database_dir = tempfile::tempdir().expect("database dir");
    let database = Database::open(database_dir.path().join("skillhub.sqlite")).expect("database");
    let source_skill = Skill::new(skillhub_core::SkillId::new(), "Replacement");
    let occupant_skill = Skill::new(skillhub_core::SkillId::new(), "Original occupant");
    let catalog = database.catalog_repository().expect("catalog repository");
    catalog
        .insert(&source_skill)
        .await
        .expect("insert source skill");
    catalog
        .insert(&occupant_skill)
        .await
        .expect("insert occupant skill");

    let library_root = tempfile::tempdir().expect("library root");
    let library = CentralLibrary::initialize(library_root.path()).expect("central library");
    let mut versions = Vec::new();
    for (skill, body) in [
        (&source_skill, "replacement contents"),
        (&occupant_skill, "original contents"),
    ] {
        let source = tempfile::tempdir().expect("source");
        std::fs::write(
            source.path().join("SKILL.md"),
            skill_markdown("shared-runtime", body),
        )
        .expect("write skill markdown");
        let version = VersionStore::from_library(&library)
            .capture(skill.id(), source.path())
            .expect("capture version");
        library
            .save_portable_skill(skill, Some(&version.id))
            .expect("save portable skill");
        database
            .connection_for_test()
            .execute(
                "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
                rusqlite::params![version.id.to_string(), skill.id().to_string()],
            )
            .expect("insert version row");
        versions.push(version.id);
    }

    let target_root = tempfile::tempdir().expect("target root");
    let other_target_root = tempfile::tempdir().expect("other target root");
    let physical_id =
        skillhub_core::physical_id_for_path(target_root.path()).expect("target identity");
    let other_physical_id = skillhub_core::physical_id_for_path(other_target_root.path())
        .expect("other target identity");
    let capabilities = skillhub_core::DeploymentCapability::new(false, false, true);
    let policy = PathPolicy::from_roots([
        AllowedRoot::new(target_root.path()).unwrap(),
        AllowedRoot::new(other_target_root.path()).unwrap(),
    ])
    .unwrap();
    let facts: Vec<TargetFact> = [
        ("claude-global", target_root.path(), physical_id),
        ("codex-global", other_target_root.path(), other_physical_id),
    ]
    .into_iter()
    .map(|(logical_id, path, identity)| {
        TargetFact::registered(
            logical_id,
            path,
            identity,
            TargetFactSource::Discovery,
            capabilities.clone(),
        )
        .with_case_sensitive(!cfg!(windows))
    })
    .collect();
    let index = RegisteredTargetIndex::from_facts(facts, policy).expect("target index");
    let facade =
        LocalApplicationFacade::new_with_library_and_targets(database, library_root.path(), index);
    Harness {
        facade,
        database_dir,
        _library_root: library_root,
        target_root,
        other_target_root,
        source_skill,
        source_version: versions[0].clone(),
        occupant_skill,
        occupant_version: versions[1].clone(),
    }
}

async fn deploy_occupant(harness: &Harness) -> skillhub_core::DeploymentId {
    let response = harness
        .facade
        .query(RootAppQuery::GetDeploymentPlan(GetDeploymentPlan {
            request: skillhub_core::DeploymentPlanRequest {
                skill_id: harness.occupant_skill.id(),
                version_id: harness.occupant_version.clone(),
                runtime_name: "shared-runtime".into(),
                logical_target_ids: vec!["claude-global".into(), "codex-global".into()],
                mode_override: Some(DeploymentMode::ManagedCopy),
            },
        }))
        .await
        .expect("deployment plan");
    let AppQueryResult::DeploymentPlan(plan) = response else {
        panic!("expected deployment plan");
    };
    let response = harness
        .facade
        .execute(AppCommand::PrepareDeployment(PrepareDeployment { plan }))
        .await
        .expect("prepare deployment");
    let AppCommandResult::PreparedDeployment(prepared) = response else {
        panic!("expected prepared deployment");
    };
    let response = harness
        .facade
        .execute(AppCommand::CommitDeployment(CommitDeployment {
            prepared_deployment_id: prepared.id,
        }))
        .await
        .expect("commit deployment");
    let AppCommandResult::DeploymentSummary(summary) = response else {
        panic!("expected deployment summary");
    };
    assert!(
        summary.committed,
        "occupant deployment failed: {:?}",
        summary.targets
    );
    let response = harness
        .facade
        .query(RootAppQuery::ListDeployments(ListDeployments {
            skill_id: Some(harness.occupant_skill.id()),
        }))
        .await
        .expect("list occupant deployments");
    let AppQueryResult::Deployments(deployments) = response else {
        panic!("expected deployments");
    };
    let main_target_id = skillhub_core::physical_id_for_path(harness.target_root.path())
        .expect("main target identity");
    deployments
        .into_iter()
        .find(|deployment| deployment.target_id == main_target_id)
        .expect("main target occupant deployment")
        .id
}

async fn conflict_preview(harness: &Harness) -> DeploymentBatchPreview {
    conflict_preview_with_preference(harness, DeploymentPreference::Copy).await
}

async fn conflict_preview_with_preference(
    harness: &Harness,
    preference: DeploymentPreference,
) -> DeploymentBatchPreview {
    let response = harness
        .facade
        .query(RootAppQuery::GetDeploymentBatchPreview(
            GetDeploymentBatchPreview {
                items: vec![DeploymentBatchPreviewRequestItem {
                    skill_id: harness.source_skill.id(),
                    version_id: Some(harness.source_version.clone()),
                    runtime_name: Some("shared-runtime".into()),
                    logical_target_ids: vec!["claude-global".into()],
                    preference,
                }],
                confirmations: std::collections::BTreeMap::new(),
                exclusions: Vec::new(),
            },
        ))
        .await
        .expect("conflict preview");
    let AppQueryResult::DeploymentBatchPreview(preview) = response else {
        panic!("expected deployment preview");
    };
    preview
}

fn deployments(harness: &Harness) -> Vec<(String, String, String, String, String)> {
    let connection = rusqlite::Connection::open_with_flags(
        harness.database_dir.path().join("skillhub.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("read connection");
    let mut statement = connection
        .prepare(
            "SELECT id,skill_id,state,runtime_name,target_id FROM deployments ORDER BY target_id",
        )
        .expect("deployments statement");
    statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .expect("deployment rows")
        .map(|row| row.expect("deployment row"))
        .collect()
}

#[tokio::test]
async fn managed_replacement_transfers_only_the_selected_deployment() {
    let harness = harness().await;
    let occupant_id = deploy_occupant(&harness).await;
    let preview = conflict_preview(&harness).await;
    let pair = preview
        .pairs
        .iter()
        .find(|pair| pair.skill_id == harness.source_skill.id())
        .expect("source pair");
    let conflict = pair.conflict.as_ref().expect("managed conflict");
    assert!(
        conflict
            .available_actions
            .contains(&DeploymentConflictAction::ReplaceTarget),
        "managed, owned occupant must allow safe replacement"
    );

    let pair_id = pair.pair_id.clone();
    let response = harness
        .facade
        .execute(AppCommand::CommitDeploymentPreview(
            CommitDeploymentPreview {
                preview_id: preview.preview_id.clone(),
                pairs: vec![DeploymentPairSelection {
                    pair_id,
                    disposition: DeploymentPairDisposition::ReplaceTarget,
                    confirm_fallback: false,
                }],
            },
        ))
        .await
        .expect("replace managed target");
    let AppCommandResult::DeploymentPreviewCommitResult(result) = response else {
        panic!("expected deployment result");
    };
    assert_eq!(
        result.pairs[0].outcome,
        skillhub_core::api::DeploymentPairCommitOutcome::Deployed
    );
    assert!(result.pairs[0].operation_id.is_some());
    assert_eq!(result.pairs[0].deployment_id, Some(occupant_id));
    assert_eq!(
        result.pairs[0]
            .replaced
            .as_ref()
            .map(|summary| summary.previous_skill_id),
        Some(harness.occupant_skill.id())
    );

    let rows = deployments(&harness);
    assert_eq!(
        rows.len(),
        2,
        "replacement leaves the other target relation intact"
    );
    let main_target_id = skillhub_core::physical_id_for_path(harness.target_root.path())
        .expect("main target identity");
    let other_target_id = skillhub_core::physical_id_for_path(harness.other_target_root.path())
        .expect("other target identity");
    let main = rows
        .iter()
        .find(|row| row.4 == main_target_id)
        .expect("main row");
    let other = rows
        .iter()
        .find(|row| row.4 == other_target_id)
        .expect("other row");
    assert_eq!(main.0, occupant_id.to_string());
    assert_eq!(main.1, harness.source_skill.id().to_string());
    assert_eq!(main.2, "deployed");
    assert_eq!(main.3, "shared-runtime");
    assert_eq!(other.1, harness.occupant_skill.id().to_string());
    assert_eq!(other.2, "deployed");
    assert_eq!(other.3, "shared-runtime");
    assert_eq!(
        std::fs::read_to_string(harness.target_root.path().join("shared-runtime/SKILL.md"))
            .expect("replacement contents"),
        skill_markdown("shared-runtime", "replacement contents")
    );
    assert_eq!(
        std::fs::read_to_string(
            harness
                .other_target_root
                .path()
                .join("shared-runtime/SKILL.md")
        )
        .expect("untouched other-target contents"),
        skill_markdown("shared-runtime", "original contents")
    );
}

#[tokio::test]
async fn changed_managed_occupant_is_left_untouched_and_blocks_replacement() {
    let harness = harness().await;
    let occupant_id = deploy_occupant(&harness).await;
    let preview = conflict_preview(&harness).await;
    let pair = preview
        .pairs
        .iter()
        .find(|pair| pair.skill_id == harness.source_skill.id())
        .expect("source pair");
    assert!(pair
        .conflict
        .as_ref()
        .expect("managed conflict")
        .available_actions
        .contains(&DeploymentConflictAction::ReplaceTarget));

    let changed_contents = "edited after replacement preview";
    std::fs::write(
        harness.target_root.path().join("shared-runtime/SKILL.md"),
        changed_contents,
    )
    .expect("edit the owned target after preview");
    let response = harness
        .facade
        .execute(AppCommand::CommitDeploymentPreview(
            CommitDeploymentPreview {
                preview_id: preview.preview_id,
                pairs: vec![DeploymentPairSelection {
                    pair_id: pair.pair_id.clone(),
                    disposition: DeploymentPairDisposition::ReplaceTarget,
                    confirm_fallback: false,
                }],
            },
        ))
        .await
        .expect("stale replacement returns pair result");
    let AppCommandResult::DeploymentPreviewCommitResult(result) = response else {
        panic!("expected deployment result");
    };
    assert_eq!(
        result.pairs[0].outcome,
        skillhub_core::api::DeploymentPairCommitOutcome::Blocked
    );
    assert_eq!(result.pairs[0].operation_id, None);
    assert_eq!(
        std::fs::read_to_string(harness.target_root.path().join("shared-runtime/SKILL.md"))
            .expect("preserved changed target"),
        changed_contents
    );
    let rows = deployments(&harness);
    assert!(rows.iter().any(|row| {
        row.0 == occupant_id.to_string() && row.1 == harness.occupant_skill.id().to_string()
    }));
}

#[tokio::test]
async fn link_preference_requires_confirmation_before_copy_fallback_replacement() {
    let harness = harness().await;
    let occupant_id = deploy_occupant(&harness).await;
    let preview = conflict_preview_with_preference(&harness, DeploymentPreference::Link).await;
    let pair = preview
        .pairs
        .iter()
        .find(|pair| pair.skill_id == harness.source_skill.id())
        .expect("source pair");
    assert_eq!(pair.mode, None);
    assert_eq!(pair.fallback_mode, Some(DeploymentMode::ManagedCopy));
    assert!(pair
        .conflict
        .as_ref()
        .expect("managed conflict")
        .available_actions
        .contains(&DeploymentConflictAction::ReplaceTarget));

    let blocked = harness
        .facade
        .execute(AppCommand::CommitDeploymentPreview(
            CommitDeploymentPreview {
                preview_id: preview.preview_id.clone(),
                pairs: vec![DeploymentPairSelection {
                    pair_id: pair.pair_id.clone(),
                    disposition: DeploymentPairDisposition::ReplaceTarget,
                    confirm_fallback: false,
                }],
            },
        ))
        .await
        .expect("unconfirmed fallback is blocked");
    let AppCommandResult::DeploymentPreviewCommitResult(blocked) = blocked else {
        panic!("expected deployment result");
    };
    assert_eq!(
        blocked.pairs[0].outcome,
        skillhub_core::api::DeploymentPairCommitOutcome::Blocked
    );
    assert_eq!(
        std::fs::read_to_string(harness.target_root.path().join("shared-runtime/SKILL.md"))
            .expect("original target remains"),
        skill_markdown("shared-runtime", "original contents")
    );

    let committed = harness
        .facade
        .execute(AppCommand::CommitDeploymentPreview(
            CommitDeploymentPreview {
                preview_id: preview.preview_id,
                pairs: vec![DeploymentPairSelection {
                    pair_id: pair.pair_id.clone(),
                    disposition: DeploymentPairDisposition::ReplaceTarget,
                    confirm_fallback: true,
                }],
            },
        ))
        .await
        .expect("confirmed fallback replacement");
    let AppCommandResult::DeploymentPreviewCommitResult(committed) = committed else {
        panic!("expected deployment result");
    };
    assert_eq!(
        committed.pairs[0].outcome,
        skillhub_core::api::DeploymentPairCommitOutcome::Deployed
    );
    assert_eq!(committed.pairs[0].deployment_id, Some(occupant_id));
}
