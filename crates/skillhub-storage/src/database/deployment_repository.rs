use super::Database;
use async_trait::async_trait;
use rusqlite::{params, OptionalExtension};
use skillhub_core::deployment::{
    DeploymentMode, DeploymentRecord, DeploymentRepository as DeploymentRepositoryPort,
    DeploymentState,
};
use skillhub_core::relationship::RelationHealthReason;
use skillhub_core::{
    AppError, AppResult, DeploymentId, ErrorCode, OperationPhase, RecoveryAction, Severity,
    SkillId, VersionRecord,
};

/// SQLite persistence for deployment facts.  The planner itself remains in
/// skillhub-core and does not depend on this repository.
pub struct DeploymentRepositorySqlite<'a> {
    pub(crate) database: &'a Database,
}

pub type DeploymentRepository<'a> = DeploymentRepositorySqlite<'a>;

impl<'a> DeploymentRepositorySqlite<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    /// Synchronous projection used by the local application facade. The
    /// repository trait remains async for service compatibility, while this
    /// read has no I/O beyond the already-open SQLite connection.
    pub fn list_all(&self) -> AppResult<Vec<DeploymentRecord>> {
        let mut statement = self
            .database
            .connection
            .prepare("SELECT id,skill_id,version_id,target_id,state,method,managed,runtime_name,expected_hash,observed_hash FROM deployments ORDER BY created_at,id")
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            })
            .map_err(database_error)?;
        rows.map(|row| {
            let row = row.map_err(database_error)?;
            let id = row.0.parse().map_err(|_| invalid_record())?;
            decode_record(
                id,
                (
                    row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9,
                ),
            )
        })
        .collect()
    }

    /// Synchronous write used by filesystem-backed application operations.
    /// The caller already serializes access to the open database connection.
    ///
    /// One `(target_id, runtime_name)` position holds exactly one row. Removing
    /// a deployment only marks that row `removed`, so adding the same Skill to
    /// the same Agent again must reactivate it: a plain insert would hit the
    /// table's `UNIQUE(target_id, runtime_name)` constraint and strand the
    /// directory that was already written to disk. The existing row keeps its
    /// id so relationship keys (`managed:<deployment id>`) stay stable.
    ///
    /// Returns the id the row actually carries, which the caller must use for
    /// anything that points back at this deployment.
    pub fn insert_sync(&self, deployment: &DeploymentRecord) -> AppResult<DeploymentId> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        let existing_id = transaction
            .query_row(
                "SELECT id FROM deployments WHERE target_id=?1 AND runtime_name=?2",
                params![deployment.target_id, deployment.runtime_name],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?;
        let effective_id = match existing_id.as_deref() {
            Some(id) => id.parse().map_err(|_| invalid_record())?,
            None => deployment.id,
        };
        let mut effective = deployment.clone();
        effective.id = effective_id;
        if existing_id.is_some() {
            transaction
                .execute(
                    "UPDATE deployments SET skill_id=?1,version_id=?2,target_id=?3,state=?4,method=?5,managed=?6,runtime_name=?7,expected_hash=?8,observed_hash=?9,updated_at=?10 WHERE id=?11",
                    params![
                        effective.skill_id.to_string(),
                        effective.version_id.to_string(),
                        effective.target_id,
                        state_code(effective.state),
                        mode_code(effective.mode),
                        i64::from(effective.managed),
                        effective.runtime_name,
                        effective.expected_hash,
                        effective.observed_hash,
                        now(),
                        effective_id.to_string(),
                    ],
                )
                .map_err(database_error)?;
        } else {
            transaction
                .execute(
                    "INSERT INTO deployments (id,skill_id,version_id,target_id,state,method,managed,runtime_name,expected_hash,observed_hash,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)",
                    params![
                        effective_id.to_string(),
                        effective.skill_id.to_string(),
                        effective.version_id.to_string(),
                        effective.target_id,
                        state_code(effective.state),
                        mode_code(effective.mode),
                        i64::from(effective.managed),
                        effective.runtime_name,
                        effective.expected_hash,
                        effective.observed_hash,
                        now(),
                    ],
                )
                .map_err(database_error)?;
        }
        let relationship_changed = self
            .database
            .relationship_repository()
            .sync_managed_deployment_tx(&transaction, &effective)?;
        if relationship_changed {
            super::relationship_repository::bump_relationship_revision_tx(&transaction)?;
        }
        transaction.commit().map_err(database_error)?;
        Ok(effective_id)
    }

    pub fn mark_removed_sync(&self, id: DeploymentId) -> AppResult<()> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        transaction
            .execute(
                "UPDATE deployments SET state='removed', updated_at=?1 WHERE id=?2 AND state IN ('deployed','active')",
                params![now(), id.to_string()],
            )
            .map_err(database_error)
            .and_then(|changed| {
                if changed == 1 {
                    Ok(())
                } else {
                    Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                        .with_param("field", "deployment")
                        .with_action(RecoveryAction::Retry))
                }
            })?;
        let relationship_changed = self
            .database
            .relationship_repository()
            .mark_managed_deployment_removed_tx(&transaction, &id.to_string(), now())?;
        if relationship_changed {
            super::relationship_repository::bump_relationship_revision_tx(&transaction)?;
        }
        transaction.commit().map_err(database_error)
    }

    pub fn detach_management_sync(&self, id: DeploymentId) -> AppResult<()> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        transaction
            .execute(
                "UPDATE deployments SET managed=0, updated_at=?1 WHERE id=?2 AND state IN ('deployed','active')",
                params![now(), id.to_string()],
            )
            .map_err(database_error)
            .and_then(|changed| {
                if changed == 1 {
                    Ok(())
                } else {
                    Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                        .with_param("field", "deployment")
                        .with_action(RecoveryAction::Retry))
                }
            })?;
        let relationship_changed = self
            .database
            .relationship_repository()
            .detach_managed_deployment_tx(&transaction, &id.to_string())?;
        if relationship_changed {
            super::relationship_repository::bump_relationship_revision_tx(&transaction)?;
        }
        transaction.commit().map_err(database_error)
    }

    pub fn update_reconcile_facts_sync(
        &self,
        id: DeploymentId,
        version_id: &skillhub_core::VersionId,
        expected_hash: &str,
        observed_hash: Option<&str>,
    ) -> AppResult<()> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        let observed_at = now();
        transaction
            .execute(
                "UPDATE deployments SET version_id=?1, expected_hash=?2, observed_hash=?3, updated_at=?4 WHERE id=?5 AND state IN ('deployed','active')",
                params![
                    version_id.to_string(),
                    expected_hash,
                    observed_hash,
                    observed_at,
                    id.to_string(),
                ],
            )
            .map_err(database_error)
            .and_then(|changed| {
                if changed == 1 {
                    Ok(())
                } else {
                    Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                        .with_param("field", "deployment")
                        .with_action(RecoveryAction::Retry))
                }
            })?;
        let relationship_changed = super::relationship_repository::sync_reconciled_deployment_tx(
            &transaction,
            &id.to_string(),
            expected_hash,
            observed_hash,
            observed_at,
        )?;
        if relationship_changed {
            super::relationship_repository::bump_relationship_revision_tx(&transaction)?;
        }
        transaction.commit().map_err(database_error)
    }

    /// Registers the captured immutable version, updates deployment and
    /// relationship facts, and commits the operation journal in one SQLite
    /// transaction. A failed journal write therefore cannot leave the
    /// deployment pointing at an uncommitted version.
    pub fn commit_reconcile_collection_sync(
        &self,
        id: DeploymentId,
        version: &VersionRecord,
        operation_id: skillhub_core::OperationId,
    ) -> AppResult<()> {
        let mut operation = self
            .database
            .operation_repository()
            .get_sync(operation_id)?
            .ok_or_else(|| {
                AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("operation_id", operation_id.to_string())
            })?;
        if operation.kind != "reconcile_collect_changes"
            || operation.phase != OperationPhase::Prepared
        {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("operation_id", operation_id.to_string()));
        }
        let expected_hash = &version.manifest.tree_hash;
        operation.phase = OperationPhase::Committed;
        operation.progress.phase = OperationPhase::Committed;
        operation.progress.completed = 1;
        operation.progress.total = 1;
        operation.progress.message_code =
            "operation.reconcile_collect_changes.committed".to_owned();
        operation.result = Some(serde_json::json!({
            "deployment_id": id.to_string(),
            "version_id": version.id.to_string(),
        }));

        let skill_id: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT skill_id FROM deployments WHERE id=?1",
                [id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        let skill_id = skill_id
            .ok_or_else(|| {
                AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("field", "deployment")
                    .with_action(RecoveryAction::Retry)
            })?
            .parse::<SkillId>()
            .map_err(|_| invalid_record())?;
        if version.manifest.skill_id != skill_id {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "version_skill_id")
                .with_action(RecoveryAction::Retry));
        }
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        let manifest = serde_json::to_string(&version.manifest).map_err(|error| {
            AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("source", error.to_string())
                .with_action(RecoveryAction::Retry)
        })?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    version.id.to_string(),
                    version.manifest.skill_id.to_string(),
                    version.manifest.tree_hash,
                    manifest,
                    now(),
                ],
            )
            .map_err(database_error)?;
        let observed_at = now();
        let changed = transaction
            .execute(
                "UPDATE deployments SET version_id=?1, expected_hash=?2, observed_hash=?3, updated_at=?4 WHERE id=?5 AND state IN ('deployed','active') AND skill_id=?6",
                params![
                    version.id.to_string(),
                    expected_hash,
                    expected_hash,
                    observed_at,
                    id.to_string(),
                    skill_id.to_string(),
                ],
            )
            .map_err(database_error)?;
        if changed != 1 {
            return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("field", "deployment")
                .with_action(RecoveryAction::Retry));
        }
        let relationship_changed = super::relationship_repository::sync_reconciled_deployment_tx(
            &transaction,
            &id.to_string(),
            expected_hash,
            Some(expected_hash),
            observed_at,
        )?;
        if relationship_changed {
            super::relationship_repository::bump_relationship_revision_tx(&transaction)?;
        }
        super::operation_repository::OperationRepositorySqlite::commit_prepared_tx(
            &transaction,
            &operation,
        )?;
        transaction.commit().map_err(database_error)
    }

    /// Updates the runtime path and pinned version of one existing managed
    /// deployment without reusing another row that happens to own the new
    /// `(target, runtime_name)` pair.
    pub fn rename_runtime_sync(
        &self,
        deployment: &DeploymentRecord,
        previous_runtime_name: &str,
    ) -> AppResult<()> {
        self.rename_runtime_for_skill_sync(deployment, deployment.skill_id, previous_runtime_name)
    }

    /// Reassigns one managed deployment to a new independent Skill while
    /// changing its runtime path, preserving the stable deployment identity.
    pub fn derive_managed_runtime_sync(
        &self,
        deployment: &DeploymentRecord,
        previous_skill_id: skillhub_core::SkillId,
        previous_runtime_name: &str,
    ) -> AppResult<()> {
        self.rename_runtime_for_skill_sync(deployment, previous_skill_id, previous_runtime_name)
    }

    fn rename_runtime_for_skill_sync(
        &self,
        deployment: &DeploymentRecord,
        previous_skill_id: skillhub_core::SkillId,
        previous_runtime_name: &str,
    ) -> AppResult<()> {
        if !deployment.managed || deployment.state != DeploymentState::Deployed {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "managed_deployment_not_renameable")
                .with_action(RecoveryAction::InspectTarget));
        }
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        let collision = transaction
            .query_row(
                "SELECT id FROM deployments WHERE target_id=?1 AND runtime_name=?2 AND id<>?3",
                params![
                    deployment.target_id,
                    deployment.runtime_name,
                    deployment.id.to_string()
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?;
        if collision.is_some() {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "subject_rename_deployment_name_conflict")
                .with_action(RecoveryAction::ChooseAnotherName));
        }
        let changed = transaction
            .execute(
                "UPDATE deployments SET skill_id=?1,runtime_name=?2,version_id=?3,expected_hash=?4,observed_hash=?5,updated_at=?6 WHERE id=?7 AND skill_id=?8 AND target_id=?9 AND runtime_name=?10 AND state='deployed' AND managed=1",
                params![
                    deployment.skill_id.to_string(),
                    deployment.runtime_name,
                    deployment.version_id.to_string(),
                    deployment.expected_hash,
                    deployment.observed_hash,
                    now(),
                    deployment.id.to_string(),
                    previous_skill_id.to_string(),
                    deployment.target_id,
                    previous_runtime_name,
                ],
            )
            .map_err(database_error)?;
        if changed != 1 {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "subject_rename_deployment_changed")
                .with_action(RecoveryAction::InspectTarget));
        }
        let target_path = transaction
            .query_row(
                "SELECT path FROM targets WHERE id=?1",
                [deployment.target_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .map_err(database_error)?;
        let relationship_changed = self
            .database
            .relationship_repository()
            .rename_managed_deployment_tx(
                &transaction,
                &deployment.id.to_string(),
                deployment.skill_id,
                &super::relationship_repository::deployment_entry_path(
                    &target_path,
                    &deployment.runtime_name,
                ),
                &deployment.expected_hash,
                now(),
            )?;
        if relationship_changed {
            super::relationship_repository::bump_relationship_revision_tx(&transaction)?;
        }
        transaction.commit().map_err(database_error)
    }

    /// Keeps a failed managed usage change visible while leaving deployment
    /// ownership, its pinned version, and the last observed target anomaly intact.
    pub fn mark_managed_usage_change_failed(&self, id: DeploymentId) -> AppResult<()> {
        let relation_id = format!("managed:{id}");
        let repository = self.database.relationship_repository();
        let mut relation = repository
            .list_relations()?
            .into_iter()
            .find(|relation| relation.relation_id == relation_id && relation.active)
            .ok_or_else(|| {
                AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("field", "managed_deployment_relation")
                    .with_action(RecoveryAction::Retry)
            })?;
        let mut reasons = relation.health_reasons.take().unwrap_or_default();
        if !reasons.contains(&RelationHealthReason::OperationFailed) {
            reasons.push(RelationHealthReason::OperationFailed);
        }
        reasons.sort_by_key(|reason| *reason as u8);
        reasons.dedup();
        relation.health_reasons = Some(reasons);
        relation.observed_at = now();
        repository.upsert_deployment_relation(&relation)
    }
}

#[async_trait(?Send)]
impl DeploymentRepositoryPort for DeploymentRepositorySqlite<'_> {
    async fn insert(&self, deployment: &DeploymentRecord) -> AppResult<()> {
        self.insert_sync(deployment).map(|_| ())
    }

    async fn get(&self, id: DeploymentId) -> AppResult<Option<DeploymentRecord>> {
        self.database
            .connection
            .query_row(
                "SELECT skill_id,version_id,target_id,state,method,managed,runtime_name,expected_hash,observed_hash FROM deployments WHERE id=?1",
                [id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?
            .map(|row| decode_record(id, row))
            .transpose()
    }

    async fn list(&self) -> AppResult<Vec<DeploymentRecord>> {
        self.list_all()
    }

    async fn list_for_target(&self, target_id: &str) -> AppResult<Vec<DeploymentRecord>> {
        let mut statement = self
            .database
            .connection
            .prepare("SELECT id,skill_id,version_id,target_id,state,method,managed,runtime_name,expected_hash,observed_hash FROM deployments WHERE target_id=?1 ORDER BY created_at,id")
            .map_err(database_error)?;
        let rows = statement
            .query_map([target_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            })
            .map_err(database_error)?;
        rows.map(|row| {
            let row = row.map_err(database_error)?;
            let id = row.0.parse().map_err(|_| invalid_record())?;
            decode_record(
                id,
                (
                    row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9,
                ),
            )
        })
        .collect()
    }
}

type StoredRecord = (
    String,
    String,
    String,
    String,
    String,
    i64,
    String,
    String,
    Option<String>,
);

fn decode_record(id: DeploymentId, row: StoredRecord) -> AppResult<DeploymentRecord> {
    Ok(DeploymentRecord {
        id,
        skill_id: row.0.parse().map_err(|_| invalid_record())?,
        version_id: row.1.parse().map_err(|_| invalid_record())?,
        target_id: row.2,
        state: parse_state(&row.3)?,
        mode: parse_mode(&row.4)?,
        managed: row.5 != 0,
        runtime_name: row.6,
        expected_hash: row.7,
        observed_hash: row.8,
    })
}

fn state_code(value: DeploymentState) -> &'static str {
    match value {
        DeploymentState::Planned => "planned",
        DeploymentState::Deployed => "deployed",
        DeploymentState::Removed => "removed",
        DeploymentState::NeedsRecovery => "needs_recovery",
    }
}

fn parse_state(value: &str) -> AppResult<DeploymentState> {
    match value {
        "planned" => Ok(DeploymentState::Planned),
        "deployed" | "active" => Ok(DeploymentState::Deployed),
        "removed" => Ok(DeploymentState::Removed),
        "needs_recovery" => Ok(DeploymentState::NeedsRecovery),
        _ => Err(invalid_record()),
    }
}

fn mode_code(value: DeploymentMode) -> &'static str {
    match value {
        DeploymentMode::SymbolicLink => "symbolic_link",
        DeploymentMode::DirectoryJunction => "directory_junction",
        DeploymentMode::ManagedCopy => "managed_copy",
    }
}

fn parse_mode(value: &str) -> AppResult<DeploymentMode> {
    match value {
        "symbolic_link" => Ok(DeploymentMode::SymbolicLink),
        "directory_junction" => Ok(DeploymentMode::DirectoryJunction),
        "managed_copy" => Ok(DeploymentMode::ManagedCopy),
        _ => Err(invalid_record()),
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn invalid_record() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("reason", "deployment_record_corrupt")
        .with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    // 2067（UNIQUE）→ TargetExists 的既有语义由共享分类统一维护。
    super::classify_database_error(error)
}
