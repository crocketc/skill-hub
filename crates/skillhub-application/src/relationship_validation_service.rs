//! Governable-relationship validation service (plan Task 5A).
//!
//! Loads active source-copy relations by scope, probes each path, derives the
//! business verdict with the pure core mapping (level-aware: Light never
//! judges occupancy or content), and persists updates or the single archiving
//! transition (MissingWithAccessibleParent → ExternalRemoved + history) in
//! one transaction per relation. Per-item failures are reported; they never
//! abort the batch.

use std::path::Path;
use std::sync::Arc;

use serde_json::json;
use skillhub_adapters::relationship::FilesystemRelationshipProbe;
use skillhub_core::api::{AppCommandResult, RunRelationshipCheck};
use skillhub_core::catalog::CatalogRepository;
use skillhub_core::relationship::{
    evaluate_relationship_probe, update_is_meaningful, RelationshipCheckItem,
    RelationshipCheckItemStatus, RelationshipCheckLevel, RelationshipCheckReport,
    RelationshipCheckScope, RelationshipPathProbe, SourceCopyArchiveReason, SourceCopyRelationFact,
    SourceCopyTransition,
};
use skillhub_core::{AppError, AppResult, OperationId};
use skillhub_storage::Database;
use skillhub_storage::GovernanceHistoryEvent;

use crate::LocalApplicationFacade;

/// Relationship-path probing abstraction. Production resolves through the
/// real filesystem; tests inject controlled verdicts (permission walls,
/// offline volumes) that cannot be simulated portably.
pub trait RelationshipPathProbing: Send + Sync {
    fn probe(&self, path: &Path) -> RelationshipPathProbe;
}

impl RelationshipPathProbing for FilesystemRelationshipProbe {
    fn probe(&self, path: &Path) -> RelationshipPathProbe {
        FilesystemRelationshipProbe::probe(self, path)
    }
}

pub(crate) fn default_relationship_probe() -> Arc<dyn RelationshipPathProbing> {
    Arc::new(FilesystemRelationshipProbe)
}

impl LocalApplicationFacade {
    /// 仅供测试：注入受控探测结果（权限/离线卷等无法跨平台模拟的场景）。
    #[doc(hidden)]
    pub fn set_relationship_probe_for_tests(&self, probe: Arc<dyn RelationshipPathProbing>) {
        *self.relationship_probe.lock().expect("relationship probe") = probe;
    }

    pub(crate) fn run_relationship_check(
        &self,
        request: RunRelationshipCheck,
    ) -> AppResult<AppCommandResult> {
        let now = now_epoch_seconds();
        let library = self.library_runtime.snapshot()?;
        let central_root = library.root.to_string_lossy().into_owned();
        let mut items = Vec::new();
        self.with_database("execute.run_relationship_check.select", |database| {
            let selected = select_relations_for_scope(database, &request.scope)?;
            for relation in selected {
                let item = check_one_relation(
                    self,
                    database,
                    relation,
                    &request,
                    &central_root,
                    &library.store,
                    now,
                );
                items.push(item);
            }
            Ok(())
        })?;
        let relationship_revision = self
            .with_database("execute.run_relationship_check.revision", |database| {
                database.relationship_repository().relationship_revision()
            })?;
        items.sort_by(|left, right| left.relation_id.cmp(&right.relation_id));
        Ok(AppCommandResult::RelationshipCheckReport(
            RelationshipCheckReport {
                items,
                relationship_revision,
            },
        ))
    }
}

fn select_relations_for_scope(
    database: &Database,
    scope: &RelationshipCheckScope,
) -> AppResult<Vec<SourceCopyRelationFact>> {
    let active = database
        .relationship_repository()
        .list_source_copy_relations(true)?;
    Ok(match scope {
        RelationshipCheckScope::AllActive => active,
        RelationshipCheckScope::RelationIds { relation_ids } => active
            .into_iter()
            .filter(|relation| relation_ids.contains(&relation.relation_id))
            .collect(),
        RelationshipCheckScope::Skill { skill_id } => active
            .into_iter()
            .filter(|relation| relation.skill_id == *skill_id)
            .collect(),
        RelationshipCheckScope::Agent { client_id } => active
            .into_iter()
            .filter(|relation| relation.agent_client_id.as_deref() == Some(client_id.as_str()))
            .collect(),
        RelationshipCheckScope::Project { project_id } => active
            .into_iter()
            .filter(|relation| relation.source_container_id.as_deref() == Some(project_id))
            .collect(),
        RelationshipCheckScope::Batch { batch_id } => {
            let relation_ids = database
                .provenance_repository()
                .list_batch_relation_ids(batch_id)?;
            active
                .into_iter()
                .filter(|relation| relation_ids.contains(&relation.relation_id))
                .collect()
        }
    })
}

#[allow(clippy::too_many_arguments)]
fn check_one_relation(
    facade: &LocalApplicationFacade,
    database: &Database,
    relation: SourceCopyRelationFact,
    request: &RunRelationshipCheck,
    central_root: &str,
    store: &skillhub_storage::VersionStore,
    now: i64,
) -> RelationshipCheckItem {
    let probe = facade
        .relationship_probe
        .lock()
        .expect("relationship probe")
        .probe(Path::new(&relation.source_path));
    match probe {
        RelationshipPathProbe::MissingWithAccessibleParent => {
            archive_removed_relation(facade, database, &relation, now)
        }
        probe => {
            let occupied = request.level == RelationshipCheckLevel::Full
                && path_lives_under(&relation.source_path, central_root);
            let fingerprint = if request.level == RelationshipCheckLevel::Full {
                store
                    .hash_tree_read_only(Path::new(&relation.source_path))
                    .ok()
            } else {
                None
            };
            let transition = evaluate_relationship_probe(
                &relation,
                request.level,
                &probe,
                occupied,
                fingerprint.as_deref(),
                now,
            );
            let SourceCopyTransition::Update(updated) = transition else {
                return archived_item(&relation);
            };
            if !update_is_meaningful(&relation, &updated) {
                return RelationshipCheckItem {
                    relation_id: relation.relation_id.clone(),
                    skill_id: relation.skill_id,
                    status: RelationshipCheckItemStatus::Unchanged,
                    health: Some(relation.health),
                    reason: None,
                };
            }
            let outcome = (|| -> AppResult<()> {
                let transaction = database.begin_transaction()?;
                skillhub_storage::RelationshipRepository::upsert_source_copy_relation_tx(
                    &transaction,
                    &updated,
                    "fs",
                    1,
                )?;
                Database::commit_transaction(transaction)
            })();
            match outcome {
                Ok(()) => RelationshipCheckItem {
                    relation_id: relation.relation_id.clone(),
                    skill_id: relation.skill_id,
                    status: RelationshipCheckItemStatus::Checked,
                    health: Some(updated.health),
                    reason: None,
                },
                Err(error) => failed_item(&relation, &error),
            }
        }
    }
}

/// MissingWithAccessibleParent 归档：同一事务里归档关系并追加
/// ExternalRemoved 历史；重复检查不重复写历史（plan 5.5）。
fn archive_removed_relation(
    _facade: &LocalApplicationFacade,
    database: &Database,
    relation: &SourceCopyRelationFact,
    now: i64,
) -> RelationshipCheckItem {
    let display_name = skill_display_name(database, relation);
    let outcome = (|| -> AppResult<()> {
        let transaction = database.begin_transaction()?;
        let changed = skillhub_storage::RelationshipRepository::archive_source_copy_relation_tx(
            &transaction,
            &relation.relation_id,
            SourceCopyArchiveReason::ExternalRemoved,
            now,
        )?;
        if changed {
            let already_recorded = database
                .governance_history_repository()
                .list_for_relation(&relation.relation_id)?
                .into_iter()
                .any(|event| {
                    event.result == "archived"
                        && event.reason.as_deref() == Some("external_removed")
                });
            if !already_recorded {
                skillhub_storage::GovernanceHistoryRepository::append_tx(
                    &transaction,
                    &GovernanceHistoryEvent {
                        event_id: format!("hist-{}", OperationId::new()),
                        relation_id: relation.relation_id.clone(),
                        skill_id: Some(relation.skill_id.to_string()),
                        skill_display_name: display_name,
                        agent_presentation: json!({
                            "client_id": relation.agent_client_id,
                        }),
                        path: relation.source_path.clone(),
                        scope: "source_copy".to_owned(),
                        project_id: None,
                        action: "validate".to_owned(),
                        result: "archived".to_owned(),
                        reason: Some("external_removed".to_owned()),
                        operation_id: None,
                        occurred_at: now,
                    },
                )?;
            }
        }
        Database::commit_transaction(transaction)
    })();
    match outcome {
        Ok(()) => RelationshipCheckItem {
            relation_id: relation.relation_id.clone(),
            skill_id: relation.skill_id,
            status: RelationshipCheckItemStatus::Archived,
            health: None,
            reason: Some("external_removed".to_owned()),
        },
        Err(error) => failed_item(relation, &error),
    }
}

fn skill_display_name(database: &Database, relation: &SourceCopyRelationFact) -> String {
    database
        .catalog_repository()
        .and_then(|repository| repository.get_sync(relation.skill_id))
        .ok()
        .flatten()
        .map(|skill| skill.runtime_name().to_owned())
        .unwrap_or_else(|| "unknown-skill".to_owned())
}

fn archived_item(relation: &SourceCopyRelationFact) -> RelationshipCheckItem {
    RelationshipCheckItem {
        relation_id: relation.relation_id.clone(),
        skill_id: relation.skill_id,
        status: RelationshipCheckItemStatus::Archived,
        health: None,
        reason: Some("external_removed".to_owned()),
    }
}

fn failed_item(relation: &SourceCopyRelationFact, error: &AppError) -> RelationshipCheckItem {
    RelationshipCheckItem {
        relation_id: relation.relation_id.clone(),
        skill_id: relation.skill_id,
        status: RelationshipCheckItemStatus::Failed,
        health: None,
        reason: Some(error.code.as_str().to_owned()),
    }
}

/// Separator/case-normalized containment: a relation whose source path fell
/// inside the central library is "managed-occupied" — the directory a user
/// once imported from is now part of the governed library itself.
fn path_lives_under(path: &str, root: &str) -> bool {
    let normalize = |value: &str| -> String {
        let unified = value.replace('\\', "/");
        let trimmed = unified.trim_end_matches('/').to_owned();
        trimmed
    };
    let normalized_path = normalize(path).to_ascii_lowercase();
    let normalized_root = normalize(root).to_ascii_lowercase();
    !normalized_root.is_empty()
        && normalized_path != normalized_root
        && normalized_path.starts_with(&normalized_root)
}

fn now_epoch_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}
