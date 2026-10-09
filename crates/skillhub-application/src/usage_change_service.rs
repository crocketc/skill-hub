//! Prepared, journal-backed release of one or more unified usage relations.
//!
//! The preview is rebuilt from the normalized usage projection at commit time.
//! Destructive file work is limited to a managed, healthy, uniquely identified
//! target and is compensated from a verified backup if the structured decision
//! transaction fails.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use skillhub_adapters::deployment::{DeploymentFilesystem, OwnershipProof};
use skillhub_adapters::relationship::FilesystemRelationshipProbe;
use skillhub_core::agent::{AgentDirectoryIdentity, AgentDirectoryProjection, AgentDirectoryRole};
use skillhub_core::api::{
    AppQueryResult, CommitUsageChange, PrepareUsageChange, RelationshipOverviewScope,
};
use skillhub_core::deployment::observed_path_key;
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, DeploymentRelationFact, FileRepresentation, PreparedUsageChange,
    RelationGovernanceTargetKind, SourceCopyRelationFact, UsageChangeAction, UsageChangeConsumer,
    UsageChangeImpact, UsageChangeImpactAction, UsageChangeItemResult, UsageChangeItemStatus,
    UsageChangeResult, UsageCopyDisposition, UsageDecision, UsageDecisionRecord,
    UsageEntryEvidence, UsageEntryKey, UsageForm, UsageHealthReason, UsageManagement,
    UsageRecoveryPoint, UsageRelationTarget, UsageRelationView, UsageSubjectVersion,
};
use skillhub_core::{
    reparse_physical_id_for_path, symlink_physical_id_for_path, AppError, AppResult,
    DeploymentMode, ErrorCode, OperationId, OperationPhase, OperationProgress, OperationRecord,
    RecoveryAction, Severity, SkillId, VersionId,
};
use skillhub_storage::Database;

use crate::relationship_governance_service::{
    capture_path_chain, create_dir_link, PathChainSnapshot,
};
use crate::LocalApplicationFacade;

const OPERATION_KIND: &str = "usage_release";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct ReleaseJournal {
    request: PrepareUsageChange,
    prepared: PreparedUsageChange,
    plans: Vec<ReleasePlan>,
    completed: Vec<UsageChangeItemResult>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct ReleasePlan {
    evidence: UsageEntryEvidence,
    impact: UsageChangeImpact,
    decision: UsageDecision,
    decision_fingerprint: Option<String>,
    expected_evidence_fingerprints: BTreeMap<String, Option<String>>,
    runtime_name: Option<String>,
    version_id: Option<VersionId>,
    parent_chain: Option<PathChainSnapshot>,
    subject_chain: Option<PathChainSnapshot>,
    backup_path: Option<String>,
    #[serde(default)]
    backup_anchor_chain: Option<PathChainSnapshot>,
    #[serde(default)]
    backup_parent_chain: Option<PathChainSnapshot>,
    backup_identity: Option<String>,
    backup_created: bool,
    removal_started: bool,
    #[serde(default)]
    restore_started: bool,
    #[serde(default)]
    restore_target_identity: Option<String>,
    target_removed: bool,
}

#[derive(Clone)]
struct RawFacts {
    deployments: Vec<DeploymentRelationFact>,
    source_copies: Vec<SourceCopyRelationFact>,
    directory_capabilities: Vec<AgentDirectoryCapabilityFact>,
    confirmations: Vec<skillhub_core::relationship::RelationGovernanceConfirmationFact>,
    revision: i64,
}

#[derive(Clone)]
struct RawEntry {
    relation_id: String,
    skill_id: SkillId,
    path: String,
    representation: FileRepresentation,
    management: UsageManagement,
    physical_source_id: Option<String>,
    fingerprint: Option<String>,
}

#[derive(Clone, Copy)]
struct ReleaseClassificationFacts {
    all_managed: bool,
    all_unmanaged: bool,
    normal: bool,
    verified_writable: bool,
    extra_consumer: bool,
}

pub(crate) fn legacy_release_endpoint_error() -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("reason", "usage_change_preview_required")
        .with_action(RecoveryAction::Retry)
}

impl LocalApplicationFacade {
    pub fn prepare_usage_change(
        &self,
        request: PrepareUsageChange,
    ) -> AppResult<PreparedUsageChange> {
        validate_request(&request)?;
        let request_fingerprint = request_fingerprint(&request)?;
        {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("usage_change.prepare.database"))?;
            if let Some(record) = database
                .operation_repository()
                .get_sync(request.operation_id)?
            {
                if record.kind != OPERATION_KIND {
                    return Err(operation_conflict("operation_id_reused"));
                }
                if record.request_fingerprint != request_fingerprint {
                    return Err(AppError::new(
                        ErrorCode::OperationIdReusedWithDifferentRequest,
                        Severity::Error,
                    )
                    .with_param("operation_id", request.operation_id.to_string()));
                }
                let journal: ReleaseJournal = serde_json::from_value(record.recovery_data)
                    .map_err(|_| operation_conflict("usage_release_journal_invalid"))?;
                return Ok(journal.prepared);
            }
        }

        let prepared_id = OperationId::new();
        let journal = build_release_journal(self, request.clone(), prepared_id)?;
        let mut record =
            OperationRecord::planned(request.operation_id, OPERATION_KIND, request_fingerprint);
        set_phase(
            &mut record,
            OperationPhase::Prepared,
            0,
            journal.plans.len() as u32,
        );
        record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
        record.result = Some(serde_json::to_value(&journal.prepared).map_err(serialization_error)?);

        let database = self
            .database
            .lock()
            .map_err(|_| internal("usage_change.prepare.database"))?;
        if let Some(existing) = database
            .operation_repository()
            .get_sync(request.operation_id)?
        {
            if existing.kind != OPERATION_KIND {
                return Err(operation_conflict("operation_id_reused"));
            }
            if existing.request_fingerprint != record.request_fingerprint {
                return Err(AppError::new(
                    ErrorCode::OperationIdReusedWithDifferentRequest,
                    Severity::Error,
                )
                .with_param("operation_id", request.operation_id.to_string()));
            }
            let existing: ReleaseJournal = serde_json::from_value(existing.recovery_data)
                .map_err(|_| operation_conflict("usage_release_journal_invalid"))?;
            return Ok(existing.prepared);
        }
        database.operation_repository().insert_sync(&record)?;
        Ok(journal.prepared)
    }

    pub fn commit_usage_change(&self, request: CommitUsageChange) -> AppResult<UsageChangeResult> {
        // Serialize against relationship migration and other usage changes in
        // this facade before rebuilding the snapshot and locking SQLite.
        let _mutation = self
            .relation_migration_lock
            .lock()
            .map_err(|_| internal("usage_change.commit.mutation_lock"))?;

        let (mut record, mut journal) = {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("usage_change.commit.database"))?;
            let record = database
                .operation_repository()
                .get_sync(request.operation_id)?
                .ok_or_else(|| operation_conflict("usage_change_preview_missing"))?;
            if record.kind != OPERATION_KIND {
                return Err(operation_conflict("operation_id_reused"));
            }
            let journal: ReleaseJournal = serde_json::from_value(record.recovery_data.clone())
                .map_err(|_| operation_conflict("usage_release_journal_invalid"))?;
            if journal.prepared.prepared_id != request.prepared_id {
                return Err(operation_conflict("usage_change_preview_mismatch"));
            }
            if record.phase == OperationPhase::Committed {
                return record
                    .result
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(serialization_error)?
                    .ok_or_else(|| operation_conflict("usage_change_receipt_missing"));
            }
            if record.phase == OperationPhase::NeedsRecovery {
                return Err(operation_conflict("usage_change_needs_recovery"));
            }
            if record.phase != OperationPhase::Prepared {
                return Err(operation_conflict("usage_change_preview_not_prepared"));
            }
            (record, journal)
        };

        let current =
            build_release_journal(self, journal.request.clone(), journal.prepared.prepared_id)?;
        if current.prepared != journal.prepared || current.plans != journal.plans {
            return Err(operation_conflict("usage_change_preview_stale"));
        }

        let database = self
            .database
            .lock()
            .map_err(|_| internal("usage_change.commit.database"))?;
        let revision = database.relationship_repository().relationship_revision()?;
        if revision.to_string() != journal.prepared.relationship_revision {
            return Err(operation_conflict("usage_change_preview_stale"));
        }
        for plan in &journal.plans {
            validate_filesystem_snapshot(plan)?;
        }

        set_phase(
            &mut record,
            OperationPhase::Applying,
            journal.completed.len() as u32,
            journal.plans.len() as u32,
        );
        record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
        database.operation_repository().update_sync(&record)?;

        let mut first_error = None;
        for index in 0..journal.plans.len() {
            let result = apply_plan(&database, &mut record, &mut journal, index);
            match result {
                Ok(item_result) => journal.completed.push(item_result),
                Err((error, recovery_required)) => {
                    first_error.get_or_insert(error.clone());
                    let plan = &journal.plans[index];
                    journal.completed.push(UsageChangeItemResult {
                        relation_ids: plan.evidence.relation_ids.clone(),
                        skill_id: plan.evidence.skill_id,
                        target: plan.impact.target.clone(),
                        action: plan.impact.action,
                        status: if recovery_required {
                            UsageChangeItemStatus::RecoveryRequired
                        } else {
                            UsageChangeItemStatus::Failed
                        },
                        reason: error
                            .params
                            .get("reason")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        recovery_point: recovery_point(plan),
                    });
                    if recovery_required {
                        set_phase(
                            &mut record,
                            OperationPhase::NeedsRecovery,
                            journal.completed.len() as u32,
                            journal.plans.len() as u32,
                        );
                        record.recovery_data =
                            serde_json::to_value(&journal).map_err(serialization_error)?;
                        record.error_code = Some(error.code);
                        database.operation_repository().update_sync(&record)?;
                        return Err(error);
                    }
                }
            }
            record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
            set_phase(
                &mut record,
                OperationPhase::Applying,
                journal.completed.len() as u32,
                journal.plans.len() as u32,
            );
            database.operation_repository().update_sync(&record)?;
        }

        if let Some(error) = first_error {
            if journal
                .completed
                .iter()
                .all(|item| item.status == UsageChangeItemStatus::Failed)
            {
                set_phase(
                    &mut record,
                    OperationPhase::RolledBack,
                    journal.completed.len() as u32,
                    journal.plans.len() as u32,
                );
                record.error_code = Some(error.code);
                record.recovery_data =
                    serde_json::to_value(&journal).map_err(serialization_error)?;
                database.operation_repository().update_sync(&record)?;
                return Err(error);
            }
        }

        let result = UsageChangeResult {
            operation_id: journal.prepared.operation_id,
            prepared_id: journal.prepared.prepared_id,
            recovery_required: journal
                .completed
                .iter()
                .any(|item| item.status == UsageChangeItemStatus::RecoveryRequired),
            item_results: journal.completed.clone(),
        };
        set_phase(
            &mut record,
            OperationPhase::Committed,
            journal.completed.len() as u32,
            journal.plans.len() as u32,
        );
        record.result = Some(serde_json::to_value(&result).map_err(serialization_error)?);
        record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
        database.operation_repository().update_sync(&record)?;
        Ok(result)
    }
}

fn build_release_journal(
    facade: &LocalApplicationFacade,
    request: PrepareUsageChange,
    prepared_id: OperationId,
) -> AppResult<ReleaseJournal> {
    let (projection, overview) = {
        let before = facade
            .database
            .lock()
            .map_err(|_| internal("usage_change.prepare.revision"))?
            .relationship_repository()
            .relationship_revision()?;
        let projection = match facade.get_agent_directory_projection()? {
            AppQueryResult::AgentDirectoryProjection(projection) => projection,
            _ => unreachable!("agent directory query returns its projection"),
        };
        let overview = match facade.get_relationship_overview(RelationshipOverviewScope::All)? {
            AppQueryResult::RelationshipOverview(overview) => overview,
            _ => unreachable!("relationship overview query returns its projection"),
        };
        let after = facade
            .database
            .lock()
            .map_err(|_| internal("usage_change.prepare.revision"))?
            .relationship_repository()
            .relationship_revision()?;
        if before != after {
            return Err(operation_conflict(
                "usage_change_facts_changed_during_prepare",
            ));
        }
        (projection, overview)
    };
    let facts = {
        let database = facade
            .database
            .lock()
            .map_err(|_| internal("usage_change.prepare.database"))?;
        RawFacts {
            deployments: database
                .relationship_repository()
                .list_relations()?
                .into_iter()
                .filter(|fact| fact.active && fact.released_at.is_none())
                .collect(),
            source_copies: database
                .relationship_repository()
                .list_source_copy_relations(true)?,
            directory_capabilities: database.relationship_repository().list_capabilities()?,
            confirmations: database
                .relationship_repository()
                .list_relation_governance_confirmations()?,
            revision: database.relationship_repository().relationship_revision()?,
        }
    };
    let revision_text = facts.revision.to_string();

    let mut selected = Vec::<&UsageRelationView>::new();
    if !request.relation_ids.is_empty() {
        let mut selected_indices = BTreeSet::new();
        for relation_id in &request.relation_ids {
            let matches = overview
                .usage_relations
                .iter()
                .enumerate()
                .filter(|(_, relation)| {
                    relation.active
                        && (relation.relation_id == *relation_id
                            || relation
                                .evidence_relation_ids
                                .iter()
                                .any(|evidence_id| evidence_id == relation_id))
                })
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            match matches.as_slice() {
                [index] => {
                    selected_indices.insert(*index);
                }
                [] => return Err(operation_conflict("usage_change_relation_missing")),
                _ => return Err(operation_conflict("usage_change_evidence_ambiguous")),
            }
        }
        selected.extend(
            selected_indices
                .into_iter()
                .map(|index| &overview.usage_relations[index]),
        );
    } else {
        let skill_id = request
            .skill_id
            .ok_or_else(|| operation_conflict("usage_change_selection_invalid"))?;
        let requested_keys = request
            .selected_entry_keys
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut observed_keys = BTreeMap::<_, usize>::new();
        for relation in &overview.usage_relations {
            if !relation.active || relation.skill_id != Some(skill_id) {
                continue;
            }
            let Some(entry_key) = relation.entry_key.as_ref() else {
                continue;
            };
            if requested_keys.contains(entry_key) {
                *observed_keys.entry(entry_key.clone()).or_default() += 1;
                selected.push(relation);
            }
        }
        if requested_keys.len() != request.selected_entry_keys.len()
            || requested_keys
                .iter()
                .any(|key| observed_keys.get(key) != Some(&1))
            || selected.len() != requested_keys.len()
        {
            return Err(operation_conflict("usage_change_selection_invalid"));
        }
    }
    if selected.is_empty() {
        return Err(operation_conflict("usage_change_relation_missing"));
    }

    let entries = raw_entries(&facts, &projection)?;
    let has_applicable_copy = selected.iter().any(|view| {
        view.form == Some(UsageForm::FullCopy)
            && view.management == UsageManagement::Managed
            && view.evidence_relation_ids.iter().all(|id| {
                entries.get(id).is_some_and(|entry| {
                    entry.management == UsageManagement::Managed
                        && fs::symlink_metadata(&entry.path).is_ok()
                })
            })
    });
    if request.copy_disposition.is_some() && !has_applicable_copy {
        return Err(operation_conflict("copy_disposition_not_applicable"));
    }
    let mut plans = Vec::new();
    let mut affected_skill_ids = HashSet::<SkillId>::new();
    let mut subject_versions = HashMap::<SkillId, UsageSubjectVersion>::new();
    let mut all_consumers = Vec::<UsageChangeConsumer>::new();
    for view in &overview.usage_relations {
        if !view.active {
            continue;
        }
        if let Some(consumer) = consumer_for_view(view, &entries) {
            all_consumers.push(consumer);
        }
    }
    all_consumers.sort_by(|left, right| {
        left.relation_ids.cmp(&right.relation_ids).then_with(|| {
            left.target
                .agent_client_id
                .cmp(&right.target.agent_client_id)
        })
    });

    for view in selected {
        let evidence_ids = sorted_unique(view.evidence_relation_ids.clone())?;
        let skill_id = view
            .skill_id
            .ok_or_else(|| operation_conflict("usage_subject_unverified"))?;
        let entry_key = view
            .entry_key
            .clone()
            .ok_or_else(|| operation_conflict("usage_entry_identity_unverified"))?;
        affected_skill_ids.insert(skill_id);
        let group = evidence_ids
            .iter()
            .map(|id| {
                entries
                    .get(id)
                    .cloned()
                    .ok_or_else(|| operation_conflict("usage_change_evidence_missing"))
            })
            .collect::<AppResult<Vec<_>>>()?;
        if group.iter().any(|entry| entry.skill_id != skill_id) {
            return Err(operation_conflict("usage_change_identity_conflict"));
        }
        let paths = group
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<BTreeSet<_>>();
        if paths.len() != 1 {
            return Err(operation_conflict("usage_change_identity_conflict"));
        }
        let path = PathBuf::from(group[0].path.clone());
        let entry_metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(operation_conflict("usage_entry_access_unverified")),
        };
        let exists = entry_metadata.is_some();
        let representation = if group
            .iter()
            .all(|entry| entry.representation == group[0].representation)
        {
            group[0].representation
        } else {
            FileRepresentation::Unknown
        };
        if exists {
            let actual_representation = FilesystemRelationshipProbe.directory_representation(&path);
            if !reported_representation_matches_actual(representation, actual_representation) {
                return Err(operation_conflict("usage_entry_representation_changed"));
            }
        }
        let link_target_path = if view.form == Some(UsageForm::Link) {
            view.link_target_path.clone()
        } else {
            None
        };
        let physical_identity = if exists {
            match representation {
                FileRepresentation::SymbolicLink => symlink_physical_id_for_path(&path),
                FileRepresentation::DirectoryJunction => reparse_physical_id_for_path(&path),
                FileRepresentation::Copy | FileRepresentation::Directory => {
                    skillhub_core::physical_id_for_path(&path)
                }
                FileRepresentation::Unknown => None,
            }
        } else {
            None
        };
        let content_fingerprint = if exists {
            DeploymentFilesystem::hash_tree(&path).ok()
        } else {
            None
        };
        let stored_fingerprints = group
            .iter()
            .map(|entry| entry.fingerprint.as_deref())
            .collect::<BTreeSet<_>>();
        let decision_fingerprint = if stored_fingerprints.len() == 1 {
            stored_fingerprints
                .iter()
                .next()
                .copied()
                .flatten()
                .map(str::to_owned)
        } else {
            None
        };
        let mut evidence = UsageEntryEvidence {
            skill_id,
            entry_key: entry_key.clone(),
            relation_ids: evidence_ids.clone(),
            physical_source_ids: sorted_unique(
                group
                    .iter()
                    .filter_map(|entry| entry.physical_source_id.clone())
                    .collect(),
            )?,
            path: path.to_string_lossy().into_owned(),
            directory_role: view.target.directory_role,
            form: view.form,
            management: view.management,
            representation,
            content_fingerprint: content_fingerprint.clone(),
            physical_identity,
            link_target_path,
            exists,
        };

        let version_record = facade
            .library_runtime
            .snapshot()?
            .central
            .load_portable_skill(skill_id)?;
        let (runtime_name, version_id) = version_record
            .map(|(record, version)| (Some(record.runtime_name), version))
            .unwrap_or((None, None));
        subject_versions.insert(
            skill_id,
            UsageSubjectVersion {
                skill_id,
                version_id: version_id.clone(),
            },
        );

        let same_path_consumers = all_consumers
            .iter()
            .filter(|consumer| path_matches(consumer.path.as_deref(), &path))
            .cloned()
            .collect::<Vec<_>>();
        let shared_consumers = shared_directory_consumers(
            &projection,
            &facts.directory_capabilities,
            view,
            &path,
            &same_path_consumers,
        )?;
        all_consumers.extend(shared_consumers);
        let selected_ids = evidence_ids.iter().cloned().collect::<BTreeSet<_>>();
        let extra_consumer = same_path_consumers.iter().any(|consumer| {
            consumer
                .relation_ids
                .iter()
                .any(|id| !selected_ids.contains(id))
        });
        let verified_writable = directory_is_verified_writable(
            &projection,
            &path,
            view.target.directory_role,
            view.target.agent_client_id.as_deref(),
        );
        let normal = view.health_reasons == [UsageHealthReason::Normal];
        let all_managed = view.management == UsageManagement::Managed
            && group
                .iter()
                .all(|entry| entry.management == UsageManagement::Managed);
        let all_unmanaged = view.management == UsageManagement::Unmanaged
            && group
                .iter()
                .all(|entry| entry.management == UsageManagement::Unmanaged);
        let mode = classify_release_action(
            &request,
            view,
            &evidence,
            decision_fingerprint.as_deref(),
            ReleaseClassificationFacts {
                all_managed,
                all_unmanaged,
                normal,
                verified_writable,
                extra_consumer,
            },
        )?;

        let (parent_chain, subject_chain, backup_path, backup_anchor_chain) = if matches!(
            mode,
            UsageChangeImpactAction::RemoveLink | UsageChangeImpactAction::RemoveCopyWithBackup
        ) {
            let parent = path
                .parent()
                .ok_or_else(|| operation_conflict("usage_entry_parent_missing"))?;
            let parent_chain = Some(capture_path_chain(parent)?);
            let library = facade.library_runtime.snapshot()?;
            let subject_path = library.central.visible_skill_path_for_runtime(
                skill_id,
                runtime_name.as_deref().unwrap_or_default(),
            );
            let subject_chain = Some(capture_path_chain(&subject_path)?);
            if version_id.is_none() || runtime_name.is_none() {
                return Err(operation_conflict("usage_subject_version_unavailable"));
            }
            let backup_anchor_chain = if mode == UsageChangeImpactAction::RemoveCopyWithBackup {
                Some(capture_backup_anchor(
                    &library.root,
                    &library.central.paths().management_dir,
                )?)
            } else {
                None
            };
            let backup_path = if mode == UsageChangeImpactAction::RemoveCopyWithBackup {
                let management = backup_anchor_chain
                    .as_ref()
                    .and_then(|chain| chain.nodes.first())
                    .map(|node| PathBuf::from(&node.path))
                    .ok_or_else(|| operation_conflict("usage_backup_anchor_unavailable"))?;
                let path = management
                    .join("usage-release-backups")
                    .join(request.operation_id.to_string())
                    .join(format!("{}", plans.len()))
                    .join("entry");
                if path.exists() || fs::symlink_metadata(&path).is_ok() {
                    return Err(operation_conflict("usage_backup_path_occupied"));
                }
                Some(path.to_string_lossy().into_owned())
            } else {
                None
            };
            (
                parent_chain,
                subject_chain,
                backup_path,
                backup_anchor_chain,
            )
        } else {
            (None, None, None, None)
        };

        // Record the actual current identity in the prepared snapshot. This is
        // intentionally re-read by commit; paths received later are ignored.
        evidence.content_fingerprint = content_fingerprint;
        let target_consumers = same_path_consumers;
        let description = match mode {
            UsageChangeImpactAction::RemoveLink => "解除链接并保留技能主体。",
            UsageChangeImpactAction::KeepIndependentCopy => "保留完整拷贝并结束此使用关系。",
            UsageChangeImpactAction::RemoveCopyWithBackup => "先备份完整拷贝，再结束此使用关系。",
            UsageChangeImpactAction::RecordOnly => "只结束使用关系记录，保留入口文件。",
        };
        let impact = UsageChangeImpact {
            relation_ids: evidence_ids,
            skill_id,
            target: view.target.clone(),
            action: mode,
            description: description.to_owned(),
        };
        let decision = if mode == UsageChangeImpactAction::KeepIndependentCopy {
            UsageDecision::RetainedIndependentCopy
        } else {
            UsageDecision::Released
        };
        let _ = target_consumers;
        plans.push(ReleasePlan {
            evidence,
            impact,
            decision,
            decision_fingerprint,
            expected_evidence_fingerprints: group
                .iter()
                .map(|entry| (entry.relation_id.clone(), entry.fingerprint.clone()))
                .collect(),
            runtime_name,
            version_id,
            parent_chain,
            subject_chain,
            backup_path,
            backup_anchor_chain,
            backup_parent_chain: None,
            backup_identity: None,
            backup_created: false,
            removal_started: false,
            restore_started: false,
            restore_target_identity: None,
            target_removed: false,
        });
    }

    let mut consumers = BTreeMap::<
        (
            Vec<String>,
            Option<String>,
            Option<String>,
            Option<UsageEntryKey>,
        ),
        UsageChangeConsumer,
    >::new();
    for plan in &plans {
        let path = Path::new(&plan.evidence.path);
        for consumer in all_consumers
            .iter()
            .filter(|consumer| path_matches(consumer.path.as_deref(), path))
        {
            consumers.insert(
                (
                    consumer.relation_ids.clone(),
                    consumer.target.agent_client_id.clone(),
                    consumer.skill_id.map(|skill_id| skill_id.to_string()),
                    consumer.entry_key.clone(),
                ),
                consumer.clone(),
            );
        }
    }
    let consumers = consumers.into_values().collect::<Vec<_>>();
    let impacts = plans
        .iter()
        .map(|plan| plan.impact.clone())
        .collect::<Vec<_>>();
    let evidence = plans
        .iter()
        .map(|plan| plan.evidence.clone())
        .collect::<Vec<_>>();
    let limitations = plans
        .iter()
        .filter(|plan| plan.impact.action == UsageChangeImpactAction::RecordOnly)
        .map(|_| {
            "此入口的身份、健康或管理事实不足以支持文件操作；提交只会结束结构化关系记录。"
                .to_owned()
        })
        .collect::<Vec<_>>();
    let prepared = PreparedUsageChange {
        operation_id: request.operation_id,
        prepared_id,
        action: request.action,
        relationship_revision: revision_text,
        affected_skill_ids: {
            let mut ids = affected_skill_ids.into_iter().collect::<Vec<_>>();
            ids.sort_by_key(|id| id.to_string());
            ids
        },
        subject_versions: {
            let mut versions = subject_versions.into_values().collect::<Vec<_>>();
            versions.sort_by_key(|version| version.skill_id.to_string());
            versions
        },
        entry_evidence: evidence,
        consumers,
        impacts,
        limitations,
    };
    Ok(ReleaseJournal {
        request,
        prepared,
        plans,
        completed: Vec::new(),
    })
}

fn classify_release_action(
    request: &PrepareUsageChange,
    view: &UsageRelationView,
    evidence: &UsageEntryEvidence,
    decision_fingerprint: Option<&str>,
    facts: ReleaseClassificationFacts,
) -> AppResult<UsageChangeImpactAction> {
    if evidence.directory_role == Some(AgentDirectoryRole::Builtin) {
        if facts.normal {
            return Err(operation_conflict(
                "usage_builtin_healthy_release_forbidden",
            ));
        }
        return Ok(UsageChangeImpactAction::RecordOnly);
    }
    if !evidence.exists {
        return Ok(UsageChangeImpactAction::RecordOnly);
    }
    if facts.all_unmanaged {
        return Ok(UsageChangeImpactAction::RecordOnly);
    }
    if !facts.all_managed || view.management != UsageManagement::Managed {
        return Err(operation_conflict("usage_management_identity_conflict"));
    }
    if !facts.verified_writable {
        return Err(operation_conflict("usage_entry_directory_unverified"));
    }
    if facts.extra_consumer
        && request.copy_disposition == Some(UsageCopyDisposition::RemoveWithBackup)
    {
        return Err(operation_conflict("shared_usage_requires_resolution"));
    }
    match view.form {
        Some(UsageForm::Link) => {
            if facts.extra_consumer {
                Err(operation_conflict("shared_usage_requires_resolution"))
            } else if matches!(
                evidence.representation,
                FileRepresentation::SymbolicLink | FileRepresentation::DirectoryJunction
            ) && evidence.link_target_path.is_some()
                && evidence.physical_identity.is_some()
            {
                Ok(UsageChangeImpactAction::RemoveLink)
            } else {
                Err(operation_conflict("usage_entry_identity_unverified"))
            }
        }
        Some(UsageForm::FullCopy) => match request.copy_disposition {
            Some(UsageCopyDisposition::KeepIndependent) => {
                if !matches!(
                    evidence.representation,
                    FileRepresentation::Copy | FileRepresentation::Directory
                ) || evidence.physical_identity.is_none()
                    || evidence.content_fingerprint.is_none()
                {
                    return Err(operation_conflict("usage_entry_identity_unverified"));
                }
                Ok(UsageChangeImpactAction::KeepIndependentCopy)
            }
            Some(UsageCopyDisposition::RemoveWithBackup) => {
                if evidence.representation != FileRepresentation::Copy
                    || evidence.physical_identity.is_none()
                    || evidence.content_fingerprint.is_none()
                    || decision_fingerprint.is_none()
                    || evidence.content_fingerprint.as_deref() != decision_fingerprint
                {
                    return Err(operation_conflict("usage_entry_content_unverified"));
                }
                Ok(UsageChangeImpactAction::RemoveCopyWithBackup)
            }
            None => Err(operation_conflict("usage_copy_disposition_required")),
        },
        None => Err(operation_conflict("usage_entry_representation_unverified")),
    }
}

fn reported_representation_matches_actual(
    reported: FileRepresentation,
    actual: FileRepresentation,
) -> bool {
    matches!(
        (reported, actual),
        (
            FileRepresentation::Copy | FileRepresentation::Directory,
            FileRepresentation::Directory
        ) | (
            FileRepresentation::SymbolicLink,
            FileRepresentation::SymbolicLink
        ) | (
            FileRepresentation::DirectoryJunction,
            FileRepresentation::DirectoryJunction
        )
    )
}

fn raw_entries(
    facts: &RawFacts,
    projection: &AgentDirectoryProjection,
) -> AppResult<HashMap<String, RawEntry>> {
    let confirmations = facts
        .confirmations
        .iter()
        .filter(|fact| fact.confirmed_at.is_some())
        .map(|fact| (fact.relation_id.as_str(), fact.management_status))
        .collect::<HashMap<_, _>>();
    let mut entries = HashMap::new();
    for fact in &facts.deployments {
        let path = fact.path.clone();
        let role = role_for_raw_path(projection, &path, Some(&fact.agent_client_id));
        let mut management =
            if fact.ownership == skillhub_core::relationship::OwnershipState::SkillhubManaged {
                UsageManagement::Managed
            } else {
                UsageManagement::Unmanaged
            };
        if confirmations
            .get(fact.relation_id.as_str())
            .is_some_and(|status| {
                *status == skillhub_core::relationship::RelationManagementStatus::TakenOver
            })
        {
            management = UsageManagement::Managed;
        }
        let _ = role;
        let entry = RawEntry {
            relation_id: fact.relation_id.clone(),
            skill_id: fact
                .skill_id
                .ok_or_else(|| operation_conflict("usage_subject_unverified"))?,
            path,
            representation: fact.file_representation,
            management,
            physical_source_id: None,
            fingerprint: (!fact.content_fingerprint.is_empty())
                .then(|| fact.content_fingerprint.clone()),
        };
        if entries.insert(entry.relation_id.clone(), entry).is_some() {
            return Err(operation_conflict("usage_change_evidence_ambiguous"));
        }
    }
    for fact in &facts.source_copies {
        let entry = RawEntry {
            relation_id: fact.relation_id.clone(),
            skill_id: fact.skill_id,
            path: fact.source_path.clone(),
            representation: FileRepresentation::Directory,
            management: UsageManagement::Unmanaged,
            physical_source_id: Some(fact.physical_source_id.clone()),
            fingerprint: fact.current_fingerprint.clone(),
        };
        if entries.insert(entry.relation_id.clone(), entry).is_some() {
            return Err(operation_conflict("usage_change_evidence_ambiguous"));
        }
    }
    Ok(entries)
}

fn consumer_for_view(
    view: &UsageRelationView,
    entries: &HashMap<String, RawEntry>,
) -> Option<UsageChangeConsumer> {
    let mut rows = view
        .evidence_relation_ids
        .iter()
        .filter_map(|id| entries.get(id))
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| left.relation_id.cmp(&right.relation_id));
    let first = rows.first()?;
    let mut physical_source_ids = rows
        .iter()
        .filter_map(|row| row.physical_source_id.clone())
        .collect::<Vec<_>>();
    physical_source_ids.sort();
    physical_source_ids.dedup();
    let fingerprints = rows
        .iter()
        .map(|row| row.fingerprint.as_deref())
        .collect::<BTreeSet<_>>();
    Some(UsageChangeConsumer {
        relation_ids: rows.iter().map(|row| row.relation_id.clone()).collect(),
        skill_id: view.skill_id,
        entry_key: view.entry_key.clone(),
        target: view.target.clone(),
        path: Some(first.path.clone()),
        form: view.form,
        management: view.management,
        representation: view.file_representation,
        health_reasons: view.health_reasons.clone(),
        physical_source_ids,
        content_fingerprint: if fingerprints.len() == 1 {
            fingerprints
                .iter()
                .next()
                .copied()
                .flatten()
                .map(str::to_owned)
        } else {
            None
        },
    })
}

fn shared_directory_consumers(
    projection: &AgentDirectoryProjection,
    capabilities: &[AgentDirectoryCapabilityFact],
    view: &UsageRelationView,
    entry_path: &Path,
    existing_consumers: &[UsageChangeConsumer],
) -> AppResult<Vec<UsageChangeConsumer>> {
    if view.target.kind != RelationGovernanceTargetKind::SharedDirectory
        && view.target.directory_role != Some(AgentDirectoryRole::SharedDirectory)
    {
        return Ok(Vec::new());
    }
    let directory_id = view
        .target
        .directory_id
        .as_deref()
        .ok_or_else(|| operation_conflict("usage_shared_directory_identity_unverified"))?;
    let directory_path = entry_path
        .parent()
        .ok_or_else(|| operation_conflict("usage_entry_parent_missing"))?;
    let directory_path = fs::canonicalize(directory_path)
        .map_err(|_| operation_conflict("usage_shared_directory_identity_unverified"))?;
    let physical_id = skillhub_core::physical_id_for_path(&directory_path)
        .ok_or_else(|| operation_conflict("usage_shared_directory_identity_unverified"))?;
    let matching_directories = projection
        .directories
        .iter()
        .filter(|directory| {
            directory.is_shared_directory
                && directory.exists
                && directory.available
                && directory.identity
                    == AgentDirectoryIdentity::VerifiedPhysical(physical_id.clone())
                && fs::canonicalize(&directory.path)
                    .is_ok_and(|candidate| candidate == directory_path)
        })
        .collect::<Vec<_>>();
    let [directory] = matching_directories.as_slice() else {
        return Err(operation_conflict(
            "usage_shared_directory_identity_unverified",
        ));
    };

    let confirmed_clients = capabilities
        .iter()
        .filter(|capability| {
            capability.directory_node_id == directory_id
                && capability.recognition
                    == skillhub_core::relationship::DirectoryRecognition::Supported
        })
        .map(|capability| capability.agent_client_id.as_str())
        .collect::<BTreeSet<_>>();
    let already_represented = existing_consumers
        .iter()
        .filter(|consumer| {
            consumer.entry_key.as_ref() == view.entry_key.as_ref()
                && path_matches(consumer.path.as_deref(), entry_path)
        })
        .filter_map(|consumer| consumer.target.agent_client_id.as_deref())
        .collect::<BTreeSet<_>>();
    let mut consumers = directory
        .members
        .iter()
        .filter(|member| {
            member.supports_shared_directory
                && member.availability.exists
                && member.availability.available
        })
        .filter_map(|member| {
            let client_id = member.client_id.as_deref()?;
            (confirmed_clients.contains(client_id) && !already_represented.contains(client_id))
                .then(|| UsageChangeConsumer {
                    relation_ids: Vec::new(),
                    skill_id: view.skill_id,
                    entry_key: view.entry_key.clone(),
                    target: UsageRelationTarget {
                        kind: RelationGovernanceTargetKind::Agent,
                        directory_id: Some(directory_id.to_owned()),
                        agent_client_id: Some(client_id.to_owned()),
                        directory_role: None,
                        recognition: Some(
                            skillhub_core::relationship::DirectoryRecognition::Supported,
                        ),
                    },
                    path: Some(entry_path.to_string_lossy().into_owned()),
                    form: view.form,
                    management: UsageManagement::Unmanaged,
                    representation: view.file_representation,
                    health_reasons: view.health_reasons.clone(),
                    physical_source_ids: Vec::new(),
                    content_fingerprint: None,
                })
        })
        .collect::<Vec<_>>();
    consumers.sort_by(|left, right| {
        left.target
            .agent_client_id
            .cmp(&right.target.agent_client_id)
    });
    Ok(consumers)
}

fn directory_is_verified_writable(
    projection: &AgentDirectoryProjection,
    path: &Path,
    role: Option<AgentDirectoryRole>,
    client_id: Option<&str>,
) -> bool {
    let Some(
        role @ (AgentDirectoryRole::AgentUser
        | AgentDirectoryRole::AgentWorkspace
        | AgentDirectoryRole::SharedDirectory
        | AgentDirectoryRole::Project),
    ) = role
    else {
        return false;
    };
    let Some(parent) = path.parent() else {
        return false;
    };
    let Ok(parent) = fs::canonicalize(parent) else {
        return false;
    };
    projection.directories.iter().any(|directory| {
        (directory.role == role
            || (role == AgentDirectoryRole::SharedDirectory && directory.is_shared_directory))
            && directory.exists
            && directory.available
            && directory.writable
            && matches!(
                &directory.identity,
                AgentDirectoryIdentity::VerifiedPhysical(_)
            )
            && fs::canonicalize(&directory.path).is_ok_and(|registered| registered == parent)
            && client_id.is_none_or(|client| {
                directory.members.iter().any(|member| {
                    member.client_id.as_deref() == Some(client)
                        && member.availability.exists
                        && member.availability.available
                        && member.availability.writable
                })
            })
    })
}

fn role_for_raw_path(
    projection: &AgentDirectoryProjection,
    path: &str,
    _client_id: Option<&str>,
) -> Option<AgentDirectoryRole> {
    let parent = Path::new(path).parent()?;
    let parent = fs::canonicalize(parent).ok()?;
    projection
        .directories
        .iter()
        .find(|directory| {
            fs::canonicalize(&directory.path).is_ok_and(|registered| registered == parent)
        })
        .map(|directory| directory.role)
}

fn validate_filesystem_snapshot(plan: &ReleasePlan) -> AppResult<()> {
    if !matches!(
        plan.impact.action,
        UsageChangeImpactAction::RemoveLink
            | UsageChangeImpactAction::KeepIndependentCopy
            | UsageChangeImpactAction::RemoveCopyWithBackup
    ) {
        return Ok(());
    }
    let path = Path::new(&plan.evidence.path);
    if let Some(expected_parent_chain) = &plan.parent_chain {
        let parent = path
            .parent()
            .ok_or_else(|| operation_conflict("usage_entry_parent_missing"))?;
        if &capture_path_chain(parent)? != expected_parent_chain {
            return Err(operation_conflict("usage_entry_parent_identity_changed"));
        }
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|_| operation_conflict("usage_entry_missing"))?;
    match plan.evidence.representation {
        FileRepresentation::SymbolicLink | FileRepresentation::DirectoryJunction => {
            let actual_identity =
                if plan.evidence.representation == FileRepresentation::SymbolicLink {
                    symlink_physical_id_for_path(path)
                } else {
                    reparse_physical_id_for_path(path)
                };
            if actual_identity != plan.evidence.physical_identity {
                return Err(operation_conflict("usage_entry_identity_changed"));
            }
            let expected_target = plan
                .evidence
                .link_target_path
                .as_deref()
                .ok_or_else(|| operation_conflict("usage_link_target_unverified"))?;
            if fs::canonicalize(path).ok() != fs::canonicalize(expected_target).ok() {
                return Err(operation_conflict("usage_link_target_changed"));
            }
        }
        FileRepresentation::Copy | FileRepresentation::Directory => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(operation_conflict("usage_entry_representation_changed"));
            }
            if skillhub_core::physical_id_for_path(path) != plan.evidence.physical_identity {
                return Err(operation_conflict("usage_entry_identity_changed"));
            }
            let fingerprint = DeploymentFilesystem::hash_tree(path)?;
            if Some(fingerprint) != plan.evidence.content_fingerprint
                || (plan.impact.action == UsageChangeImpactAction::RemoveCopyWithBackup
                    && plan.decision_fingerprint.as_deref()
                        != plan.evidence.content_fingerprint.as_deref())
            {
                return Err(operation_conflict("usage_entry_content_changed"));
            }
        }
        _ => return Err(operation_conflict("usage_entry_representation_unverified")),
    }
    Ok(())
}

fn capture_backup_anchor(
    library_root: &Path,
    management_dir: &Path,
) -> AppResult<PathChainSnapshot> {
    let canonical_root = fs::canonicalize(library_root)
        .map_err(|_| operation_conflict("usage_backup_library_root_unavailable"))?;
    let metadata = fs::symlink_metadata(management_dir)
        .map_err(|_| operation_conflict("usage_backup_anchor_unavailable"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(operation_conflict("usage_backup_anchor_identity_changed"));
    }
    let canonical_management = fs::canonicalize(management_dir)
        .map_err(|_| operation_conflict("usage_backup_anchor_unavailable"))?;
    if canonical_management != canonical_root.join(".skillhub") {
        return Err(operation_conflict("usage_backup_anchor_identity_changed"));
    }
    let chain = capture_path_chain(&canonical_management)?;
    if chain.nodes.first().map(|node| node.path.as_str())
        != Some(canonical_management.to_string_lossy().as_ref())
    {
        return Err(operation_conflict("usage_backup_anchor_identity_changed"));
    }
    Ok(chain)
}

fn verify_backup_anchor(plan: &ReleasePlan) -> AppResult<PathBuf> {
    let expected = plan
        .backup_anchor_chain
        .as_ref()
        .ok_or_else(|| operation_conflict("usage_backup_anchor_unverified"))?;
    let anchor = expected
        .nodes
        .first()
        .map(|node| PathBuf::from(&node.path))
        .ok_or_else(|| operation_conflict("usage_backup_anchor_unverified"))?;
    let metadata = fs::symlink_metadata(&anchor)
        .map_err(|_| operation_conflict("usage_backup_anchor_identity_changed"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(operation_conflict("usage_backup_anchor_identity_changed"));
    }
    let root = anchor
        .parent()
        .ok_or_else(|| operation_conflict("usage_backup_anchor_unverified"))?;
    if anchor.file_name().and_then(|name| name.to_str()) != Some(".skillhub")
        || fs::canonicalize(root).ok().as_deref() != Some(root)
    {
        return Err(operation_conflict("usage_backup_anchor_identity_changed"));
    }
    if capture_path_chain(&anchor)? != *expected {
        return Err(operation_conflict("usage_backup_anchor_identity_changed"));
    }
    Ok(anchor)
}

fn backup_parent_relative<'a>(
    plan: &'a ReleasePlan,
    anchor: &Path,
) -> AppResult<(&'a Path, PathBuf)> {
    let backup_path = Path::new(
        plan.backup_path
            .as_deref()
            .ok_or_else(|| operation_conflict("usage_backup_path_missing"))?,
    );
    let parent = backup_path
        .parent()
        .ok_or_else(|| operation_conflict("usage_backup_path_invalid"))?;
    let relative = parent
        .strip_prefix(anchor)
        .map_err(|_| operation_conflict("usage_backup_path_invalid"))?
        .to_path_buf();
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(operation_conflict("usage_backup_path_invalid"));
    }
    Ok((parent, relative))
}

fn backup_chain_is_anchored(
    chain: &PathChainSnapshot,
    anchor: &PathChainSnapshot,
    relative_component_count: usize,
) -> bool {
    chain
        .nodes
        .get(relative_component_count..)
        .is_some_and(|suffix| suffix == anchor.nodes.as_slice())
}

fn ensure_backup_parent(plan: &ReleasePlan) -> AppResult<PathChainSnapshot> {
    let anchor = verify_backup_anchor(plan)?;
    let anchor_chain = plan
        .backup_anchor_chain
        .as_ref()
        .ok_or_else(|| operation_conflict("usage_backup_anchor_unverified"))?;
    let (parent, relative) = backup_parent_relative(plan, &anchor)?;
    let mut current = anchor;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(operation_conflict("usage_backup_path_invalid"));
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(operation_conflict("usage_backup_parent_identity_changed"));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match fs::create_dir(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(_) => return Err(operation_conflict("usage_backup_create_failed")),
                }
                let metadata = fs::symlink_metadata(&current)
                    .map_err(|_| operation_conflict("usage_backup_parent_identity_changed"))?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(operation_conflict("usage_backup_parent_identity_changed"));
                }
            }
            Err(_) => return Err(operation_conflict("usage_backup_parent_identity_changed")),
        }
        if fs::canonicalize(&current).ok().as_deref() != Some(current.as_path()) {
            return Err(operation_conflict("usage_backup_parent_identity_changed"));
        }
    }
    let chain = capture_path_chain(parent)?;
    if !backup_chain_is_anchored(&chain, anchor_chain, relative.components().count()) {
        return Err(operation_conflict("usage_backup_parent_identity_changed"));
    }
    if plan
        .backup_parent_chain
        .as_ref()
        .is_some_and(|expected| expected != &chain)
    {
        return Err(operation_conflict("usage_backup_parent_identity_changed"));
    }
    Ok(chain)
}

fn verify_backup_parent_chain(plan: &ReleasePlan) -> AppResult<()> {
    let anchor = verify_backup_anchor(plan)?;
    let anchor_chain = plan
        .backup_anchor_chain
        .as_ref()
        .ok_or_else(|| operation_conflict("usage_backup_anchor_unverified"))?;
    let expected_parent_chain = plan
        .backup_parent_chain
        .as_ref()
        .ok_or_else(|| operation_conflict("usage_backup_parent_unverified"))?;
    let (parent, relative) = backup_parent_relative(plan, &anchor)?;
    let current = capture_path_chain(parent)
        .map_err(|_| operation_conflict("usage_backup_parent_identity_changed"))?;
    if current != *expected_parent_chain
        || !backup_chain_is_anchored(&current, anchor_chain, relative.components().count())
    {
        return Err(operation_conflict("usage_backup_parent_identity_changed"));
    }
    Ok(())
}

fn apply_plan(
    database: &Database,
    record: &mut OperationRecord,
    journal: &mut ReleaseJournal,
    index: usize,
) -> Result<UsageChangeItemResult, (AppError, bool)> {
    let mut plan = journal.plans[index].clone();
    let recovery_point = match plan.impact.action {
        UsageChangeImpactAction::RemoveCopyWithBackup => {
            let backup = plan
                .backup_path
                .as_ref()
                .ok_or_else(|| (operation_conflict("usage_backup_path_missing"), false))?;
            if !plan.backup_created {
                let backup_path = Path::new(backup);
                if backup_path.exists() || fs::symlink_metadata(backup_path).is_ok() {
                    return Err((operation_conflict("usage_backup_path_occupied"), false));
                }
                plan.backup_parent_chain =
                    Some(ensure_backup_parent(&plan).map_err(|error| (error, false))?);
                journal.plans[index] = plan.clone();
                persist_journal(database, record, journal, OperationPhase::Applying)
                    .map_err(|error| (error, true))?;
                ensure_backup_parent(&plan).map_err(|error| (error, true))?;
                super::copy_directory_tree(Path::new(&plan.evidence.path), backup_path)
                    .map_err(|error| (error, false))?;
                verify_backup_parent_chain(&plan).map_err(|error| (error, true))?;
                let fingerprint =
                    DeploymentFilesystem::hash_tree(backup_path).map_err(|error| (error, false))?;
                if Some(fingerprint) != plan.evidence.content_fingerprint {
                    return Err((
                        operation_conflict("usage_backup_verification_failed"),
                        false,
                    ));
                }
                plan.backup_identity = skillhub_core::physical_id_for_path(backup_path);
                plan.backup_created = true;
                verify_backup_parent_chain(&plan).map_err(|error| (error, true))?;
                journal.plans[index] = plan.clone();
                persist_journal(database, record, journal, OperationPhase::Applying)
                    .map_err(|error| (error, true))?;
            } else {
                verify_recovery_backup(&plan).map_err(|error| (error, true))?;
            }
            recovery_point(&plan)
        }
        _ => None,
    };

    if matches!(
        plan.impact.action,
        UsageChangeImpactAction::RemoveLink | UsageChangeImpactAction::RemoveCopyWithBackup
    ) {
        plan.removal_started = true;
        // Persist rollback intent before the first possible filesystem change.
        // If restoration succeeds and the next journal write crashes, the
        // recovery pass can recognize the new copy identity by its verified
        // contents instead of treating it as an external replacement.
        plan.restore_started = true;
        journal.plans[index] = plan.clone();
        persist_journal(database, record, journal, OperationPhase::Applying)
            .map_err(|error| (error, true))?;
        if let Err((error, recovery_required)) =
            remove_owned_with_compensation(&mut plan, |proof| {
                DeploymentFilesystem::new().remove_owned(proof)
            })
        {
            if recovery_required {
                journal.plans[index] = plan.clone();
                persist_journal(database, record, journal, OperationPhase::NeedsRecovery)
                    .map_err(|persist_error| (persist_error, true))?;
            } else {
                plan.removal_started = false;
                plan.restore_started = false;
                plan.target_removed = false;
                journal.plans[index] = plan.clone();
                persist_journal(database, record, journal, OperationPhase::RolledBack)
                    .map_err(|persist_error| (persist_error, true))?;
            }
            return Err((error, recovery_required));
        }
        plan.removal_started = false;
        plan.restore_started = false;
        plan.target_removed = true;
        journal.plans[index] = plan.clone();
        persist_journal(database, record, journal, OperationPhase::Applying)
            .map_err(|error| (error, true))?;
    }

    let decision = decision_record(journal, index);
    if let Err(error) = database.record_usage_decision_with_expected_evidence_fingerprints(
        &decision,
        &plan.expected_evidence_fingerprints,
    ) {
        if plan.target_removed {
            plan.restore_started = true;
            journal.plans[index] = plan.clone();
            persist_journal(database, record, journal, OperationPhase::Applying)
                .map_err(|persist_error| (persist_error, true))?;
            match restore_plan(&mut plan) {
                Ok(()) => {
                    plan.target_removed = false;
                    plan.restore_started = false;
                    journal.plans[index] = plan.clone();
                    persist_journal(database, record, journal, OperationPhase::RolledBack)
                        .map_err(|persist_error| (persist_error, true))?;
                    return Err((error, false));
                }
                Err(restore_error) => {
                    journal.plans[index] = plan.clone();
                    persist_journal(database, record, journal, OperationPhase::NeedsRecovery)
                        .map_err(|persist_error| (persist_error, true))?;
                    return Err((restore_error, true));
                }
            }
        }
        journal.plans[index] = plan.clone();
        persist_journal(database, record, journal, OperationPhase::RolledBack)
            .map_err(|persist_error| (persist_error, true))?;
        return Err((error, false));
    }
    Ok(UsageChangeItemResult {
        relation_ids: plan.evidence.relation_ids.clone(),
        skill_id: plan.evidence.skill_id,
        target: plan.impact.target.clone(),
        action: plan.impact.action,
        status: UsageChangeItemStatus::Applied,
        reason: None,
        recovery_point,
    })
}

fn remove_owned_with_compensation<F>(
    plan: &mut ReleasePlan,
    remove_owned: F,
) -> Result<(), (AppError, bool)>
where
    F: FnOnce(&OwnershipProof) -> AppResult<()>,
{
    let proof = ownership_proof(plan).map_err(|error| (error, false))?;
    match remove_owned(&proof) {
        Ok(()) => Ok(()),
        Err(remove_error) => match restore_plan(plan) {
            Ok(()) => Err((remove_error, false)),
            Err(restore_error) => Err((restore_error, true)),
        },
    }
}

fn ownership_proof(plan: &ReleasePlan) -> AppResult<OwnershipProof> {
    let representation = plan.evidence.representation;
    let mode = match representation {
        FileRepresentation::SymbolicLink => DeploymentMode::SymbolicLink,
        FileRepresentation::DirectoryJunction => DeploymentMode::DirectoryJunction,
        FileRepresentation::Copy => DeploymentMode::ManagedCopy,
        _ => return Err(operation_conflict("usage_entry_representation_unverified")),
    };
    let source_path = if mode.is_directory_link() {
        PathBuf::from(
            plan.evidence
                .link_target_path
                .as_deref()
                .ok_or_else(|| operation_conflict("usage_link_target_unverified"))?,
        )
    } else {
        PathBuf::from(plan.evidence.path.clone())
    };
    let version_id = plan
        .version_id
        .clone()
        .ok_or_else(|| operation_conflict("usage_subject_version_unavailable"))?;
    let runtime_name = plan
        .runtime_name
        .clone()
        .ok_or_else(|| operation_conflict("usage_subject_version_unavailable"))?;
    Ok(OwnershipProof {
        mode,
        destination_path: PathBuf::from(plan.evidence.path.clone()),
        source_path: source_path.clone(),
        expected_hash: plan
            .evidence
            .content_fingerprint
            .clone()
            .unwrap_or_default(),
        target_identity: plan
            .restore_started
            .then(|| plan.restore_target_identity.clone())
            .flatten()
            .or_else(|| plan.evidence.physical_identity.clone())
            .ok_or_else(|| operation_conflict("usage_entry_identity_unverified"))?,
        link_anchor_paths: if mode.is_directory_link() {
            vec![source_path]
        } else {
            Vec::new()
        },
        skill_id: plan.evidence.skill_id,
        version_id,
        runtime_name,
    })
}

fn restore_plan(plan: &mut ReleasePlan) -> AppResult<()> {
    let destination = Path::new(&plan.evidence.path);
    let parent = destination
        .parent()
        .ok_or_else(|| operation_conflict("usage_entry_parent_missing"))?;
    if Some(&capture_path_chain(parent)?) != plan.parent_chain.as_ref() {
        return Err(operation_conflict("usage_entry_parent_identity_changed"));
    }
    let destination_exists = fs::symlink_metadata(destination).is_ok();
    if destination_exists {
        if plan.restore_started && restored_contents_match(plan)? {
            plan.restore_target_identity = current_target_identity(plan)?;
            return Ok(());
        }
        if target_matches_evidence(plan)? {
            return Ok(());
        }
        if !same_target_identity(plan)? {
            return Err(operation_conflict("usage_restore_destination_occupied"));
        }
    }
    // All recovery material and source-chain identities are checked before a
    // same-identity partial target is removed. A damaged backup must never
    // destroy the remaining evidence at the destination.
    validate_restore_material(plan)?;
    if destination_exists {
        DeploymentFilesystem::new().replace_owned(&ownership_proof(plan)?)?;
    }
    match plan.impact.action {
        UsageChangeImpactAction::RemoveCopyWithBackup => {
            let backup = Path::new(
                plan.backup_path
                    .as_deref()
                    .ok_or_else(|| operation_conflict("usage_backup_path_missing"))?,
            );
            super::copy_directory_tree(backup, destination)?;
            if Some(DeploymentFilesystem::hash_tree(destination)?)
                != plan.evidence.content_fingerprint
            {
                return Err(operation_conflict("usage_restore_verification_failed"));
            }
        }
        UsageChangeImpactAction::RemoveLink => {
            let target = Path::new(
                plan.evidence
                    .link_target_path
                    .as_deref()
                    .ok_or_else(|| operation_conflict("usage_link_target_unverified"))?,
            );
            create_dir_link(target, destination)?;
            if fs::canonicalize(destination).ok() != fs::canonicalize(target).ok() {
                return Err(operation_conflict("usage_restore_verification_failed"));
            }
        }
        _ => return Err(operation_conflict("usage_change_not_recoverable")),
    }
    plan.restore_target_identity = current_target_identity(plan)?;
    Ok(())
}

fn validate_restore_material(plan: &ReleasePlan) -> AppResult<()> {
    match plan.impact.action {
        UsageChangeImpactAction::RemoveCopyWithBackup => verify_recovery_backup(plan),
        UsageChangeImpactAction::RemoveLink => {
            let target = Path::new(
                plan.evidence
                    .link_target_path
                    .as_deref()
                    .ok_or_else(|| operation_conflict("usage_link_target_unverified"))?,
            );
            if Some(&capture_path_chain(target)?) != plan.subject_chain.as_ref() {
                return Err(operation_conflict("usage_subject_identity_changed"));
            }
            Ok(())
        }
        _ => Err(operation_conflict("usage_change_not_recoverable")),
    }
}

fn restored_contents_match(plan: &ReleasePlan) -> AppResult<bool> {
    let destination = Path::new(&plan.evidence.path);
    let Ok(metadata) = fs::symlink_metadata(destination) else {
        return Ok(false);
    };
    match plan.impact.action {
        UsageChangeImpactAction::RemoveCopyWithBackup => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Ok(false);
            }
            Ok(Some(DeploymentFilesystem::hash_tree(destination)?)
                == plan.evidence.content_fingerprint)
        }
        UsageChangeImpactAction::RemoveLink => {
            let target = plan
                .evidence
                .link_target_path
                .as_deref()
                .ok_or_else(|| operation_conflict("usage_link_target_unverified"))?;
            if Some(&capture_path_chain(Path::new(target))?) != plan.subject_chain.as_ref() {
                return Ok(false);
            }
            Ok(fs::canonicalize(destination).ok() == fs::canonicalize(target).ok())
        }
        _ => Ok(false),
    }
}

fn current_target_identity(plan: &ReleasePlan) -> AppResult<Option<String>> {
    let path = Path::new(&plan.evidence.path);
    Ok(match plan.evidence.representation {
        FileRepresentation::SymbolicLink => symlink_physical_id_for_path(path),
        FileRepresentation::DirectoryJunction => reparse_physical_id_for_path(path),
        FileRepresentation::Copy | FileRepresentation::Directory => {
            skillhub_core::physical_id_for_path(path)
        }
        FileRepresentation::Unknown => None,
    })
}

fn target_matches_evidence(plan: &ReleasePlan) -> AppResult<bool> {
    let destination = Path::new(&plan.evidence.path);
    let Ok(metadata) = fs::symlink_metadata(destination) else {
        return Ok(false);
    };
    let identity_matches = match plan.evidence.representation {
        FileRepresentation::SymbolicLink => {
            symlink_physical_id_for_path(destination) == plan.evidence.physical_identity
        }
        FileRepresentation::DirectoryJunction => {
            reparse_physical_id_for_path(destination) == plan.evidence.physical_identity
        }
        FileRepresentation::Copy => {
            !metadata.file_type().is_symlink()
                && metadata.is_dir()
                && skillhub_core::physical_id_for_path(destination)
                    == plan.evidence.physical_identity
        }
        _ => false,
    };
    if !identity_matches {
        return Ok(false);
    }
    match plan.evidence.representation {
        FileRepresentation::SymbolicLink | FileRepresentation::DirectoryJunction => {
            let target = plan
                .evidence
                .link_target_path
                .as_deref()
                .ok_or_else(|| operation_conflict("usage_link_target_unverified"))?;
            Ok(fs::canonicalize(destination).ok() == fs::canonicalize(target).ok())
        }
        FileRepresentation::Copy => Ok(Some(DeploymentFilesystem::hash_tree(destination)?)
            == plan.evidence.content_fingerprint),
        _ => Ok(false),
    }
}

pub(crate) fn rollback_release_operation(
    database: &Database,
    operation_id: OperationId,
) -> AppResult<()> {
    let mut record = database
        .operation_repository()
        .get_sync(operation_id)?
        .ok_or_else(|| operation_conflict("usage_change_recovery_missing"))?;
    if record.kind != OPERATION_KIND {
        return Ok(());
    }
    let mut journal: ReleaseJournal = serde_json::from_value(record.recovery_data.clone())
        .map_err(|_| operation_conflict("usage_release_journal_invalid"))?;
    let mut item_results = Vec::with_capacity(journal.plans.len());
    for index in (0..journal.plans.len()).rev() {
        let mut plan = journal.plans[index].clone();
        if decision_exists(database, operation_id, &plan)? {
            item_results.push(UsageChangeItemResult {
                relation_ids: plan.evidence.relation_ids.clone(),
                skill_id: plan.evidence.skill_id,
                target: plan.impact.target.clone(),
                action: plan.impact.action,
                status: UsageChangeItemStatus::Applied,
                reason: None,
                recovery_point: recovery_point(&plan),
            });
            continue;
        }
        if plan.target_removed || plan.removal_started {
            plan.restore_started = true;
            journal.plans[index] = plan.clone();
            persist_journal(
                database,
                &mut record,
                &journal,
                OperationPhase::NeedsRecovery,
            )?;
            restore_plan(&mut plan)?;
            plan.target_removed = false;
            plan.removal_started = false;
            plan.restore_started = false;
        }
        journal.plans[index] = plan.clone();
        item_results.push(UsageChangeItemResult {
            relation_ids: plan.evidence.relation_ids.clone(),
            skill_id: plan.evidence.skill_id,
            target: plan.impact.target.clone(),
            action: plan.impact.action,
            status: UsageChangeItemStatus::Failed,
            reason: Some(if index < journal.completed.len() {
                "rolled_back_after_recovery".to_owned()
            } else {
                "operation_rolled_back".to_owned()
            }),
            recovery_point: recovery_point(&plan),
        });
        persist_journal(
            database,
            &mut record,
            &journal,
            OperationPhase::NeedsRecovery,
        )?;
    }
    item_results.reverse();
    journal.completed = item_results.clone();
    record.recovery_data = serde_json::to_value(journal).map_err(serialization_error)?;
    if item_results
        .iter()
        .any(|item| item.status == UsageChangeItemStatus::Applied)
    {
        record.result = Some(
            serde_json::to_value(UsageChangeResult {
                operation_id,
                prepared_id: item_results
                    .first()
                    .map(|_| serde_json::from_value::<ReleaseJournal>(record.recovery_data.clone()))
                    .transpose()
                    .map_err(serialization_error)?
                    .map(|journal| journal.prepared.prepared_id)
                    .unwrap_or(operation_id),
                item_results: item_results.clone(),
                recovery_required: false,
            })
            .map_err(serialization_error)?,
        );
        set_phase(
            &mut record,
            OperationPhase::Committed,
            item_results
                .iter()
                .filter(|item| item.status == UsageChangeItemStatus::Applied)
                .count() as u32,
            item_results.len() as u32,
        );
    } else {
        set_phase(
            &mut record,
            OperationPhase::RolledBack,
            item_results.len() as u32,
            item_results.len() as u32,
        );
    }
    database.operation_repository().update_sync(&record)
}

pub(crate) fn complete_release_operation(
    database: &Database,
    operation_id: OperationId,
) -> AppResult<()> {
    let mut record = database
        .operation_repository()
        .get_sync(operation_id)?
        .ok_or_else(|| operation_conflict("usage_change_recovery_missing"))?;
    if record.kind != OPERATION_KIND {
        return Ok(());
    }
    if record.phase != OperationPhase::NeedsRecovery {
        return Err(operation_conflict("usage_change_not_recoverable"));
    }
    let mut journal: ReleaseJournal = serde_json::from_value(record.recovery_data.clone())
        .map_err(|_| operation_conflict("usage_release_journal_invalid"))?;
    for index in 0..journal.plans.len() {
        let mut plan = journal.plans[index].clone();
        let has_decision = decision_exists(database, operation_id, &plan)?;
        if !has_decision
            && matches!(
                plan.impact.action,
                UsageChangeImpactAction::RemoveLink | UsageChangeImpactAction::RemoveCopyWithBackup
            )
        {
            verify_recovery_backup(&plan)?;
            let target_path = Path::new(&plan.evidence.path);
            if fs::symlink_metadata(target_path).is_ok() {
                let original_matches = target_matches_evidence(&plan)?;
                let recovered_matches = plan.restore_started && restored_contents_match(&plan)?;
                if !original_matches && !recovered_matches && !same_target_identity(&plan)? {
                    return Err(operation_conflict("usage_release_target_identity_changed"));
                }
                if original_matches {
                    plan.restore_target_identity = None;
                } else if recovered_matches {
                    plan.restore_target_identity = current_target_identity(&plan)?;
                }
                plan.removal_started = true;
                plan.restore_started = true;
                journal.plans[index] = plan.clone();
                persist_journal(
                    database,
                    &mut record,
                    &journal,
                    OperationPhase::NeedsRecovery,
                )?;

                let proof = ownership_proof(&plan)?;
                let removal = if original_matches || recovered_matches {
                    DeploymentFilesystem::new().remove_owned(&proof)
                } else {
                    // Same-identity residue can be a partially deleted copy;
                    // the verified backup was checked above, so remove only
                    // the exact physical target captured in the journal.
                    DeploymentFilesystem::new().replace_owned(&proof)
                };
                if let Err(remove_error) = removal {
                    match restore_plan(&mut plan) {
                        Ok(()) => {
                            plan.removal_started = false;
                            plan.target_removed = false;
                            journal.plans[index] = plan.clone();
                            persist_journal(
                                database,
                                &mut record,
                                &journal,
                                OperationPhase::NeedsRecovery,
                            )?;
                            return Err(remove_error);
                        }
                        Err(restore_error) => {
                            journal.plans[index] = plan.clone();
                            persist_journal(
                                database,
                                &mut record,
                                &journal,
                                OperationPhase::NeedsRecovery,
                            )?;
                            return Err(restore_error);
                        }
                    }
                }
            }
            plan.target_removed = true;
            plan.removal_started = false;
            plan.restore_started = false;
            plan.restore_target_identity = None;
            journal.plans[index] = plan.clone();
            persist_journal(
                database,
                &mut record,
                &journal,
                OperationPhase::NeedsRecovery,
            )?;
        }
        if !has_decision {
            journal.plans[index] = plan.clone();
            database.record_usage_decision_with_expected_evidence_fingerprints(
                &decision_record(&journal, index),
                &plan.expected_evidence_fingerprints,
            )?;
        }
        persist_journal(
            database,
            &mut record,
            &journal,
            OperationPhase::NeedsRecovery,
        )?;
    }
    let result = UsageChangeResult {
        operation_id,
        prepared_id: journal.prepared.prepared_id,
        item_results: journal
            .plans
            .iter()
            .map(|plan| UsageChangeItemResult {
                relation_ids: plan.evidence.relation_ids.clone(),
                skill_id: plan.evidence.skill_id,
                target: plan.impact.target.clone(),
                action: plan.impact.action,
                status: UsageChangeItemStatus::Applied,
                reason: None,
                recovery_point: recovery_point(plan),
            })
            .collect(),
        recovery_required: false,
    };
    record.result = Some(serde_json::to_value(result).map_err(serialization_error)?);
    set_phase(
        &mut record,
        OperationPhase::Committed,
        journal.plans.len() as u32,
        journal.plans.len() as u32,
    );
    database.operation_repository().update_sync(&record)
}

fn verify_recovery_backup(plan: &ReleasePlan) -> AppResult<()> {
    if plan.impact.action != UsageChangeImpactAction::RemoveCopyWithBackup {
        return Ok(());
    }
    let backup = Path::new(
        plan.backup_path
            .as_deref()
            .ok_or_else(|| operation_conflict("usage_backup_path_missing"))?,
    );
    verify_backup_parent_chain(plan)?;
    let metadata = fs::symlink_metadata(backup)
        .map_err(|_| operation_conflict("usage_backup_verification_failed"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || !plan.backup_created
        || skillhub_core::physical_id_for_path(backup) != plan.backup_identity
        || Some(DeploymentFilesystem::hash_tree(backup)?) != plan.evidence.content_fingerprint
    {
        return Err(operation_conflict("usage_backup_verification_failed"));
    }
    Ok(())
}

fn same_target_identity(plan: &ReleasePlan) -> AppResult<bool> {
    let destination = Path::new(&plan.evidence.path);
    let current = match plan.evidence.representation {
        FileRepresentation::SymbolicLink => symlink_physical_id_for_path(destination),
        FileRepresentation::DirectoryJunction => reparse_physical_id_for_path(destination),
        FileRepresentation::Copy | FileRepresentation::Directory => {
            skillhub_core::physical_id_for_path(destination)
        }
        FileRepresentation::Unknown => None,
    };
    Ok(current.is_some()
        && (current == plan.evidence.physical_identity
            || (plan.restore_started && current == plan.restore_target_identity)))
}

fn decision_record(journal: &ReleaseJournal, index: usize) -> UsageDecisionRecord {
    let plan = &journal.plans[index];
    UsageDecisionRecord {
        decision_id: format!("usage-decision:{}:{index}", journal.prepared.operation_id),
        skill_id: plan.evidence.skill_id,
        entry_key: plan.evidence.entry_key.clone(),
        relation_ids: plan.evidence.relation_ids.clone(),
        physical_source_ids: plan.evidence.physical_source_ids.clone(),
        decision: plan.decision,
        content_fingerprint: plan.evidence.content_fingerprint.clone(),
        decided_at: super::now_epoch_seconds(),
        operation_id: Some(journal.prepared.operation_id.to_string()),
    }
}

fn decision_exists(
    database: &Database,
    operation_id: OperationId,
    plan: &ReleasePlan,
) -> AppResult<bool> {
    Ok(database
        .list_usage_decisions(&plan.evidence.skill_id, &plan.evidence.entry_key)?
        .iter()
        .any(|decision| {
            decision.operation_id.as_deref() == Some(operation_id.to_string().as_str())
        }))
}

fn persist_journal(
    database: &Database,
    record: &mut OperationRecord,
    journal: &ReleaseJournal,
    phase: OperationPhase,
) -> AppResult<()> {
    record.recovery_data = serde_json::to_value(journal).map_err(serialization_error)?;
    set_phase(
        record,
        phase,
        journal.completed.len() as u32,
        journal.plans.len() as u32,
    );
    database.operation_repository().update_sync(record)
}

fn recovery_point(plan: &ReleasePlan) -> Option<UsageRecoveryPoint> {
    let path = plan.backup_path.clone()?;
    plan.backup_created.then(|| UsageRecoveryPoint {
        path,
        fingerprint: plan.evidence.content_fingerprint.clone(),
        representation: plan.evidence.representation,
    })
}

fn path_matches(candidate: Option<&str>, selected: &Path) -> bool {
    let Some(candidate) = candidate else {
        return false;
    };
    let candidate = Path::new(candidate);
    match (fs::canonicalize(candidate), fs::canonicalize(selected)) {
        (Ok(left), Ok(right)) => left == right,
        _ => {
            observed_path_key(&candidate.to_string_lossy())
                == observed_path_key(&selected.to_string_lossy())
        }
    }
}

fn sorted_unique(mut values: Vec<String>) -> AppResult<Vec<String>> {
    values.sort();
    if values.iter().any(|value| value.trim().is_empty()) {
        return Err(operation_conflict("usage_change_evidence_invalid"));
    }
    values.dedup();
    Ok(values)
}

fn validate_request(request: &PrepareUsageChange) -> AppResult<()> {
    if request.action != UsageChangeAction::Release {
        return Err(operation_conflict("usage_change_action_unsupported"));
    }
    let relation_selector = !request.relation_ids.is_empty();
    let entry_selector = request.skill_id.is_some() || !request.selected_entry_keys.is_empty();
    if relation_selector == entry_selector {
        return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
            .with_param("field", "usage_selection")
            .with_action(RecoveryAction::Retry));
    }
    if relation_selector
        && (request.relation_ids.iter().any(|id| id.trim().is_empty())
            || request.relation_ids.iter().collect::<BTreeSet<_>>().len()
                != request.relation_ids.len())
    {
        return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
            .with_param("field", "relation_ids")
            .with_action(RecoveryAction::Retry));
    }
    if entry_selector
        && (request.skill_id.is_none()
            || request.selected_entry_keys.is_empty()
            || request
                .selected_entry_keys
                .iter()
                .collect::<BTreeSet<_>>()
                .len()
                != request.selected_entry_keys.len())
    {
        return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
            .with_param("field", "selected_entry_keys")
            .with_action(RecoveryAction::Retry));
    }
    if request.problem_id.is_some()
        || request.requested_form.is_some()
        || request.content_basis.is_some()
        || request.retain_entry_key.is_some()
        || request.runtime_name.is_some()
        || request.base_version_id.is_some()
        || request.non_recognized_destination.is_some()
    {
        return Err(operation_conflict("usage_change_field_not_applicable"));
    }
    Ok(())
}

fn request_fingerprint(request: &PrepareUsageChange) -> AppResult<String> {
    let encoded = serde_json::to_vec(request).map_err(serialization_error)?;
    let digest = Sha256::digest(encoded);
    Ok(format!("sha256:{digest:x}"))
}

fn set_phase(record: &mut OperationRecord, phase: OperationPhase, completed: u32, total: u32) {
    record.phase = phase;
    record.progress = OperationProgress {
        operation_id: record.operation_id,
        phase,
        completed,
        total,
        message_code: format!("operation.{OPERATION_KIND}.{}", phase_code(phase)),
    };
}

fn phase_code(phase: OperationPhase) -> &'static str {
    match phase {
        OperationPhase::Planned => "planned",
        OperationPhase::Prepared => "prepared",
        OperationPhase::Applying => "applying",
        OperationPhase::Verifying => "verifying",
        OperationPhase::Committed => "committed",
        OperationPhase::NeedsRecovery => "needs_recovery",
        OperationPhase::RolledBack => "rolled_back",
    }
}

fn operation_conflict(reason: &str) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("reason", reason)
        .with_action(RecoveryAction::Retry)
}

fn internal(operation: &str) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("operation", operation)
        .with_action(RecoveryAction::Retry)
}

fn serialization_error(error: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("detail", error.to_string())
        .with_action(RecoveryAction::Retry)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_copy_plan(root: &Path) -> ReleasePlan {
        let canonical_root = fs::canonicalize(root).expect("canonical test workspace");
        let root = canonical_root.as_path();
        let entry = root.join("entry");
        let anchor = root.join(".skillhub");
        let backup = anchor.join("usage-release-backups/test/0/entry");
        fs::create_dir_all(&entry).expect("entry directory");
        fs::write(entry.join("SKILL.md"), "original managed copy\n").expect("entry file");
        fs::create_dir_all(&backup).expect("backup directory");
        fs::write(backup.join("SKILL.md"), "original managed copy\n").expect("backup file");
        let fingerprint = DeploymentFilesystem::hash_tree(&entry).expect("entry fingerprint");
        let skill_id = SkillId::new();
        ReleasePlan {
            evidence: UsageEntryEvidence {
                skill_id,
                entry_key: skillhub_core::relationship::UsageEntryKey {
                    directory_id: "unit-test-directory".to_owned(),
                    relative_entry_path: "entry".to_owned(),
                },
                relation_ids: vec!["unit-test-relation".to_owned()],
                physical_source_ids: vec!["unit-test-source".to_owned()],
                path: entry.to_string_lossy().into_owned(),
                directory_role: Some(AgentDirectoryRole::AgentUser),
                form: Some(UsageForm::FullCopy),
                management: UsageManagement::Managed,
                representation: FileRepresentation::Copy,
                content_fingerprint: Some(fingerprint.clone()),
                physical_identity: skillhub_core::physical_id_for_path(&entry),
                link_target_path: None,
                exists: true,
            },
            impact: UsageChangeImpact {
                relation_ids: vec!["unit-test-relation".to_owned()],
                skill_id,
                target: UsageRelationTarget {
                    kind: RelationGovernanceTargetKind::Agent,
                    directory_id: Some("unit-test-directory".to_owned()),
                    agent_client_id: Some("unit-test-agent".to_owned()),
                    directory_role: Some(AgentDirectoryRole::AgentUser),
                    recognition: Some(skillhub_core::relationship::DirectoryRecognition::Supported),
                },
                action: UsageChangeImpactAction::RemoveCopyWithBackup,
                description: "test".to_owned(),
            },
            decision: UsageDecision::Released,
            decision_fingerprint: Some(fingerprint.clone()),
            expected_evidence_fingerprints: BTreeMap::from([(
                "unit-test-relation".to_owned(),
                Some(fingerprint.clone()),
            )]),
            runtime_name: Some("unit-test".to_owned()),
            version_id: Some(
                VersionId::parse(
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                )
                .expect("version id"),
            ),
            parent_chain: Some(capture_path_chain(root).expect("parent chain")),
            subject_chain: None,
            backup_path: Some(backup.to_string_lossy().into_owned()),
            backup_anchor_chain: Some(capture_path_chain(&anchor).expect("backup anchor chain")),
            backup_parent_chain: Some(
                capture_path_chain(backup.parent().expect("backup parent"))
                    .expect("backup parent chain"),
            ),
            backup_identity: skillhub_core::physical_id_for_path(&backup),
            backup_created: true,
            removal_started: true,
            restore_started: true,
            restore_target_identity: None,
            target_removed: false,
        }
    }

    #[test]
    fn partial_remove_error_restores_verified_backup() {
        let workspace = tempfile::tempdir().expect("workspace");
        let mut plan = test_copy_plan(workspace.path());
        let entry = PathBuf::from(&plan.evidence.path);
        let error = operation_conflict("injected_partial_remove");
        let result = remove_owned_with_compensation(&mut plan, |_| {
            fs::remove_file(entry.join("SKILL.md")).expect("simulate partial recursive remove");
            Err(error.clone())
        });
        assert!(matches!(result, Err((actual, false)) if actual == error));
        assert_eq!(
            DeploymentFilesystem::hash_tree(&entry).expect("restored real entry"),
            plan.evidence
                .content_fingerprint
                .expect("expected fingerprint"),
        );
    }

    #[test]
    fn external_replacement_is_left_untouched_during_compensation() {
        let workspace = tempfile::tempdir().expect("workspace");
        let mut plan = test_copy_plan(workspace.path());
        let entry = PathBuf::from(&plan.evidence.path);
        fs::remove_dir_all(&entry).expect("replace recorded entry");
        fs::create_dir_all(&entry).expect("external replacement directory");
        fs::write(entry.join("EXTERNAL.txt"), "keep me\n").expect("external marker");
        let result = remove_owned_with_compensation(&mut plan, |_| {
            Err(operation_conflict("injected_remove_failure"))
        });
        assert!(matches!(result, Err((_, true))));
        assert_eq!(
            fs::read_to_string(entry.join("EXTERNAL.txt")).expect("external file survives"),
            "keep me\n",
        );
        assert!(!entry.join("SKILL.md").exists());
    }

    #[test]
    fn damaged_backup_preserves_partial_residue() {
        let workspace = tempfile::tempdir().expect("workspace");
        let mut plan = test_copy_plan(workspace.path());
        let entry = PathBuf::from(&plan.evidence.path);
        let backup = PathBuf::from(plan.backup_path.as_deref().expect("backup path"));
        fs::remove_file(entry.join("SKILL.md")).expect("simulate partial removal");
        fs::write(entry.join("PARTIAL.txt"), "residual evidence\n").expect("partial residue");
        fs::write(backup.join("SKILL.md"), "corrupted backup\n").expect("corrupt backup");

        let error = restore_plan(&mut plan).expect_err("damaged backup must block restore");
        assert_eq!(
            error.params.get("reason").and_then(Value::as_str),
            Some("usage_backup_verification_failed"),
        );
        assert_eq!(
            fs::read_to_string(entry.join("PARTIAL.txt")).expect("partial residue preserved"),
            "residual evidence\n",
        );
        assert!(!entry.join("SKILL.md").exists());
    }
}
