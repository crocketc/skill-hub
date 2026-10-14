use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommandResult, AppQueryResult, CommitDeployment, CommitDeploymentPreview,
    DeploymentBatchPreview, DeploymentBatchPreviewRequestItem, DeploymentPairSelection,
    GetDeploymentBatchPreview, GetDeploymentPlan, ListDeployments, PrepareDeployment,
    SaveAsCopyInheritance, SaveAsCopyOrigin, SaveMarkdownAsCopy,
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
    third_target_root: tempfile::TempDir,
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
            .record_current_version(skill.id(), &version)
            .expect("record current version");
        VersionStore::from_library(&library)
            .set_current(skill.id(), &version.id)
            .expect("set version store current pointer");
        library
            .materialize_current_skill(skill, &version.id)
            .expect("materialize current skill");
        versions.push(version.id);
    }

    let target_root = tempfile::tempdir().expect("target root");
    let other_target_root = tempfile::tempdir().expect("other target root");
    let third_target_root = tempfile::tempdir().expect("third target root");
    let physical_id =
        skillhub_core::physical_id_for_path(target_root.path()).expect("target identity");
    let other_physical_id = skillhub_core::physical_id_for_path(other_target_root.path())
        .expect("other target identity");
    let capabilities = skillhub_core::DeploymentCapability::new(false, false, true);
    let policy = PathPolicy::from_roots([
        AllowedRoot::new(target_root.path()).unwrap(),
        AllowedRoot::new(other_target_root.path()).unwrap(),
        AllowedRoot::new(third_target_root.path()).unwrap(),
    ])
    .unwrap();
    let third_physical_id = skillhub_core::physical_id_for_path(third_target_root.path())
        .expect("third target identity");
    let facts: Vec<TargetFact> = [
        ("claude-global", target_root.path(), physical_id),
        ("codex-global", other_target_root.path(), other_physical_id),
        ("gemini-global", third_target_root.path(), third_physical_id),
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
        third_target_root,
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

async fn deploy_skill_to_target(
    harness: &Harness,
    skill_id: skillhub_core::SkillId,
    version_id: &skillhub_core::VersionId,
    runtime_name: &str,
    logical_target_id: &str,
) -> skillhub_core::DeploymentId {
    let response = harness
        .facade
        .query(RootAppQuery::GetDeploymentPlan(GetDeploymentPlan {
            request: skillhub_core::DeploymentPlanRequest {
                skill_id,
                version_id: version_id.clone(),
                runtime_name: runtime_name.to_owned(),
                logical_target_ids: vec![logical_target_id.to_owned()],
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
        "deployment failed: {:?}",
        summary.targets
    );
    let response = harness
        .facade
        .query(RootAppQuery::ListDeployments(ListDeployments {
            skill_id: Some(skill_id),
        }))
        .await
        .expect("list deployments");
    let AppQueryResult::Deployments(deployments) = response else {
        panic!("expected deployments");
    };
    let root = match logical_target_id {
        "claude-global" => harness.target_root.path(),
        "codex-global" => harness.other_target_root.path(),
        "gemini-global" => harness.third_target_root.path(),
        _ => panic!("unexpected target"),
    };
    let target_id = skillhub_core::physical_id_for_path(root).expect("target identity");
    deployments
        .into_iter()
        .find(|deployment| deployment.target_id == target_id)
        .expect("deployment row")
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
        skillhub_core::api::DeploymentPairCommitOutcome::Deployed,
        "rename receipt: {:?}",
        result.pairs[0]
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
async fn unknown_directory_replacement_is_restorable_without_creating_a_recovery_gate() {
    use skillhub_core::api::{
        AppCommand, AppCommandResult, AppQuery, AppQueryResult, RestoreDeploymentConflictBackup,
    };

    let harness = harness().await;
    let original = harness.target_root.path().join("shared-runtime");
    std::fs::create_dir(&original).expect("create unknown original directory");
    std::fs::write(original.join("keep.txt"), "original user content")
        .expect("write unknown original content");

    let preview = conflict_preview(&harness).await;
    let pair = preview
        .pairs
        .iter()
        .find(|pair| pair.skill_id == harness.source_skill.id())
        .expect("source pair");
    assert!(pair
        .conflict
        .as_ref()
        .expect("unknown conflict")
        .available_actions
        .contains(&DeploymentConflictAction::ReplaceTarget));

    let committed = harness
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
        .expect("replace unknown directory");
    let AppCommandResult::DeploymentPreviewCommitResult(committed) = committed else {
        panic!("expected deployment result");
    };
    assert_eq!(
        committed.pairs[0].outcome,
        skillhub_core::api::DeploymentPairCommitOutcome::Deployed,
        "replacement result: {:?}",
        committed.pairs[0]
    );
    assert_eq!(
        std::fs::read_to_string(original.join("SKILL.md")).expect("new managed content"),
        skill_markdown("shared-runtime", "replacement contents")
    );

    let backups = harness
        .facade
        .query(AppQuery::ListDeploymentConflictBackups)
        .await
        .expect("list replaced content");
    let AppQueryResult::DeploymentConflictBackups(backups) = backups else {
        panic!("expected replaced-content list");
    };
    assert_eq!(backups.len(), 1);
    assert_eq!(backups[0].entry_name, "shared-runtime");
    assert_eq!(
        backups[0].entry_kind,
        skillhub_core::api::DeploymentConflictBackupEntryKind::Directory
    );

    let unfinished = harness
        .facade
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list unfinished operations");
    let AppQueryResult::RecoveryCandidates(unfinished) = unfinished else {
        panic!("expected recovery candidates");
    };
    assert!(
        unfinished.is_empty(),
        "a committed backup is not unfinished work"
    );

    let backup_id = backups[0].backup_id.clone();
    let restored = harness
        .facade
        .execute(AppCommand::RestoreDeploymentConflictBackup(
            RestoreDeploymentConflictBackup {
                backup_id: backup_id.clone(),
            },
        ))
        .await
        .expect("restore unknown original");
    assert!(matches!(restored, AppCommandResult::OperationSummary(_)));
    assert_eq!(
        std::fs::read_to_string(original.join("keep.txt")).expect("restored original content"),
        "original user content"
    );
    assert!(!original.join("SKILL.md").exists());

    let restored_again = harness
        .facade
        .execute(AppCommand::RestoreDeploymentConflictBackup(
            RestoreDeploymentConflictBackup { backup_id },
        ))
        .await
        .expect("repeated restore is idempotent");
    assert!(matches!(
        restored_again,
        AppCommandResult::OperationSummary(_)
    ));

    let replacement_backups = harness
        .facade
        .query(AppQuery::ListDeploymentConflictBackups)
        .await
        .expect("list replacement backup after restore");
    let AppQueryResult::DeploymentConflictBackups(replacement_backups) = replacement_backups else {
        panic!("expected replaced-content list");
    };
    assert_eq!(replacement_backups.len(), 1);
    assert_eq!(
        replacement_backups[0].entry_kind,
        skillhub_core::api::DeploymentConflictBackupEntryKind::Directory
    );
    assert!(replacement_backups[0].backup_id != backups[0].backup_id);
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

#[tokio::test]
async fn rename_and_deploy_is_offered_for_managed_conflicts() {
    let harness = harness().await;
    deploy_occupant(&harness).await;
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
        .contains(&DeploymentConflictAction::RenameAndDeploy));

    let response = harness
        .facade
        .execute(AppCommand::CommitDeploymentPreview(
            CommitDeploymentPreview {
                preview_id: preview.preview_id,
                pairs: vec![DeploymentPairSelection {
                    pair_id: pair.pair_id.clone(),
                    disposition: DeploymentPairDisposition::RenameAndDeploy {
                        runtime_name: "replacement-renamed".to_owned(),
                    },
                    confirm_fallback: false,
                }],
            },
        ))
        .await
        .expect("commit renamed deployment");
    let AppCommandResult::DeploymentPreviewCommitResult(result) = response else {
        panic!("expected deployment result");
    };
    assert_eq!(
        result.pairs.len(),
        1,
        "each selected pair must have one result"
    );
    assert_eq!(result.pairs[0].pair_id, pair.pair_id);
    assert_eq!(
        result.pairs[0].outcome,
        skillhub_core::api::DeploymentPairCommitOutcome::Deployed,
        "rename receipt: {:?}",
        result.pairs[0]
    );
    assert_eq!(
        result.pairs[0].result_skill_id,
        Some(harness.source_skill.id())
    );
    assert_eq!(
        result.pairs[0].runtime_name.as_deref(),
        Some("replacement-renamed")
    );
    assert_eq!(result.pairs[0].affected_target_ids.len(), 1);
    assert!(deployments(&harness).iter().any(|row| {
        row.1 == harness.source_skill.id().to_string()
            && row.3 == "replacement-renamed"
            && row.4 == skillhub_core::physical_id_for_path(harness.target_root.path()).unwrap()
    }));
    assert_eq!(
        std::fs::read_to_string(
            harness
                .target_root
                .path()
                .join("replacement-renamed/SKILL.md")
        )
        .expect("renamed deployment contents"),
        skill_markdown("replacement-renamed", "replacement contents")
    );
    assert_eq!(
        std::fs::read_to_string(harness.target_root.path().join("shared-runtime/SKILL.md"))
            .expect("conflicting occupant remains untouched"),
        skill_markdown("shared-runtime", "original contents")
    );
}

#[tokio::test]
async fn rename_and_deploy_derives_subject_when_source_has_an_unselected_use() {
    let harness = harness().await;
    deploy_occupant(&harness).await;
    let original_deployment = deploy_skill_to_target(
        &harness,
        harness.source_skill.id(),
        &harness.source_version,
        "shared-runtime",
        "gemini-global",
    )
    .await;
    let preview = conflict_preview(&harness).await;
    let pair = preview
        .pairs
        .iter()
        .find(|pair| pair.skill_id == harness.source_skill.id())
        .expect("source pair");

    let response = harness
        .facade
        .execute(AppCommand::CommitDeploymentPreview(
            CommitDeploymentPreview {
                preview_id: preview.preview_id,
                pairs: vec![DeploymentPairSelection {
                    pair_id: pair.pair_id.clone(),
                    disposition: DeploymentPairDisposition::RenameAndDeploy {
                        runtime_name: "replacement-local".to_owned(),
                    },
                    confirm_fallback: false,
                }],
            },
        ))
        .await
        .expect("commit derived deployment");
    let AppCommandResult::DeploymentPreviewCommitResult(result) = response else {
        panic!("expected deployment result");
    };
    assert_eq!(
        result.pairs[0].outcome,
        skillhub_core::api::DeploymentPairCommitOutcome::Deployed
    );
    let main_target_id = skillhub_core::physical_id_for_path(harness.target_root.path())
        .expect("main target identity");
    let rows = deployments(&harness);
    let derived = rows
        .iter()
        .find(|row| row.3 == "replacement-local" && row.4 == main_target_id)
        .expect("derived deployment row");
    assert_eq!(
        result.pairs[0].result_skill_id.map(|id| id.to_string()),
        Some(derived.1.clone())
    );
    assert_eq!(
        result.pairs[0].runtime_name.as_deref(),
        Some("replacement-local")
    );
    assert_eq!(
        result.pairs[0].affected_target_ids,
        vec![main_target_id.clone()]
    );
    assert_ne!(derived.1, harness.source_skill.id().to_string());
    let original = rows
        .iter()
        .find(|row| row.0 == original_deployment.to_string())
        .expect("original deployment remains");
    assert_eq!(original.1, harness.source_skill.id().to_string());
    assert_eq!(original.2, "deployed");
    assert_eq!(original.3, "shared-runtime");
    assert_eq!(
        std::fs::read_to_string(
            harness
                .third_target_root
                .path()
                .join("shared-runtime/SKILL.md")
        )
        .expect("original source contents remain"),
        skill_markdown("shared-runtime", "replacement contents")
    );
    let connection = rusqlite::Connection::open_with_flags(
        harness.database_dir.path().join("skillhub.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("read connection");
    let (origin_skill_id, origin_version_id): (String, String) = connection
        .query_row(
            "SELECT origin_skill_id,origin_version_id FROM skill_lineage WHERE skill_id=?1",
            [&derived.1],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("derived lineage");
    assert_eq!(origin_skill_id, harness.source_skill.id().to_string());
    assert_eq!(origin_version_id, harness.source_version.as_str());
}

#[tokio::test]
async fn retry_after_derived_copy_commit_reuses_the_saved_subject() {
    let harness = harness().await;
    deploy_occupant(&harness).await;
    deploy_skill_to_target(
        &harness,
        harness.source_skill.id(),
        &harness.source_version,
        "shared-runtime",
        "gemini-global",
    )
    .await;
    let preview = conflict_preview(&harness).await;
    let pair = preview
        .pairs
        .iter()
        .find(|pair| pair.skill_id == harness.source_skill.id())
        .expect("source pair");
    let selection = DeploymentPairSelection {
        pair_id: pair.pair_id.clone(),
        disposition: DeploymentPairDisposition::RenameAndDeploy {
            runtime_name: "replacement-local".to_owned(),
        },
        confirm_fallback: false,
    };

    // Recreate the durable boundary where Save As Copy committed but the
    // preview workflow had not yet stored its final result.
    let library = CentralLibrary::initialize(harness._library_root.path()).expect("library");
    let store = VersionStore::from_library(&library);
    let (expected_identity, markdown) = store
        .read_file(&harness.source_version, "SKILL.md", 1_048_576)
        .expect("source markdown");
    let renamed_markdown = String::from_utf8(markdown)
        .expect("UTF-8 source markdown")
        .replace("name: shared-runtime", "name: replacement-local");
    let saved = harness
        .facade
        .execute(AppCommand::SaveMarkdownAsCopy(SaveMarkdownAsCopy {
            skill_id: harness.source_skill.id(),
            path: "SKILL.md".to_owned(),
            markdown: renamed_markdown,
            expected_identity,
            origin: Some(SaveAsCopyOrigin {
                source_skill_id: harness.source_skill.id(),
                source_version_id: harness.source_version.clone(),
            }),
            inheritance: SaveAsCopyInheritance::None,
            target_display_name: None,
            target_runtime_name: Some("replacement-local".to_owned()),
        }))
        .await
        .expect("save derived subject");
    let AppCommandResult::SavedSkillCopy(saved) = saved else {
        panic!("expected saved copy");
    };

    let database =
        skillhub_storage::Database::open(harness.database_dir.path().join("skillhub.sqlite"))
            .expect("database");
    let copy_operation = database
        .operation_repository()
        .list_sync()
        .expect("operation rows")
        .into_iter()
        .find(|record| {
            record.kind == "save_markdown_as_copy"
                && record.phase == skillhub_core::OperationPhase::Committed
                && record.recovery_data["skill_id"] == saved.skill_id.to_string()
        })
        .expect("committed derived-copy operation");
    let payload_json = serde_json::json!({
        "pairs": preview.pairs,
        "rename_dispatches": [{
            "idempotency_key": preview_commit_key_for_test(&preview.preview_id, &selection),
            "pair_ids": [pair.pair_id],
            "source_skill_id": harness.source_skill.id(),
            "source_version_id": harness.source_version,
            "runtime_name": "replacement-local",
            "branch": "derived",
            "operation_id": copy_operation.operation_id,
            "prepared_usage_change_id": null,
            "result_skill_id": null,
            "result_version_id": null,
        }],
    });
    let encoded_payload = serde_json::to_string(&payload_json).expect("encode payload");
    database
        .connection_for_test()
        .execute(
            "UPDATE deployment_preview_snapshots SET payload_json=?1 WHERE preview_id=?2",
            rusqlite::params![encoded_payload, preview.preview_id],
        )
        .expect("persist interrupted preview checkpoint");

    let response = harness
        .facade
        .execute(AppCommand::CommitDeploymentPreview(
            CommitDeploymentPreview {
                preview_id: preview.preview_id,
                pairs: vec![selection],
            },
        ))
        .await
        .expect("resume derived deployment");
    let AppCommandResult::DeploymentPreviewCommitResult(result) = response else {
        panic!("expected deployment result");
    };
    assert_eq!(
        result.pairs[0].outcome,
        skillhub_core::api::DeploymentPairCommitOutcome::Deployed
    );
    assert_eq!(result.pairs[0].result_skill_id, Some(saved.skill_id));
    let lineage_count: i64 = database
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM skill_lineage WHERE origin_skill_id=?1 AND origin_version_id=?2",
            rusqlite::params![
                harness.source_skill.id().to_string(),
                harness.source_version.as_str()
            ],
            |row| row.get(0),
        )
        .expect("count derived subjects");
    assert_eq!(
        lineage_count, 1,
        "retry must not create another derived Skill"
    );
}

#[tokio::test]
async fn retry_after_original_subject_rename_uses_its_committed_version() {
    let harness = harness().await;
    deploy_occupant(&harness).await;
    let preview = conflict_preview(&harness).await;
    let pair = preview
        .pairs
        .iter()
        .find(|pair| pair.skill_id == harness.source_skill.id())
        .expect("source pair");
    let selection = DeploymentPairSelection {
        pair_id: pair.pair_id.clone(),
        disposition: DeploymentPairDisposition::RenameAndDeploy {
            runtime_name: "replacement-renamed".to_owned(),
        },
        confirm_fallback: false,
    };
    let first_response = harness
        .facade
        .execute(AppCommand::CommitDeploymentPreview(
            CommitDeploymentPreview {
                preview_id: preview.preview_id.clone(),
                pairs: vec![selection.clone()],
            },
        ))
        .await
        .expect("commit original subject rename");
    let AppCommandResult::DeploymentPreviewCommitResult(first_result) = first_response else {
        panic!("expected deployment result");
    };
    assert_eq!(
        first_result.pairs[0].outcome,
        skillhub_core::api::DeploymentPairCommitOutcome::Deployed
    );

    // Simulate an exit after the original-subject rename child committed but
    // before the parent copied the child receipt into its checkpoint.
    let database =
        skillhub_storage::Database::open(harness.database_dir.path().join("skillhub.sqlite"))
            .expect("database");
    let mut payload: serde_json::Value = database
        .connection_for_test()
        .query_row(
            "SELECT payload_json FROM deployment_preview_snapshots WHERE preview_id=?1",
            [&preview.preview_id],
            |row| row.get::<_, String>(0),
        )
        .map(|raw| serde_json::from_str(&raw).expect("stored preview payload"))
        .expect("preview snapshot");
    assert_eq!(payload["rename_dispatches"][0]["branch"], "original");
    payload["rename_dispatches"][0]["result_skill_id"] = serde_json::Value::Null;
    payload["rename_dispatches"][0]["result_version_id"] = serde_json::Value::Null;
    let encoded_payload = serde_json::to_string(&payload).expect("encode payload");
    let idempotency_key = preview_commit_key_for_test(&preview.preview_id, &selection);
    database
        .connection_for_test()
        .execute(
            "UPDATE deployment_preview_snapshots SET payload_json=?1, status='active' WHERE preview_id=?2",
            rusqlite::params![encoded_payload, preview.preview_id],
        )
        .expect("restore interrupted preview");
    database
        .connection_for_test()
        .execute(
            "DELETE FROM deployment_preview_commits WHERE idempotency_key=?1",
            [&idempotency_key],
        )
        .expect("remove final commit receipt");

    let response = harness
        .facade
        .execute(AppCommand::CommitDeploymentPreview(
            CommitDeploymentPreview {
                preview_id: preview.preview_id,
                pairs: vec![selection],
            },
        ))
        .await
        .expect("resume original subject deployment");
    let AppCommandResult::DeploymentPreviewCommitResult(result) = response else {
        panic!("expected deployment result");
    };
    assert_eq!(
        result.pairs[0].outcome,
        skillhub_core::api::DeploymentPairCommitOutcome::Deployed
    );
    assert_eq!(
        result.pairs[0].result_skill_id,
        Some(harness.source_skill.id())
    );
    assert_eq!(
        result.pairs[0].runtime_name.as_deref(),
        Some("replacement-renamed")
    );
    assert_eq!(
        deployments(&harness)
            .iter()
            .filter(|row| row.1 == harness.source_skill.id().to_string()
                && row.3 == "replacement-renamed")
            .count(),
        1,
        "retry must reuse the original deployed target"
    );
}

fn preview_commit_key_for_test(preview_id: &str, selection: &DeploymentPairSelection) -> String {
    format!(
        "{}\n{}|disposition:{}|confirm:{}",
        preview_id,
        selection.pair_id,
        serde_json::to_string(&selection.disposition).expect("serialize disposition"),
        selection.confirm_fallback
    )
}

#[tokio::test]
async fn occupied_new_runtime_name_blocks_rename_without_changing_subject_or_targets() {
    let harness = harness().await;
    deploy_occupant(&harness).await;
    let occupied = harness.target_root.path().join("replacement-local");
    std::fs::create_dir(&occupied).expect("create occupied candidate name");
    std::fs::write(occupied.join("keep.txt"), "leave this entry untouched")
        .expect("write occupied candidate contents");
    let preview = conflict_preview(&harness).await;
    let pair = preview
        .pairs
        .iter()
        .find(|pair| pair.skill_id == harness.source_skill.id())
        .expect("source pair");

    let response = harness
        .facade
        .execute(AppCommand::CommitDeploymentPreview(
            CommitDeploymentPreview {
                preview_id: preview.preview_id,
                pairs: vec![DeploymentPairSelection {
                    pair_id: pair.pair_id.clone(),
                    disposition: DeploymentPairDisposition::RenameAndDeploy {
                        runtime_name: "replacement-local".to_owned(),
                    },
                    confirm_fallback: false,
                }],
            },
        ))
        .await
        .expect("occupied rename is reported per pair");
    let AppCommandResult::DeploymentPreviewCommitResult(result) = response else {
        panic!("expected deployment result");
    };
    assert_eq!(
        result.pairs[0].outcome,
        skillhub_core::api::DeploymentPairCommitOutcome::Blocked
    );
    assert_eq!(
        result.pairs[0].error.as_ref().map(|error| error.code),
        Some(skillhub_core::ErrorCode::TargetExists)
    );
    let connection = rusqlite::Connection::open_with_flags(
        harness.database_dir.path().join("skillhub.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("read connection");
    let runtime_name: String = connection
        .query_row(
            "SELECT runtime_name FROM skills WHERE id=?1",
            [harness.source_skill.id().to_string()],
            |row| row.get(0),
        )
        .expect("read source runtime name");
    assert_eq!(runtime_name, "Replacement");
    assert_eq!(
        std::fs::read_to_string(occupied.join("keep.txt")).expect("preserved occupant"),
        "leave this entry untouched"
    );
    assert_eq!(deployments(&harness).len(), 2);
}
