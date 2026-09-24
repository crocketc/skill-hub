use super::Database;
use rusqlite::{params, OptionalExtension, Transaction};
use skillhub_core::deployment::observed_path_key;
use skillhub_core::deployment::{
    ObservedDeployment, ObservedMatchState, ObservedOrigin, ObservedRowAction, ObservedStatus,
};
use skillhub_core::import::{
    CandidateOwnership, ImportBatch, ImportProvenance, ImportProvenanceEvent, ImportSourceClass,
    OriginalMigrationResult, OriginalMigrationState,
};
use skillhub_core::relationship::{
    DeploymentRelationFact, FileRepresentation, OwnershipState, RelationshipType,
    SourceRelationFact,
};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{
    AppError, AppResult, ErrorCode, ObservedDeploymentId, OperationId, RecoveryAction, Severity,
    SkillId,
};

/// OPT-20260914-08 的持久化边界：导入存证、已观察部署关系与原始文件
/// 迁移审计。所有写入都是显式 upsert/状态迁移；同一路径重复导入或重复
/// 扫描不会产生重复行。
pub struct ProvenanceRepository<'a> {
    database: &'a Database,
}

/// Terminal status for closing an import batch. The 0019 schema CHECK admits
/// `completed`/`failed`/`cancelled` — a running batch cannot be a final state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImportBatchFinalStatus {
    Completed,
    Failed,
    Cancelled,
}

/// Outcome of one import candidate inside a batch (`import_batch_items`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImportBatchItemStatus {
    Succeeded,
    Failed,
    Cancelled,
    Skipped,
}

/// One candidate outcome to record for an import batch. `skill_id`,
/// `provenance_id`, and `source_relation_id` are optional because failed,
/// cancelled, and skipped candidates may never have produced those entities.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportBatchItemRecord {
    pub batch_id: String,
    pub candidate_key: String,
    pub skill_id: Option<SkillId>,
    pub provenance_id: Option<String>,
    pub source_relation_id: Option<String>,
    pub status: ImportBatchItemStatus,
    pub reason: Option<String>,
}

fn final_status_code(value: ImportBatchFinalStatus) -> &'static str {
    match value {
        ImportBatchFinalStatus::Completed => "completed",
        ImportBatchFinalStatus::Failed => "failed",
        ImportBatchFinalStatus::Cancelled => "cancelled",
    }
}

fn item_status_code(value: ImportBatchItemStatus) -> &'static str {
    match value {
        ImportBatchItemStatus::Succeeded => "succeeded",
        ImportBatchItemStatus::Failed => "failed",
        ImportBatchItemStatus::Cancelled => "cancelled",
        ImportBatchItemStatus::Skipped => "skipped",
    }
}

impl<'a> ProvenanceRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    /// 导入即存证。0014 规范化关系表以独立 provenance ID 保存每次事实；
    /// 旧 import_provenance 表只继续承担最新兼容投影，确保既有调用不破坏。
    ///
    /// Deprecated compatibility path (v19): this writes the immutable event via
    /// the legacy source-relation shape and classifies it as
    /// `legacy_unclassified` because the storage layer never guesses a source
    /// class. New import flows must call [`Self::append_provenance_event`] with
    /// an explicit classification instead.
    pub fn upsert_provenance(&self, provenance: &ImportProvenance) -> AppResult<()> {
        let relation = provenance.to_source_relation_fact();
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        let relationship_changed =
            super::relationship_repository::upsert_source_relation_tx(&transaction, &relation)?;
        Self::upsert_provenance_projection_tx(&transaction, provenance, true)?;
        if relationship_changed {
            super::relationship_repository::bump_relationship_revision_tx(&transaction)?;
        }
        transaction.commit().map_err(database_error)
    }

    /// Deprecated `import_provenance` latest-only projection write, shared by
    /// [`Self::upsert_provenance`] and the v19 single-transaction import
    /// outcome path. The immutable events stay authoritative; this table only
    /// keeps existing readers working. `overwrite=false` keeps first-import
    /// facts intact — a reuse confirmation must never rewrite the original
    /// provenance history of the reused Skill.
    pub fn upsert_provenance_projection_tx(
        transaction: &Transaction<'_>,
        provenance: &ImportProvenance,
        overwrite: bool,
    ) -> AppResult<()> {
        let on_conflict = if overwrite {
            "DO UPDATE SET \
             agent_client_id=excluded.agent_client_id, original_path=excluded.original_path, \
             source_kind=excluded.source_kind, source_locator=excluded.source_locator, \
             ownership=excluded.ownership, content_fingerprint=excluded.content_fingerprint, \
             imported_at=excluded.imported_at"
        } else {
            "DO NOTHING"
        };
        transaction
            .execute(
                &format!(
                    "INSERT INTO import_provenance \
                     (skill_id, agent_client_id, original_path, source_kind, source_locator, ownership, content_fingerprint, imported_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                     ON CONFLICT(skill_id) {on_conflict}"
                ),
                params![
                    provenance.skill_id.to_string(),
                    provenance.agent_client_id,
                    provenance.original_path,
                    source_kind_code(&provenance.source.kind),
                    source_locator_text(&provenance.source.locator),
                    ownership_code(provenance.ownership),
                    provenance.content_fingerprint,
                    provenance.imported_at,
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    /// Deprecated latest-only compatibility projection over the immutable
    /// import events (the `import_provenance` table carries the schema-level
    /// `deprecated_projection` marker since v19). New callers should read
    /// [`Self::list_provenance_events_for_skill`] instead.
    pub fn provenance_for_skill(&self, skill_id: SkillId) -> AppResult<Option<ImportProvenance>> {
        let row = self
            .database
            .connection
            .query_row(
                "SELECT skill_id, agent_client_id, original_path, source_kind, source_locator, ownership, content_fingerprint, imported_at \
                 FROM import_provenance WHERE skill_id=?1",
                [skill_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, i64>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?;
        if let Some(value) = row {
            return decode_provenance(value)
                .ok_or_else(invalid_record)
                .map(Some);
        }
        Ok(self
            .database
            .relationship_repository()
            .list_source_relations_for_skill(skill_id)?
            .into_iter()
            .last()
            .map(provenance_from_relation))
    }

    /// Returns immutable provenance facts in chronological order.  Re-imports
    /// with a different imported_at or source path remain separate rows.
    pub fn list_provenance_for_skill(&self, skill_id: SkillId) -> AppResult<Vec<ImportProvenance>> {
        Ok(self
            .database
            .relationship_repository()
            .list_source_relations_for_skill(skill_id)?
            .into_iter()
            .map(provenance_from_relation)
            .collect())
    }

    /// Opens an import batch (`status='running'`). Batch bookkeeping is not a
    /// relationship fact and never invalidates the relationship projection.
    pub fn begin_import_batch(&self, batch_id: &str, started_at: i64) -> AppResult<()> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        Self::begin_import_batch_tx(&transaction, batch_id, started_at)?;
        transaction.commit().map_err(database_error)
    }

    /// Caller-transaction seam for cross-repository writes: opens the batch
    /// inside the caller's transaction so batches, provenance events, and
    /// source-copy relations commit or roll back together.
    pub fn begin_import_batch_tx(
        transaction: &Transaction<'_>,
        batch_id: &str,
        started_at: i64,
    ) -> AppResult<()> {
        transaction
            .execute(
                "INSERT INTO import_batches (batch_id, status, started_at) VALUES (?1, 'running', ?2)",
                params![batch_id, started_at],
            )
            .map(|_| ())
            .map_err(database_error)
    }

    /// Persists one immutable import event under an already opened batch.
    /// Events are evidence: a provenance ID can never be rewritten, and the
    /// online source-coordinate validation from the domain layer runs again
    /// before anything is written.
    pub fn append_provenance_event(&self, event: &ImportProvenanceEvent) -> AppResult<()> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        Self::append_provenance_event_tx(&transaction, event)?;
        transaction.commit().map_err(database_error)
    }

    /// Caller-transaction seam for appending an event. The event is visible to
    /// the `source_relations` compatibility view, so a successful append bumps
    /// the relationship projection revision.
    pub fn append_provenance_event_tx(
        transaction: &Transaction<'_>,
        event: &ImportProvenanceEvent,
    ) -> AppResult<()> {
        if !event.has_valid_source_coordinates() {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "source_coordinates")
                .with_action(RecoveryAction::Retry));
        }
        let source_kind = source_kind_code(&event.source.kind);
        let source_locator = source_locator_text(&event.source.locator);
        let source_path = event
            .local_source_path
            .clone()
            .unwrap_or_else(|| source_locator.clone());
        transaction
            .execute(
                "INSERT INTO import_provenance_events_v19 (
                    provenance_id, batch_id, skill_id, agent_client_id, source_path,
                    source_path_key, relationship, file_representation, ownership,
                    link_target_path, link_target_directory_id, content_fingerprint,
                    source_kind, source_locator, imported_at, source_class,
                    local_source_path, source_container_id, physical_source_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'import_copy', 'directory',
                     CASE WHEN ?7 = 'central_library' THEN 'skillhub_managed'
                          ELSE 'observed_unmanaged' END,
                     NULL, NULL, ?8, ?9, ?10, ?11, ?7, ?12, ?13, ?14)",
                params![
                    event.provenance_id,
                    event.batch_id,
                    event.skill_id.to_string(),
                    event.agent_client_id,
                    source_path,
                    observed_path_key(&source_path),
                    source_class_code(event.source_class),
                    event.content_fingerprint,
                    source_kind,
                    source_locator,
                    event.imported_at,
                    event.local_source_path,
                    event.source_container_id,
                    event.physical_source_id,
                ],
            )
            .map_err(database_error)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO import_batch_items
                 (batch_id, candidate_key, skill_id, provenance_id, status)
                 VALUES (?1, ?2, ?3, ?2, 'succeeded')",
                params![
                    event.batch_id,
                    event.provenance_id,
                    event.skill_id.to_string(),
                ],
            )
            .map_err(database_error)?;
        super::relationship_repository::bump_relationship_revision_tx(transaction)
    }

    /// Batch summary with the number of successfully imported candidates.
    pub fn import_batch(&self, batch_id: &str) -> AppResult<Option<ImportBatch>> {
        let imported_count: Option<i64> = self
            .database
            .connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM import_batch_items
                         WHERE batch_id=?1 AND status='succeeded')
                 FROM import_batches WHERE batch_id=?1",
                [batch_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        Ok(imported_count.map(|count| ImportBatch {
            batch_id: batch_id.to_owned(),
            imported_count: u32::try_from(count).unwrap_or(u32::MAX),
        }))
    }

    /// Lists batches still in the `running` state (open), oldest first, so a
    /// restarted process can offer resume-or-abandon for each one.
    pub fn list_open_import_batches(&self) -> AppResult<Vec<(String, i64)>> {
        let mut statement = self
            .database
            .connection
            .prepare("SELECT batch_id, started_at FROM import_batches WHERE status='running' ORDER BY started_at, batch_id")
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        Ok(rows)
    }

    /// Count of successful batch items that established an active-governable
    /// source relation — the persisted source of `manageable_source_count`.
    pub fn manageable_source_count(&self, batch_id: &str) -> AppResult<i64> {
        self.database
            .connection
            .query_row(
                "SELECT COUNT(*) FROM import_batch_items
                 WHERE batch_id=?1 AND status='succeeded' AND source_relation_id IS NOT NULL",
                [batch_id],
                |row| row.get(0),
            )
            .map_err(database_error)
    }

    /// Source relation ids established by a batch's succeeded items — the
    /// persisted join for Batch-scoped relationship checks (plan 5.3).
    pub fn list_batch_relation_ids(&self, batch_id: &str) -> AppResult<Vec<String>> {
        let mut statement = self
            .database
            .connection
            .prepare(
                "SELECT DISTINCT source_relation_id FROM import_batch_items
                 WHERE batch_id=?1 AND source_relation_id IS NOT NULL",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([batch_id], |row| row.get::<_, String>(0))
            .map_err(database_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
    }

    /// Closes an import batch with a terminal status and finish time.
    /// Final-state semantics (pinned by tests): finalizing a running batch
    /// writes `status`/`finished_at`; replaying the identical terminal state
    /// is an idempotent no-op; any other transition on an already-finalized
    /// batch, or finalizing a missing batch, is rejected. Batch bookkeeping is
    /// not a relationship fact and never bumps the projection revision.
    pub fn finalize_import_batch(
        &self,
        batch_id: &str,
        status: ImportBatchFinalStatus,
        finished_at: i64,
    ) -> AppResult<()> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        Self::finalize_import_batch_tx(&transaction, batch_id, status, finished_at)?;
        transaction.commit().map_err(database_error)
    }

    /// Caller-transaction seam for closing an import batch inside the
    /// caller's transaction.
    pub fn finalize_import_batch_tx(
        transaction: &Transaction<'_>,
        batch_id: &str,
        status: ImportBatchFinalStatus,
        finished_at: i64,
    ) -> AppResult<()> {
        let status_code = final_status_code(status);
        let stored = transaction
            .query_row(
                "SELECT status, finished_at FROM import_batches WHERE batch_id=?1",
                [batch_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)),
            )
            .optional()
            .map_err(database_error)?;
        match stored {
            None => Err(missing_import_batch(batch_id)),
            Some((current, _)) if current == "running" => {
                let changed = transaction
                    .execute(
                        "UPDATE import_batches SET status=?2, finished_at=?3
                         WHERE batch_id=?1 AND status='running'",
                        params![batch_id, status_code, finished_at],
                    )
                    .map_err(database_error)?;
                if changed == 0 {
                    return Err(missing_import_batch(batch_id));
                }
                Ok(())
            }
            Some((current, stored_finished_at))
                if current == status_code && stored_finished_at == Some(finished_at) =>
            {
                Ok(())
            }
            Some((current, _)) => Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "import_batch")
                .with_param("reason", "import_batch_already_finalized")
                .with_param("status", current)
                .with_action(RecoveryAction::Retry)),
        }
    }

    /// Records one candidate outcome with an explicit status (`succeeded`,
    /// `failed`, `cancelled`, or `skipped`) and an optional reason, so
    /// failure/skip/cancel evidence is as reachable as the success rows that
    /// the event append writes automatically.
    pub fn record_batch_item(&self, item: &ImportBatchItemRecord) -> AppResult<()> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        Self::record_batch_item_tx(&transaction, item)?;
        transaction.commit().map_err(database_error)
    }

    /// Caller-transaction seam for recording a candidate outcome inside the
    /// caller's transaction.
    pub fn record_batch_item_tx(
        transaction: &Transaction<'_>,
        item: &ImportBatchItemRecord,
    ) -> AppResult<()> {
        for field in [
            ("batch_id", item.batch_id.as_str()),
            ("candidate_key", item.candidate_key.as_str()),
        ] {
            if field.1.trim().is_empty() {
                return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                    .with_param("field", field.0)
                    .with_action(RecoveryAction::Retry));
            }
        }
        transaction
            .execute(
                "INSERT INTO import_batch_items
                 (batch_id, candidate_key, skill_id, provenance_id, source_relation_id,
                  status, reason)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    item.batch_id,
                    item.candidate_key,
                    item.skill_id.map(|skill_id| skill_id.to_string()),
                    item.provenance_id,
                    item.source_relation_id,
                    item_status_code(item.status),
                    item.reason,
                ],
            )
            .map(|_| ())
            .map_err(database_error)
    }

    /// Immutable import facts for one Skill in chronological order. Re-imports
    /// with a different time or source remain separate events.
    pub fn list_provenance_events_for_skill(
        &self,
        skill_id: SkillId,
    ) -> AppResult<Vec<ImportProvenanceEvent>> {
        self.list_events(
            "WHERE skill_id=?1 ORDER BY imported_at, provenance_id",
            [skill_id.to_string()],
        )
    }

    /// Read-only legacy backfill seam: returns the unclassified events left by
    /// the v19 migration (and by the deprecated compat write path) so a later
    /// classification step can review them. There is deliberately no delete or
    /// rewrite API: evidence stays until a classified successor flow exists.
    pub fn list_unclassified_legacy_events(&self) -> AppResult<Vec<ImportProvenanceEvent>> {
        self.list_events(
            "WHERE source_class='legacy_unclassified' ORDER BY imported_at, provenance_id",
            [],
        )
    }

    fn list_events<T: rusqlite::Params>(
        &self,
        suffix: &str,
        parameters: T,
    ) -> AppResult<Vec<ImportProvenanceEvent>> {
        let mut statement = self
            .database
            .connection
            .prepare(&format!(
                "SELECT provenance_id, batch_id, skill_id, source_class, source_kind,
                        source_locator, local_source_path, source_container_id,
                        physical_source_id, agent_client_id, content_fingerprint, imported_at
                 FROM import_provenance_events_v19 {suffix}"
            ))
            .map_err(database_error)?;
        let rows = statement
            .query_map(parameters, |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, i64>(11)?,
                ))
            })
            .map_err(database_error)?;
        rows.map(|row| decode_event(row.map_err(database_error)?).ok_or_else(invalid_record))
            .collect()
    }

    pub fn list_observed(&self) -> AppResult<Vec<ObservedDeployment>> {
        let mut statement = self
            .database
            .connection
            .prepare(
                "SELECT id, skill_id, client_id, original_path, content_fingerprint, match_state, origin, status, observed_at, released_at \
                 FROM observed_deployments ORDER BY original_path, id",
            )
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
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                ))
            })
            .map_err(database_error)?;
        rows.map(|row| {
            let value = row.map_err(database_error)?;
            decode_observed(value).ok_or_else(invalid_record)
        })
        .collect()
    }

    pub fn list_observed_for_skill(&self, skill_id: SkillId) -> AppResult<Vec<ObservedDeployment>> {
        Ok(self
            .list_observed()?
            .into_iter()
            .filter(|row| row.skill_id == skill_id)
            .collect())
    }

    /// 按纯判定结果落库。`observed_at` 是本次观察时间；Release 用它作为
    /// 收回时间。`origin` 记录这条关系由扫描比对还是导入存证建立。路径键
    /// 在写入时计算（Windows 形态折叠、POSIX 精确）。
    pub fn apply_observed_row_action(
        &self,
        client_id: &str,
        original_path: &str,
        action: &ObservedRowAction,
        origin: ObservedOrigin,
        observed_at: i64,
    ) -> AppResult<()> {
        let origin_code = match origin {
            ObservedOrigin::Scan => "scan",
            ObservedOrigin::Import => "import",
        };
        match action {
            ObservedRowAction::Unchanged => Ok(()),
            ObservedRowAction::EstablishVerified {
                skill_id,
                fingerprint,
            } => {
                let id = ObservedDeploymentId::new().to_string();
                let transaction = self
                    .database
                    .connection
                    .unchecked_transaction()
                    .map_err(database_error)?;
                transaction
                    .execute(
                        "INSERT INTO observed_deployments \
                         (id, skill_id, client_id, original_path, path_key, content_fingerprint, match_state, origin, status, observed_at, released_at) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'content_verified', ?7, 'active', ?8, NULL) \
                         ON CONFLICT(path_key) DO UPDATE SET \
                         skill_id=excluded.skill_id, client_id=excluded.client_id, \
                         content_fingerprint=excluded.content_fingerprint, match_state='content_verified', \
                         status='active', observed_at=excluded.observed_at, released_at=NULL",
                        params![
                            id.clone(),
                            skill_id.to_string(),
                            client_id,
                            original_path,
                            observed_path_key(original_path),
                            fingerprint,
                            origin_code,
                            observed_at,
                        ],
                    )
                    .map_err(database_error)?;
                let relation_id: String = transaction
                    .query_row(
                        "SELECT id FROM observed_deployments WHERE path_key=?1",
                        [observed_path_key(original_path)],
                        |row| row.get(0),
                    )
                    .map_err(database_error)?;
                let relationship_changed =
                    super::relationship_repository::upsert_deployment_relation_tx(
                        &transaction,
                        &DeploymentRelationFact {
                            relation_id,
                            skill_id: Some(*skill_id),
                            agent_client_id: client_id.to_owned(),
                            path: original_path.to_owned(),
                            path_key: String::new(),
                            directory_node_id: None,
                            relationship: RelationshipType::Unknown,
                            file_representation: FileRepresentation::Unknown,
                            ownership: OwnershipState::ObservedUnmanaged,
                            link_target_path: None,
                            link_target_path_key: None,
                            link_target_directory_id: None,
                            content_fingerprint: fingerprint.clone(),
                            origin,
                            match_state: ObservedMatchState::ContentVerified,
                            active: true,
                            observed_at,
                            released_at: None,
                        },
                    )?;
                if relationship_changed {
                    super::relationship_repository::bump_relationship_revision_tx(&transaction)?;
                }
                transaction.commit().map_err(database_error)
            }
            ObservedRowAction::MarkUnreliable {
                match_state,
                fingerprint,
            } => {
                let transaction = self
                    .database
                    .connection
                    .unchecked_transaction()
                    .map_err(database_error)?;
                transaction
                    .execute(
                    "UPDATE observed_deployments SET match_state=?1, content_fingerprint=?2, observed_at=?3 \
                     WHERE path_key=?4 AND status='active'",
                    params![
                        match_state_code(*match_state),
                        fingerprint,
                        observed_at,
                        observed_path_key(original_path),
                    ],
                    )
                    .map_err(database_error)?;
                let relationship_changed = transaction
                        .execute(
                        "UPDATE deployment_relations SET skill_id=NULL, content_fingerprint=?1, match_state=?2, active=1, observed_at=?3, released_at=NULL WHERE agent_client_id=?4 AND path_key=?5 AND ownership<>'skillhub_managed'",
                        params![
                            fingerprint,
                            match_state_code(*match_state),
                            observed_at,
                            client_id,
                            observed_path_key(original_path),
                        ],
                    )
                    .map_err(database_error)?
                    != 0;
                if relationship_changed {
                    super::relationship_repository::bump_relationship_revision_tx(&transaction)?;
                }
                transaction.commit().map_err(database_error)
            }
            ObservedRowAction::Release => {
                let transaction = self
                    .database
                    .connection
                    .unchecked_transaction()
                    .map_err(database_error)?;
                transaction
                    .execute(
                        "UPDATE observed_deployments SET status='released', released_at=?1 \
                     WHERE path_key=?2 AND status='active'",
                        params![observed_at, observed_path_key(original_path)],
                    )
                    .map_err(database_error)?;
                let relationship_changed = transaction
                        .execute(
                        "UPDATE deployment_relations SET active=0, released_at=?1 WHERE agent_client_id=?2 AND path_key=?3 AND active=1 AND ownership<>'skillhub_managed'",
                        params![observed_at, client_id, observed_path_key(original_path)],
                    )
                    .map_err(database_error)?
                    != 0;
                if relationship_changed {
                    super::relationship_repository::bump_relationship_revision_tx(&transaction)?;
                }
                transaction.commit().map_err(database_error)
            }
        }
    }

    pub fn insert_original_migration(&self, result: &OriginalMigrationResult) -> AppResult<()> {
        self.database
            .connection
            .execute(
                "INSERT INTO original_migrations \
                 (id, skill_id, original_path, backup_path, content_fingerprint, state, confirmed_at, rolled_back_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    result.migration_id.to_string(),
                    result.skill_id.to_string(),
                    result.original_path,
                    result.backup_path,
                    result.content_fingerprint,
                    migration_state_code(result.state),
                    result.confirmed_at,
                    result.rolled_back_at,
                ],
            )
            .map(|_| ())
            .map_err(database_error)
    }

    /// 补偿性删除：仅用于"记录已写入但随后删除原目录失败"的中止路径，
    /// 让失败现场回到干净状态（原文件仍在、无迁移记录）。回滚不走这里，
    /// 回滚必须保留审计行。
    pub fn remove_original_migration(&self, migration_id: OperationId) -> AppResult<()> {
        self.database
            .connection
            .execute(
                "DELETE FROM original_migrations WHERE id=?1",
                [migration_id.to_string()],
            )
            .map(|_| ())
            .map_err(database_error)
    }

    pub fn original_migration(
        &self,
        migration_id: OperationId,
    ) -> AppResult<Option<OriginalMigrationResult>> {
        let row = self
            .database
            .connection
            .query_row(
                "SELECT id, skill_id, original_path, backup_path, content_fingerprint, state, confirmed_at, rolled_back_at \
                 FROM original_migrations WHERE id=?1",
                [migration_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?;
        row.map(|value| decode_migration(value).ok_or_else(invalid_record))
            .transpose()
    }

    /// 回滚后追加审计状态：备份保留、原路径恢复，标记 RolledBack。
    /// 记录本身永不删除（历史证据）。
    pub fn mark_original_migration_rolled_back(
        &self,
        migration_id: OperationId,
        rolled_back_at: i64,
    ) -> AppResult<()> {
        let changed = self
            .database
            .connection
            .execute(
                "UPDATE original_migrations SET state='rolled_back', rolled_back_at=?1 WHERE id=?2",
                params![rolled_back_at, migration_id.to_string()],
            )
            .map_err(database_error)?;
        if changed == 0 {
            return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("field", "original_migration"));
        }
        Ok(())
    }
}

type ProvenanceRow = (
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    String,
    i64,
);

type EventRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    i64,
);

#[allow(clippy::type_complexity)]
fn decode_event(value: EventRow) -> Option<ImportProvenanceEvent> {
    let skill_id = value.2.parse().ok()?;
    let source_class = parse_source_class(&value.3)?;
    let source_kind = parse_source_kind(&value.4)?;
    let source_locator = parse_source_locator(&value.4, &value.5)?;
    Some(ImportProvenanceEvent {
        provenance_id: value.0,
        batch_id: value.1,
        skill_id,
        source_class,
        source: SourceDescriptor::new(source_kind, source_locator),
        local_source_path: value.6,
        source_container_id: value.7,
        physical_source_id: value.8,
        agent_client_id: value.9,
        content_fingerprint: value.10,
        imported_at: value.11,
    })
}

fn missing_import_batch(batch_id: &str) -> AppError {
    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
        .with_param("field", "import_batch")
        .with_param("batch_id", batch_id.to_owned())
        .with_action(RecoveryAction::Retry)
}

fn parse_source_class(value: &str) -> Option<ImportSourceClass> {
    let source_class = match value {
        "agent_local" => ImportSourceClass::AgentLocal,
        "user_local" => ImportSourceClass::UserLocal,
        "registered_project" => ImportSourceClass::RegisteredProject,
        "online" => ImportSourceClass::Online,
        "central_library" => ImportSourceClass::CentralLibrary,
        "legacy_unclassified" => ImportSourceClass::LegacyUnclassified,
        _ => return None,
    };
    Some(source_class)
}

fn source_class_code(value: ImportSourceClass) -> &'static str {
    match value {
        ImportSourceClass::AgentLocal => "agent_local",
        ImportSourceClass::UserLocal => "user_local",
        ImportSourceClass::RegisteredProject => "registered_project",
        ImportSourceClass::Online => "online",
        ImportSourceClass::CentralLibrary => "central_library",
        ImportSourceClass::LegacyUnclassified => "legacy_unclassified",
    }
}

fn parse_source_kind(value: &str) -> Option<SourceKind> {
    let source_kind = match value {
        "local" => SourceKind::Local,
        "https" => SourceKind::Https,
        "git" => SourceKind::Git,
        _ => return None,
    };
    Some(source_kind)
}

fn parse_source_locator(kind: &str, locator: &str) -> Option<SourceLocator> {
    let source_locator = match kind {
        "local" => SourceLocator::local_path(locator),
        "https" => SourceLocator::https_url(locator),
        "git" => SourceLocator::git_url(locator),
        _ => return None,
    };
    Some(source_locator)
}

fn decode_provenance(value: ProvenanceRow) -> Option<ImportProvenance> {
    let skill_id = value.0.parse().ok()?;
    let source_kind = match value.3.as_str() {
        "local" => SourceKind::Local,
        "https" => SourceKind::Https,
        "git" => SourceKind::Git,
        _ => return None,
    };
    let source_locator = match value.4.clone() {
        locator if value.3 == "local" => SourceLocator::local_path(locator),
        locator if value.3 == "https" => SourceLocator::https_url(locator),
        locator => SourceLocator::git_url(locator),
    };
    Some(ImportProvenance {
        skill_id,
        agent_client_id: value.1,
        original_path: value.2,
        source: SourceDescriptor::new(source_kind, source_locator),
        ownership: parse_ownership(&value.5)?,
        content_fingerprint: value.6,
        imported_at: value.7,
    })
}

fn provenance_from_relation(relation: SourceRelationFact) -> ImportProvenance {
    ImportProvenance {
        skill_id: relation.skill_id,
        agent_client_id: relation.agent_client_id,
        original_path: relation.source_path,
        source: relation.source,
        ownership: match relation.ownership {
            skillhub_core::relationship::OwnershipState::SkillhubManaged => {
                CandidateOwnership::CentralLibrary
            }
            skillhub_core::relationship::OwnershipState::ObservedUnmanaged
            | skillhub_core::relationship::OwnershipState::SharedReference => {
                CandidateOwnership::KnownAgentTarget
            }
        },
        content_fingerprint: relation.content_fingerprint,
        imported_at: relation.imported_at,
    }
}

fn parse_ownership(value: &str) -> Option<CandidateOwnership> {
    let ownership = match value {
        "unclassified" => CandidateOwnership::Unclassified,
        "central_library" => CandidateOwnership::CentralLibrary,
        "known_agent_target" => CandidateOwnership::KnownAgentTarget,
        "registered_project" => CandidateOwnership::RegisteredProject,
        "read_only_builtin_or_plugin" => CandidateOwnership::ReadOnlyBuiltinOrPlugin,
        "arbitrary_local_directory" => CandidateOwnership::ArbitraryLocalDirectory,
        "downloaded_source" => CandidateOwnership::DownloadedSource,
        _ => return None,
    };
    Some(ownership)
}

fn ownership_code(value: CandidateOwnership) -> &'static str {
    match value {
        CandidateOwnership::Unclassified => "unclassified",
        CandidateOwnership::CentralLibrary => "central_library",
        CandidateOwnership::KnownAgentTarget => "known_agent_target",
        CandidateOwnership::RegisteredProject => "registered_project",
        CandidateOwnership::ReadOnlyBuiltinOrPlugin => "read_only_builtin_or_plugin",
        CandidateOwnership::ArbitraryLocalDirectory => "arbitrary_local_directory",
        CandidateOwnership::DownloadedSource => "downloaded_source",
    }
}

fn source_kind_code(value: &SourceKind) -> &'static str {
    match value {
        SourceKind::Local => "local",
        SourceKind::Https => "https",
        SourceKind::Git => "git",
    }
}

fn source_locator_text(locator: &SourceLocator) -> String {
    match locator {
        SourceLocator::LocalPath(path) => path.to_string_lossy().into_owned(),
        SourceLocator::HttpsUrl(url) => url.clone(),
        SourceLocator::GitUrl(url) => url.clone(),
    }
}

type ObservedRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    Option<i64>,
);

#[allow(clippy::type_complexity)]
fn decode_observed(value: ObservedRow) -> Option<ObservedDeployment> {
    let match_state = match value.5.as_str() {
        "content_verified" => ObservedMatchState::ContentVerified,
        "name_only" => ObservedMatchState::NameOnly,
        "diverged" => ObservedMatchState::Diverged,
        _ => return None,
    };
    let origin = match value.6.as_str() {
        "scan" => ObservedOrigin::Scan,
        "import" => ObservedOrigin::Import,
        _ => return None,
    };
    let status = match value.7.as_str() {
        "active" => ObservedStatus::Active,
        "released" => ObservedStatus::Released,
        _ => return None,
    };
    Some(ObservedDeployment {
        id: value.0.parse().ok()?,
        skill_id: value.1.parse().ok()?,
        client_id: value.2,
        original_path: value.3,
        content_fingerprint: value.4,
        match_state,
        origin,
        status,
        observed_at: value.8,
        released_at: value.9,
    })
}

fn match_state_code(value: ObservedMatchState) -> &'static str {
    match value {
        ObservedMatchState::ContentVerified => "content_verified",
        ObservedMatchState::NameOnly => "name_only",
        ObservedMatchState::Diverged => "diverged",
    }
}

type MigrationRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    Option<i64>,
);

fn decode_migration(value: MigrationRow) -> Option<OriginalMigrationResult> {
    let state = match value.5.as_str() {
        "migrated" => OriginalMigrationState::Migrated,
        "rolled_back" => OriginalMigrationState::RolledBack,
        _ => return None,
    };
    Some(OriginalMigrationResult {
        migration_id: value.0.parse().ok()?,
        skill_id: value.1.parse().ok()?,
        original_path: value.2,
        backup_path: value.3,
        content_fingerprint: value.4,
        state,
        confirmed_at: value.6,
        rolled_back_at: value.7,
    })
}

fn migration_state_code(value: OriginalMigrationState) -> &'static str {
    match value {
        OriginalMigrationState::Migrated => "migrated",
        OriginalMigrationState::RolledBack => "rolled_back",
    }
}

fn invalid_record() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("reason", "provenance_record_corrupt")
        .with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("source", error.to_string())
}
