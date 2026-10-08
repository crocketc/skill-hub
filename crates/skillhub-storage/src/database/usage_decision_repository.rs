use super::relationship_repository::{bump_relationship_revision_tx, RelationshipRepository};
use super::Database;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use skillhub_core::deployment::observed_path_key;
use skillhub_core::relationship::{SourceCopyArchiveReason, UsageDecision, UsageEntryKey};
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity, SkillId};

/// A durable user decision for one skill and one confirmed usage entry.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct UsageDecisionRecord {
    pub decision_id: String,
    pub skill_id: SkillId,
    pub entry_key: UsageEntryKey,
    pub relation_ids: Vec<String>,
    pub physical_source_ids: Vec<String>,
    pub decision: UsageDecision,
    pub content_fingerprint: Option<String>,
    pub decided_at: i64,
    pub operation_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ActiveEvidence {
    relation_kind: String,
    relation_id: String,
    physical_source_id: Option<String>,
    content_fingerprint: Option<String>,
}

impl Database {
    /// Stores a usage decision and archives every active fact for the same
    /// skill and canonical entry in one SQLite transaction.
    pub fn record_usage_decision(&self, record: &UsageDecisionRecord) -> AppResult<()> {
        validate_record(record)?;
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;

        if let Some(operation_id) = record.operation_id.as_deref() {
            if let Some(existing) = find_operation_record(&transaction, operation_id, record)? {
                if existing == *record {
                    return Ok(());
                }
                return Err(operation_conflict("operation_id_reused"));
            }
        }

        let slot_exists: bool = transaction
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM active_usage_slots
                    WHERE skill_id=?1 AND directory_id=?2 AND relative_entry_path=?3
                 )",
                params![
                    record.skill_id.to_string(),
                    record.entry_key.directory_id,
                    record.entry_key.relative_entry_path,
                ],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        if !slot_exists {
            return Err(operation_conflict("active_usage_slot_missing"));
        }

        let evidence = list_active_evidence(&transaction, &record.skill_id, &record.entry_key)?;
        validate_evidence(record, &evidence)?;

        let relation_ids_json =
            serde_json::to_string(&record.relation_ids).map_err(serialization_error)?;
        let physical_source_ids_json =
            serde_json::to_string(&record.physical_source_ids).map_err(serialization_error)?;
        transaction
            .execute(
                "INSERT INTO usage_decisions
                 (decision_id, skill_id, directory_id, relative_entry_path,
                  relation_ids_json, physical_source_ids_json, decision,
                  content_fingerprint, decided_at, operation_id, legacy_evidence)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)",
                params![
                    record.decision_id,
                    record.skill_id.to_string(),
                    record.entry_key.directory_id,
                    record.entry_key.relative_entry_path,
                    relation_ids_json,
                    physical_source_ids_json,
                    decision_code(record.decision),
                    record.content_fingerprint,
                    record.decided_at,
                    record.operation_id,
                ],
            )
            .map_err(database_error)?;

        for item in &evidence {
            match item.relation_kind.as_str() {
                "source_copy" => {
                    RelationshipRepository::archive_source_copy_relation_tx(
                        &transaction,
                        &item.relation_id,
                        SourceCopyArchiveReason::UserEnded,
                        record.decided_at,
                    )?;
                }
                "deployment" => {
                    let changed = transaction
                        .execute(
                            "UPDATE deployment_relations
                             SET active=0, released_at=?1
                             WHERE relation_id=?2 AND active=1",
                            params![record.decided_at, item.relation_id],
                        )
                        .map_err(database_error)?;
                    if changed != 0 {
                        bump_relationship_revision_tx(&transaction)?;
                    }
                    remove_usage_evidence_tx(&transaction, "deployment", &item.relation_id)?;
                }
                _ => return Err(invalid_record("relation_kind")),
            }
        }
        transaction
            .execute(
                "DELETE FROM active_usage_slots
                 WHERE skill_id=?1 AND directory_id=?2 AND relative_entry_path=?3",
                params![
                    record.skill_id.to_string(),
                    record.entry_key.directory_id,
                    record.entry_key.relative_entry_path,
                ],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)
    }

    /// Returns all decisions for the same skill and canonical entry, oldest
    /// first so callers can reconstruct the full decision history.
    pub fn list_usage_decisions(
        &self,
        skill_id: &SkillId,
        entry_key: &UsageEntryKey,
    ) -> AppResult<Vec<UsageDecisionRecord>> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT decision_id, skill_id, directory_id, relative_entry_path,
                        relation_ids_json, physical_source_ids_json, decision,
                        content_fingerprint, decided_at, operation_id
                 FROM usage_decisions
                 WHERE skill_id=?1 AND directory_id=?2 AND relative_entry_path=?3
                 ORDER BY decided_at, decision_id",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map(
                params![
                    skill_id.to_string(),
                    entry_key.directory_id,
                    entry_key.relative_entry_path,
                ],
                usage_decision_row,
            )
            .map_err(database_error)?;
        rows.map(|row| decode_usage_decision(row.map_err(database_error)?))
            .collect()
    }
}

/// Backfills a newly-created active-slot index from existing active facts.
pub(super) fn backfill_active_usage_slots_tx(transaction: &Transaction<'_>) -> AppResult<()> {
    let deployments = {
        let mut statement = transaction
            .prepare(
                "SELECT relation_id FROM deployment_relations WHERE active=1 AND skill_id IS NOT NULL",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        rows
    };
    for relation_id in deployments {
        sync_deployment_usage_evidence_tx(transaction, &relation_id)?;
    }

    let source_copies = {
        let mut statement = transaction
            .prepare("SELECT relation_id, fact_json FROM source_copy_relations WHERE active=1")
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        rows
    };
    for (relation_id, fact_json) in source_copies {
        if let Ok(fact) =
            serde_json::from_str::<skillhub_core::relationship::SourceCopyRelationFact>(&fact_json)
        {
            if relation_id == fact.relation_id {
                sync_source_copy_usage_evidence_tx(transaction, &fact)?;
            }
        }
    }
    Ok(())
}

/// Converts only unambiguous, identity-bound legacy user actions. The old
/// history rows remain immutable and unresolved rows stay available for review.
pub(super) fn migrate_legacy_usage_decisions_tx(transaction: &Transaction<'_>) -> AppResult<()> {
    let history = {
        let mut statement = transaction
            .prepare(
                "SELECT event_id, relation_id, skill_id, path, scope, action,
                        result, operation_id, occurred_at
                 FROM relation_history_events
                 WHERE (action='retain' AND result='retained')
                    OR (action='end_relationship' AND result='ended')
                 ORDER BY occurred_at, event_id",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(LegacyHistoryRow {
                    event_id: row.get(0)?,
                    relation_id: row.get(1)?,
                    skill_id: row.get(2)?,
                    path: row.get(3)?,
                    scope: row.get(4)?,
                    action: row.get(5)?,
                    result: row.get(6)?,
                    operation_id: row.get(7)?,
                    occurred_at: row.get(8)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        rows
    };

    for event in history {
        let decision = match (
            event.scope.as_str(),
            event.action.as_str(),
            event.result.as_str(),
        ) {
            ("source_copy", "retain", "retained") => UsageDecision::RetainedIndependentCopy,
            ("source_copy" | "deployment", "end_relationship", "ended")
                if event
                    .operation_id
                    .as_deref()
                    .is_some_and(|operation_id| !operation_id.trim().is_empty()) =>
            {
                UsageDecision::Released
            }
            _ => continue,
        };
        let Some(skill_id_text) = event.skill_id.as_deref() else {
            continue;
        };
        let Ok(skill_id) = skill_id_text.parse::<SkillId>() else {
            continue;
        };
        let Some(identity) = resolve_legacy_history_identity(transaction, &event, &skill_id)?
        else {
            continue;
        };
        if decision == UsageDecision::RetainedIndependentCopy
            && legacy_retention_was_revoked(transaction, &event)?
        {
            // Preserve the append-only legacy history, but don't surface an
            // explicitly revoked retain as the current structured decision.
            continue;
        }
        let record = UsageDecisionRecord {
            decision_id: event.event_id.clone(),
            skill_id,
            entry_key: identity.entry_key.clone(),
            relation_ids: vec![event.relation_id.clone()],
            physical_source_ids: identity.physical_source_id.iter().cloned().collect(),
            decision,
            content_fingerprint: identity.content_fingerprint.clone(),
            decided_at: event.occurred_at,
            operation_id: event.operation_id.clone(),
        };
        insert_legacy_decision_tx(transaction, &record)?;

        if identity.active
            && event.occurred_at >= identity.active_since
            && active_evidence_matches_event(transaction, &record, &event.scope)?
        {
            archive_active_slot_tx(
                transaction,
                &record.skill_id,
                &record.entry_key,
                event.occurred_at,
            )?;
        }
    }
    Ok(())
}

#[derive(Clone, Debug)]
struct LegacyHistoryRow {
    event_id: String,
    relation_id: String,
    skill_id: Option<String>,
    path: String,
    scope: String,
    action: String,
    result: String,
    operation_id: Option<String>,
    occurred_at: i64,
}

#[derive(Clone, Debug)]
struct LegacyUsageIdentity {
    entry_key: UsageEntryKey,
    physical_source_id: Option<String>,
    content_fingerprint: Option<String>,
    active: bool,
    active_since: i64,
}

fn insert_legacy_decision_tx(
    transaction: &Transaction<'_>,
    record: &UsageDecisionRecord,
) -> AppResult<()> {
    let relation_ids_json =
        serde_json::to_string(&record.relation_ids).map_err(serialization_error)?;
    let physical_source_ids_json =
        serde_json::to_string(&record.physical_source_ids).map_err(serialization_error)?;
    let changed = transaction
        .execute(
            "INSERT INTO usage_decisions
             (decision_id, skill_id, directory_id, relative_entry_path,
              relation_ids_json, physical_source_ids_json, decision,
              content_fingerprint, decided_at, operation_id, legacy_evidence)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1)
             ON CONFLICT(decision_id) DO NOTHING",
            params![
                record.decision_id,
                record.skill_id.to_string(),
                record.entry_key.directory_id,
                record.entry_key.relative_entry_path,
                relation_ids_json,
                physical_source_ids_json,
                decision_code(record.decision),
                record.content_fingerprint,
                record.decided_at,
                record.operation_id,
            ],
        )
        .map_err(database_error)?;
    if changed != 0 {
        return Ok(());
    }
    let existing = transaction
        .query_row(
            "SELECT decision_id, skill_id, directory_id, relative_entry_path,
                    relation_ids_json, physical_source_ids_json, decision,
                    content_fingerprint, decided_at, operation_id, legacy_evidence
             FROM usage_decisions WHERE decision_id=?1",
            [&record.decision_id],
            |row| Ok((usage_decision_row(row)?, row.get::<_, i64>(10)?)),
        )
        .optional()
        .map_err(database_error)?;
    let Some((row, legacy_evidence)) = existing else {
        return Err(invalid_record("legacy_decision_insert"));
    };
    if legacy_evidence == 1 && decode_usage_decision(row)? == *record {
        Ok(())
    } else {
        Err(operation_conflict(
            "legacy_event_id_reused_with_different_decision",
        ))
    }
}

fn resolve_legacy_history_identity(
    transaction: &Transaction<'_>,
    event: &LegacyHistoryRow,
    skill_id: &SkillId,
) -> AppResult<Option<LegacyUsageIdentity>> {
    match event.scope.as_str() {
        "source_copy" => {
            let row = transaction
                .query_row(
                    "SELECT source_copy_relations.skill_id, source_copy_relations.latest_provenance_id,
                            source_copy_relations.physical_source_id, source_copy_relations.fact_json,
                            source_copy_relations.active, provenance.imported_at
                     FROM source_copy_relations
                     JOIN import_provenance_events_v19 provenance
                       ON provenance.provenance_id=source_copy_relations.latest_provenance_id
                     WHERE source_copy_relations.relation_id=?1",
                    [&event.relation_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                        ))
                    },
                )
                .optional()
                .map_err(database_error)?;
            let Some((
                stored_skill_id,
                _provenance_id,
                physical_id,
                fact_json,
                active,
                imported_at,
            )) = row
            else {
                return Ok(None);
            };
            if stored_skill_id != skill_id.to_string() {
                return Ok(None);
            }
            let Ok(fact) = serde_json::from_str::<
                skillhub_core::relationship::SourceCopyRelationFact,
            >(&fact_json) else {
                return Ok(None);
            };
            if fact.relation_id != event.relation_id
                || fact.skill_id != *skill_id
                || comparable_path(&fact.source_path) != comparable_path(&event.path)
                || fact.source_container_id.as_deref() != fact.directory_node_id.as_deref()
            {
                return Ok(None);
            }
            let Some(directory_id) = fact.directory_node_id.as_deref() else {
                return Ok(None);
            };
            let Some(entry_key) = entry_key_for_path_tx(transaction, directory_id, &event.path)?
            else {
                return Ok(None);
            };
            Ok(Some(LegacyUsageIdentity {
                entry_key,
                physical_source_id: Some(physical_id),
                content_fingerprint: fact.current_fingerprint,
                active: active == 1 && fact.active,
                active_since: imported_at,
            }))
        }
        "deployment" => {
            let row = transaction
                .query_row(
                    "SELECT skill_id, directory_node_id, path, active,
                            content_fingerprint, observed_at
                     FROM deployment_relations WHERE relation_id=?1",
                    [&event.relation_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, i64>(5)?,
                        ))
                    },
                )
                .optional()
                .map_err(database_error)?;
            let Some((
                Some(stored_skill_id),
                Some(directory_id),
                path,
                active,
                fingerprint,
                observed_at,
            )) = row
            else {
                return Ok(None);
            };
            if stored_skill_id != skill_id.to_string()
                || comparable_path(&path) != comparable_path(&event.path)
            {
                return Ok(None);
            }
            let Some(entry_key) = entry_key_for_path_tx(transaction, &directory_id, &event.path)?
            else {
                return Ok(None);
            };
            Ok(Some(LegacyUsageIdentity {
                entry_key,
                physical_source_id: None,
                content_fingerprint: Some(fingerprint),
                active: active == 1,
                active_since: observed_at,
            }))
        }
        _ => Ok(None),
    }
}

fn legacy_retention_was_revoked(
    transaction: &Transaction<'_>,
    event: &LegacyHistoryRow,
) -> AppResult<bool> {
    if event.action != "retain" {
        return Ok(false);
    }
    transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM relation_history_events
                WHERE relation_id=?1 AND action='revoke_retention'
                  AND result='retention_revoked' AND occurred_at>=?2
             )",
            params![event.relation_id, event.occurred_at],
            |row| row.get(0),
        )
        .map_err(database_error)
}

fn active_evidence_matches_event(
    transaction: &Transaction<'_>,
    record: &UsageDecisionRecord,
    relation_kind: &str,
) -> AppResult<bool> {
    transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM active_usage_evidence
                WHERE skill_id=?1 AND directory_id=?2 AND relative_entry_path=?3
                  AND relation_kind=?4 AND relation_id=?5
             )",
            params![
                record.skill_id.to_string(),
                record.entry_key.directory_id,
                record.entry_key.relative_entry_path,
                relation_kind,
                record.relation_ids[0],
            ],
            |row| row.get(0),
        )
        .map_err(database_error)
}

fn archive_active_slot_tx(
    transaction: &Transaction<'_>,
    skill_id: &SkillId,
    entry_key: &UsageEntryKey,
    archived_at: i64,
) -> AppResult<()> {
    let evidence = list_active_evidence(transaction, skill_id, entry_key)?;
    for item in evidence {
        match item.relation_kind.as_str() {
            "source_copy" => {
                RelationshipRepository::archive_source_copy_relation_tx(
                    transaction,
                    &item.relation_id,
                    SourceCopyArchiveReason::UserEnded,
                    archived_at,
                )?;
            }
            "deployment" => {
                let changed = transaction
                    .execute(
                        "UPDATE deployment_relations SET active=0, released_at=?1
                         WHERE relation_id=?2 AND active=1",
                        params![archived_at, item.relation_id],
                    )
                    .map_err(database_error)?;
                if changed != 0 {
                    bump_relationship_revision_tx(transaction)?;
                }
                remove_usage_evidence_tx(transaction, "deployment", &item.relation_id)?;
            }
            _ => return Err(invalid_record("relation_kind")),
        }
    }
    transaction
        .execute(
            "DELETE FROM active_usage_slots
             WHERE skill_id=?1 AND directory_id=?2 AND relative_entry_path=?3",
            params![
                skill_id.to_string(),
                entry_key.directory_id,
                entry_key.relative_entry_path,
            ],
        )
        .map_err(database_error)?;
    Ok(())
}

/// Rebuilds slot evidence for a persisted deployment fact after its row changes.
pub(super) fn sync_deployment_usage_evidence_tx(
    transaction: &Transaction<'_>,
    relation_id: &str,
) -> AppResult<()> {
    remove_usage_evidence_tx(transaction, "deployment", relation_id)?;
    let row = transaction
        .query_row(
            "SELECT skill_id, directory_node_id, path, active, content_fingerprint
             FROM deployment_relations WHERE relation_id=?1",
            [relation_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(database_error)?;
    let Some((Some(skill_id), Some(directory_id), path, active, fingerprint)) = row else {
        prune_empty_slots_tx(transaction)?;
        return Ok(());
    };
    if active != 1 {
        prune_empty_slots_tx(transaction)?;
        return Ok(());
    }
    let Ok(skill_id) = skill_id.parse::<SkillId>() else {
        prune_empty_slots_tx(transaction)?;
        return Ok(());
    };
    if let Some(entry_key) = entry_key_for_path_tx(transaction, &directory_id, &path)? {
        insert_usage_evidence_tx(
            transaction,
            &skill_id,
            &entry_key,
            "deployment",
            relation_id,
            None,
            Some(&fingerprint),
        )?;
    }
    prune_empty_slots_tx(transaction)
}

/// Rebuilds slot evidence for a source-copy fact after its row changes.
pub(super) fn sync_source_copy_usage_evidence_tx(
    transaction: &Transaction<'_>,
    fact: &skillhub_core::relationship::SourceCopyRelationFact,
) -> AppResult<()> {
    remove_usage_evidence_tx(transaction, "source_copy", &fact.relation_id)?;
    if fact.active {
        if let Some(directory_id) = fact.directory_node_id.as_deref() {
            if let Some(entry_key) =
                entry_key_for_path_tx(transaction, directory_id, &fact.source_path)?
            {
                insert_usage_evidence_tx(
                    transaction,
                    &fact.skill_id,
                    &entry_key,
                    "source_copy",
                    &fact.relation_id,
                    Some(&fact.physical_source_id),
                    fact.current_fingerprint.as_deref(),
                )?;
            }
        }
    }
    prune_empty_slots_tx(transaction)
}

/// Refreshes a deployment relation selected by its observed target identity.
pub(super) fn refresh_deployment_usage_evidence_by_target_tx(
    transaction: &Transaction<'_>,
    agent_client_id: &str,
    path_key: &str,
) -> AppResult<()> {
    let relation_id = transaction
        .query_row(
            "SELECT relation_id FROM deployment_relations
             WHERE agent_client_id=?1 AND path_key=?2",
            params![agent_client_id, path_key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(database_error)?;
    if let Some(relation_id) = relation_id {
        sync_deployment_usage_evidence_tx(transaction, &relation_id)?;
    }
    Ok(())
}

pub(super) fn clear_usage_slots_for_skill_tx(
    transaction: &Transaction<'_>,
    skill_id: &str,
) -> AppResult<()> {
    transaction
        .execute(
            "DELETE FROM active_usage_slots WHERE skill_id=?1",
            [skill_id],
        )
        .map(|_| ())
        .map_err(database_error)
}

fn insert_usage_evidence_tx(
    transaction: &Transaction<'_>,
    skill_id: &SkillId,
    entry_key: &UsageEntryKey,
    relation_kind: &str,
    relation_id: &str,
    physical_source_id: Option<&str>,
    content_fingerprint: Option<&str>,
) -> AppResult<()> {
    transaction
        .execute(
            "INSERT INTO active_usage_slots(skill_id, directory_id, relative_entry_path)
             VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING",
            params![
                skill_id.to_string(),
                entry_key.directory_id,
                entry_key.relative_entry_path,
            ],
        )
        .map_err(database_error)?;
    transaction
        .execute(
            "INSERT INTO active_usage_evidence
             (skill_id, directory_id, relative_entry_path, relation_kind,
              relation_id, physical_source_id, content_fingerprint)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                skill_id.to_string(),
                entry_key.directory_id,
                entry_key.relative_entry_path,
                relation_kind,
                relation_id,
                physical_source_id,
                content_fingerprint,
            ],
        )
        .map(|_| ())
        .map_err(database_error)
}

fn entry_key_for_path_tx(
    transaction: &Transaction<'_>,
    directory_id: &str,
    entry_path: &str,
) -> AppResult<Option<UsageEntryKey>> {
    let node = transaction
        .query_row(
            "SELECT path_key, role FROM directory_nodes WHERE node_id=?1",
            [directory_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(database_error)?;
    let Some((root, role)) = node else {
        return Ok(None);
    };
    if role == "central_library" {
        return Ok(None);
    }
    let root = comparable_path(&root).trim_end_matches('/').to_owned();
    let entry = comparable_path(entry_path);
    let Some(relative) = entry
        .strip_prefix(&root)
        .and_then(|suffix| suffix.strip_prefix('/'))
    else {
        return Ok(None);
    };
    // Keep path normalization identical to `UsageEntryKey` projection: repeated
    // separators collapse, while traversal components remain unresolvable.
    let components = relative
        .split('/')
        .filter(|component| !component.is_empty())
        .collect::<Vec<_>>();
    if components.is_empty()
        || components
            .iter()
            .any(|component| *component == "." || *component == "..")
    {
        return Ok(None);
    }
    Ok(Some(UsageEntryKey {
        directory_id: directory_id.to_owned(),
        relative_entry_path: components.join("/"),
    }))
}

fn comparable_path(path: &str) -> String {
    observed_path_key(&path.replace('\\', "/"))
}

pub(super) fn remove_usage_evidence_tx(
    transaction: &Transaction<'_>,
    relation_kind: &str,
    relation_id: &str,
) -> AppResult<()> {
    transaction
        .execute(
            "DELETE FROM active_usage_evidence WHERE relation_kind=?1 AND relation_id=?2",
            params![relation_kind, relation_id],
        )
        .map_err(database_error)?;
    prune_empty_slots_tx(transaction)
}

fn prune_empty_slots_tx(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction
        .execute(
            "DELETE FROM active_usage_slots
             WHERE NOT EXISTS (
                 SELECT 1 FROM active_usage_evidence evidence
                 WHERE evidence.skill_id=active_usage_slots.skill_id
                   AND evidence.directory_id=active_usage_slots.directory_id
                   AND evidence.relative_entry_path=active_usage_slots.relative_entry_path
             )",
            [],
        )
        .map(|_| ())
        .map_err(database_error)
}

fn list_active_evidence(
    transaction: &Transaction<'_>,
    skill_id: &SkillId,
    entry_key: &UsageEntryKey,
) -> AppResult<Vec<ActiveEvidence>> {
    let mut statement = transaction
        .prepare(
            "SELECT relation_kind, relation_id, physical_source_id, content_fingerprint
             FROM active_usage_evidence
             WHERE skill_id=?1 AND directory_id=?2 AND relative_entry_path=?3
             ORDER BY relation_kind, relation_id",
        )
        .map_err(database_error)?;
    let rows = statement
        .query_map(
            params![
                skill_id.to_string(),
                entry_key.directory_id,
                entry_key.relative_entry_path,
            ],
            |row| {
                Ok(ActiveEvidence {
                    relation_kind: row.get(0)?,
                    relation_id: row.get(1)?,
                    physical_source_id: row.get(2)?,
                    content_fingerprint: row.get(3)?,
                })
            },
        )
        .map_err(database_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
}

fn validate_evidence(record: &UsageDecisionRecord, evidence: &[ActiveEvidence]) -> AppResult<()> {
    let mut actual_relation_ids = evidence
        .iter()
        .map(|item| item.relation_id.clone())
        .collect::<Vec<_>>();
    let mut requested_relation_ids = record.relation_ids.clone();
    actual_relation_ids.sort();
    requested_relation_ids.sort();
    if actual_relation_ids != requested_relation_ids {
        return Err(operation_conflict("active_usage_evidence_changed"));
    }

    let mut actual_physical_ids = evidence
        .iter()
        .filter_map(|item| item.physical_source_id.clone())
        .collect::<Vec<_>>();
    actual_physical_ids.sort();
    actual_physical_ids.dedup();
    let mut requested_physical_ids = record.physical_source_ids.clone();
    requested_physical_ids.sort();
    requested_physical_ids.dedup();
    if actual_physical_ids != requested_physical_ids {
        return Err(operation_conflict("physical_source_evidence_changed"));
    }
    if let Some(fingerprint) = record.content_fingerprint.as_deref() {
        if evidence
            .iter()
            .any(|item| item.content_fingerprint.as_deref() != Some(fingerprint))
        {
            return Err(operation_conflict("content_fingerprint_changed"));
        }
    }
    Ok(())
}

fn find_operation_record(
    transaction: &Transaction<'_>,
    operation_id: &str,
    record: &UsageDecisionRecord,
) -> AppResult<Option<UsageDecisionRecord>> {
    let row = transaction
        .query_row(
            "SELECT decision_id, skill_id, directory_id, relative_entry_path,
                    relation_ids_json, physical_source_ids_json, decision,
                    content_fingerprint, decided_at, operation_id
             FROM usage_decisions
             WHERE operation_id=?1 AND skill_id=?2 AND directory_id=?3
               AND relative_entry_path=?4 AND legacy_evidence=0",
            params![
                operation_id,
                record.skill_id.to_string(),
                record.entry_key.directory_id,
                record.entry_key.relative_entry_path,
            ],
            usage_decision_row,
        )
        .optional()
        .map_err(database_error)?;
    row.map(decode_usage_decision).transpose()
}

type UsageDecisionRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    i64,
    Option<String>,
);

fn usage_decision_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<UsageDecisionRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
    ))
}

fn decode_usage_decision(row: UsageDecisionRow) -> AppResult<UsageDecisionRecord> {
    let skill_id = row
        .1
        .parse::<SkillId>()
        .map_err(|_| invalid_record("skill_id"))?;
    let decision = match row.6.as_str() {
        "released" => UsageDecision::Released,
        "retained_independent_copy" => UsageDecision::RetainedIndependentCopy,
        _ => return Err(invalid_record("decision")),
    };
    Ok(UsageDecisionRecord {
        decision_id: row.0,
        skill_id,
        entry_key: UsageEntryKey {
            directory_id: row.2,
            relative_entry_path: row.3,
        },
        relation_ids: serde_json::from_str(&row.4).map_err(serialization_error)?,
        physical_source_ids: serde_json::from_str(&row.5).map_err(serialization_error)?,
        decision,
        content_fingerprint: row.7,
        decided_at: row.8,
        operation_id: row.9,
    })
}

fn validate_record(record: &UsageDecisionRecord) -> AppResult<()> {
    for (field, value) in [
        ("decision_id", record.decision_id.as_str()),
        ("directory_id", record.entry_key.directory_id.as_str()),
        (
            "relative_entry_path",
            record.entry_key.relative_entry_path.as_str(),
        ),
    ] {
        if value.trim().is_empty() {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", field)
                .with_action(RecoveryAction::Retry));
        }
    }
    if !is_canonical_relative_entry_path(&record.entry_key.relative_entry_path) {
        return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
            .with_param("field", "relative_entry_path")
            .with_action(RecoveryAction::Retry));
    }
    if record.relation_ids.is_empty()
        || record
            .relation_ids
            .iter()
            .any(|value| value.trim().is_empty())
    {
        return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
            .with_param("field", "relation_ids")
            .with_action(RecoveryAction::Retry));
    }
    if record
        .physical_source_ids
        .iter()
        .any(|value| value.trim().is_empty())
    {
        return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
            .with_param("field", "physical_source_ids")
            .with_action(RecoveryAction::Retry));
    }
    if record
        .operation_id
        .as_deref()
        .is_none_or(|operation_id| operation_id.trim().is_empty())
    {
        return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
            .with_param("field", "operation_id")
            .with_action(RecoveryAction::Retry));
    }
    Ok(())
}

fn is_canonical_relative_entry_path(path: &str) -> bool {
    if path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return false;
    }
    let components = path.split('/').collect::<Vec<_>>();
    if components.is_empty()
        || components
            .iter()
            .any(|component| component.is_empty() || *component == "." || *component == "..")
    {
        return false;
    }
    let first_component = components[0].as_bytes();
    if first_component.len() >= 2
        && first_component[0].is_ascii_alphabetic()
        && first_component[1] == b':'
    {
        return false;
    }
    components.join("/") == path
}

fn decision_code(decision: UsageDecision) -> &'static str {
    match decision {
        UsageDecision::Released => "released",
        UsageDecision::RetainedIndependentCopy => "retained_independent_copy",
    }
}

fn operation_conflict(reason: &str) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("reason", reason)
        .with_action(RecoveryAction::Retry)
}

fn invalid_record(field: &str) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("field", field)
        .with_action(RecoveryAction::OpenReadOnly)
}

fn serialization_error(error: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("reason", error.to_string())
        .with_action(RecoveryAction::OpenReadOnly)
}

fn database_error(error: rusqlite::Error) -> AppError {
    super::classify_database_error(error)
}
