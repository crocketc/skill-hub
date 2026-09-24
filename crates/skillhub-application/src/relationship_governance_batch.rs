//! Relationship-governance batch orchestration.
//!
//! A batch is *orchestration only*.  Every child item goes through the exact
//! same single-relation safety chain the governance page uses for one row:
//! `prepare_relation_migration` (fingerprint re-check, shared-impact
//! confirmation, path authorization), `commit_relation_migration` (relation
//! lock, staged link verification, backup) and `rollback_relation_migration`.
//! Nothing here re-implements a filesystem operation, opens a second
//! relationship store or writes a second operation log.
//!
//! One parent operation maps to one child operation per relationship edge, so
//! the operation log can be followed from the batch down to each item.
//!
//! Batch semantics:
//!
//! - each row is prepared, backed up, verified and confirmed independently;
//! - rows the ledger already reports as non-executable are grouped as blocked
//!   and never touch the filesystem;
//! - cancelling a row leaves the other rows untouched;
//! - a partial failure keeps the successful rows and returns per-item retry
//!   and rollback information instead of collapsing into a single verdict.

use std::collections::{BTreeSet, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::json;
use skillhub_core::api::{
    AppCommandResult, AppQueryResult, CommitRelationGovernanceBatch, CommitRelationMigration,
    ListRelationGovernance, PrepareRelationGovernanceBatch, PrepareRelationMigration,
    RelationGovernanceBatchAction, RelationGovernanceBatchItem, RelationGovernanceBatchItemState,
    RelationGovernanceBatchOutcome, RelationGovernanceBatchState,
    RelationshipMigrationBackupPolicy, RollbackRelationGovernanceBatch, RollbackRelationMigration,
};
use skillhub_core::relationship::{
    project_relation_governance_ledger_with_names, RelationGovernanceFilters,
    RelationGovernanceNames, RelationGovernanceReadiness,
};
use skillhub_core::{
    AppError, AppResult, ErrorCode, OperationId, OperationPhase, RelationMigrationState,
    RelationMigrationTargetMode, Severity,
};
use skillhub_storage::Database;

use crate::LocalApplicationFacade;

const BATCH_KIND: &str = "relation_governance_batch";

/// A prepared child edge of a batch.  This is the durable link between the
/// parent operation and the single-relation operation it orchestrates.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct GovernanceBatchChild {
    relation_id: String,
    operation_id: OperationId,
}

impl LocalApplicationFacade {
    /// Reads the relationship-governance ledger.  Read-only: the projection is
    /// pure, so the query never scans files, probes link capability, calls AI
    /// or writes a fact.
    pub(crate) fn list_relation_governance(
        &self,
        request: ListRelationGovernance,
    ) -> AppResult<AppQueryResult> {
        let ledger = self.with_database("query.relation_governance_ledger", |database| {
            let relationship_repository = database.relationship_repository();
            let revision = relationship_repository.relationship_revision()?;
            let last_verified_at = relationship_repository.last_verified_at()?;
            let names = relationship_names(database)?;
            // 统一清单（plan 7.8）：来源副本与部署边同表投影；Online
            // provenance 不参与（清单只从关系事实构建）。
            let mut facts = Vec::new();
            for copy in relationship_repository.list_source_copy_relations(true)? {
                facts.push(skillhub_core::relationship::GovernableRelationFact::SourceCopy(copy));
            }
            for relation in relationship_repository.list_relations()? {
                facts.push(
                    skillhub_core::relationship::GovernableRelationFact::Deployment(relation),
                );
            }
            // batch_id 过滤只命中 import_batch_items 映射的关系（plan 7.3）。
            let batch_relation_ids = match &request.filters.batch_id {
                Some(batch_id) => database
                    .provenance_repository()
                    .list_batch_relation_ids(batch_id)?
                    .into_iter()
                    .collect::<std::collections::BTreeSet<_>>(),
                None => std::collections::BTreeSet::new(),
            };
            Ok(
                skillhub_core::relationship::project_unified_governance_ledger(
                    &request.filters,
                    &facts,
                    &relationship_repository.list_capabilities()?,
                    &batch_relation_ids,
                    &names,
                    revision,
                    last_verified_at,
                ),
            )
        })?;
        Ok(AppQueryResult::RelationGovernanceLedger(ledger))
    }

    /// 独立治理历史查询（plan 7.10）：只读写入时固化的显示快照，分页、
    /// 最新在前；不回查可能已删除的 Agent/项目，也不混入通用 operations。
    pub(crate) fn list_governance_history(
        &self,
        request: skillhub_core::relationship::ListGovernanceHistory,
    ) -> AppResult<AppQueryResult> {
        let page = self.with_database("query.governance_history", |database| {
            let query = skillhub_storage::GovernanceHistoryPageQuery {
                relation_id: request.relation_id.clone(),
                skill_id: request.skill_id.map(|skill_id| skill_id.to_string()),
                agent_client_id: request.agent_client_id.clone(),
                project_id: request.project_id.clone(),
                result: request.result.clone(),
                page: request.page,
                page_size: request.page_size,
            };
            let (events, total) = database.governance_history_repository().list_page(&query)?;
            let items = events
                .into_iter()
                .map(
                    |event| skillhub_core::relationship::GovernanceHistoryEntry {
                        relation_id: event.relation_id,
                        skill_id: event
                            .skill_id
                            .as_deref()
                            .and_then(|raw| raw.parse::<skillhub_core::SkillId>().ok()),
                        skill_display_name: event.skill_display_name,
                        agent: skillhub_core::relationship::GovernanceHistoryAgent {
                            client_id: event
                                .agent_presentation
                                .get("client_id")
                                .and_then(|value| value.as_str())
                                .map(str::to_owned),
                        },
                        path: event.path,
                        scope: event.scope,
                        project_id: event.project_id,
                        action: event.action,
                        result: event.result,
                        reason: event.reason,
                        operation_id: event.operation_id,
                        occurred_at: event.occurred_at,
                    },
                )
                .collect();
            Ok(skillhub_core::relationship::GovernanceHistoryPage {
                items,
                total,
                page: request.page.max(1),
                page_size: request.page_size.clamp(1, 200),
            })
        })?;
        Ok(AppQueryResult::GovernanceHistoryPage(page))
    }

    /// Prepares one child operation per selected relationship edge.  A row the
    /// ledger reports as not eligible is refused here without touching the
    /// filesystem; every eligible row still has to pass the single-relation
    /// prepare gate on its own.
    pub(crate) fn prepare_relation_governance_batch(
        &self,
        request: PrepareRelationGovernanceBatch,
    ) -> AppResult<AppCommandResult> {
        let batch_id = OperationId::new();
        let relation_ids = dedupe_preserving_order(&request.relation_ids)?;

        let rows = self.with_database("query.relation_governance_ledger", |database| {
            let relationship_repository = database.relationship_repository();
            let ledger = project_relation_governance_ledger_with_names(
                &RelationGovernanceFilters::default(),
                &relationship_repository.list_relations()?,
                &relationship_repository.list_capabilities()?,
                &relationship_names(database)?,
                relationship_repository.relationship_revision()?,
                relationship_repository.last_verified_at()?,
            );
            Ok(ledger
                .rows
                .into_iter()
                .map(|row| (row.relation_id().to_owned(), row))
                .collect::<HashMap<_, _>>())
        })?;

        // 批次约束（plan 7.5）：来源副本与部署边不可混在同一个批次里。
        let has_source_copy = rows.values().any(|row| row.source_copy().is_some());
        let has_deployment = rows.values().any(|row| row.deployment().is_some());
        if has_source_copy && has_deployment {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning)
                .with_param("reason", "mixed_relation_governance_batch_kinds"));
        }
        self.journal_begin(batch_id, BATCH_KIND);

        let mut children = Vec::new();
        let mut items = Vec::new();
        for relation_id in relation_ids {
            let Some(row) = rows.get(&relation_id) else {
                items.push(blocked_item(
                    relation_id,
                    ErrorCode::ObjectNotFound,
                    "relationship is not an established edge in the current facts",
                    Vec::new(),
                ));
                continue;
            };
            let confirmation_token = request
                .confirmations
                .get(&relation_id)
                .filter(|token| !token.trim().is_empty())
                .cloned();
            if !batch_row_is_executable(row, confirmation_token.as_deref()) {
                items.push(blocked_item(
                    relation_id,
                    ErrorCode::OperationConflict,
                    "relationship is not eligible to be brought under central management",
                    row.blockers.clone(),
                ));
                continue;
            }
            let prepared = self.prepare_relation_migration(PrepareRelationMigration {
                relation_id: relation_id.clone(),
                target_mode: RelationMigrationTargetMode::ManagedLink,
                backup_policy: RelationshipMigrationBackupPolicy::Required,
                confirmation_token,
            });
            match prepared {
                Ok(AppCommandResult::PreparedRelationMigration(prepared)) => {
                    children.push(GovernanceBatchChild {
                        relation_id: relation_id.clone(),
                        operation_id: prepared.operation_id,
                    });
                    items.push(RelationGovernanceBatchItem {
                        relation_id,
                        operation_id: Some(prepared.operation_id),
                        state: RelationGovernanceBatchItemState::Prepared,
                        error_code: None,
                        detail: None,
                        retryable: true,
                        rollback_available: prepared.rollback_available,
                        backup_path: Some(prepared.backup_path.clone()),
                        affected_paths: prepared.affected_paths.clone(),
                        blockers: Vec::new(),
                    });
                }
                Ok(_) => items.push(failed_item(
                    relation_id,
                    ErrorCode::InternalError,
                    Some("prepare did not return a prepared relationship migration".into()),
                )),
                Err(error) => {
                    items.push(failed_item(relation_id, error.code, error_detail(&error)))
                }
            }
        }

        let prepared_count = count(&items, RelationGovernanceBatchItemState::Prepared);
        let failed_count = count(&items, RelationGovernanceBatchItemState::Failed);
        let blocked_count = count(&items, RelationGovernanceBatchItemState::Blocked);
        let outcome = RelationGovernanceBatchOutcome {
            batch_id,
            action: request.action,
            state: if prepared_count == 0 {
                RelationGovernanceBatchState::Failed
            } else {
                RelationGovernanceBatchState::Prepared
            },
            items,
            prepared_count,
            committed_count: 0,
            failed_count,
            blocked_count,
            cancelled_count: 0,
            relationship_revision: String::new(),
        };
        let outcome = self.with_revision(outcome)?;
        let phase = if outcome.prepared_count == 0 {
            OperationPhase::RolledBack
        } else {
            OperationPhase::Prepared
        };
        self.persist_governance_batch(batch_id, request.action, phase, &children, &outcome, None)?;
        Ok(AppCommandResult::RelationGovernanceBatch(outcome))
    }

    /// Executes the rows the user kept after the preview.  Every child is
    /// committed independently, so a failure never discards the rows that
    /// already succeeded, and a row the user deselected is cancelled without
    /// affecting the rest.
    pub(crate) async fn commit_relation_governance_batch(
        &self,
        request: CommitRelationGovernanceBatch,
    ) -> AppResult<AppCommandResult> {
        let (action, children) = self.load_governance_batch(request.batch_id)?;
        let selected = request
            .relation_ids
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut items = Vec::new();
        for child in &children {
            if !selected.contains(&child.relation_id) {
                items.push(self.cancel_governance_batch_child(child).await);
                continue;
            }
            let committed = self
                .commit_relation_migration(CommitRelationMigration {
                    prepared_relation_migration_id: child.operation_id,
                })
                .await;
            match committed {
                Ok(AppCommandResult::RelationMigrationResult(result)) => {
                    items.push(RelationGovernanceBatchItem {
                        relation_id: child.relation_id.clone(),
                        operation_id: Some(result.operation_id),
                        state: match result.state {
                            RelationMigrationState::Committed => {
                                RelationGovernanceBatchItemState::Committed
                            }
                            // A row that was rolled back to its original
                            // relationship changed nothing, so it is reported
                            // as cancelled rather than as a success.
                            RelationMigrationState::RolledBack => {
                                RelationGovernanceBatchItemState::Cancelled
                            }
                            RelationMigrationState::Cancelled => {
                                RelationGovernanceBatchItemState::Cancelled
                            }
                            RelationMigrationState::Failed | RelationMigrationState::Prepared => {
                                RelationGovernanceBatchItemState::Failed
                            }
                        },
                        error_code: result.error_code,
                        detail: result.detail.clone(),
                        retryable: true,
                        rollback_available: result.rollback_available,
                        backup_path: result.backup_path.clone(),
                        affected_paths: result.affected_paths.clone(),
                        blockers: Vec::new(),
                    });
                }
                Ok(_) => items.push(failed_item(
                    child.relation_id.clone(),
                    ErrorCode::InternalError,
                    Some("commit did not return a relationship migration result".into()),
                )),
                Err(error) => items.push(failed_item(
                    child.relation_id.clone(),
                    error.code,
                    error_detail(&error),
                )),
            }
        }

        // Rows that were refused during prepare are not selectable; reporting
        // them keeps the batch summary honest about what it did not do.
        for relation_id in &request.relation_ids {
            if !children
                .iter()
                .any(|child| &child.relation_id == relation_id)
            {
                items.push(blocked_item(
                    relation_id.clone(),
                    ErrorCode::ObjectNotFound,
                    "relationship was not prepared in this batch",
                    Vec::new(),
                ));
            }
        }

        let committed_count = count(&items, RelationGovernanceBatchItemState::Committed);
        let failed_count = count(&items, RelationGovernanceBatchItemState::Failed);
        let cancelled_count = count(&items, RelationGovernanceBatchItemState::Cancelled);
        let blocked_count = count(&items, RelationGovernanceBatchItemState::Blocked);
        let state = if committed_count > 0 && (failed_count > 0 || blocked_count > 0) {
            RelationGovernanceBatchState::PartiallyCommitted
        } else if committed_count > 0 {
            RelationGovernanceBatchState::Committed
        } else if cancelled_count > 0 && failed_count == 0 && blocked_count == 0 {
            RelationGovernanceBatchState::Cancelled
        } else {
            RelationGovernanceBatchState::Failed
        };
        let outcome = self.with_revision(RelationGovernanceBatchOutcome {
            batch_id: request.batch_id,
            action,
            state,
            items,
            prepared_count: 0,
            committed_count,
            failed_count,
            blocked_count,
            cancelled_count,
            relationship_revision: String::new(),
        })?;
        let phase = if failed_count == 0 && blocked_count == 0 {
            OperationPhase::Committed
        } else {
            OperationPhase::NeedsRecovery
        };
        self.persist_governance_batch(request.batch_id, action, phase, &children, &outcome, None)?;
        Ok(AppCommandResult::RelationGovernanceBatch(outcome))
    }

    /// Rolls back the selected committed rows.  Successful rollbacks are kept
    /// even when a sibling row fails.
    pub(crate) async fn rollback_relation_governance_batch(
        &self,
        request: RollbackRelationGovernanceBatch,
    ) -> AppResult<AppCommandResult> {
        let (action, children) = self.load_governance_batch(request.batch_id)?;
        let selected = request
            .relation_ids
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut items = Vec::new();
        for child in &children {
            if !selected.contains(&child.relation_id) {
                continue;
            }
            let rolled_back = self
                .rollback_relation_migration(RollbackRelationMigration {
                    operation_id: child.operation_id,
                })
                .await;
            match rolled_back {
                Ok(AppCommandResult::RelationMigrationResult(result)) => {
                    items.push(RelationGovernanceBatchItem {
                        relation_id: child.relation_id.clone(),
                        operation_id: Some(result.operation_id),
                        state: match result.state {
                            RelationMigrationState::RolledBack => {
                                RelationGovernanceBatchItemState::RolledBack
                            }
                            RelationMigrationState::Committed => {
                                RelationGovernanceBatchItemState::Committed
                            }
                            _ => RelationGovernanceBatchItemState::Failed,
                        },
                        error_code: result.error_code,
                        detail: result.detail.clone(),
                        retryable: true,
                        rollback_available: result.rollback_available,
                        backup_path: result.backup_path.clone(),
                        affected_paths: result.affected_paths.clone(),
                        blockers: Vec::new(),
                    });
                }
                Ok(_) => items.push(failed_item(
                    child.relation_id.clone(),
                    ErrorCode::InternalError,
                    Some("rollback did not return a relationship migration result".into()),
                )),
                Err(error) => items.push(failed_item(
                    child.relation_id.clone(),
                    error.code,
                    error_detail(&error),
                )),
            }
        }

        let rolled_back_count = count(&items, RelationGovernanceBatchItemState::RolledBack);
        let failed_count = count(&items, RelationGovernanceBatchItemState::Failed);
        let state = if failed_count > 0 && rolled_back_count > 0 {
            RelationGovernanceBatchState::PartiallyCommitted
        } else if failed_count > 0 {
            RelationGovernanceBatchState::Failed
        } else {
            RelationGovernanceBatchState::Cancelled
        };
        let outcome = self.with_revision(RelationGovernanceBatchOutcome {
            batch_id: request.batch_id,
            action,
            state,
            items,
            prepared_count: 0,
            committed_count: 0,
            failed_count,
            blocked_count: 0,
            cancelled_count: rolled_back_count,
            relationship_revision: String::new(),
        })?;
        self.persist_governance_batch(
            request.batch_id,
            action,
            if failed_count == 0 {
                OperationPhase::RolledBack
            } else {
                OperationPhase::NeedsRecovery
            },
            &children,
            &outcome,
            None,
        )?;
        Ok(AppCommandResult::RelationGovernanceBatch(outcome))
    }

    /// A deselected row is cancelled through the same single-relation rollback
    /// the page uses.  A prepared-but-uncommitted migration never touched the
    /// filesystem, so cancelling it only discards the prepared journal.
    async fn cancel_governance_batch_child(
        &self,
        child: &GovernanceBatchChild,
    ) -> RelationGovernanceBatchItem {
        match self
            .rollback_relation_migration(RollbackRelationMigration {
                operation_id: child.operation_id,
            })
            .await
        {
            Ok(AppCommandResult::RelationMigrationResult(result)) => RelationGovernanceBatchItem {
                relation_id: child.relation_id.clone(),
                operation_id: Some(result.operation_id),
                state: RelationGovernanceBatchItemState::Cancelled,
                error_code: result.error_code,
                detail: result.detail.clone(),
                retryable: true,
                rollback_available: result.rollback_available,
                backup_path: result.backup_path.clone(),
                affected_paths: result.affected_paths.clone(),
                blockers: Vec::new(),
            },
            Ok(_) => failed_item(
                child.relation_id.clone(),
                ErrorCode::InternalError,
                Some("cancellation did not return a relationship migration result".into()),
            ),
            Err(error) => failed_item(child.relation_id.clone(), error.code, error_detail(&error)),
        }
    }

    fn with_revision(
        &self,
        mut outcome: RelationGovernanceBatchOutcome,
    ) -> AppResult<RelationGovernanceBatchOutcome> {
        outcome.relationship_revision =
            self.with_database("query.relationship_revision", |database| {
                Ok(database
                    .relationship_repository()
                    .relationship_revision()?
                    .to_string())
            })?;
        Ok(outcome)
    }

    /// Persists the parent operation row.  Every child is recorded as an
    /// object result and as a recovery-data child, so one batch log entry can
    /// be followed to each item it orchestrates.
    fn persist_governance_batch(
        &self,
        batch_id: OperationId,
        action: RelationGovernanceBatchAction,
        phase: OperationPhase,
        children: &[GovernanceBatchChild],
        outcome: &RelationGovernanceBatchOutcome,
        error_code: Option<ErrorCode>,
    ) -> AppResult<()> {
        let mut record = super::journal_record(batch_id, BATCH_KIND, phase, error_code);
        record.request_fingerprint = serde_json::to_string(&action).unwrap_or_default();
        record.recovery_data = json!({
            "action": action,
            "children": children,
            "phase": phase,
        });
        record.object_results = outcome
            .items
            .iter()
            .map(|item| skillhub_core::OperationObjectResult {
                object_id: item.relation_id.clone(),
                status: serde_json::to_string(&item.state)
                    .unwrap_or_else(|_| "\"unknown\"".into())
                    .trim_matches('"')
                    .into(),
                result: serde_json::to_value(item).ok(),
                error_code: item.error_code,
            })
            .collect();
        record.result = serde_json::to_value(outcome).ok();
        self.with_database(
            "operation_journal.relationship_governance_batch",
            |database| {
                database
                    .operation_repository()
                    .update_sync(&record)
                    .or_else(|_| database.operation_repository().insert_sync(&record))
            },
        )
    }

    fn load_governance_batch(
        &self,
        batch_id: OperationId,
    ) -> AppResult<(RelationGovernanceBatchAction, Vec<GovernanceBatchChild>)> {
        let record = self
            .with_database(
                "operation_journal.relationship_governance_batch",
                |database| database.operation_repository().get_sync(batch_id),
            )?
            .ok_or_else(|| {
                AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("operation", "relation_governance_batch")
                    .with_param("reason", "batch_not_found")
            })?;
        if record.kind != BATCH_KIND {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "operation_is_not_a_governance_batch"));
        }
        let action = serde_json::from_value(
            record
                .recovery_data
                .get("action")
                .cloned()
                .ok_or_else(governance_batch_corrupt)?,
        )
        .map_err(|_| governance_batch_corrupt())?;
        let children = serde_json::from_value::<Vec<GovernanceBatchChild>>(
            record
                .recovery_data
                .get("children")
                .cloned()
                .ok_or_else(governance_batch_corrupt)?,
        )
        .map_err(|_| governance_batch_corrupt())?;
        Ok((action, children))
    }
}

fn relationship_names(database: &Database) -> AppResult<RelationGovernanceNames> {
    let catalog = database.catalog_repository()?;
    let mut names = RelationGovernanceNames::new();
    for skill_id in catalog.list_ids_sync()? {
        if let Some(detail) = catalog.get_detail(skill_id)? {
            names.push((skill_id, detail.display_name));
        }
    }
    Ok(names)
}

fn count(items: &[RelationGovernanceBatchItem], state: RelationGovernanceBatchItemState) -> u32 {
    items.iter().filter(|item| item.state == state).count() as u32
}

/// Whether the ledger lets a batch run this row.
///
/// A row that is only waiting on an explicit shared-impact confirmation
/// becomes executable once the caller supplies that confirmation for the row —
/// the batch must not silently treat "user has not agreed yet" and "user
/// agreed" as the same thing, nor may it refuse a row the single-relation flow
/// would accept.  Any other `NeedsValidation` reason needs the underlying fact
/// to change first, so it stays refused.
fn batch_row_is_executable(
    row: &skillhub_core::relationship::RelationGovernanceRow,
    confirmation_token: Option<&str>,
) -> bool {
    match row.readiness {
        RelationGovernanceReadiness::EligibleToCentralize => true,
        RelationGovernanceReadiness::NeedsValidation => {
            confirmation_token.is_some()
                && !row.blockers.is_empty()
                && row
                    .blockers
                    .iter()
                    .all(|blocker| {
                        *blocker
                            == skillhub_core::relationship::RelationGovernanceBlocker::SharedImpactConfirmationRequired
                    })
        }
        RelationGovernanceReadiness::Blocked
        | RelationGovernanceReadiness::AlreadyCentralized => false,
    }
}

fn dedupe_preserving_order(relation_ids: &[String]) -> AppResult<Vec<String>> {
    let mut seen = BTreeSet::new();
    let mut ordered = Vec::new();
    for relation_id in relation_ids {
        let relation_id = relation_id.trim();
        if relation_id.is_empty() {
            continue;
        }
        // 批次约束（plan 7.5）：重复 relation_id 在拆分子操作前整体拒绝，
        // 不静默去重。
        if !seen.insert(relation_id.to_owned()) {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning)
                .with_param("reason", "duplicate_relation_governance_batch_item")
                .with_param("relation_id", relation_id.to_owned()));
        }
        ordered.push(relation_id.to_owned());
    }
    if ordered.is_empty() {
        return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning)
            .with_param("reason", "empty_relation_governance_batch"));
    }
    Ok(ordered)
}

fn blocked_item(
    relation_id: String,
    code: ErrorCode,
    detail: &str,
    blockers: Vec<skillhub_core::relationship::RelationGovernanceBlocker>,
) -> RelationGovernanceBatchItem {
    RelationGovernanceBatchItem {
        relation_id,
        operation_id: None,
        state: RelationGovernanceBatchItemState::Blocked,
        error_code: Some(code),
        detail: Some(detail.to_owned()),
        retryable: false,
        rollback_available: false,
        backup_path: None,
        affected_paths: Vec::new(),
        blockers,
    }
}

fn failed_item(
    relation_id: String,
    code: ErrorCode,
    detail: Option<String>,
) -> RelationGovernanceBatchItem {
    RelationGovernanceBatchItem {
        relation_id,
        operation_id: None,
        state: RelationGovernanceBatchItemState::Failed,
        error_code: Some(code),
        detail,
        retryable: true,
        rollback_available: false,
        backup_path: None,
        affected_paths: Vec::new(),
        blockers: Vec::new(),
    }
}

/// Reports only the whitelisted detail parameter; raw error payloads never
/// reach the operation log.
fn error_detail(error: &AppError) -> Option<String> {
    error
        .params
        .get("detail")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
}

fn governance_batch_corrupt() -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("reason", "governance_batch_record_corrupt")
}
