use skillhub_core::{
    AppCommand, AppEvent, AppQuery, ImportAction, ImportCandidate, ImportDecision, OperationId,
    OperationPhase, OperationProgress, SourceDescriptor, SourceKind, SourceLocator,
};

#[test]
fn progress_event_has_stable_wire_shape() {
    let event = AppEvent::OperationProgress(OperationProgress {
        operation_id: OperationId::new(),
        phase: OperationPhase::Prepared,
        completed: 2,
        total: 5,
        message_code: "operation.prepared".into(),
    });
    let json = serde_json::to_value(event).unwrap();
    assert_eq!(json["type"], "operation_progress");
    assert_eq!(json["payload"]["phase"], "prepared");
}

#[test]
fn application_envelopes_include_foundation_operations() {
    let commands = [
        AppCommand::CancelOperation {
            operation_id: OperationId::new(),
        },
        AppCommand::AcknowledgeRecovery {
            operation_id: OperationId::new(),
        },
    ];
    for command in commands {
        fn assert_send<T: Send>(_: T) {}
        assert_send(command);
    }
    let _query = AppQuery::GetBootstrapSnapshot;
}

#[test]
fn import_prepare_commit_and_cancel_have_stable_wire_shapes() {
    let candidate = ImportCandidate::detected(
        SourceDescriptor::new(
            SourceKind::Local,
            SourceLocator::local_path("C:/incoming/notes"),
        ),
        "C:/incoming/notes",
        ".",
        "SKILL.md",
        "notes",
    )
    .with_ownership(
        skillhub_core::CandidateOwnership::ArbitraryLocalDirectory,
        ImportAction::Review,
        None,
    );
    let prepared = OperationId::new();
    let prepare = AppCommand::PrepareImport(skillhub_core::PrepareImport {
        candidate,
        tree_hash: None,
    });
    let commit = AppCommand::CommitImport(skillhub_core::CommitImport {
        prepared_import_id: prepared,
        decision: ImportDecision::CopyIntoLibrary,
    });
    let cancel = AppCommand::CancelImport {
        prepared_import_id: prepared,
    };
    assert_eq!(
        serde_json::to_value(prepare).unwrap()["type"],
        "prepare_import"
    );
    assert_eq!(
        serde_json::to_value(commit).unwrap()["type"],
        "commit_import"
    );
    assert_eq!(
        serde_json::to_value(cancel).unwrap()["type"],
        "cancel_import"
    );
}

#[test]
fn source_update_commands_have_stable_wire_shapes() {
    let skill_id = skillhub_core::SkillId::new();
    let relink = AppCommand::RelinkSource(skillhub_core::RelinkSource {
        skill_id,
        source: SourceDescriptor::new(
            SourceKind::Git,
            SourceLocator::git_url("https://github.com/example/skill"),
        ),
    });
    let check = AppCommand::CheckSourceUpdate(skillhub_core::CheckSourceUpdate { skill_id });
    let apply = AppCommand::ApplySourceUpdate(skillhub_core::ApplySourceUpdate {
        skill_id,
        decision: skillhub_core::UpdateDecision::KeepLocal,
    });
    assert_eq!(
        serde_json::to_value(relink).unwrap()["type"],
        "relink_source"
    );
    assert_eq!(
        serde_json::to_value(check).unwrap()["type"],
        "check_source_update"
    );
    assert_eq!(
        serde_json::to_value(apply).unwrap()["type"],
        "apply_source_update"
    );
}

#[test]
fn online_source_search_query_has_stable_wire_shape() {
    let query = AppQuery::SearchOnlineSources(skillhub_core::SearchOnlineSources {
        query: skillhub_core::SourceSearchQuery::new("pdf"),
    });
    assert_eq!(
        serde_json::to_value(query).unwrap()["type"],
        "search_online_sources"
    );
}
