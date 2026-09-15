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
    calculate_removal_impact, ConflictCaseFact, DeploymentRelationFact, GovernanceTaskFact,
    GovernanceTaskKind, RelationshipType, RemovalFacts,
};
use skillhub_core::{
    AppError, AppResult, ErrorCode, InverseOperation, OperationId, OperationObjectResult,
    OperationPhase, RecoveryAction, RelationMigrationResult, RelationMigrationState, Severity,
};

use crate::LocalApplicationFacade;

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
            let mut impact = calculate_removal_impact(
                relation_id,
                &RemovalFacts::new(
                    snapshot.deployments.clone(),
                    snapshot.directory_capabilities.clone(),
                ),
            );
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
            authorize_paths(&relation.path, &target_path, &self.library_root()?)?;
            let target_fingerprint = DeploymentFilesystem::hash_tree(&target_path)?;
            if target_fingerprint != current_fingerprint {
                return Err(AppError::new(ErrorCode::TargetChanged, Severity::Error)
                    .with_param("path", target_path.to_string_lossy().into_owned())
                    .with_param("detail", "central target fingerprint differs")
                    .with_action(RecoveryAction::InspectTarget));
            }

            let mut governance_tasks = calculate_removal_impact(
                &request.relation_id,
                &RemovalFacts::new(
                    snapshot.deployments.clone(),
                    snapshot.directory_capabilities.clone(),
                ),
            )
            .governance_tasks;
            let shared_impact = matches!(
                relation.relationship,
                RelationshipType::SharedDirectoryRead | RelationshipType::SharedDirectoryReference
            ) || !calculate_removal_impact(
                &request.relation_id,
                &RemovalFacts::new(snapshot.deployments, snapshot.directory_capabilities),
            )
            .other_consumers
            .is_empty();
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
                self.persist_relation_operation(
                    prepared.operation_id,
                    OperationPhase::Prepared,
                    RelationMigrationState::Prepared,
                    &prepared,
                    None,
                    None,
                );
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

    pub(crate) fn commit_relation_migration(
        &self,
        request: skillhub_core::api::CommitRelationMigration,
    ) -> AppResult<AppCommandResult> {
        let prepared = self
            .prepared_relation_migrations
            .lock()
            .map_err(|_| internal("execute.commit_relation_migration"))?
            .get(&request.prepared_relation_migration_id)
            .cloned()
            .ok_or_else(|| relation_operation_not_found(request.prepared_relation_migration_id))?;

        if let Some(existing) = self
            .relation_migration_results
            .lock()
            .map_err(|_| internal("execute.commit_relation_migration"))?
            .get(&prepared.operation_id)
            .cloned()
        {
            return Ok(AppCommandResult::RelationMigrationResult(existing));
        }

        let relation = match self.current_relation(&prepared.relation_id) {
            Ok(relation) => relation,
            Err(error) => return self.failed_relation_result(&prepared, error),
        };
        if !relation.active || relation.path != prepared.relation.path {
            return self.failed_relation_result(&prepared, target_changed(&relation.path));
        }
        let current_fingerprint = match DeploymentFilesystem::hash_tree(&relation.path) {
            Ok(value) => value,
            Err(error) => return self.failed_relation_result(&prepared, error),
        };
        if current_fingerprint != prepared.current_content_fingerprint
            || relation.content_fingerprint != prepared.relation.content_fingerprint
        {
            return self.failed_relation_result(&prepared, target_changed(&relation.path));
        }
        let target_path = match self.central_path_for_relation(&relation) {
            Ok(value) => value,
            Err(error) => return self.failed_relation_result(&prepared, error),
        };
        if target_path.to_string_lossy() != prepared.target_path {
            return self.failed_relation_result(&prepared, target_changed(&prepared.target_path));
        }
        let target_fingerprint = match DeploymentFilesystem::hash_tree(&target_path) {
            Ok(value) => value,
            Err(error) => return self.failed_relation_result(&prepared, error),
        };
        if target_fingerprint != current_fingerprint {
            return self.failed_relation_result(&prepared, target_changed(&prepared.target_path));
        }
        if !prepared.governance_tasks.is_empty() {
            let error =
                invalid_relation_migration("relationship governance confirmation is pending");
            return self.failed_relation_result(&prepared, error);
        }

        let capabilities = DeploymentFilesystem::new().available_capabilities();
        let mode = if capabilities.symlink {
            DeploymentMode::SymbolicLink
        } else if capabilities.junction {
            DeploymentMode::DirectoryJunction
        } else {
            let error = AppError::new(ErrorCode::SymlinkNotSupported, Severity::Warning)
                .with_action(RecoveryAction::OpenReadOnly);
            return self.failed_relation_result(&prepared, error);
        };
        if let Err(error) = authorize_paths(&relation.path, &target_path, &self.library_root()?) {
            return self.failed_relation_result(&prepared, error);
        }

        let backup_path = PathBuf::from(&prepared.backup_path);
        if let Err(error) = backup_relation_entry(&relation, &backup_path) {
            return self.failed_relation_result(&prepared, error);
        }
        if let Err(error) = remove_relation_entry(Path::new(&relation.path)) {
            return self.failed_relation_result(&prepared, error);
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
                version_id: self.current_version_for_relation(&relation)?,
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
                let _ = restore_relation_entry(&relation, &backup_path);
                return self.failed_relation_result(&prepared, error);
            }
        };

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
            let _ = remove_relation_entry(Path::new(&relation.path));
            let _ = restore_relation_entry(&relation, &backup_path);
            return self.failed_relation_result(&prepared, error);
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
        self.relation_migration_results
            .lock()
            .map_err(|_| internal("execute.commit_relation_migration"))?
            .insert(result.operation_id, result.clone());
        self.persist_relation_operation(
            result.operation_id,
            OperationPhase::Committed,
            RelationMigrationState::Committed,
            &prepared,
            Some(&result),
            None,
        );
        Ok(AppCommandResult::RelationMigrationResult(result))
    }

    pub(crate) fn rollback_relation_migration(
        &self,
        request: skillhub_core::api::RollbackRelationMigration,
    ) -> AppResult<AppCommandResult> {
        let prepared = self
            .prepared_relation_migrations
            .lock()
            .map_err(|_| internal("execute.rollback_relation_migration"))?
            .get(&request.operation_id)
            .cloned()
            .ok_or_else(|| relation_operation_not_found(request.operation_id))?;
        if let Some(existing) = self
            .relation_migration_results
            .lock()
            .map_err(|_| internal("execute.rollback_relation_migration"))?
            .get(&request.operation_id)
            .cloned()
        {
            if existing.state == RelationMigrationState::RolledBack
                || existing.state == RelationMigrationState::Cancelled
            {
                return Ok(AppCommandResult::RelationMigrationResult(existing));
            }
        }

        let committed = self
            .relation_migration_results
            .lock()
            .map_err(|_| internal("execute.rollback_relation_migration"))?
            .get(&request.operation_id)
            .is_some_and(|result| result.state == RelationMigrationState::Committed);
        if !committed {
            let result = migration_result_from_prepared(
                &prepared,
                RelationMigrationState::Cancelled,
                None,
                None,
                prepared.governance_tasks.clone(),
            );
            self.relation_migration_results
                .lock()
                .map_err(|_| internal("execute.rollback_relation_migration"))?
                .insert(result.operation_id, result.clone());
            self.persist_relation_operation(
                result.operation_id,
                OperationPhase::RolledBack,
                RelationMigrationState::Cancelled,
                &prepared,
                Some(&result),
                None,
            );
            return Ok(AppCommandResult::RelationMigrationResult(result));
        }

        let current = self.current_relation(&prepared.relation_id)?;
        let backup = PathBuf::from(&prepared.backup_path);
        if let Err(error) = remove_relation_entry(Path::new(&current.path))
            .and_then(|_| restore_relation_entry(&prepared.relation, &backup))
        {
            return self.failed_relation_result(&prepared, error);
        }
        self.with_database("execute.rollback_relation_migration.record", |database| {
            database
                .relationship_repository()
                .upsert_deployment_relation(&prepared.relation)
        })?;
        let result = migration_result_from_prepared(
            &prepared,
            RelationMigrationState::RolledBack,
            Some(prepared.backup_path.clone()),
            None,
            Vec::new(),
        );
        self.relation_migration_results
            .lock()
            .map_err(|_| internal("execute.rollback_relation_migration"))?
            .insert(result.operation_id, result.clone());
        self.persist_relation_operation(
            result.operation_id,
            OperationPhase::RolledBack,
            RelationMigrationState::RolledBack,
            &prepared,
            Some(&result),
            None,
        );
        Ok(AppCommandResult::RelationMigrationResult(result))
    }

    fn failed_relation_result(
        &self,
        prepared: &skillhub_core::PreparedRelationMigration,
        error: AppError,
    ) -> AppResult<AppCommandResult> {
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
        let _ = self.with_database("execute.relation_migration.recovery_task", |database| {
            database.governance_task_repository().create(&task)
        });
        let result = migration_result_from_prepared(
            prepared,
            RelationMigrationState::Failed,
            Some(prepared.backup_path.clone())
                .filter(|_| Path::new(&prepared.backup_path).exists()),
            Some(error.code),
            tasks,
        );
        self.relation_migration_results
            .lock()
            .map_err(|_| internal("execute.relation_migration.failure"))?
            .insert(result.operation_id, result.clone());
        self.persist_relation_operation(
            result.operation_id,
            OperationPhase::NeedsRecovery,
            RelationMigrationState::Failed,
            prepared,
            Some(&result),
            Some(error.code),
        );
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
        prepared: &skillhub_core::PreparedRelationMigration,
        result: Option<&RelationMigrationResult>,
        error_code: Option<ErrorCode>,
    ) {
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
        let _ = self.with_database("operation_journal.relationship_migration", |database| {
            database
                .operation_repository()
                .update_sync(&record)
                .or_else(|_| database.operation_repository().insert_sync(&record))
        });
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
        || snapshot
            .deployments
            .iter()
            .any(|relation| relation.relation_id == task.subject_id)
        || snapshot.deployments.iter().any(|relation| {
            relation
                .skill_id
                .map(|skill_id| skill_id.to_string() == subject)
                .unwrap_or(false)
                && relation.relation_id == task.subject_id
        })
}

fn validate_relation_for_prepare(relation: &DeploymentRelationFact) -> AppResult<()> {
    if !relation.active || relation.released_at.is_some() {
        return Err(invalid_relation_migration("relationship is not active"));
    }
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
            | RelationshipType::SharedDirectoryReference
    ) {
        return Err(invalid_relation_migration(
            "relationship type cannot be converted by this operation",
        ));
    }
    Ok(())
}

fn authorize_paths(relation_path: &str, target_path: &Path, library_root: &Path) -> AppResult<()> {
    let relation = Path::new(relation_path);
    let relation_canonical =
        fs::canonicalize(relation).map_err(|_| path_boundary(relation_path))?;
    let relation_root = relation_canonical
        .parent()
        .ok_or_else(|| path_boundary(relation_path))?;
    let mut policy = skillhub_core::PathPolicy::new();
    policy.register_root(skillhub_core::AllowedRoot::new(relation_root)?)?;
    policy.register_root(skillhub_core::AllowedRoot::new(library_root)?)?;
    policy.authorize_existing(&relation_canonical)?;
    policy.authorize_existing(target_path)?;
    Ok(())
}

fn backup_relation_entry(relation: &DeploymentRelationFact, backup: &Path) -> AppResult<()> {
    if backup.exists() {
        return Err(invalid_relation_migration("backup path already exists"));
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
