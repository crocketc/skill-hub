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
fn import_analysis_query_has_stable_wire_shape() {
    let query = AppQuery::AnalyzeImport(skillhub_core::AnalyzeImport {
        candidate: ImportCandidate::detected(
            SourceDescriptor::new(
                SourceKind::Local,
                SourceLocator::local_path("C:/incoming/notes"),
            ),
            "C:/incoming/notes",
            ".",
            "SKILL.md",
            "notes",
        ),
        tree_hash: None,
    });
    assert_eq!(
        serde_json::to_value(query).unwrap()["type"],
        "analyze_import"
    );
}

#[test]
fn import_candidate_discovery_query_has_stable_wire_shape() {
    let query = AppQuery::DiscoverImportCandidates(skillhub_core::DiscoverImportCandidates {
        source: SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path("C:/incoming")),
    });
    assert_eq!(
        serde_json::to_value(query).unwrap()["type"],
        "discover_import_candidates"
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

#[test]
fn deployment_commands_and_queries_have_stable_wire_shapes() {
    let command = AppCommand::PrepareDeployment(skillhub_core::PrepareDeployment {
        plan: skillhub_core::DeploymentPlan {
            skill_id: skillhub_core::SkillId::new(),
            version_id: skillhub_core::VersionId::parse(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )
            .unwrap(),
            runtime_name: "notes".into(),
            mode: skillhub_core::DeploymentMode::ManagedCopy,
            targets: vec![],
            warnings: vec![],
            conflicts: vec![],
        },
    });
    let commit = AppCommand::CommitDeployment(skillhub_core::CommitDeployment {
        prepared_deployment_id: OperationId::new(),
    });
    let list = AppQuery::ListDeployments(skillhub_core::ListDeployments { skill_id: None });
    let relations = AppQuery::GetDeploymentRelations(skillhub_core::GetDeploymentRelations {
        skill_id: skillhub_core::SkillId::new(),
    });
    assert_eq!(
        serde_json::to_value(command).unwrap()["type"],
        "prepare_deployment"
    );
    assert_eq!(
        serde_json::to_value(commit).unwrap()["type"],
        "commit_deployment"
    );
    assert_eq!(
        serde_json::to_value(list).unwrap()["type"],
        "list_deployments"
    );
    assert_eq!(
        serde_json::to_value(relations).unwrap()["type"],
        "get_deployment_relations"
    );
}

#[test]
fn external_change_commands_and_query_have_stable_wire_shapes() {
    let deployment_id = skillhub_core::DeploymentId::new();
    let commands = [
        AppCommand::CollectDeploymentChanges(skillhub_core::CollectDeploymentChanges {
            deployment_id,
        }),
        AppCommand::RestoreDeployment(skillhub_core::RestoreDeployment { deployment_id }),
        AppCommand::KeepIndependentCopy(skillhub_core::KeepIndependentCopy { deployment_id }),
        AppCommand::IgnoreExternalChange(skillhub_core::IgnoreExternalChange { deployment_id }),
    ];
    let expected = [
        "collect_deployment_changes",
        "restore_deployment",
        "keep_independent_copy",
        "ignore_external_change",
    ];
    for (command, expected_type) in commands.into_iter().zip(expected) {
        assert_eq!(
            serde_json::to_value(command).unwrap()["type"],
            expected_type
        );
    }
    let query = AppQuery::GetReconcilePlan(skillhub_core::GetReconcilePlan { deployment_id });
    assert_eq!(
        serde_json::to_value(query).unwrap()["type"],
        "get_reconcile_plan"
    );
}

#[test]
fn removal_commands_and_query_have_stable_wire_shapes() {
    let skill_id = skillhub_core::SkillId::new();
    let deployment_id = skillhub_core::DeploymentId::new();
    let commands = [
        AppCommand::PrepareUndeploy(skillhub_core::PrepareUndeploy { deployment_id }),
        AppCommand::CommitUndeploy(skillhub_core::CommitUndeploy {
            prepared_undeploy_id: skillhub_core::OperationId::new(),
            decision: skillhub_core::RemovalDecision::KeepSharedDeployment,
        }),
        AppCommand::PrepareDeleteSkill(skillhub_core::PrepareDeleteSkill { skill_id }),
        AppCommand::CommitDeleteSkill(skillhub_core::CommitDeleteSkill {
            prepared_delete_id: skillhub_core::OperationId::new(),
            decisions: vec![],
        }),
        AppCommand::DetachManagement(skillhub_core::DetachManagement { deployment_id }),
    ];
    let expected = [
        "prepare_undeploy",
        "commit_undeploy",
        "prepare_delete_skill",
        "commit_delete_skill",
        "detach_management",
    ];
    for (command, expected_type) in commands.into_iter().zip(expected) {
        assert_eq!(
            serde_json::to_value(command).unwrap()["type"],
            expected_type
        );
    }
    let query = AppQuery::GetRemovalImpact(skillhub_core::GetRemovalImpact { skill_id });
    assert_eq!(
        serde_json::to_value(query).unwrap()["type"],
        "get_removal_impact"
    );
}

#[test]
fn health_and_recovery_commands_and_queries_have_stable_wire_shapes() {
    let operation_id = skillhub_core::OperationId::new();
    let commands = [
        AppCommand::RunHealthCheck(skillhub_core::RunHealthCheck),
        AppCommand::PrepareRepair(skillhub_core::PrepareRepair {
            health_report_id: operation_id,
            finding_index: 0,
        }),
        AppCommand::CommitRepair(skillhub_core::CommitRepair {
            repair_id: operation_id,
        }),
        AppCommand::ResolveRecovery(skillhub_core::ResolveRecovery {
            operation_id,
            action: skillhub_core::RecoveryAction::RollbackOperation,
        }),
    ];
    let expected = [
        "run_health_check",
        "prepare_repair",
        "commit_repair",
        "resolve_recovery",
    ];
    for (command, expected_type) in commands.into_iter().zip(expected) {
        assert_eq!(
            serde_json::to_value(command).unwrap()["type"],
            expected_type
        );
    }
    let query = AppQuery::ListRecoveryCandidates;
    assert_eq!(
        serde_json::to_value(query).unwrap()["type"],
        "list_recovery_candidates"
    );
}

#[test]
fn call_policy_commands_and_query_have_stable_wire_shapes() {
    let skill_id = skillhub_core::SkillId::new();
    let operation_id = skillhub_core::OperationId::new();
    let commands = [
        AppCommand::PrepareCallPolicyChange(skillhub_core::PrepareCallPolicyChange {
            skill_id,
            policy: skillhub_core::catalog::CallPolicy::ManualOnly,
        }),
        AppCommand::CommitCallPolicyChange(skillhub_core::CommitCallPolicyChange {
            plan_id: operation_id,
        }),
        AppCommand::RestoreOriginalCallPolicy(skillhub_core::RestoreOriginalCallPolicy {
            skill_id,
        }),
    ];
    let expected = [
        "prepare_call_policy_change",
        "commit_call_policy_change",
        "restore_original_call_policy",
    ];
    for (command, expected_type) in commands.into_iter().zip(expected) {
        assert_eq!(
            serde_json::to_value(command).unwrap()["type"],
            expected_type
        );
    }
    let query = AppQuery::GetCallPolicy(skillhub_core::GetCallPolicy { skill_id });
    assert_eq!(
        serde_json::to_value(query).unwrap()["type"],
        "get_call_policy"
    );
}

#[test]
fn ignore_rule_commands_and_query_have_stable_wire_shapes() {
    let commands = [
        AppCommand::CreateIgnoreRule(skillhub_core::CreateIgnoreRule {
            subject: skillhub_core::IgnoreSubject::exact_pending("pending-1"),
            reason: "later".into(),
            defer_until: None,
        }),
        AppCommand::RemoveIgnoreRule(skillhub_core::RemoveIgnoreRule {
            rule_id: "rule-1".into(),
        }),
    ];
    let expected = ["create_ignore_rule", "remove_ignore_rule"];
    for (command, expected_type) in commands.into_iter().zip(expected) {
        assert_eq!(
            serde_json::to_value(command).unwrap()["type"],
            expected_type
        );
    }
    assert_eq!(
        serde_json::to_value(AppQuery::ListIgnoreRules).unwrap()["type"],
        "list_ignore_rules"
    );
}

#[test]
fn llm_safety_commands_and_query_have_stable_wire_shapes() {
    let commands = [
        AppCommand::RunLlmSafetyCheck(skillhub_core::RunLlmSafetyCheck {
            skill_id: skillhub_core::SkillId::new(),
            version_id: skillhub_core::VersionId::parse(&format!("sha256:{}", "a".repeat(64)))
                .unwrap(),
        }),
        AppCommand::RecheckLlmSafety(skillhub_core::RecheckLlmSafety {
            skill_id: skillhub_core::SkillId::new(),
            version_id: skillhub_core::VersionId::parse(&format!("sha256:{}", "b".repeat(64)))
                .unwrap(),
        }),
    ];
    let expected = ["run_llm_safety_check", "recheck_llm_safety"];
    for (command, expected_type) in commands.into_iter().zip(expected) {
        assert_eq!(
            serde_json::to_value(command).unwrap()["type"],
            expected_type
        );
    }
    assert_eq!(
        serde_json::to_value(AppQuery::GetLlmSafetyCheckResult(
            skillhub_core::api::GetLlmSafetyCheckResult {
                skill_id: skillhub_core::SkillId::new(),
                version_id: skillhub_core::VersionId::parse(&format!("sha256:{}", "c".repeat(64)))
                    .unwrap(),
            },
        ))
        .unwrap()["type"],
        "get_llm_safety_check_result"
    );
}

#[test]
fn semantic_duplicate_command_has_stable_wire_shape() {
    let command = AppCommand::AnalyzeSemanticDuplicates(skillhub_core::AnalyzeSemanticDuplicates {
        skill_id: skillhub_core::SkillId::new(),
    });
    assert_eq!(
        serde_json::to_value(command).unwrap()["type"],
        "analyze_semantic_duplicates"
    );
}

#[test]
fn translation_and_search_helpers_have_stable_wire_shapes() {
    let skill_id = skillhub_core::SkillId::new();
    let commands = [
        AppCommand::TranslateDescription(skillhub_core::TranslateDescription {
            skill_id,
            language: "zh-CN".into(),
        }),
        AppCommand::SaveUserTranslationRevision(skillhub_core::SaveUserTranslationRevision {
            skill_id,
            language: "zh-CN".into(),
            source_description_hash: "sha256:abc".into(),
            text: "译文".into(),
        }),
        AppCommand::GenerateOnlineSearchQuery(skillhub_core::GenerateOnlineSearchQuery {
            text: "PDF".into(),
        }),
    ];
    let expected = [
        "translate_description",
        "save_user_translation_revision",
        "generate_online_search_query",
    ];
    for (command, expected_type) in commands.into_iter().zip(expected) {
        assert_eq!(
            serde_json::to_value(command).unwrap()["type"],
            expected_type
        );
    }
}

#[test]
fn usage_evidence_query_has_stable_wire_shape() {
    let query = AppQuery::AnalyzeGlobalSkillEvidence(skillhub_core::AnalyzeGlobalSkillEvidence {
        window_days: 90,
        threshold_calls: 2,
    });
    assert_eq!(
        serde_json::to_value(query).unwrap()["type"],
        "analyze_global_skill_evidence"
    );
}

#[test]
fn backup_commands_have_stable_wire_shapes() {
    let skill_id = skillhub_core::SkillId::new();
    let commands = [
        AppCommand::PrepareBackup(skillhub_core::PrepareBackup {
            scope: skillhub_core::backup::BackupScope::Full,
        }),
        AppCommand::CreateBackup(skillhub_core::CreateBackup {
            scope: skillhub_core::backup::BackupScope::Full,
            decisions: vec![skillhub_core::BackupDecision {
                skill_id,
                decision: skillhub_core::backup::SensitiveContentDecision::ExcludeSkill,
            }],
        }),
        AppCommand::VerifyBackup(skillhub_core::VerifyBackup {
            path: "backup".into(),
        }),
    ];
    let expected = ["prepare_backup", "create_backup", "verify_backup"];
    for (command, expected_type) in commands.into_iter().zip(expected) {
        assert_eq!(
            serde_json::to_value(command).unwrap()["type"],
            expected_type
        );
    }
}

#[test]
fn backup_created_result_has_path_and_portable_manifest() {
    let result =
        skillhub_core::AppCommandResult::BackupCreated(skillhub_core::backup::BackupCreated {
            path: "C:/SkillHub/backups/skillhub-backup-1".into(),
            manifest: skillhub_core::backup::BackupManifest {
                format_version: 1,
                entries: vec![],
                contains_sensitive_skill_content: false,
            },
        });
    let json = serde_json::to_value(result).unwrap();
    assert_eq!(json["type"], "backup_created");
    assert_eq!(
        json["payload"]["path"],
        "C:/SkillHub/backups/skillhub-backup-1"
    );
    assert!(json["payload"]["manifest"].get("path").is_none());
}

#[test]
fn restore_commands_have_stable_wire_shapes() {
    let commands = [
        AppCommand::PrepareRestore(skillhub_core::PrepareRestore {
            path: "backup".into(),
        }),
        AppCommand::CommitRestore(skillhub_core::CommitRestore {
            path: "backup".into(),
            decisions: Vec::new(),
        }),
        AppCommand::RunRollingBackup(skillhub_core::RunRollingBackup {
            scope: skillhub_core::backup::BackupScope::Full,
            retention: skillhub_core::backup::BackupRetentionPolicy { max_backups: 3 },
            decisions: Vec::new(),
        }),
    ];
    let expected = ["prepare_restore", "commit_restore", "run_rolling_backup"];
    for (command, expected_type) in commands.into_iter().zip(expected) {
        assert_eq!(
            serde_json::to_value(command).unwrap()["type"],
            expected_type
        );
    }
}

#[test]
fn export_input_without_format_field_defaults_to_folder() {
    let input: skillhub_core::ExportInput = serde_json::from_value(serde_json::json!({
        "selection": { "skills": [] },
        "versions": "current",
        "skills": []
    }))
    .unwrap();
    assert_eq!(input.format, skillhub_core::ExportFormat::Folder);
    let zipped: skillhub_core::ExportInput = serde_json::from_value(serde_json::json!({
        "selection": { "skills": [] },
        "versions": "current",
        "skills": [],
        "format": "zip"
    }))
    .unwrap();
    assert_eq!(zipped.format, skillhub_core::ExportFormat::Zip);
}

#[test]
fn export_and_uninstall_commands_have_stable_wire_shapes() {
    let empty = skillhub_core::ExportInput {
        selection: skillhub_core::ExportSelection::Skills(Vec::new()),
        versions: skillhub_core::VersionSelection::Current,
        skills: Vec::new(),
        format: skillhub_core::ExportFormat::Folder,
        output_dir: None,
    };
    let commands = [
        AppCommand::PrepareStandardExport(skillhub_core::PrepareStandardExport {
            input: empty.clone(),
        }),
        AppCommand::CreateStandardExport(skillhub_core::CreateStandardExport {
            input: empty,
            decisions: Vec::new(),
        }),
        AppCommand::PrepareUninstall(skillhub_core::PrepareUninstall {
            deployment_ids: Vec::new(),
        }),
        AppCommand::ApplyUninstallDecision(skillhub_core::ApplyUninstallDecision {
            actions: vec![skillhub_core::UninstallAction::Cancel],
        }),
    ];
    let expected = [
        "prepare_standard_export",
        "create_standard_export",
        "prepare_uninstall",
        "apply_uninstall_decision",
    ];
    for (command, expected_type) in commands.into_iter().zip(expected) {
        assert_eq!(
            serde_json::to_value(command).unwrap()["type"],
            expected_type
        );
    }
}
