//! Application facade for normalized relationship facts and safe relationship
//! conversion.  This module owns orchestration only; relationship
//! classification and removal-impact rules remain in `skillhub-core`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;
use skillhub_adapters::deployment::DeploymentFilesystem;
use skillhub_core::api::{
    AppCommandResult, AppQueryResult, PrepareRelationMigration, RelationMigrationTargetMode,
    RelationshipMigrationBackupPolicy, RelationshipOverviewScope,
};
use skillhub_core::deployment::{DeploymentMode, TargetChange, TargetPlan};
use skillhub_core::relationship::{
    calculate_removal_impact, ConflictCaseFact, DeploymentRelationFact, DirectoryNodeFact,
    FileRepresentation, GovernanceTaskFact, GovernanceTaskKind, OwnershipState, RelationshipType,
    RemovalFacts, SourceRelationFact,
};
use skillhub_core::{
    AppError, AppResult, ErrorCode, InverseOperation, OperationId, OperationObjectResult,
    OperationPhase, RecoveryAction, RelationMigrationResult, RelationMigrationState, Severity,
};

use crate::LocalApplicationFacade;

#[derive(Clone, Debug)]
struct RelationMigrationJournal {
    prepared: skillhub_core::PreparedRelationMigration,
    expected_target_fingerprint: String,
    expected_link_representation: FileRepresentation,
    source_relations: Vec<SourceRelationFact>,
    safety: RelationSafetySnapshot,
    stage: RelationMigrationStage,
    backup: RelationBackupMetadata,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct RelationSafetySnapshot {
    relation_parent: PathChainSnapshot,
    central_target: PathChainSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct PathChainSnapshot {
    nodes: Vec<PathNodeSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct PathNodeSnapshot {
    path: String,
    physical_id: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum RelationMigrationStage {
    #[default]
    Prepared,
    FilesystemApplying,
    FilesystemRestoredRelationPersistencePending,
    FilesystemRestoredRelationPersisted,
}

#[derive(Clone, Debug)]
struct RelationBackupMetadata {
    operation_id: OperationId,
    path: String,
    original_path: String,
    original_fingerprint: String,
    original_relationship: RelationshipType,
    original_representation: FileRepresentation,
    original_ownership: OwnershipState,
    original_active: bool,
    original_link_target: Option<String>,
    original_entity_identity: String,
}

impl RelationMigrationJournal {
    fn from_prepared(
        prepared: skillhub_core::PreparedRelationMigration,
        expected_target_fingerprint: String,
        source_relations: Vec<SourceRelationFact>,
        safety: RelationSafetySnapshot,
        original_entity_identity: String,
    ) -> Self {
        let relation = &prepared.relation;
        Self {
            expected_target_fingerprint,
            expected_link_representation: representation_for_mode(prepared.target_mode),
            source_relations,
            safety,
            stage: RelationMigrationStage::Prepared,
            backup: RelationBackupMetadata {
                operation_id: prepared.operation_id,
                path: prepared.backup_path.clone(),
                original_path: relation.path.clone(),
                original_fingerprint: relation.content_fingerprint.clone(),
                original_relationship: relation.relationship,
                original_representation: relation.file_representation,
                original_ownership: relation.ownership,
                original_active: relation.active,
                original_link_target: relation.link_target_path.clone(),
                original_entity_identity,
            },
            prepared,
        }
    }

    fn from_persisted(
        prepared: skillhub_core::PreparedRelationMigration,
        expected_target_fingerprint: String,
        expected_link_representation: FileRepresentation,
        source_relations: Vec<SourceRelationFact>,
        safety: RelationSafetySnapshot,
        stage: RelationMigrationStage,
        backup: RelationBackupMetadata,
    ) -> Self {
        Self {
            prepared,
            expected_target_fingerprint,
            expected_link_representation,
            source_relations,
            safety,
            stage,
            backup,
        }
    }
}

impl RelationBackupMetadata {
    fn from_json(value: serde_json::Value) -> AppResult<Self> {
        let object = value
            .as_object()
            .ok_or_else(|| invalid_relation_migration("relationship backup metadata is corrupt"))?;
        let string = |name: &str| {
            object
                .get(name)
                .and_then(|value| value.as_str())
                .map(str::to_owned)
                .ok_or_else(|| {
                    invalid_relation_migration("relationship backup metadata is corrupt")
                })
        };
        let operation_id = string("operation_id")?.parse().map_err(|_| {
            invalid_relation_migration("relationship backup operation id is corrupt")
        })?;
        let value = |name: &str| {
            object.get(name).cloned().ok_or_else(|| {
                invalid_relation_migration("relationship backup metadata is corrupt")
            })
        };
        let original_active = object
            .get("original_active")
            .and_then(|value| value.as_bool())
            .ok_or_else(|| invalid_relation_migration("relationship backup metadata is corrupt"))?;
        let original_link_target = match object.get("original_link_target") {
            Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(value)) => Some(value.to_owned()),
            _ => {
                return Err(invalid_relation_migration(
                    "relationship backup metadata is corrupt",
                ))
            }
        };
        let original_entity_identity = string("original_entity_identity")?;
        Ok(Self {
            operation_id,
            path: string("path")?,
            original_path: string("original_path")?,
            original_fingerprint: string("original_fingerprint")?,
            original_relationship: serde_json::from_value(value("original_relationship")?)
                .map_err(|_| {
                    invalid_relation_migration("relationship backup metadata is corrupt")
                })?,
            original_representation: serde_json::from_value(value("original_representation")?)
                .map_err(|_| {
                    invalid_relation_migration("relationship backup metadata is corrupt")
                })?,
            original_ownership: serde_json::from_value(value("original_ownership")?).map_err(
                |_| invalid_relation_migration("relationship backup metadata is corrupt"),
            )?,
            original_active,
            original_link_target,
            original_entity_identity,
        })
    }

    fn to_json(&self) -> serde_json::Value {
        json!({
            "operation_id": self.operation_id,
            "path": self.path,
            "original_path": self.original_path,
            "original_fingerprint": self.original_fingerprint,
            "original_relationship": self.original_relationship,
            "original_representation": self.original_representation,
            "original_ownership": self.original_ownership,
            "original_active": self.original_active,
            "original_link_target": self.original_link_target,
            "original_entity_identity": self.original_entity_identity,
        })
    }
}

impl LocalApplicationFacade {
    pub(crate) fn get_relationship_overview(
        &self,
        scope: RelationshipOverviewScope,
    ) -> AppResult<AppQueryResult> {
        let overview = self.with_database("query.relationship_overview", |database| {
            let snapshot = relationship_snapshot_for_scope(database, &scope)?;
            let all_cases = database.conflict_repository().list_cases()?;
            let all_tasks = database.governance_task_repository().list_pending()?;
            let subject = scope_subject(&scope);
            let conflict_cases = all_cases
                .into_iter()
                .filter(|case| {
                    subject
                        .as_deref()
                        .is_none_or(|id| conflict_matches(case, id))
                })
                .collect();
            let pending_governance_tasks = all_tasks
                .into_iter()
                .filter(|task| governance_task_matches(task, subject.as_deref(), &snapshot))
                .collect();
            Ok(skillhub_core::api::RelationshipOverview {
                scope,
                directory_nodes: snapshot.directory_nodes,
                agent_directory_capabilities: snapshot.directory_capabilities,
                source_relations: snapshot.source_relations,
                deployment_relations: snapshot.deployments,
                conflict_cases,
                pending_governance_tasks,
                // A discovered/recognized directory is not runtime execution
                // evidence.  Do not fabricate this conclusion at the facade.
                agent_execution_confirmed: false,
            })
        })?;
        Ok(AppQueryResult::RelationshipOverview(overview))
    }

    pub(crate) fn get_relationship_removal_impact(
        &self,
        relation_id: &str,
    ) -> AppResult<AppQueryResult> {
        let impact = self.with_database("query.relationship_removal_impact", |database| {
            let snapshot = database
                .relationship_repository()
                .list_relation_impact(relation_id)?;
            let relation_path = snapshot
                .deployments
                .iter()
                .find(|relation| relation.relation_id == relation_id)
                .map(|relation| relation.path.as_str());
            let permission_limited = relation_path.is_none_or(relation_path_is_inaccessible);
            let mut impact = calculate_removal_impact(
                relation_id,
                &RemovalFacts::new(
                    snapshot.deployments.clone(),
                    snapshot.directory_capabilities.clone(),
                )
                .with_permission_limited(permission_limited),
            );
            if !impact.other_consumers.is_empty() {
                push_task(
                    &mut impact.governance_tasks,
                    governance_task(
                        relation_id,
                        GovernanceTaskKind::ConfirmSharedDirectoryImpact,
                        "shared relationship impact requires explicit confirmation".into(),
                    ),
                );
                impact.minimal_action =
                    skillhub_core::relationship::MinimalImpactAction::CreateGovernanceTask;
            }
            for task in database.governance_task_repository().list_pending()? {
                if task.subject_id == relation_id
                    && !impact
                        .governance_tasks
                        .iter()
                        .any(|existing| existing.task_id == task.task_id)
                {
                    impact.governance_tasks.push(task);
                }
            }
            Ok(impact)
        })?;
        Ok(AppQueryResult::RelationshipRemovalImpact(impact))
    }

    pub(crate) fn prepare_relation_migration(
        &self,
        request: PrepareRelationMigration,
    ) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        let prepared = self.with_database("execute.prepare_relation_migration", |database| {
            if request.target_mode != RelationMigrationTargetMode::ManagedLink
                || request.backup_policy != RelationshipMigrationBackupPolicy::Required
            {
                return Err(invalid_relation_migration(
                    "only required-backup managed-link conversion is supported",
                ));
            }
            let snapshot = database
                .relationship_repository()
                .list_relation_impact(&request.relation_id)?;
            let relation = snapshot
                .deployments
                .iter()
                .find(|relation| relation.relation_id == request.relation_id)
                .cloned()
                .ok_or_else(|| relation_not_found(&request.relation_id))?;
            validate_relation_for_prepare(&relation)?;
            if relation.file_representation == FileRepresentation::DirectoryJunction {
                let error = unsupported_junction_migration();
                database
                    .governance_task_repository()
                    .create(&governance_task(
                        &request.relation_id,
                        GovernanceTaskKind::OperationFailureRecovery,
                        "directory junction migration is unsupported because its target cannot be verified safely".into(),
                    ))?;
                return Err(error);
            }
            let current_fingerprint = DeploymentFilesystem::hash_tree(&relation.path)?;
            if current_fingerprint != relation.content_fingerprint {
                return Err(target_changed(&relation.path));
            }
            validate_relation_entity(
                &relation.path,
                relation.file_representation,
                relation.link_target_path.as_deref(),
                &current_fingerprint,
            )?;
            let target_path = self.central_path_for_relation(&relation)?;
            let library_root = self.library_root()?;
            if let Err(error) = authorize_paths(
                &relation.path,
                &target_path,
                &snapshot.directory_nodes,
                &library_root,
            ) {
                if error.code == ErrorCode::PathOutsideAllowedRoots {
                    database
                        .governance_task_repository()
                        .create(&governance_task(
                            &request.relation_id,
                            GovernanceTaskKind::UnknownDirectoryRecognition,
                            "relationship or central target is outside a registered directory root"
                                .into(),
                        ))?;
                }
                return Err(error);
            }
            validate_non_symlink_directory(&target_path)?;
            let target_fingerprint = DeploymentFilesystem::hash_tree(&target_path)?;
            if target_fingerprint != current_fingerprint {
                return Err(AppError::new(ErrorCode::TargetChanged, Severity::Error)
                    .with_param("path", target_path.to_string_lossy().into_owned())
                    .with_param("detail", "central target fingerprint differs")
                    .with_action(RecoveryAction::InspectTarget));
            }

            let permission_limited = relation_path_is_inaccessible(&relation.path);
            let impact = calculate_removal_impact(
                &request.relation_id,
                &RemovalFacts::new(
                    snapshot.deployments.clone(),
                    snapshot.directory_capabilities,
                )
                .with_permission_limited(permission_limited),
            );
            // The technical link form is decided by platform capability at
            // the exact volume that must host the replacement entry.  A
            // conversion whose link cannot be created there fails up front
            // and keeps the original entry; it never degrades to a copy.
            let relation_parent = Path::new(&relation.path)
                .parent()
                .ok_or_else(|| ownership_mismatch(&relation.path))?;
            let conversion_plan =
                skillhub_core::deployment::plan_relation_conversion(
                    &skillhub_core::deployment::RelationConversionFacts {
                        relationship: relation.relationship,
                        link_capabilities: DeploymentFilesystem::new()
                            .probe_link_capabilities(relation_parent, &target_path),
                        link_target_same_volume: skillhub_core::paths_share_volume(
                            relation_parent,
                            &target_path,
                        ),
                        other_shared_consumers: impact.other_consumers.len(),
                    },
                );
            let conversion_plan = match conversion_plan {
                Ok(plan) => plan,
                Err(error) => {
                    database
                        .governance_task_repository()
                        .create(&governance_task(
                            &request.relation_id,
                            conversion_todo_kind(relation.relationship),
                            format!(
                                "relationship conversion is unavailable: {}",
                                error.code.as_str()
                            ),
                        ))?;
                    return Err(error);
                }
            };
            let mut governance_tasks = impact.governance_tasks;
            let shared_impact = conversion_plan.requires_shared_impact_confirmation
                || !impact.other_consumers.is_empty();
            if shared_impact
                && request
                    .confirmation_token
                    .as_deref()
                    .is_none_or(|token| token.trim().is_empty())
            {
                push_task(
                    &mut governance_tasks,
                    governance_task(
                        &request.relation_id,
                        GovernanceTaskKind::ConfirmSharedDirectoryImpact,
                        "shared relationship impact requires explicit confirmation".into(),
                    ),
                );
            }
            let safety = capture_relation_safety_snapshot(
                &relation.path,
                &target_path,
                &snapshot.directory_nodes,
                &library_root,
            )?;
            let original_entity_identity = relation_entity_identity(
                &relation.path,
                relation.file_representation,
            )?;
            let backup_path = library_root
                .join(".skillhub")
                .join("relationship-migrations")
                .join(operation_id.to_string())
                .join("previous");
            let relation_path = relation.path.clone();
            Ok((
                skillhub_core::PreparedRelationMigration {
                operation_id,
                relation_id: request.relation_id.clone(),
                relation,
                current_content_fingerprint: current_fingerprint,
                target_path: target_path.to_string_lossy().into_owned(),
                target_mode: conversion_plan.mode,
                backup_path: backup_path.to_string_lossy().into_owned(),
                affected_paths: vec![relation_path, target_path.to_string_lossy().into_owned()],
                rollback_available: true,
                governance_tasks,
                },
                snapshot.source_relations,
                safety,
                original_entity_identity,
            ))
        });

        match prepared {
            Ok((prepared, source_relations, safety, original_entity_identity)) => {
                self.prepared_relation_migrations
                    .lock()
                    .map_err(|_| internal("execute.prepare_relation_migration"))?
                    .insert(prepared.operation_id, prepared.clone());
                let journal = RelationMigrationJournal::from_prepared(
                    prepared.clone(),
                    DeploymentFilesystem::hash_tree(&prepared.target_path)?,
                    source_relations,
                    safety,
                    original_entity_identity,
                );
                self.persist_relation_operation(
                    prepared.operation_id,
                    OperationPhase::Prepared,
                    RelationMigrationState::Prepared,
                    &journal,
                    None,
                    None,
                )?;
                Ok(AppCommandResult::PreparedRelationMigration(prepared))
            }
            Err(error) => {
                self.journal_advance(
                    operation_id,
                    "migrate_relation",
                    OperationPhase::RolledBack,
                    Some(error.code),
                );
                Err(error)
            }
        }
    }

    pub(crate) async fn commit_relation_migration(
        &self,
        request: skillhub_core::api::CommitRelationMigration,
    ) -> AppResult<AppCommandResult> {
        let _relation_migration_guard =
            self.lock_relation_migration("execute.commit_relation_migration")?;
        let (journal, existing_result, _) =
            self.load_relation_migration_journal(request.prepared_relation_migration_id)?;
        let prepared = journal.prepared.clone();
        if let Some(existing) = existing_result.as_ref() {
            if matches!(
                existing.state,
                RelationMigrationState::Committed
                    | RelationMigrationState::RolledBack
                    | RelationMigrationState::Cancelled
            ) {
                return Ok(AppCommandResult::RelationMigrationResult(existing.clone()));
            }
        }

        let relation = match self.current_relation(&prepared.relation_id) {
            Ok(relation) => relation,
            Err(error) => return self.failed_relation_result(&journal, error),
        };
        if !relation.active || relation.path != prepared.relation.path {
            return self.failed_relation_result(&journal, target_changed(&relation.path));
        }
        if !relation_facts_match(&relation, &prepared.relation) {
            return self.failed_relation_result(&journal, target_changed(&relation.path));
        }
        let current_fingerprint = match DeploymentFilesystem::hash_tree(&relation.path) {
            Ok(value) => value,
            Err(error) => return self.failed_relation_result(&journal, error),
        };
        if current_fingerprint != prepared.current_content_fingerprint
            || relation.content_fingerprint != prepared.relation.content_fingerprint
        {
            return self.failed_relation_result(&journal, target_changed(&relation.path));
        }
        if let Err(error) =
            validate_relation_entity_binding(&journal, &relation, &current_fingerprint)
        {
            return self.failed_relation_result(&journal, error);
        }
        let target_path = match self.central_path_for_relation(&relation) {
            Ok(value) => value,
            Err(error) => return self.failed_relation_result(&journal, error),
        };
        if target_path.to_string_lossy() != prepared.target_path {
            return self.failed_relation_result(&journal, target_changed(&prepared.target_path));
        }
        if let Err(error) = validate_non_symlink_directory(&target_path) {
            return self.failed_relation_result(&journal, error);
        }
        let target_fingerprint = match DeploymentFilesystem::hash_tree(&target_path) {
            Ok(value) => value,
            Err(error) => return self.failed_relation_result(&journal, error),
        };
        if target_fingerprint != current_fingerprint
            || target_fingerprint != journal.expected_target_fingerprint
        {
            return self.failed_relation_result(&journal, target_changed(&prepared.target_path));
        }
        let library_root = match self.library_root() {
            Ok(root) => root,
            Err(error) => return self.failed_relation_result(&journal, error),
        };
        let snapshot = self.with_database("relationship.commit_snapshot", |database| {
            database
                .relationship_repository()
                .list_relation_impact(&prepared.relation_id)
        })?;
        if snapshot.source_relations != journal.source_relations {
            return self.failed_relation_result(&journal, target_changed(&prepared.relation.path));
        }
        if let Err(error) =
            validate_relation_safety_snapshot(&journal, &relation, &target_path, &library_root)
        {
            return self.failed_relation_result(&journal, error);
        }
        if !prepared.governance_tasks.is_empty() {
            let error =
                invalid_relation_migration("relationship governance confirmation is pending");
            return self.failed_relation_result(&journal, error);
        }

        // Re-probe at the relation volume: capability facts are only valid
        // where the replacement entry will be created.
        let relation_parent = Path::new(&relation.path)
            .parent()
            .ok_or_else(|| ownership_mismatch(&relation.path))?
            .to_path_buf();
        let capabilities =
            DeploymentFilesystem::new().probe_link_capabilities(&relation_parent, &target_path);
        let mode = prepared.target_mode;
        if !mode.is_supported_by(&capabilities) {
            let code = match mode {
                DeploymentMode::SymbolicLink => ErrorCode::SymlinkNotSupported,
                DeploymentMode::DirectoryJunction => ErrorCode::JunctionNotSupported,
                DeploymentMode::ManagedCopy => ErrorCode::OperationConflict,
            };
            let error =
                AppError::new(code, Severity::Warning).with_action(RecoveryAction::OpenReadOnly);
            return self.failed_relation_result(&journal, error);
        }
        if let Err(error) = authorize_paths(
            &relation.path,
            &target_path,
            &snapshot.directory_nodes,
            &library_root,
        ) {
            return self.failed_relation_result(&journal, error);
        }

        let version_id = match self.current_version_for_relation(&relation) {
            Ok(version_id) => version_id,
            Err(error) => return self.failed_relation_result(&journal, error),
        };
        let mut applying = journal.clone();
        applying.stage = RelationMigrationStage::FilesystemApplying;
        self.persist_relation_operation(
            applying.prepared.operation_id,
            OperationPhase::Applying,
            RelationMigrationState::Prepared,
            &applying,
            None,
            None,
        )?;
        if let Err(error) = self
            .validate_source_relations_snapshot(&prepared.relation_id, &applying.source_relations)
        {
            return self.failed_relation_result(&applying, error);
        }

        let backup_path = PathBuf::from(&prepared.backup_path);
        if let Err(error) = validate_backup_path(&applying, &library_root) {
            return self.failed_relation_result(&applying, error);
        }
        if let Err(error) = validate_relation_entity_binding(
            &applying,
            &relation,
            &current_fingerprint,
        )
        .and_then(|_| {
            validate_relation_safety_snapshot(&applying, &relation, &target_path, &library_root)
        }) {
            return self.failed_relation_result(&applying, error);
        }
        if let Err(error) = backup_relation_entry(&relation, &backup_path) {
            return self.failed_relation_result(&applying, error);
        }
        if let Err(error) = validate_backup_fingerprint(&applying, &library_root) {
            return self.failed_relation_result(&applying, error);
        }
        if let Err(error) = validate_relation_entity_binding(
            &applying,
            &relation,
            &current_fingerprint,
        )
        .and_then(|_| {
            validate_relation_safety_snapshot(&applying, &relation, &target_path, &library_root)
        }) {
            return self.failed_relation_result(&applying, error);
        }
        if let Err(error) = self
            .validate_source_relations_snapshot(&prepared.relation_id, &applying.source_relations)
        {
            return self.failed_relation_result(&applying, error);
        }
        if let Err(error) = remove_relation_entry(Path::new(&relation.path)) {
            return self.failed_relation_result(&applying, error);
        }

        if let Err(error) = validate_relation_parent_and_target_snapshot(
            &applying,
            Path::new(&relation.path),
            &target_path,
        ) {
            return self.failed_relation_result(&applying, error);
        }
        let applied = DeploymentFilesystem::new()
            .prepare(&TargetPlan {
                physical_target_id: relation.agent_client_id.clone(),
                logical_target_ids: Vec::new(),
                target_path: Path::new(&relation.path)
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .to_string_lossy()
                    .into_owned(),
                destination_path: relation.path.clone(),
                source_path: target_path.to_string_lossy().into_owned(),
                runtime_name: Path::new(&relation.path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_owned(),
                skill_id: relation
                    .skill_id
                    .unwrap_or_else(skillhub_core::SkillId::new),
                version_id,
                mode,
                change: TargetChange::Create,
                warnings: Vec::new(),
                conflicts: Vec::new(),
            })
            .and_then(|prepared_target| {
                let applied = DeploymentFilesystem::new().apply(prepared_target)?;
                DeploymentFilesystem::new().verify(&applied)?;
                Ok(applied)
            });
        let applied = match applied {
            Ok(applied) => applied,
            Err(error) => {
                let error = self
                    .library_root()
                    .and_then(|library_root| recover_relation_entry(&applying, &library_root))
                    .err()
                    .unwrap_or(error);
                return self.failed_relation_result(&applying, error);
            }
        };
        if applied.ownership.mode != prepared.target_mode {
            let error =
                invalid_relation_migration("actual link representation differs from prepared mode");
            let error = self
                .library_root()
                .and_then(|library_root| recover_relation_entry(&applying, &library_root))
                .err()
                .unwrap_or(error);
            return self.failed_relation_result(&applying, error);
        }
        let verifying = applying.clone();
        if let Err(error) = self.persist_relation_operation(
            verifying.prepared.operation_id,
            OperationPhase::Verifying,
            RelationMigrationState::Prepared,
            &verifying,
            None,
            None,
        ) {
            return self.handle_post_filesystem_failure(&journal, error, false);
        }

        let mut normalized = relation.clone();
        normalized.relationship = RelationshipType::ManagedLink;
        normalized.file_representation = match mode {
            DeploymentMode::SymbolicLink => {
                skillhub_core::relationship::FileRepresentation::SymbolicLink
            }
            DeploymentMode::DirectoryJunction => {
                skillhub_core::relationship::FileRepresentation::DirectoryJunction
            }
            DeploymentMode::ManagedCopy => skillhub_core::relationship::FileRepresentation::Unknown,
        };
        normalized.ownership = skillhub_core::relationship::OwnershipState::SkillhubManaged;
        normalized.link_target_path = Some(target_path.to_string_lossy().into_owned());
        normalized.link_target_path_key = None;
        normalized.link_target_directory_id = None;
        normalized.content_fingerprint = applied.observed_tree_hash;
        normalized.active = true;
        let persisted =
            self.with_database("execute.commit_relation_migration.record", |database| {
                database
                    .relationship_repository()
                    .upsert_deployment_relation(&normalized)
            });
        if let Err(error) = persisted {
            return self.handle_post_filesystem_failure(&journal, error, true);
        }

        let result = RelationMigrationResult {
            operation_id: prepared.operation_id,
            relation_id: prepared.relation_id.clone(),
            state: RelationMigrationState::Committed,
            relation_type: normalized.relationship,
            ownership: normalized.ownership,
            old_path: relation.path.clone(),
            target_path: prepared.target_path.clone(),
            backup_path: Some(prepared.backup_path.clone()),
            affected_paths: prepared.affected_paths.clone(),
            rollback_available: true,
            governance_tasks: Vec::new(),
            error_code: None,
            detail: None,
        };
        if let Err(error) = self.persist_relation_operation(
            result.operation_id,
            OperationPhase::Committed,
            RelationMigrationState::Committed,
            &journal,
            Some(&result),
            None,
        ) {
            return self.handle_post_filesystem_failure(&journal, error, true);
        }
        self.relation_migration_results
            .lock()
            .map_err(|_| internal("execute.commit_relation_migration"))?
            .insert(result.operation_id, result.clone());
        Ok(AppCommandResult::RelationMigrationResult(result))
    }

    pub(crate) async fn rollback_relation_migration(
        &self,
        request: skillhub_core::api::RollbackRelationMigration,
    ) -> AppResult<AppCommandResult> {
        let _relation_migration_guard =
            self.lock_relation_migration("execute.rollback_relation_migration")?;
        let (journal, existing_result, journal_phase) =
            self.load_relation_migration_journal(request.operation_id)?;
        let prepared = journal.prepared.clone();
        if let Some(existing) = existing_result.as_ref() {
            if existing.state == RelationMigrationState::RolledBack
                || existing.state == RelationMigrationState::Cancelled
            {
                return Ok(AppCommandResult::RelationMigrationResult(existing.clone()));
            }
        }

        let committed = existing_result.as_ref().is_some_and(|result| {
            matches!(
                result.state,
                RelationMigrationState::Committed | RelationMigrationState::Failed
            )
        }) || matches!(
            journal_phase,
            OperationPhase::Applying | OperationPhase::Verifying | OperationPhase::NeedsRecovery
        );
        if !committed {
            let result = migration_result_from_prepared(
                &prepared,
                RelationMigrationState::Cancelled,
                None,
                None,
                prepared.governance_tasks.clone(),
            );
            self.persist_relation_operation(
                result.operation_id,
                OperationPhase::RolledBack,
                RelationMigrationState::Cancelled,
                &journal,
                Some(&result),
                None,
            )?;
            self.relation_migration_results
                .lock()
                .map_err(|_| internal("execute.rollback_relation_migration"))?
                .insert(result.operation_id, result.clone());
            return Ok(AppCommandResult::RelationMigrationResult(result));
        }

        let current = match self.current_relation(&prepared.relation_id) {
            Ok(current) => current,
            Err(error) => return self.failed_relation_result(&journal, error),
        };
        let library_root = match self.library_root() {
            Ok(root) => root,
            Err(error) => return self.failed_relation_result(&journal, error),
        };
        if let Err(error) = validate_backup_fingerprint(&journal, &library_root) {
            return self.failed_relation_result(&journal, error);
        }
        let filesystem_restored = filesystem_is_restored(&journal);
        let retry_restored = matches!(
            journal.stage,
            RelationMigrationStage::FilesystemRestoredRelationPersistencePending
                | RelationMigrationStage::FilesystemRestoredRelationPersisted
        ) && filesystem_restored;
        let already_restored = relation_is_restored(&current, &journal);
        if retry_restored {
            if let Err(error) = validate_relation_parent_and_target_snapshot(
                &journal,
                Path::new(&prepared.relation.path),
                Path::new(&prepared.target_path),
            ) {
                return self.failed_relation_result(&journal, error);
            }
        } else if !already_restored {
            if let Err(error) = validate_relation_parent_and_target_snapshot(
                &journal,
                Path::new(&current.path),
                Path::new(&prepared.target_path),
            ) {
                return self.failed_relation_result(&journal, error);
            }
            if let Err(error) = validate_relation_for_rollback(&current, &journal) {
                return self.failed_relation_result(&journal, error);
            }
        }
        let mut applying = journal.clone();
        applying.stage = if retry_restored || already_restored {
            RelationMigrationStage::FilesystemRestoredRelationPersistencePending
        } else {
            RelationMigrationStage::FilesystemApplying
        };
        self.persist_relation_operation(
            prepared.operation_id,
            OperationPhase::Applying,
            RelationMigrationState::Committed,
            &applying,
            None,
            None,
        )?;
        if !retry_restored && !already_restored {
            if let Err(error) = recover_relation_entry(&applying, &library_root) {
                return self.failed_relation_result(&applying, error);
            }
            applying.stage = RelationMigrationStage::FilesystemRestoredRelationPersistencePending;
            self.persist_relation_operation(
                prepared.operation_id,
                OperationPhase::Applying,
                RelationMigrationState::Committed,
                &applying,
                None,
                None,
            )?;
        }
        if let Err(error) = validate_relation_parent_and_target_snapshot(
            &applying,
            Path::new(&prepared.relation.path),
            Path::new(&prepared.target_path),
        ) {
            return self.failed_relation_result(&applying, error);
        }
        if let Err(error) =
            self.with_database("execute.rollback_relation_migration.record", |database| {
                database
                    .relationship_repository()
                    .restore_deployment_relation(&prepared.relation)
            })
        {
            return self.failed_relation_result(&applying, error);
        }
        applying.stage = RelationMigrationStage::FilesystemRestoredRelationPersisted;
        if let Err(error) = self.persist_relation_operation(
            prepared.operation_id,
            OperationPhase::Verifying,
            RelationMigrationState::Committed,
            &applying,
            None,
            None,
        ) {
            return Err(journal_failure_audit_error(&prepared.operation_id, &error));
        }
        let result = migration_result_from_prepared(
            &prepared,
            RelationMigrationState::RolledBack,
            Some(prepared.backup_path.clone()),
            None,
            Vec::new(),
        );
        if let Err(error) = self.persist_relation_operation(
            result.operation_id,
            OperationPhase::RolledBack,
            RelationMigrationState::RolledBack,
            &applying,
            Some(&result),
            None,
        ) {
            return Err(journal_failure_audit_error(&prepared.operation_id, &error));
        }
        self.relation_migration_results
            .lock()
            .map_err(|_| internal("execute.rollback_relation_migration"))?
            .insert(result.operation_id, result.clone());
        Ok(AppCommandResult::RelationMigrationResult(result))
    }

    fn failed_relation_result(
        &self,
        journal: &RelationMigrationJournal,
        error: AppError,
    ) -> AppResult<AppCommandResult> {
        let prepared = &journal.prepared;
        let task = governance_task(
            &prepared.relation_id,
            GovernanceTaskKind::OperationFailureRecovery,
            format!(
                "relationship migration requires recovery: {}",
                error.code.as_str()
            ),
        );
        let mut tasks = prepared.governance_tasks.clone();
        push_task(&mut tasks, task.clone());
        self.with_database("execute.relation_migration.recovery_task", |database| {
            database.governance_task_repository().create(&task)
        })?;
        let mut result = migration_result_from_prepared(
            prepared,
            RelationMigrationState::Failed,
            Path::new(&prepared.backup_path)
                .exists()
                .then_some(prepared.backup_path.clone()),
            Some(error.code),
            tasks,
        );
        let detail = error
            .params
            .get("recovery_error")
            .and_then(|value| value.as_str())
            .map(|recovery_error| {
                let journal_error = error
                    .params
                    .get("journal_error")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");
                format!("recovery_required:{recovery_error};journal_error:{journal_error}")
            })
            .unwrap_or_else(|| format!("recovery_required:{}", error.code.as_str()));
        result.detail = Some(detail);
        self.persist_relation_operation(
            result.operation_id,
            OperationPhase::NeedsRecovery,
            RelationMigrationState::Failed,
            journal,
            Some(&result),
            Some(error.code),
        )?;
        self.relation_migration_results
            .lock()
            .map_err(|_| internal("execute.relation_migration.failure"))?
            .insert(result.operation_id, result.clone());
        Ok(AppCommandResult::RelationMigrationResult(result))
    }

    fn handle_post_filesystem_failure(
        &self,
        journal: &RelationMigrationJournal,
        journal_error: AppError,
        restore_relation_record: bool,
    ) -> AppResult<AppCommandResult> {
        let mut restored = journal.clone();
        restored.stage = RelationMigrationStage::FilesystemRestoredRelationPersistencePending;
        let filesystem_recovery = self
            .library_root()
            .and_then(|library_root| recover_relation_entry(&restored, &library_root));
        if let Err(recovery_error) = filesystem_recovery {
            let combined = recovery_failure_error(&journal_error, &recovery_error);
            return match self.failed_relation_result(journal, combined.clone()) {
                Ok(result) => Ok(result),
                Err(persist_error) => {
                    Err(combined.with_param("failure_record_error", persist_error.code.as_str()))
                }
            };
        }

        if let Err(checkpoint_error) = self.persist_relation_operation(
            restored.prepared.operation_id,
            OperationPhase::NeedsRecovery,
            RelationMigrationState::Failed,
            &restored,
            None,
            Some(journal_error.code),
        ) {
            return Err(journal_failure_audit_error(
                &journal.prepared.operation_id,
                &checkpoint_error,
            ));
        }

        if restore_relation_record {
            if let Err(writeback_error) =
                self.with_database("execute.relation_migration.recover_record", |database| {
                    database
                        .relationship_repository()
                        .restore_deployment_relation(&restored.prepared.relation)
                })
            {
                let combined = recovery_failure_error(&journal_error, &writeback_error);
                return match self.failed_relation_result(&restored, combined.clone()) {
                    Ok(result) => Ok(result),
                    Err(persist_error) => {
                        Err(combined
                            .with_param("failure_record_error", persist_error.code.as_str()))
                    }
                };
            }
            restored.stage = RelationMigrationStage::FilesystemRestoredRelationPersisted;
            if let Err(checkpoint_error) = self.persist_relation_operation(
                restored.prepared.operation_id,
                OperationPhase::NeedsRecovery,
                RelationMigrationState::Failed,
                &restored,
                None,
                Some(journal_error.code),
            ) {
                return Err(journal_failure_audit_error(
                    &journal.prepared.operation_id,
                    &checkpoint_error,
                ));
            }
        }
        Err(journal_failure_audit_error(
            &journal.prepared.operation_id,
            &journal_error,
        ))
    }

    fn current_relation(&self, relation_id: &str) -> AppResult<DeploymentRelationFact> {
        self.with_database("relationship.current_relation", |database| {
            database
                .relationship_repository()
                .list_relations()?
                .into_iter()
                .find(|relation| relation.relation_id == relation_id)
                .ok_or_else(|| relation_not_found(relation_id))
        })
    }

    fn validate_source_relations_snapshot(
        &self,
        relation_id: &str,
        expected: &[SourceRelationFact],
    ) -> AppResult<()> {
        let current = self.with_database("relationship.commit_source_snapshot", |database| {
            database
                .relationship_repository()
                .list_relation_impact(relation_id)
        })?;
        if current.source_relations != expected {
            return Err(target_changed(relation_id));
        }
        Ok(())
    }

    fn load_relation_migration_journal(
        &self,
        operation_id: OperationId,
    ) -> AppResult<(
        RelationMigrationJournal,
        Option<RelationMigrationResult>,
        OperationPhase,
    )> {
        let record = {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("operation_journal.relationship_migration.load"))?;
            database.operation_repository().get_sync(operation_id)?
        };
        if let Some(record) = record {
            if record.kind != "migrate_relation" {
                return Err(relation_operation_not_found(operation_id));
            }
            let journal_value = record
                .recovery_data
                .get("journal")
                .cloned()
                .ok_or_else(|| {
                    invalid_relation_migration("relationship journal facts are missing")
                })?;
            let prepared_value = journal_value.get("prepared").cloned().ok_or_else(|| {
                invalid_relation_migration("relationship journal prepared facts are missing")
            })?;
            let prepared: skillhub_core::PreparedRelationMigration =
                serde_json::from_value(prepared_value).map_err(|_| {
                    invalid_relation_migration("relationship journal facts are corrupt")
                })?;
            let expected_target_fingerprint = journal_value
                .get("expected_target_fingerprint")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    invalid_relation_migration("relationship journal target fingerprint is missing")
                })?;
            let expected_link_representation = journal_value
                .get("expected_link_representation")
                .cloned()
                .map(|value| {
                    serde_json::from_value(value).map_err(|_| {
                        invalid_relation_migration(
                            "relationship journal link representation is corrupt",
                        )
                    })
                })
                .transpose()?
                .ok_or_else(|| {
                    invalid_relation_migration(
                        "relationship journal link representation is missing",
                    )
                })?;
            let source_relations = journal_value
                .get("source_relations")
                .cloned()
                .ok_or_else(|| {
                    invalid_relation_migration("relationship journal source relations are missing")
                })
                .and_then(|value| {
                    serde_json::from_value(value).map_err(|_| {
                        invalid_relation_migration(
                            "relationship journal source relations are corrupt",
                        )
                    })
                })?;
            let safety = journal_value
                .get("safety")
                .cloned()
                .ok_or_else(|| {
                    invalid_relation_migration("relationship safety snapshot is missing")
                })
                .and_then(|value| {
                    serde_json::from_value(value).map_err(|_| {
                        invalid_relation_migration("relationship safety snapshot is corrupt")
                    })
                })?;
            let stage = journal_value
                .get("stage")
                .cloned()
                .ok_or_else(|| {
                    invalid_relation_migration("relationship migration stage is missing")
                })
                .and_then(|value| {
                    serde_json::from_value(value).map_err(|_| {
                        invalid_relation_migration("relationship migration stage is corrupt")
                    })
                })?;
            let backup = journal_value
                .get("backup")
                .cloned()
                .ok_or_else(|| {
                    invalid_relation_migration("relationship backup metadata is corrupt")
                })
                .and_then(RelationBackupMetadata::from_json)?;
            let journal = RelationMigrationJournal::from_persisted(
                prepared,
                expected_target_fingerprint,
                expected_link_representation,
                source_relations,
                safety,
                stage,
                backup,
            );
            let result = record
                .result
                .map(|value| {
                    serde_json::from_value(value).map_err(|_| {
                        invalid_relation_migration("relationship journal result is corrupt")
                    })
                })
                .transpose()?;
            return Ok((journal, result, record.phase));
        }

        let prepared = self
            .prepared_relation_migrations
            .lock()
            .map_err(|_| internal("operation_journal.relationship_migration.load"))?
            .get(&operation_id)
            .cloned()
            .ok_or_else(|| relation_operation_not_found(operation_id))?;
        let target_fingerprint = DeploymentFilesystem::hash_tree(&prepared.target_path)?;
        let relation = self.current_relation(&prepared.relation_id)?;
        let snapshot = self.with_database("relationship.load_journal_snapshot", |database| {
            database
                .relationship_repository()
                .list_relation_impact(&prepared.relation_id)
        })?;
        let library_root = self.library_root()?;
        let safety = capture_relation_safety_snapshot(
            &relation.path,
            Path::new(&prepared.target_path),
            &snapshot.directory_nodes,
            &library_root,
        )?;
        let original_entity_identity =
            relation_entity_identity(&relation.path, relation.file_representation)?;
        Ok((
            RelationMigrationJournal::from_prepared(
                prepared,
                target_fingerprint,
                snapshot.source_relations,
                safety,
                original_entity_identity,
            ),
            None,
            OperationPhase::Prepared,
        ))
    }

    fn central_path_for_relation(&self, relation: &DeploymentRelationFact) -> AppResult<PathBuf> {
        let skill_id = relation.skill_id.ok_or_else(|| {
            invalid_relation_migration("relationship has no deterministically confirmed Skill")
        })?;
        let library = self.library_runtime.snapshot()?;
        let (record, current) = library
            .central
            .load_portable_skill(skill_id)?
            .ok_or_else(|| relation_not_found(&skill_id.to_string()))?;
        let version = current.ok_or_else(|| {
            invalid_relation_migration("Skill has no current central-library version")
        })?;
        let path = library
            .central
            .visible_skill_path_for_runtime(skill_id, &record.runtime_name);
        if !path.is_dir() {
            return Err(invalid_relation_migration("central target is unavailable"));
        }
        // Keep the version lookup live so a changed current version is caught
        // before a link is created, while the public prepared DTO remains
        // path/fingerprint based.
        let _ = version;
        Ok(path)
    }

    fn current_version_for_relation(
        &self,
        relation: &DeploymentRelationFact,
    ) -> AppResult<skillhub_core::VersionId> {
        let skill_id = relation.skill_id.ok_or_else(|| {
            invalid_relation_migration("relationship has no Skill version identity")
        })?;
        self.library_runtime
            .snapshot()?
            .current(skill_id)?
            .ok_or_else(|| invalid_relation_migration("Skill has no current version"))
    }

    fn library_root(&self) -> AppResult<PathBuf> {
        Ok(self.library_runtime.snapshot()?.root.clone())
    }

    fn persist_relation_operation(
        &self,
        operation_id: OperationId,
        phase: OperationPhase,
        state: RelationMigrationState,
        journal: &RelationMigrationJournal,
        result: Option<&RelationMigrationResult>,
        error_code: Option<ErrorCode>,
    ) -> AppResult<()> {
        let prepared = &journal.prepared;
        let mut record = super::journal_record(operation_id, "migrate_relation", phase, error_code);
        record.request_fingerprint = prepared.relation_id.clone();
        record.inverse = Some(InverseOperation {
            kind: "rollback_relation_migration".into(),
            preconditions: json!({
                "relation_id": prepared.relation_id,
                "fingerprint": prepared.current_content_fingerprint,
                "target_path": prepared.target_path,
            }),
            facts: json!({
                "backup_path": prepared.backup_path,
                "old_path": prepared.relation.path,
            }),
        });
        record.recovery_data = json!({
            "relation_migration_state": state,
            "prepared": prepared,
            "journal": {
                "prepared": prepared,
                "expected_target_fingerprint": journal.expected_target_fingerprint,
                "expected_link_representation": journal.expected_link_representation,
                "source_relations": journal.source_relations,
                "safety": journal.safety,
                "stage": journal.stage,
                "backup": journal.backup.to_json(),
            },
            "phase": phase,
        });
        record.result = result.and_then(|value| serde_json::to_value(value).ok());
        record.object_results.push(match result {
            Some(value) => OperationObjectResult::succeeded(
                prepared.relation_id.clone(),
                serde_json::to_value(value).ok(),
            ),
            None => OperationObjectResult {
                object_id: prepared.relation_id.clone(),
                status: serde_json::to_string(&state)
                    .unwrap_or_else(|_| "unknown".into())
                    .trim_matches('"')
                    .into(),
                result: None,
                error_code,
            },
        });
        self.with_database("operation_journal.relationship_migration", |database| {
            database
                .operation_repository()
                .update_sync(&record)
                .or_else(|_| database.operation_repository().insert_sync(&record))
        })
    }
}

fn relationship_snapshot_for_scope(
    database: &skillhub_storage::Database,
    scope: &RelationshipOverviewScope,
) -> AppResult<skillhub_storage::RelationshipImpactSnapshot> {
    match scope_subject(scope) {
        Some(subject) => database
            .relationship_repository()
            .list_relation_impact(&subject),
        None => Ok(skillhub_storage::RelationshipImpactSnapshot {
            deployments: database.relationship_repository().list_relations()?,
            source_relations: database.relationship_repository().list_source_relations()?,
            directory_capabilities: database.relationship_repository().list_capabilities()?,
            directory_nodes: database.directory_repository().list_nodes()?,
        }),
    }
}

fn scope_subject(scope: &RelationshipOverviewScope) -> Option<String> {
    match scope {
        RelationshipOverviewScope::All => None,
        RelationshipOverviewScope::Skill { skill_id } => Some(skill_id.to_string()),
        RelationshipOverviewScope::Agent { agent_client_id } => Some(agent_client_id.clone()),
        RelationshipOverviewScope::Directory { directory_node_id } => {
            Some(directory_node_id.clone())
        }
        RelationshipOverviewScope::Relation { relation_id } => Some(relation_id.clone()),
        RelationshipOverviewScope::Path { path_key } => Some(path_key.clone()),
    }
}

fn conflict_matches(case: &ConflictCaseFact, subject: &str) -> bool {
    case.conflict_id == subject
        || case
            .member_skill_ids
            .iter()
            .any(|id| id.to_string() == subject)
        || case.members.iter().any(|member| {
            member.provenance_id.as_deref() == Some(subject)
                || member.directory_node_id.as_deref() == Some(subject)
                || member.path.as_deref() == Some(subject)
        })
}

fn governance_task_matches(
    task: &GovernanceTaskFact,
    subject: Option<&str>,
    snapshot: &skillhub_storage::RelationshipImpactSnapshot,
) -> bool {
    let Some(subject) = subject else {
        return true;
    };
    task.subject_id == subject
        || snapshot.deployments.iter().any(|relation| {
            relation.relation_id == task.subject_id
                && (relation
                    .skill_id
                    .map(|id| id.to_string() == subject)
                    .unwrap_or(false)
                    || relation.agent_client_id == subject
                    || relation.directory_node_id.as_deref() == Some(subject)
                    || relation.path_key == subject
                    || relation.path == subject)
        })
        || snapshot.source_relations.iter().any(|relation| {
            relation.provenance_id == task.subject_id
                && (relation.skill_id.to_string() == subject
                    || relation.agent_client_id.as_deref() == Some(subject)
                    || relation.directory_node_id.as_deref() == Some(subject)
                    || relation.source_path_key == subject
                    || relation.source_path == subject)
        })
}

fn validate_relation_for_prepare(relation: &DeploymentRelationFact) -> AppResult<()> {
    if matches!(relation.relationship, RelationshipType::Unknown)
        || relation.skill_id.is_none()
        || relation.content_fingerprint.trim().is_empty()
    {
        return Err(invalid_relation_migration(
            "relationship identity is not deterministically confirmed",
        ));
    }
    if !matches!(
        relation.relationship,
        RelationshipType::ObservedCopy
            | RelationshipType::ManagedCopy
            | RelationshipType::ObservedLink
            | RelationshipType::ManagedLink
            | RelationshipType::SharedDirectoryRead
            | RelationshipType::SharedDirectoryReference
    ) {
        return Err(invalid_relation_migration(
            "relationship type cannot be converted by this operation",
        ));
    }
    Ok(())
}

fn relation_facts_match(
    current: &DeploymentRelationFact,
    prepared: &DeploymentRelationFact,
) -> bool {
    let mut expected = prepared.clone();
    expected.content_fingerprint = current.content_fingerprint.clone();
    current == &expected
}

fn validate_non_symlink_directory(path: &Path) -> AppResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ownership_mismatch(path))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ownership_mismatch(path));
    }
    Ok(())
}

fn validate_relation_entity(
    path: &str,
    representation: FileRepresentation,
    expected_link_target: Option<&str>,
    expected_fingerprint: &str,
) -> AppResult<()> {
    let path = Path::new(path);
    let metadata = fs::symlink_metadata(path).map_err(|error| io_conflict(path, error))?;
    match representation {
        FileRepresentation::SymbolicLink => {
            let expected_target = expected_link_target
                .ok_or_else(|| invalid_relation_migration("symbolic-link target is missing"))?;
            let actual_target = fs::read_link(path).map_err(|error| io_conflict(path, error))?;
            if !metadata.file_type().is_symlink()
                || actual_target.as_path() != Path::new(expected_target)
            {
                return Err(ownership_mismatch(path));
            }
        }
        FileRepresentation::Directory | FileRepresentation::Copy => {
            validate_non_symlink_directory(path)?;
        }
        FileRepresentation::DirectoryJunction => return Err(unsupported_junction_migration()),
        FileRepresentation::Unknown => {
            return Err(invalid_relation_migration(
                "relationship representation is unknown",
            ))
        }
    }
    if DeploymentFilesystem::hash_tree(path)? != expected_fingerprint {
        return Err(target_changed(path));
    }
    Ok(())
}

fn relation_entity_identity(path: &str, representation: FileRepresentation) -> AppResult<String> {
    let path = Path::new(path);
    match representation {
        FileRepresentation::SymbolicLink => skillhub_core::symlink_physical_id_for_path(path),
        FileRepresentation::Directory | FileRepresentation::Copy => {
            validate_non_symlink_directory(path)?;
            skillhub_core::physical_id_for_path(path)
        }
        FileRepresentation::DirectoryJunction => return Err(unsupported_junction_migration()),
        FileRepresentation::Unknown => None,
    }
    .ok_or_else(|| ownership_mismatch(path))
}

fn validate_relation_entity_binding(
    journal: &RelationMigrationJournal,
    relation: &DeploymentRelationFact,
    current_fingerprint: &str,
) -> AppResult<()> {
    if relation.file_representation != journal.prepared.relation.file_representation
        || relation.link_target_path != journal.backup.original_link_target
    {
        return Err(ownership_mismatch(&relation.path));
    }
    validate_relation_entity(
        &relation.path,
        relation.file_representation,
        relation.link_target_path.as_deref(),
        current_fingerprint,
    )?;
    let identity = relation_entity_identity(&relation.path, relation.file_representation)?;
    if identity != journal.backup.original_entity_identity {
        return Err(ownership_mismatch(&relation.path));
    }
    Ok(())
}

fn capture_path_chain(path: &Path) -> AppResult<PathChainSnapshot> {
    let mut nodes = Vec::new();
    for ancestor in path.ancestors() {
        // macOS commonly exposes `/var` and `/tmp` as symlinked system
        // prefixes. Resolve only the already-existing parent chain so those
        // harmless aliases are accepted while a replaced parent still gets a
        // different canonical path/physical identity.
        let canonical = fs::canonicalize(ancestor).map_err(|error| io_conflict(ancestor, error))?;
        let metadata =
            fs::symlink_metadata(&canonical).map_err(|error| io_conflict(&canonical, error))?;
        if !metadata.is_dir() {
            return Err(ownership_mismatch(&canonical));
        }
        let physical_id = skillhub_core::physical_id_for_path(&canonical)
            .ok_or_else(|| ownership_mismatch(ancestor))?;
        nodes.push(PathNodeSnapshot {
            path: canonical.to_string_lossy().into_owned(),
            physical_id,
        });
    }
    Ok(PathChainSnapshot { nodes })
}

fn capture_relation_safety_snapshot(
    relation_path: &str,
    target_path: &Path,
    _directory_nodes: &[DirectoryNodeFact],
    _library_root: &Path,
) -> AppResult<RelationSafetySnapshot> {
    let relation_parent = Path::new(relation_path)
        .parent()
        .ok_or_else(|| ownership_mismatch(relation_path))?;
    Ok(RelationSafetySnapshot {
        relation_parent: capture_path_chain(relation_parent)?,
        central_target: capture_path_chain(target_path)?,
    })
}

fn validate_relation_parent_and_target_snapshot(
    journal: &RelationMigrationJournal,
    relation_path: &Path,
    target_path: &Path,
) -> AppResult<()> {
    let relation_parent = relation_path
        .parent()
        .ok_or_else(|| ownership_mismatch(relation_path))?;
    let current = RelationSafetySnapshot {
        relation_parent: capture_path_chain(relation_parent)?,
        central_target: capture_path_chain(target_path)?,
    };
    if current != journal.safety {
        return Err(ownership_mismatch(relation_path));
    }
    validate_non_symlink_directory(target_path)
}

fn validate_relation_safety_snapshot(
    journal: &RelationMigrationJournal,
    relation: &DeploymentRelationFact,
    target_path: &Path,
    _library_root: &Path,
) -> AppResult<()> {
    validate_relation_parent_and_target_snapshot(journal, Path::new(&relation.path), target_path)?;
    Ok(())
}

fn unsupported_junction_migration() -> AppError {
    AppError::new(ErrorCode::JunctionNotSupported, Severity::Warning)
        .with_param(
            "detail",
            "directory junction target cannot be verified safely by the current filesystem abstraction",
        )
        .with_action(RecoveryAction::OpenReadOnly)
}

fn authorize_paths(
    relation_path: &str,
    target_path: &Path,
    directory_nodes: &[DirectoryNodeFact],
    library_root: &Path,
) -> AppResult<()> {
    let mut policy = skillhub_core::PathPolicy::new();
    let mut registered_root = false;
    for node in directory_nodes.iter().filter(|node| node.exists) {
        if let Ok(root) = skillhub_core::AllowedRoot::new(&node.path) {
            policy.register_root(root)?;
            registered_root = true;
        }
    }
    if !registered_root {
        return Err(path_boundary(relation_path));
    }
    // The central library root is an application-owned registered storage
    // root, not a root inferred from the relationship path.
    policy.register_root(skillhub_core::AllowedRoot::new(library_root)?)?;
    policy.authorize_existing(relation_path)?;
    policy.authorize_existing(target_path)?;
    Ok(())
}

fn validate_backup_binding(journal: &RelationMigrationJournal) -> AppResult<()> {
    let prepared = &journal.prepared;
    let backup = &journal.backup;
    if backup.operation_id != prepared.operation_id
        || backup.path != prepared.backup_path
        || backup.original_path != prepared.relation.path
        || backup.original_fingerprint != prepared.current_content_fingerprint
        || backup.original_fingerprint != prepared.relation.content_fingerprint
        || backup.original_relationship != prepared.relation.relationship
        || backup.original_representation != prepared.relation.file_representation
        || backup.original_ownership != prepared.relation.ownership
        || backup.original_active != prepared.relation.active
        || backup.original_link_target != prepared.relation.link_target_path
    {
        return Err(invalid_relation_migration(
            "relationship backup metadata is not bound to this migration",
        ));
    }
    Ok(())
}

fn validate_backup_path(
    journal: &RelationMigrationJournal,
    library_root: &Path,
) -> AppResult<PathBuf> {
    validate_backup_binding(journal)?;
    let backup = PathBuf::from(&journal.backup.path);
    let expected = library_root
        .join(".skillhub")
        .join("relationship-migrations")
        .join(journal.prepared.operation_id.to_string())
        .join("previous");
    if backup != expected {
        return Err(path_boundary(&journal.backup.path));
    }
    let root = skillhub_core::AllowedRoot::new(library_root)?;
    let root_id = root.id();
    let relative = backup
        .strip_prefix(library_root)
        .map_err(|_| path_boundary(&journal.backup.path))?;
    let mut policy = skillhub_core::PathPolicy::new();
    policy.register_root(root)?;
    policy.resolve_for_create(root_id, relative)?;
    Ok(backup)
}

fn validate_backup_entity(relation: &DeploymentRelationFact, backup: &Path) -> AppResult<()> {
    let metadata = fs::symlink_metadata(backup).map_err(|error| io_conflict(backup, error))?;
    match relation.file_representation {
        FileRepresentation::SymbolicLink => {
            let expected_target = relation.link_target_path.as_deref().ok_or_else(|| {
                invalid_relation_migration("original symbolic-link target is missing")
            })?;
            let actual_target =
                fs::read_link(backup).map_err(|error| io_conflict(backup, error))?;
            if !metadata.file_type().is_symlink()
                || actual_target.as_path() != Path::new(expected_target)
            {
                return Err(invalid_relation_migration(
                    "relationship backup symbolic-link target differs from the original target",
                ));
            }
        }
        FileRepresentation::Directory | FileRepresentation::Copy => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(invalid_relation_migration(
                    "relationship backup representation differs from the original relationship",
                ));
            }
        }
        FileRepresentation::DirectoryJunction => return Err(unsupported_junction_migration()),
        FileRepresentation::Unknown => {
            return Err(invalid_relation_migration(
                "relationship backup representation is unknown",
            ));
        }
    }
    Ok(())
}

fn validate_backup_fingerprint(
    journal: &RelationMigrationJournal,
    library_root: &Path,
) -> AppResult<PathBuf> {
    let backup = validate_backup_path(journal, library_root)?;
    if fs::symlink_metadata(&backup).is_err() {
        return Err(invalid_relation_migration(
            "relationship backup is unavailable",
        ));
    }
    validate_backup_entity(&journal.prepared.relation, &backup)?;
    let fingerprint = DeploymentFilesystem::hash_tree(&backup)?;
    if fingerprint != journal.backup.original_fingerprint {
        return Err(invalid_relation_migration(
            "relationship backup fingerprint differs from the original migration content",
        ));
    }
    Ok(backup)
}

fn backup_relation_entry(relation: &DeploymentRelationFact, backup: &Path) -> AppResult<()> {
    if fs::symlink_metadata(backup).is_ok() {
        validate_backup_entity(relation, backup)?;
        let fingerprint = DeploymentFilesystem::hash_tree(backup)?;
        if fingerprint == relation.content_fingerprint {
            return Ok(());
        }
        return Err(invalid_relation_migration(
            "relationship backup does not match prepared content",
        ));
    }
    if let Some(parent) = backup.parent() {
        fs::create_dir_all(parent).map_err(|error| io_conflict(parent, error))?;
    }
    let metadata =
        fs::symlink_metadata(&relation.path).map_err(|error| io_conflict(&relation.path, error))?;
    let copied = if metadata.file_type().is_symlink() {
        let target =
            fs::read_link(&relation.path).map_err(|error| io_conflict(&relation.path, error))?;
        create_dir_link(&target, backup)
    } else {
        super::copy_directory_tree(Path::new(&relation.path), backup)
    };
    copied?;
    validate_backup_entity(relation, backup)?;
    let fingerprint = DeploymentFilesystem::hash_tree(backup)?;
    if fingerprint != relation.content_fingerprint {
        return Err(invalid_relation_migration(
            "relationship backup fingerprint differs from the original content",
        ));
    }
    Ok(())
}

fn restore_relation_entry(journal: &RelationMigrationJournal, backup: &Path) -> AppResult<()> {
    validate_relation_parent_and_target_snapshot(
        journal,
        Path::new(&journal.backup.original_path),
        Path::new(&journal.prepared.target_path),
    )?;
    validate_backup_entity(&journal.prepared.relation, backup)?;
    if journal.prepared.relation.file_representation == FileRepresentation::SymbolicLink {
        let target = fs::read_link(backup).map_err(|error| io_conflict(backup, error))?;
        create_dir_link(&target, Path::new(&journal.backup.original_path))
    } else {
        super::copy_directory_tree(backup, Path::new(&journal.backup.original_path))
    }
}

fn remove_relation_entry(path: &Path) -> AppResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io_conflict(path, error))?;
    if metadata.file_type().is_symlink() {
        fs::remove_file(path).map_err(|error| io_conflict(path, error))
    } else if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|error| io_conflict(path, error))
    } else {
        fs::remove_file(path).map_err(|error| io_conflict(path, error))
    }
}

fn remove_created_relation_entry(journal: &RelationMigrationJournal) -> AppResult<()> {
    let path = Path::new(&journal.backup.original_path);
    validate_relation_parent_and_target_snapshot(
        journal,
        path,
        Path::new(&journal.prepared.target_path),
    )?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let target = fs::read_link(path).map_err(|error| io_conflict(path, error))?;
            if target.as_path() != Path::new(&journal.prepared.target_path) {
                return Err(ownership_mismatch(path));
            }
            remove_relation_entry(path)
        }
        Ok(_) => Err(ownership_mismatch(path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_conflict(path, error)),
    }
}

fn recover_relation_entry(
    journal: &RelationMigrationJournal,
    library_root: &Path,
) -> AppResult<()> {
    let backup = validate_backup_fingerprint(journal, library_root)?;
    remove_created_relation_entry(journal)?;
    restore_relation_entry(journal, &backup)
}

fn validate_relation_for_rollback(
    current: &DeploymentRelationFact,
    journal: &RelationMigrationJournal,
) -> AppResult<()> {
    let prepared = &journal.prepared;
    if current.path != prepared.relation.path
        || !current.active
        || current.relationship != RelationshipType::ManagedLink
        || current.ownership != OwnershipState::SkillhubManaged
        || current.file_representation != journal.expected_link_representation
        || current.content_fingerprint != prepared.current_content_fingerprint
        || current.link_target_path.as_deref() != Some(prepared.target_path.as_str())
    {
        return Err(ownership_mismatch(&current.path));
    }
    let metadata =
        fs::symlink_metadata(&current.path).map_err(|_| ownership_mismatch(&current.path))?;
    match prepared.target_mode {
        DeploymentMode::SymbolicLink => {
            let actual_target =
                fs::read_link(&current.path).map_err(|_| ownership_mismatch(&current.path))?;
            if !metadata.file_type().is_symlink()
                || actual_target.as_path() != Path::new(&prepared.target_path)
            {
                return Err(ownership_mismatch(&current.path));
            }
        }
        DeploymentMode::DirectoryJunction => {
            if metadata.file_type().is_symlink() {
                return Err(ownership_mismatch(&current.path));
            }
        }
        DeploymentMode::ManagedCopy => return Err(ownership_mismatch(&current.path)),
    }
    Ok(())
}

fn relation_is_restored(
    current: &DeploymentRelationFact,
    journal: &RelationMigrationJournal,
) -> bool {
    current == &journal.prepared.relation && filesystem_is_restored(journal)
}

fn filesystem_is_restored(journal: &RelationMigrationJournal) -> bool {
    let path = Path::new(&journal.backup.original_path);
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    match journal.prepared.relation.file_representation {
        FileRepresentation::SymbolicLink => {
            let Some(expected_target) = journal.prepared.relation.link_target_path.as_deref()
            else {
                return false;
            };
            metadata.file_type().is_symlink()
                && fs::read_link(path)
                    .map(|target| target.as_path() == Path::new(expected_target))
                    .unwrap_or(false)
        }
        FileRepresentation::Directory
        | FileRepresentation::DirectoryJunction
        | FileRepresentation::Copy => {
            !metadata.file_type().is_symlink()
                && metadata.is_dir()
                && DeploymentFilesystem::hash_tree(path)
                    .map(|fingerprint| fingerprint == journal.backup.original_fingerprint)
                    .unwrap_or(false)
        }
        FileRepresentation::Unknown => false,
    }
}

fn relation_path_is_inaccessible(path: &str) -> bool {
    // Access checks must follow a directory link: symlink_metadata reports
    // the link itself as non-directory even when its target is readable.
    // Dangling links and unreadable targets still fail closed.
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return true,
    };
    !metadata.is_dir() || fs::read_dir(path).is_err()
}

fn representation_for_mode(mode: DeploymentMode) -> FileRepresentation {
    match mode {
        DeploymentMode::SymbolicLink => FileRepresentation::SymbolicLink,
        DeploymentMode::DirectoryJunction => FileRepresentation::DirectoryJunction,
        DeploymentMode::ManagedCopy => FileRepresentation::Copy,
    }
}

fn ownership_mismatch(path: impl AsRef<Path>) -> AppError {
    AppError::new(ErrorCode::OwnershipMismatch, Severity::Error)
        .with_param("path", path.as_ref().to_string_lossy().into_owned())
        .with_action(RecoveryAction::InspectTarget)
}

#[cfg(unix)]
fn create_dir_link(source: &Path, destination: &Path) -> AppResult<()> {
    std::os::unix::fs::symlink(source, destination).map_err(|error| io_conflict(destination, error))
}

#[cfg(windows)]
fn create_dir_link(source: &Path, destination: &Path) -> AppResult<()> {
    std::os::windows::fs::symlink_dir(source, destination)
        .map_err(|error| io_conflict(destination, error))
}

#[cfg(not(any(unix, windows)))]
fn create_dir_link(_source: &Path, destination: &Path) -> AppResult<()> {
    Err(
        AppError::new(ErrorCode::SymlinkNotSupported, Severity::Warning)
            .with_param("path", destination.to_string_lossy().into_owned()),
    )
}

fn migration_result_from_prepared(
    prepared: &skillhub_core::PreparedRelationMigration,
    state: RelationMigrationState,
    backup_path: Option<String>,
    error_code: Option<ErrorCode>,
    governance_tasks: Vec<GovernanceTaskFact>,
) -> RelationMigrationResult {
    RelationMigrationResult {
        operation_id: prepared.operation_id,
        relation_id: prepared.relation_id.clone(),
        state,
        relation_type: prepared.relation.relationship,
        ownership: prepared.relation.ownership,
        old_path: prepared.relation.path.clone(),
        target_path: prepared.target_path.clone(),
        backup_path,
        affected_paths: prepared.affected_paths.clone(),
        rollback_available: state == RelationMigrationState::Committed
            || state == RelationMigrationState::Failed,
        governance_tasks,
        error_code,
        detail: None,
    }
}

fn governance_task(
    subject_id: &str,
    kind: GovernanceTaskKind,
    detail: String,
) -> GovernanceTaskFact {
    GovernanceTaskFact {
        task_id: format!("relation-migration:{subject_id}:{}", task_kind_code(kind)),
        kind,
        subject_id: subject_id.into(),
        detail,
        resolved: false,
        created_at: super::now_epoch_seconds(),
        resolved_at: None,
    }
}

fn push_task(tasks: &mut Vec<GovernanceTaskFact>, task: GovernanceTaskFact) {
    if !tasks
        .iter()
        .any(|existing| existing.task_id == task.task_id)
    {
        tasks.push(task);
    }
}

fn task_kind_code(kind: GovernanceTaskKind) -> &'static str {
    match kind {
        GovernanceTaskKind::SelectAuthoritativeVersion => "authoritative",
        GovernanceTaskKind::ClassifySameNameSkill => "same_name",
        GovernanceTaskKind::ConfirmSharedDirectoryImpact => "shared_impact",
        GovernanceTaskKind::ConvertCopyToManagedLink => "copy_to_link",
        GovernanceTaskKind::ConvertSharedReferenceToManagedLink => "shared_to_link",
        GovernanceTaskKind::UnknownDirectoryRecognition => "unknown_directory",
        GovernanceTaskKind::OperationFailureRecovery => "recovery",
    }
}

/// Governance todo kind matching the relation family a refused conversion
/// belongs to, so the pending item names the decision the user actually has.
fn conversion_todo_kind(relationship: RelationshipType) -> GovernanceTaskKind {
    if matches!(
        relationship,
        RelationshipType::SharedDirectoryRead | RelationshipType::SharedDirectoryReference
    ) {
        GovernanceTaskKind::ConvertSharedReferenceToManagedLink
    } else {
        GovernanceTaskKind::ConvertCopyToManagedLink
    }
}

fn relation_not_found(id: &str) -> AppError {
    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
        .with_param("relation_id", id.to_owned())
        .with_action(RecoveryAction::ChooseAnotherName)
}

fn relation_operation_not_found(id: OperationId) -> AppError {
    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
        .with_param("operation_id", id.to_string())
        .with_action(RecoveryAction::ChooseAnotherName)
}

fn invalid_relation_migration(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("detail", detail.into())
        .with_action(RecoveryAction::InspectTarget)
}

fn target_changed(path: impl AsRef<Path>) -> AppError {
    AppError::new(ErrorCode::TargetChanged, Severity::Error)
        .with_param("path", path.as_ref().to_string_lossy().into_owned())
        .with_action(RecoveryAction::InspectTarget)
}

fn path_boundary(path: &str) -> AppError {
    AppError::new(ErrorCode::PathOutsideAllowedRoots, Severity::Error)
        .with_param("path", path.to_owned())
        .with_action(RecoveryAction::ChooseAnotherName)
}

fn io_conflict(path: impl AsRef<Path>, error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("path", path.as_ref().to_string_lossy().into_owned())
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}

fn journal_failure_audit_error(operation_id: &OperationId, journal_error: &AppError) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("operation_id", operation_id.to_string())
        .with_param("audit", "filesystem_restored_after_journal_failure")
        .with_param("journal_error", journal_error.code.as_str())
        .with_action(RecoveryAction::Retry)
}

fn recovery_failure_error(journal_error: &AppError, recovery_error: &AppError) -> AppError {
    AppError::new(recovery_error.code, Severity::Critical)
        .with_param("recovery_required", true)
        .with_param("journal_error", journal_error.code.as_str())
        .with_param("recovery_error", recovery_error.code.as_str())
        .with_action(RecoveryAction::Retry)
        .with_action(RecoveryAction::InspectTarget)
}

fn internal(operation: &'static str) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("operation", operation)
        .with_action(RecoveryAction::Retry)
}
