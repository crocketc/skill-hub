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
fn clear_llm_provider_credential_has_stable_wire_shape() {
    let command =
        AppCommand::ClearLlmProviderCredential(skillhub_core::api::ClearLlmProviderCredential {
            id: "deepseek".to_owned(),
        });
    let json = serde_json::to_value(command).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "type": "clear_llm_provider_credential",
            "payload": { "id": "deepseek" },
        })
    );
}

#[test]
fn save_markdown_as_copy_has_stable_wire_shape() {
    let command = AppCommand::SaveMarkdownAsCopy(skillhub_core::api::SaveMarkdownAsCopy {
        skill_id: skillhub_core::SkillId::new(),
        path: "SKILL.md".to_owned(),
        markdown: "# Copy".to_owned(),
        expected_identity: "sha256:original".to_owned(),
        origin: None,
        inheritance: skillhub_core::api::SaveAsCopyInheritance::None,
        target_display_name: None,
    });
    let json = serde_json::to_value(command).unwrap();
    assert_eq!(json["type"], "save_markdown_as_copy");
    assert_eq!(json["payload"]["path"], "SKILL.md");
    assert_eq!(json["payload"]["expected_identity"], "sha256:original");
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
        governance_decision: skillhub_core::ImportGovernanceDecision::default(),
        batch_id: None,
        candidate_key: None,
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
            confirm_shared_target_removal: false,
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
            overwrite_user_revision: false,
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
        AppCommand::PrepareStandardExport(skillhub_core::PrepareStandardExport { input: empty }),
        AppCommand::CreateStandardExport(skillhub_core::CreateStandardExport {
            preview_id: OperationId::new(),
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

#[test]
fn export_preview_and_sensitive_items_have_stable_wire_shapes() {
    // K3：预览三件套 + 导出专用敏感项的 wire 字段严格 snake_case。
    let preview = skillhub_core::ExportPreview {
        selection: skillhub_core::ExportSelection::Skills(Vec::new()),
        versions: skillhub_core::VersionSelection::Current,
        skills: Vec::new(),
        sensitive_items: vec![skillhub_core::ExportSensitiveItem {
            skill_id: skillhub_core::SkillId::new(),
            version_id: skillhub_core::VersionId::parse(&format!("sha256:{}", "a".repeat(64)))
                .unwrap(),
            path: ".env".into(),
            reason: "sensitive_filename".into(),
        }],
        preview_id: OperationId::new(),
        expires_at: "2026-10-04T00:00:00Z".into(),
        confirmation_fingerprint: "0".repeat(64),
    };
    let value = serde_json::to_value(&preview).unwrap();
    let keys: std::collections::BTreeSet<&str> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "confirmation_fingerprint",
            "expires_at",
            "preview_id",
            "sensitive_items",
            "selection",
            "skills",
            "versions",
        ]
        .into_iter()
        .collect()
    );
    let item = &value["sensitive_items"][0];
    let item_keys: std::collections::BTreeSet<&str> = item
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        item_keys,
        ["path", "reason", "skill_id", "version_id"]
            .into_iter()
            .collect()
    );
    let tagged =
        serde_json::to_value(skillhub_core::AppCommandResult::ExportPreview(preview)).unwrap();
    assert_eq!(tagged["type"], "export_preview");
}

#[test]
fn markdown_draft_commands_and_query_have_stable_wire_shapes() {
    // K4：草稿命令/查询的 wire 字段严格 snake_case，与前端本地声明一一对应。
    let skill_id = skillhub_core::SkillId::new();
    let commands = [
        AppCommand::SaveMarkdownDraft(skillhub_core::SaveMarkdownDraft {
            skill_id,
            path: "SKILL.md".into(),
            markdown: "# Draft".into(),
            base_version_id: None,
            base_content_identity: "object-1".into(),
        }),
        AppCommand::DiscardMarkdownDraft(skillhub_core::DiscardMarkdownDraft {
            skill_id,
            path: "SKILL.md".into(),
        }),
        AppCommand::ValidateMarkdown(skillhub_core::ValidateMarkdown {
            path: "SKILL.md".into(),
            markdown: "# Draft".into(),
        }),
    ];
    let expected_types = [
        "save_markdown_draft",
        "discard_markdown_draft",
        "validate_markdown",
    ];
    for (command, expected) in commands.into_iter().zip(expected_types) {
        let value = serde_json::to_value(&command).unwrap();
        assert_eq!(value["type"], expected);
        let payload_keys: Vec<String> = value["payload"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert!(
            payload_keys
                .iter()
                .all(|key| key.chars().all(|c| c.is_ascii_lowercase() || c == '_')),
            "{expected} payload keys must be snake_case: {payload_keys:?}"
        );
    }
    let save = serde_json::to_value(AppCommand::SaveMarkdownDraft(
        skillhub_core::SaveMarkdownDraft {
            skill_id,
            path: "SKILL.md".into(),
            markdown: "# Draft".into(),
            base_version_id: None,
            base_content_identity: "object-1".into(),
        },
    ))
    .unwrap();
    let save_keys: std::collections::BTreeSet<&str> = save["payload"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        save_keys,
        [
            "base_content_identity",
            "base_version_id",
            "markdown",
            "path",
            "skill_id",
        ]
        .into_iter()
        .collect()
    );

    let query = serde_json::to_value(AppQuery::GetMarkdownDraft(
        skillhub_core::GetMarkdownDraft {
            skill_id,
            path: "SKILL.md".into(),
        },
    ))
    .unwrap();
    assert_eq!(query["type"], "get_markdown_draft");
    let query_keys: std::collections::BTreeSet<&str> = query["payload"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(query_keys, ["path", "skill_id"].into_iter().collect());
}

#[test]
fn markdown_draft_summary_and_validation_results_have_stable_wire_shapes() {
    // K4：草稿摘要形状由契约固定——工作台一次拉取的恢复事实。
    let summary = skillhub_core::MarkdownDraftSummary {
        base_content_identity: "object-1".into(),
        base_version_id: Some("sha256:".to_owned() + &"a".repeat(64)),
        markdown: "# Draft".into(),
        updated_at: "2026-10-04T00:00:00Z".into(),
    };
    let value = serde_json::to_value(&summary).unwrap();
    let keys: std::collections::BTreeSet<&str> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "base_content_identity",
            "base_version_id",
            "markdown",
            "updated_at",
        ]
        .into_iter()
        .collect()
    );

    let draft_query =
        serde_json::to_value(skillhub_core::AppQueryResult::MarkdownDraft(Some(summary))).unwrap();
    assert_eq!(draft_query["type"], "markdown_draft");
    assert_eq!(draft_query["payload"]["markdown"], "# Draft");

    let validation = skillhub_core::MarkdownValidationResult {
        valid: false,
        issues: vec![skillhub_core::MarkdownValidationIssue {
            code: "markdown_too_large".into(),
            field: "markdown".into(),
            params: [("size_limit".to_owned(), "1048576".to_owned())]
                .into_iter()
                .collect(),
        }],
    };
    let value = serde_json::to_value(&validation).unwrap();
    let keys: std::collections::BTreeSet<&str> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(keys, ["issues", "valid"].into_iter().collect());
    let issue_keys: std::collections::BTreeSet<&str> = value["issues"][0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        issue_keys,
        ["code", "field", "params"].into_iter().collect()
    );

    let tagged = serde_json::to_value(skillhub_core::AppCommandResult::MarkdownValidationResult(
        validation,
    ))
    .unwrap();
    assert_eq!(tagged["type"], "markdown_validation_result");

    let saved = serde_json::to_value(skillhub_core::AppCommandResult::MarkdownDraftSaved(
        skillhub_core::MarkdownDraftSaved {
            skill_id: skillhub_core::SkillId::new(),
            path: "SKILL.md".into(),
            updated_at: "2026-10-04T00:00:00Z".into(),
        },
    ))
    .unwrap();
    assert_eq!(saved["type"], "markdown_draft_saved");
    let saved_keys: std::collections::BTreeSet<&str> = saved["payload"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        saved_keys,
        ["path", "skill_id", "updated_at"].into_iter().collect()
    );

    let discarded = serde_json::to_value(skillhub_core::AppCommandResult::MarkdownDraftDiscarded(
        skillhub_core::MarkdownDraftDiscarded {
            skill_id: skillhub_core::SkillId::new(),
            path: "SKILL.md".into(),
        },
    ))
    .unwrap();
    assert_eq!(discarded["type"], "markdown_draft_discarded");
}
