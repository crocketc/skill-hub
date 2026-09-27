use skillhub_application::LocalApplicationFacade;
use skillhub_core::bootstrap::InitializationStatus;
use skillhub_core::pending::{DismissPendingWork, WorkKind};
use skillhub_core::{AppCommand, AppQuery, AppQueryResult, ApplicationFacade};
use skillhub_storage::Database;

#[tokio::test]
async fn initialized_empty_library_has_optional_guidance_and_skip_is_durable() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let db = Database::open(&path).unwrap();
    db.bootstrap_repository()
        .save_initialization(&InitializationStatus::initialized("library", false))
        .unwrap();
    let facade = LocalApplicationFacade::new(db);
    let AppQueryResult::PendingWorkspace(work) =
        facade.query(AppQuery::GetPendingWorkspace).await.unwrap()
    else {
        panic!("workspace")
    };
    let item = work
        .items
        .iter()
        .find(|item| item.kind == WorkKind::ImportSkills)
        .unwrap();
    assert!(item.recommended && item.can_ignore);
    facade
        .execute(AppCommand::DismissPendingWork(DismissPendingWork {
            item_id: item.id.clone(),
            defer_until: None,
            reason: "Not needed".into(),
        }))
        .await
        .unwrap();
    drop(facade);
    let facade = LocalApplicationFacade::new(Database::open(&path).unwrap());
    let AppQueryResult::PendingWorkspace(work) =
        facade.query(AppQuery::GetPendingWorkspace).await.unwrap()
    else {
        panic!("workspace")
    };
    assert!(!work
        .items
        .iter()
        .any(|item| item.kind == WorkKind::ImportSkills));
}

#[tokio::test]
async fn cannot_complete_an_unknown_or_stale_item() {
    let facade = LocalApplicationFacade::new(Database::open_in_memory().unwrap());
    assert!(facade
        .execute(AppCommand::DismissPendingWork(DismissPendingWork {
            item_id: "work:security:missing".into(),
            defer_until: None,
            reason: "done".into(),
        }))
        .await
        .is_err());
}

#[tokio::test]
async fn current_version_check_closes_only_after_a_real_completed_check() {
    use skillhub_storage::CentralLibrary;
    let root = tempfile::tempdir().unwrap();
    CentralLibrary::initialize(root.path()).unwrap();
    let source = tempfile::tempdir().unwrap();
    std::fs::write(source.path().join("SKILL.md"), "---\nname: notes\ndescription: Organize notes\n---\n# Notes\nOrganize user supplied notes.\n").unwrap();
    let facade =
        LocalApplicationFacade::new_with_library(Database::open_in_memory().unwrap(), root.path());
    facade
        .execute(AppCommand::CreateSkill(skillhub_core::api::CreateSkill {
            name: "Notes".into(),
            source_path: source.path().to_string_lossy().into_owned(),
        }))
        .await
        .unwrap();
    let AppQueryResult::PendingWorkspace(before) =
        facade.query(AppQuery::GetPendingWorkspace).await.unwrap()
    else {
        panic!("workspace")
    };
    let check = before
        .items
        .iter()
        .find(|item| item.kind == WorkKind::BasicCheck)
        .unwrap();
    assert!(!check.can_defer && !check.can_ignore && !check.recommended);
    assert!(facade
        .execute(AppCommand::DismissPendingWork(DismissPendingWork {
            item_id: check.id.clone(),
            defer_until: None,
            reason: "done".into()
        }))
        .await
        .is_err());
    facade
        .execute(AppCommand::RunBasicCheck(
            skillhub_core::api::RunBasicCheck {
                skill_id: check.subject.parse().unwrap(),
                version_id: check.version_id.as_ref().unwrap().parse().unwrap(),
            },
        ))
        .await
        .unwrap();
    let AppQueryResult::PendingWorkspace(after) =
        facade.query(AppQuery::GetPendingWorkspace).await.unwrap()
    else {
        panic!("workspace")
    };
    assert!(!after
        .items
        .iter()
        .any(|item| item.kind == WorkKind::BasicCheck));
}

#[tokio::test]
async fn manual_confirmation_records_only_the_import_advisory_and_survives_restart() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("test.sqlite");
    let db = Database::open(&path).unwrap();
    db.governance_task_repository()
        .create(&skillhub_core::GovernanceTaskFact {
            task_id: "import-advisory".into(),
            subject_id: "source-member".into(),
            kind: skillhub_core::GovernanceTaskKind::UnknownDirectoryRecognition,
            detail: "import.governance.task.unknown_directory_recognition".into(),
            resolved: false,
            created_at: 1,
            resolved_at: None,
        })
        .unwrap();
    let facade = LocalApplicationFacade::new(db);
    let AppQueryResult::PendingWorkspace(work) =
        facade.query(AppQuery::GetPendingWorkspace).await.unwrap()
    else {
        panic!("workspace")
    };
    let item = work
        .items
        .iter()
        .find(|item| item.kind == WorkKind::GovernanceFollowup)
        .unwrap();
    assert!(item.can_confirm);
    facade
        .execute(AppCommand::ConfirmPendingWork(
            skillhub_core::pending::ConfirmPendingWork {
                item_id: item.id.clone(),
                reason: "Reviewed manually".into(),
            },
        ))
        .await
        .unwrap();
    assert!(facade
        .execute(AppCommand::ConfirmPendingWork(
            skillhub_core::pending::ConfirmPendingWork {
                item_id: item.id.clone(),
                reason: "again".into()
            }
        ))
        .await
        .is_err());
    drop(facade);
    let facade = LocalApplicationFacade::new(Database::open(&path).unwrap());
    let AppQueryResult::PendingWorkspace(work) =
        facade.query(AppQuery::GetPendingWorkspace).await.unwrap()
    else {
        panic!("workspace")
    };
    assert!(!work
        .items
        .iter()
        .any(|item| item.kind == WorkKind::GovernanceFollowup));
    let AppQueryResult::PendingConfirmations(history) = facade
        .query(AppQuery::ListPendingConfirmations)
        .await
        .unwrap()
    else {
        panic!("history")
    };
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].reason, "Reviewed manually");
}

#[tokio::test]
async fn findings_keep_exact_identity_and_close_independently() {
    use skillhub_core::check::{CheckKind, CheckRun, Finding, FindingDisposition};
    use skillhub_storage::CentralLibrary;
    let root = tempfile::tempdir().unwrap();
    CentralLibrary::initialize(root.path()).unwrap();
    let db_path = root.path().join("test.sqlite");
    let source = tempfile::tempdir().unwrap();
    std::fs::write(
        source.path().join("SKILL.md"),
        "---\nname: notes\ndescription: Notes\n---\n# Notes\n",
    )
    .unwrap();
    let facade =
        LocalApplicationFacade::new_with_library(Database::open(&db_path).unwrap(), root.path());
    facade
        .execute(AppCommand::CreateSkill(skillhub_core::api::CreateSkill {
            name: "Notes".into(),
            source_path: source.path().to_string_lossy().into_owned(),
        }))
        .await
        .unwrap();
    let AppQueryResult::PendingWorkspace(work) =
        facade.query(AppQuery::GetPendingWorkspace).await.unwrap()
    else {
        panic!("workspace")
    };
    let item = work
        .items
        .iter()
        .find(|item| item.kind == WorkKind::BasicCheck)
        .unwrap();
    let skill_id = item.subject.parse().unwrap();
    let version: skillhub_core::VersionId = item.version_id.as_ref().unwrap().parse().unwrap();
    drop(facade);
    let db = Database::open(&db_path).unwrap();
    for (name, kind) in [("basic-run", CheckKind::Basic), ("llm-run", CheckKind::Llm)] {
        db.check_repository()
            .insert_sync(&CheckRun::completed(
                name,
                skill_id,
                version.clone(),
                kind,
                vec![Finding::new(
                    "same-finding",
                    "same-code",
                    skillhub_core::Severity::Warning,
                )],
            ))
            .unwrap();
    }
    let facade = LocalApplicationFacade::new_with_library(db, root.path());
    let AppQueryResult::PendingWorkspace(work) =
        facade.query(AppQuery::GetPendingWorkspace).await.unwrap()
    else {
        panic!("workspace")
    };
    let findings: Vec<_> = work
        .items
        .iter()
        .filter(|item| item.kind == WorkKind::SecurityFinding)
        .collect();
    assert_eq!(findings.len(), 2);
    assert_ne!(findings[0].id, findings[1].id);
    assert!(findings
        .iter()
        .all(|item| item.finding_id.as_deref() == Some("same-finding") && !item.can_ignore));
    assert!(facade
        .execute(AppCommand::CreateIgnoreRule(
            skillhub_core::CreateIgnoreRule {
                subject: skillhub_core::ignore::IgnoreSubject::exact_pending(
                    findings[0].id.clone()
                ),
                reason: "force done".into(),
                defer_until: None,
            }
        ))
        .await
        .is_err());
    facade
        .execute(AppCommand::SetFindingDisposition(
            skillhub_core::api::SetFindingDisposition {
                skill_id,
                version_id: version,
                kind: CheckKind::Basic,
                finding_id: "same-finding".into(),
                disposition: FindingDisposition::Acknowledged,
                high_risk_confirmed: false,
            },
        ))
        .await
        .unwrap();
    let AppQueryResult::PendingWorkspace(after) =
        facade.query(AppQuery::GetPendingWorkspace).await.unwrap()
    else {
        panic!("workspace")
    };
    let remaining: Vec<_> = after
        .items
        .iter()
        .filter(|item| item.kind == WorkKind::SecurityFinding)
        .collect();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].check_kind.as_deref(), Some("llm"));
}
