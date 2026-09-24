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
    AppCommandResult, AppQueryResult, CommitOriginalMigration, CommitRelationGovernanceBatch,
    CommitRelationMigration, ListRelationGovernance, PrepareOriginalMigration,
    PrepareRelationGovernanceBatch, PrepareRelationMigration, RelationGovernanceBatchAction,
    RelationGovernanceBatchItem, RelationGovernanceBatchItemState, RelationGovernanceBatchOutcome,
    RelationGovernanceBatchState, RelationshipMigrationBackupPolicy, RetainSourceCopy,
    RollbackOriginalMigration, RollbackRelationGovernanceBatch, RollbackRelationMigration,
};
use skillhub_core::relationship::{
    project_unified_governance_ledger, GovernableRelationFact, RelationGovernanceFilters,
    RelationGovernanceNames, RelationGovernanceReadiness, RelationGovernanceRow,
    SourceCopyDecision,
};
use skillhub_core::{
    AppError, AppResult, ErrorCode, OperationId, OperationPhase, OriginalMigrationState,
    RelationMigrationState, RelationMigrationTargetMode, Severity,
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
    /// CleanSourceCopy 在 prepare 阶段逐行取得的删除确认；提交时原样传
    /// 给单条状态机。未确认的行根本不会成为子操作，所以部署转换子项
    /// 恒为 false（旧批次记录缺字段时同样按 false 读取）。
    #[serde(default)]
    ownership_confirmed: bool,
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
            // 统一清单（plan 7.8）：批次行的资格判定与治理页同源，来源副本
            // 与部署边都在场，来源批次约束（plan 8.9）才有事实可判。
            let mut facts = Vec::new();
            for copy in relationship_repository.list_source_copy_relations(true)? {
                facts.push(GovernableRelationFact::SourceCopy(copy));
            }
            for relation in relationship_repository.list_relations()? {
                facts.push(GovernableRelationFact::Deployment(relation));
            }
            let ledger = project_unified_governance_ledger(
                &RelationGovernanceFilters::default(),
                &facts,
                &relationship_repository.list_capabilities()?,
                &std::collections::BTreeSet::new(),
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
        // 批次约束（plan 8.9）：来源动作只接受同为来源副本的批次；部署边
        // 混入在拆分子操作前整体拒绝，而不是逐行降级成 blocked。
        let source_scoped = matches!(
            request.action,
            RelationGovernanceBatchAction::RetainSourceCopy
                | RelationGovernanceBatchAction::CleanSourceCopy
        );
        if source_scoped && has_deployment {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning)
                .with_param("reason", "batch_action_requires_source_copy_rows"));
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
            // 8.16：按 action 分派到各自的逐行状态机；批处理本身只做编排。
            let (child, item) = match request.action {
                RelationGovernanceBatchAction::CentralizeManagement => {
                    self.prepare_centralize_item(relation_id.clone(), row, confirmation_token)
                }
                RelationGovernanceBatchAction::RetainSourceCopy => {
                    self.prepare_retain_item(relation_id.clone(), row)
                }
                RelationGovernanceBatchAction::CleanSourceCopy => {
                    self.prepare_clean_item(relation_id.clone(), confirmation_token)
                }
            };
            if let Some(child) = child {
                children.push(child);
            }
            items.push(item);
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

    /// 部署转换行的逐行准备：与单条流程完全同链路（资格门 + prepare）。
    fn prepare_centralize_item(
        &self,
        relation_id: String,
        row: &RelationGovernanceRow,
        confirmation_token: Option<String>,
    ) -> (Option<GovernanceBatchChild>, RelationGovernanceBatchItem) {
        if !batch_row_is_executable(row, confirmation_token.as_deref()) {
            return (
                None,
                blocked_item(
                    relation_id,
                    ErrorCode::OperationConflict,
                    "relationship is not eligible to be brought under central management",
                    row.blockers.clone(),
                ),
            );
        }
        match self.prepare_relation_migration(PrepareRelationMigration {
            relation_id: relation_id.clone(),
            target_mode: RelationMigrationTargetMode::ManagedLink,
            backup_policy: RelationshipMigrationBackupPolicy::Required,
            confirmation_token,
        }) {
            Ok(AppCommandResult::PreparedRelationMigration(prepared)) => {
                let child = GovernanceBatchChild {
                    relation_id: relation_id.clone(),
                    operation_id: prepared.operation_id,
                    ownership_confirmed: false,
                };
                let item = RelationGovernanceBatchItem {
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
                };
                (Some(child), item)
            }
            Ok(_) => (
                None,
                failed_item(
                    relation_id,
                    ErrorCode::InternalError,
                    Some("prepare did not return a prepared relationship migration".into()),
                ),
            ),
            Err(error) => (
                None,
                failed_item(relation_id, error.code, error_detail(&error)),
            ),
        }
    }

    /// 保留行的逐行准备：只读检查决策事实，绝不触碰来源目录。已是
    /// Retained 的行如实报受阻——批处理不把「无事可做」伪装成成功。
    fn prepare_retain_item(
        &self,
        relation_id: String,
        row: &RelationGovernanceRow,
    ) -> (Option<GovernanceBatchChild>, RelationGovernanceBatchItem) {
        let Some(fact) = row.source_copy() else {
            return (
                None,
                blocked_item(
                    relation_id,
                    ErrorCode::OperationConflict,
                    "row is not a source copy",
                    row.blockers.clone(),
                ),
            );
        };
        if fact.decision != SourceCopyDecision::Pending {
            return (
                None,
                blocked_item(
                    relation_id,
                    ErrorCode::OperationConflict,
                    "source copy is not waiting for a retain decision",
                    Vec::new(),
                ),
            );
        }
        let child = GovernanceBatchChild {
            operation_id: OperationId::new(),
            relation_id: relation_id.clone(),
            ownership_confirmed: false,
        };
        let item = RelationGovernanceBatchItem {
            relation_id,
            operation_id: Some(child.operation_id),
            state: RelationGovernanceBatchItemState::Prepared,
            error_code: None,
            detail: None,
            retryable: true,
            rollback_available: false,
            backup_path: None,
            affected_paths: Vec::new(),
            blockers: Vec::new(),
        };
        (Some(child), item)
    }

    /// 清理行的逐行准备：逐行显式确认是硬门槛，未确认的行不产生子操作；
    /// 确认后复用单条 cleanup prepare（Full 校验与冲突判定都在里面）。
    fn prepare_clean_item(
        &self,
        relation_id: String,
        confirmation_token: Option<String>,
    ) -> (Option<GovernanceBatchChild>, RelationGovernanceBatchItem) {
        let Some(_) = confirmation_token.filter(|token| !token.trim().is_empty()) else {
            return (
                None,
                blocked_item(
                    relation_id,
                    ErrorCode::OperationConflict,
                    "per-row ownership confirmation is required before cleanup",
                    Vec::new(),
                ),
            );
        };
        match self.prepare_original_migration(PrepareOriginalMigration {
            source_relation_id: relation_id.clone(),
        }) {
            Ok(AppCommandResult::OriginalMigrationPlan(plan)) => {
                let child = GovernanceBatchChild {
                    relation_id: relation_id.clone(),
                    operation_id: plan.operation_id,
                    ownership_confirmed: true,
                };
                let item = RelationGovernanceBatchItem {
                    relation_id,
                    operation_id: Some(plan.operation_id),
                    state: RelationGovernanceBatchItemState::Prepared,
                    error_code: None,
                    detail: None,
                    retryable: true,
                    rollback_available: false,
                    backup_path: None,
                    affected_paths: vec![plan.original_path.clone()],
                    blockers: Vec::new(),
                };
                (Some(child), item)
            }
            Ok(_) => (
                None,
                failed_item(
                    relation_id,
                    ErrorCode::InternalError,
                    Some("prepare did not return an original migration plan".into()),
                ),
            ),
            Err(error) => (
                None,
                failed_item(relation_id, error.code, error_detail(&error)),
            ),
        }
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
                items.push(self.cancel_governance_batch_child(child, action).await);
                continue;
            }
            let item = match action {
                RelationGovernanceBatchAction::CentralizeManagement => {
                    self.commit_centralize_child(child).await
                }
                RelationGovernanceBatchAction::RetainSourceCopy => self.commit_retain_child(child),
                RelationGovernanceBatchAction::CleanSourceCopy => self.commit_clean_child(child),
            };
            items.push(item);
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
            let item = match action {
                RelationGovernanceBatchAction::CentralizeManagement => {
                    self.rollback_centralize_child(child).await
                }
                // 保留决策是账本事实，没有文件系统回滚；如实报失败，
                // 不假装能撤销。
                RelationGovernanceBatchAction::RetainSourceCopy => failed_item(
                    child.relation_id.clone(),
                    ErrorCode::OperationConflict,
                    Some(
                        "a retained decision is a ledger fact and has no filesystem rollback"
                            .into(),
                    ),
                ),
                RelationGovernanceBatchAction::CleanSourceCopy => self.rollback_clean_child(child),
            };
            items.push(item);
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
        action: RelationGovernanceBatchAction,
    ) -> RelationGovernanceBatchItem {
        match action {
            RelationGovernanceBatchAction::CentralizeManagement => {
                match self
                    .rollback_relation_migration(RollbackRelationMigration {
                        operation_id: child.operation_id,
                    })
                    .await
                {
                    Ok(AppCommandResult::RelationMigrationResult(result)) => {
                        RelationGovernanceBatchItem {
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
                        }
                    }
                    Ok(_) => failed_item(
                        child.relation_id.clone(),
                        ErrorCode::InternalError,
                        Some("cancellation did not return a relationship migration result".into()),
                    ),
                    Err(error) => {
                        failed_item(child.relation_id.clone(), error.code, error_detail(&error))
                    }
                }
            }
            // 来源动作的取消行没有任何已提交或已执行的动作：保留只差一次
            // 账本写入，清理只差一次确认后的执行。清理子操作在 prepare 时
            // 已落一条 migrate_original 记录，取消时推进到 RolledBack，避免
            // 悬挂的 Prepared 操作。
            RelationGovernanceBatchAction::RetainSourceCopy => cancelled_item(child),
            RelationGovernanceBatchAction::CleanSourceCopy => {
                self.journal_advance(
                    child.operation_id,
                    "migrate_original",
                    OperationPhase::RolledBack,
                    None,
                );
                cancelled_item(child)
            }
        }
    }

    /// 部署转换行的逐行提交：复用单条 commit（关系锁、链接校验、备份）。
    async fn commit_centralize_child(
        &self,
        child: &GovernanceBatchChild,
    ) -> RelationGovernanceBatchItem {
        match self
            .commit_relation_migration(CommitRelationMigration {
                prepared_relation_migration_id: child.operation_id,
            })
            .await
        {
            Ok(AppCommandResult::RelationMigrationResult(result)) => RelationGovernanceBatchItem {
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
            },
            Ok(_) => failed_item(
                child.relation_id.clone(),
                ErrorCode::InternalError,
                Some("commit did not return a relationship migration result".into()),
            ),
            Err(error) => failed_item(child.relation_id.clone(), error.code, error_detail(&error)),
        }
    }

    /// 保留行的逐行提交：复用单条 retain（决策 + 治理历史），子操作记录
    /// 在自己的 operation kind 下。
    fn commit_retain_child(&self, child: &GovernanceBatchChild) -> RelationGovernanceBatchItem {
        self.journal_begin(child.operation_id, "retain_source_copy");
        match self.retain_source_copy(RetainSourceCopy {
            source_relation_id: child.relation_id.clone(),
        }) {
            Ok(AppCommandResult::SourceCopyRelationUpdated(_)) => {
                self.journal_advance(
                    child.operation_id,
                    "retain_source_copy",
                    OperationPhase::Committed,
                    None,
                );
                RelationGovernanceBatchItem {
                    relation_id: child.relation_id.clone(),
                    operation_id: Some(child.operation_id),
                    state: RelationGovernanceBatchItemState::Committed,
                    error_code: None,
                    detail: None,
                    retryable: true,
                    rollback_available: false,
                    backup_path: None,
                    affected_paths: Vec::new(),
                    blockers: Vec::new(),
                }
            }
            Ok(_) => {
                self.journal_advance(
                    child.operation_id,
                    "retain_source_copy",
                    OperationPhase::NeedsRecovery,
                    Some(ErrorCode::InternalError),
                );
                failed_item(
                    child.relation_id.clone(),
                    ErrorCode::InternalError,
                    Some("retain did not return the updated source copy".into()),
                )
            }
            Err(error) => {
                self.journal_advance(
                    child.operation_id,
                    "retain_source_copy",
                    OperationPhase::RolledBack,
                    Some(error.code),
                );
                failed_item(child.relation_id.clone(), error.code, error_detail(&error))
            }
        }
    }

    /// 清理行的逐行提交：复用单条 cleanup 状态机（备份、checkpoint、
    /// 删除、原子归档）；prepare 阶段取得的逐行确认在这里原样生效。
    fn commit_clean_child(&self, child: &GovernanceBatchChild) -> RelationGovernanceBatchItem {
        match self.commit_original_migration(CommitOriginalMigration {
            prepared_migration_id: child.operation_id,
            ownership_confirmed: child.ownership_confirmed,
        }) {
            Ok(AppCommandResult::OriginalMigrationResult(result)) => RelationGovernanceBatchItem {
                relation_id: child.relation_id.clone(),
                operation_id: Some(result.migration_id),
                state: if result.state == OriginalMigrationState::Migrated {
                    RelationGovernanceBatchItemState::Committed
                } else {
                    RelationGovernanceBatchItemState::Failed
                },
                error_code: None,
                detail: None,
                retryable: true,
                rollback_available: result.state == OriginalMigrationState::Migrated,
                backup_path: Some(result.backup_path.clone()),
                affected_paths: vec![result.original_path.clone()],
                blockers: Vec::new(),
            },
            Ok(_) => failed_item(
                child.relation_id.clone(),
                ErrorCode::InternalError,
                Some("commit did not return an original migration result".into()),
            ),
            Err(error) => failed_item(child.relation_id.clone(), error.code, error_detail(&error)),
        }
    }

    /// 清理行的逐行回退：复用单条 rollback（备份恢复、新建关系、旧记录
    /// 翻转 RolledBack）。
    fn rollback_clean_child(&self, child: &GovernanceBatchChild) -> RelationGovernanceBatchItem {
        match self.rollback_original_migration(RollbackOriginalMigration {
            migration_id: child.operation_id,
        }) {
            Ok(AppCommandResult::OriginalMigrationResult(result)) => RelationGovernanceBatchItem {
                relation_id: child.relation_id.clone(),
                operation_id: Some(result.migration_id),
                state: match result.state {
                    OriginalMigrationState::RolledBack => {
                        RelationGovernanceBatchItemState::RolledBack
                    }
                    OriginalMigrationState::Migrated => RelationGovernanceBatchItemState::Committed,
                    _ => RelationGovernanceBatchItemState::Failed,
                },
                error_code: None,
                detail: None,
                retryable: true,
                rollback_available: result.state == OriginalMigrationState::Migrated,
                backup_path: Some(result.backup_path.clone()),
                affected_paths: vec![result.original_path.clone()],
                blockers: Vec::new(),
            },
            Ok(_) => failed_item(
                child.relation_id.clone(),
                ErrorCode::InternalError,
                Some("rollback did not return an original migration result".into()),
            ),
            Err(error) => failed_item(child.relation_id.clone(), error.code, error_detail(&error)),
        }
    }

    /// 部署转换行的逐行回退：复用单条 rollback。
    async fn rollback_centralize_child(
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
            },
            Ok(_) => failed_item(
                child.relation_id.clone(),
                ErrorCode::InternalError,
                Some("rollback did not return a relationship migration result".into()),
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

/// 用户在预览后放弃的行：没有任何已执行的动作，只如实报取消。
fn cancelled_item(child: &GovernanceBatchChild) -> RelationGovernanceBatchItem {
    RelationGovernanceBatchItem {
        relation_id: child.relation_id.clone(),
        operation_id: Some(child.operation_id),
        state: RelationGovernanceBatchItemState::Cancelled,
        error_code: None,
        detail: None,
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
