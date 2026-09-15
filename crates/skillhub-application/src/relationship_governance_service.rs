//! Application facade for normalized relationship facts and safe relationship
//! conversion.  This module owns orchestration only; relationship
//! classification and removal-impact rules remain in `skillhub-core`.

use std::fs;
use std::path::{Path, PathBuf};

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
    RemovalFacts,
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
    backup: RelationBackupMetadata,
}

#[derive(Clone, Debug)]
struct RelationBackupMetadata {
    path: String,
    original_fingerprint: String,
    original_relationship: RelationshipType,
    original_representation: FileRepresentation,
    original_ownership: OwnershipState,
    original_active: bool,
}

impl RelationMigrationJournal {
    fn from_prepared(
        prepared: skillhub_core::PreparedRelationMigration,
        expected_target_fingerprint: String,
    ) -> Self {
        let relation = &prepared.relation;
        Self {
            expected_target_fingerprint,
            expected_link_representation: representation_for_mode(prepared.target_mode),
            backup: RelationBackupMetadata {
                path: prepared.backup_path.clone(),
                original_fingerprint: relation.content_fingerprint.clone(),
                original_relationship: relation.relationship,
                original_representation: relation.file_representation,
                original_ownership: relation.ownership,
                original_active: relation.active,
            },
            prepared,
        }
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
            let current_fingerprint = DeploymentFilesystem::hash_tree(&relation.path)?;
            if current_fingerprint != relation.content_fingerprint {
                return Err(target_changed(&relation.path));
            }
            let target_path = self.central_path_for_relation(&relation)?;
            if let Err(error) = authorize_paths(
                &relation.path,
                &target_path,
                &snapshot.directory_nodes,
                &self.library_root()?,
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
            let target_fingerprint = DeploymentFilesystem::hash_tree(&target_path)?;
            if target_fingerprint != current_fingerprint {
                return Err(AppError::new(ErrorCode::TargetChanged, Severity::Error)
                    .with_param("path", target_path.to_string_lossy().into_owned())
                    .with_param("detail", "central target fingerprint differs")
                    .with_action(RecoveryAction::InspectTarget));
            }

            let permission_limited = relation_path_is_inaccessible(&relation.path);
            let mut governance_tasks = calculate_removal_impact(
                &request.relation_id,
                &RemovalFacts::new(
                    snapshot.deployments.clone(),
                    snapshot.directory_capabilities.clone(),
                )
                .with_permission_limited(permission_limited),
            )
            .governance_tasks;
            let impact = calculate_removal_impact(
                &request.relation_id,
                &RemovalFacts::new(
                    snapshot.deployments.clone(),
                    snapshot.directory_capabilities,
                )
                .with_permission_limited(permission_limited),
            );
            let shared_impact = matches!(
                relation.relationship,
                RelationshipType::SharedDirectoryRead | RelationshipType::SharedDirectoryReference
            ) || !impact.other_consumers.is_empty();
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
            let library_root = self.library_root()?;
            let backup_path = library_root
                .join(".skillhub")
                .join("relationship-migrations")
                .join(operation_id.to_string())
                .join("previous");
            let relation_path = relation.path.clone();
            Ok(skillhub_core::PreparedRelationMigration {
                operation_id,
                relation_id: request.relation_id.clone(),
                relation,
                current_content_fingerprint: current_fingerprint,
                target_path: target_path.to_string_lossy().into_owned(),
                target_mode: DeploymentMode::SymbolicLink,
                backup_path: backup_path.to_string_lossy().into_owned(),
                affected_paths: vec![relation_path, target_path.to_string_lossy().into_owned()],
                rollback_available: true,
                governance_tasks,
            })
        });

        match prepared {
            Ok(prepared) => {
                self.prepared_relation_migrations
                    .lock()
                    .map_err(|_| internal("execute.prepare_relation_migration"))?
                    .insert(prepared.operation_id, prepared.clone());
                let journal = RelationMigrationJournal::from_prepared(
                    prepared.clone(),
                    DeploymentFilesystem::hash_tree(&prepared.target_path)?,
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
        let (journal, existing_result) =
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
        let current_fingerprint = match DeploymentFilesystem::hash_tree(&relation.path) {
            Ok(value) => value,
            Err(error) => return self.failed_relation_result(&journal, error),
        };
        if current_fingerprint != prepared.current_content_fingerprint
            || relation.content_fingerprint != prepared.relation.content_fingerprint
        {
            return self.failed_relation_result(&journal, target_changed(&relation.path));
        }
        let target_path = match self.central_path_for_relation(&relation) {
            Ok(value) => value,
            Err(error) => return self.failed_relation_result(&journal, error),
        };
        if target_path.to_string_lossy() != prepared.target_path {
            return self.failed_relation_result(&journal, target_changed(&prepared.target_path));
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
        if !prepared.governance_tasks.is_empty() {
            let error =
                invalid_relation_migration("relationship governance confirmation is pending");
            return self.failed_relation_result(&journal, error);
        }

        let capabilities = DeploymentFilesystem::new().available_capabilities();
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
        let snapshot = self.with_database("relationship.commit_snapshot", |database| {
            database
                .relationship_repository()
                .list_relation_impact(&prepared.relation_id)
        })?;
        if let Err(error) = authorize_paths(
            &relation.path,
            &target_path,
            &snapshot.directory_nodes,
            &self.library_root()?,
        ) {
            return self.failed_relation_result(&journal, error);
        }

        let version_id = match self.current_version_for_relation(&relation) {
            Ok(version_id) => version_id,
            Err(error) => return self.failed_relation_result(&journal, error),
        };
        let applying = journal.clone();
        self.persist_relation_operation(
            applying.prepared.operation_id,
            OperationPhase::Applying,
            RelationMigrationState::Prepared,
            &applying,
            None,
            None,
        )?;

        let backup_path = PathBuf::from(&prepared.backup_path);
        if let Err(error) = backup_relation_entry(&relation, &backup_path) {
            return self.failed_relation_result(&journal, error);
        }
        if let Err(error) = remove_relation_entry(Path::new(&relation.path)) {
            return self.failed_relation_result(&journal, error);
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
                let error = recover_relation_entry(&relation, &backup_path)
                    .err()
                    .unwrap_or(error);
                return self.failed_relation_result(&journal, error);
            }
        };
        if applied.ownership.mode != prepared.target_mode {
            let error =
                invalid_relation_migration("actual link representation differs from prepared mode");
            let error = recover_relation_entry(&relation, &backup_path)
                .err()
                .unwrap_or(error);
            return self.failed_relation_result(&journal, error);
        }
        let verifying = journal.clone();
        if let Err(error) = self.persist_relation_operation(
            verifying.prepared.operation_id,
            OperationPhase::Verifying,
            RelationMigrationState::Prepared,
            &verifying,
            None,
            None,
        ) {
            let _ = recover_relation_entry(&relation, &backup_path);
            return Err(error);
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
            let error = recover_relation_entry(&relation, &backup_path)
                .err()
                .unwrap_or(error);
            return self.failed_relation_result(&journal, error);
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
            let recovery = recover_relation_entry(&relation, &backup_path).and_then(|_| {
                self.with_database(
                    "execute.commit_relation_migration.recover_record",
                    |database| {
                        database
                            .relationship_repository()
                            .upsert_deployment_relation(&relation)
                    },
                )
            });
            return Err(recovery.err().unwrap_or(error));
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
        let (journal, existing_result) =
            self.load_relation_migration_journal(request.operation_id)?;
        let prepared = journal.prepared.clone();
        if let Some(existing) = existing_result.as_ref() {
            if existing.state == RelationMigrationState::RolledBack
                || existing.state == RelationMigrationState::Cancelled
            {
                return Ok(AppCommandResult::RelationMigrationResult(existing.clone()));
            }
        }

        let committed = existing_result
            .as_ref()
            .is_some_and(|result| result.state == RelationMigrationState::Committed);
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
        if let Err(error) = validate_relation_for_rollback(&current, &journal) {
            return self.failed_relation_result(&journal, error);
        }
        let backup = PathBuf::from(&prepared.backup_path);
        self.persist_relation_operation(
            prepared.operation_id,
            OperationPhase::Applying,
            RelationMigrationState::Committed,
            &journal,
            None,
            None,
        )?;
        if let Err(error) = recover_relation_entry(&current, &backup) {
            return self.failed_relation_result(&journal, error);
        }
        self.persist_relation_operation(
            prepared.operation_id,
            OperationPhase::Verifying,
            RelationMigrationState::Committed,
            &journal,
            None,
            None,
        )?;
        if let Err(error) =
            self.with_database("execute.rollback_relation_migration.record", |database| {
                database
                    .relationship_repository()
                    .upsert_deployment_relation(&prepared.relation)
            })
        {
            return self.failed_relation_result(&journal, error);
        }
        let result = migration_result_from_prepared(
            &prepared,
            RelationMigrationState::RolledBack,
            Some(prepared.backup_path.clone()),
            None,
            Vec::new(),
        );
        self.persist_relation_operation(
            result.operation_id,
            OperationPhase::RolledBack,
            RelationMigrationState::RolledBack,
            &journal,
            Some(&result),
            None,
        )?;
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
        let result = migration_result_from_prepared(
            prepared,
            RelationMigrationState::Failed,
            Some(prepared.backup_path.clone())
                .filter(|_| Path::new(&prepared.backup_path).exists()),
            Some(error.code),
            tasks,
        );
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

    fn load_relation_migration_journal(
        &self,
        operation_id: OperationId,
    ) -> AppResult<(RelationMigrationJournal, Option<RelationMigrationResult>)> {
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
                .or_else(|| record.recovery_data.get("prepared").cloned())
                .ok_or_else(|| {
                    invalid_relation_migration("relationship journal facts are missing")
                })?;
            let journal = if let Some(prepared_value) = journal_value.get("prepared") {
                let prepared: skillhub_core::PreparedRelationMigration =
                    serde_json::from_value(prepared_value.clone()).map_err(|_| {
                        invalid_relation_migration("relationship journal facts are corrupt")
                    })?;
                let expected_target_fingerprint = journal_value
                    .get("expected_target_fingerprint")
                    .and_then(|value| value.as_str())
                    .map(str::to_owned)
                    .unwrap_or(DeploymentFilesystem::hash_tree(&prepared.target_path)?);
                RelationMigrationJournal::from_prepared(prepared, expected_target_fingerprint)
            } else {
                let prepared: skillhub_core::PreparedRelationMigration =
                    serde_json::from_value(journal_value).map_err(|_| {
                        invalid_relation_migration("prepared relationship facts are corrupt")
                    })?;
                let target_fingerprint = DeploymentFilesystem::hash_tree(&prepared.target_path)?;
                RelationMigrationJournal::from_prepared(prepared, target_fingerprint)
            };
            let result = record
                .result
                .and_then(|value| serde_json::from_value(value).ok());
            return Ok((journal, result));
        }

        let prepared = self
            .prepared_relation_migrations
            .lock()
            .map_err(|_| internal("operation_journal.relationship_migration.load"))?
            .get(&operation_id)
            .cloned()
            .ok_or_else(|| relation_operation_not_found(operation_id))?;
        let target_fingerprint = DeploymentFilesystem::hash_tree(&prepared.target_path)?;
        Ok((
            RelationMigrationJournal::from_prepared(prepared, target_fingerprint),
            None,
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
                "backup": {
                    "path": journal.backup.path,
                    "original_fingerprint": journal.backup.original_fingerprint,
                    "original_relationship": journal.backup.original_relationship,
                    "original_representation": journal.backup.original_representation,
                    "original_ownership": journal.backup.original_ownership,
                    "original_active": journal.backup.original_active,
                },
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

fn backup_relation_entry(relation: &DeploymentRelationFact, backup: &Path) -> AppResult<()> {
    if backup.exists() {
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
    if metadata.file_type().is_symlink() {
        let target =
            fs::read_link(&relation.path).map_err(|error| io_conflict(&relation.path, error))?;
        create_dir_link(&target, backup)
    } else {
        super::copy_directory_tree(Path::new(&relation.path), backup)
    }
}

fn restore_relation_entry(relation: &DeploymentRelationFact, backup: &Path) -> AppResult<()> {
    if backup.is_dir() || fs::symlink_metadata(backup).is_ok() {
        let metadata = fs::symlink_metadata(backup).map_err(|error| io_conflict(backup, error))?;
        if metadata.file_type().is_symlink() {
            let target = fs::read_link(backup).map_err(|error| io_conflict(backup, error))?;
            create_dir_link(&target, Path::new(&relation.path))
        } else {
            super::copy_directory_tree(backup, Path::new(&relation.path))
        }
    } else {
        Err(invalid_relation_migration(
            "relationship backup is unavailable",
        ))
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

fn recover_relation_entry(relation: &DeploymentRelationFact, backup: &Path) -> AppResult<()> {
    // Do not follow a possibly-new link while restoring the original copy.
    // The link itself must be removed before the backup directory is copied.
    match fs::symlink_metadata(&relation.path) {
        Ok(_) => remove_relation_entry(Path::new(&relation.path))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_conflict(&relation.path, error)),
    }
    restore_relation_entry(relation, backup)
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
                || actual_target != PathBuf::from(&prepared.target_path)
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

fn relation_path_is_inaccessible(path: &str) -> bool {
    let metadata = match fs::symlink_metadata(path) {
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

fn internal(operation: &'static str) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("operation", operation)
        .with_action(RecoveryAction::Retry)
}
