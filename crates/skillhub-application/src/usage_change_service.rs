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
    AppQueryResult, CommitRelationMigration, CommitUsageChange, DeploymentPlanRequest,
    GetSaveAsCopyReplacementPreview, PrepareRelationMigration, PrepareUsageChange,
    RelationMigrationTargetMode, RelationshipMigrationBackupPolicy, RelationshipOverviewScope,
    SaveAsCopyInheritance, SaveAsCopyInheritanceOutcome, SaveAsCopyOrigin,
    SaveAsCopyReplacementChoice, SaveAsCopyTargetStatus, SaveMarkdownAsCopy,
};
use skillhub_core::catalog::CatalogRepository;
use skillhub_core::deployment::{observed_path_key, DeploymentPlan};
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, DeploymentRelationFact, DerivedRenamePreview,
    DerivedRenameTargetPreview, DuplicateCleanupPreview, EnvironmentProblemKind,
    FileRepresentation, OwnershipState, PreparedUsageChange, RelationGovernanceTargetKind,
    SharedUsageMigrationPreview, SharedUsageReplacement, SourceCopyRelationFact, UsageChangeAction,
    UsageChangeConsumer, UsageChangeImpact, UsageChangeImpactAction, UsageChangeItemResult,
    UsageChangeItemStatus, UsageChangeResult, UsageContentBasis, UsageCopyDisposition,
    UsageDecision, UsageDecisionRecord, UsageEntryEvidence, UsageEntryKey, UsageEnvironmentEntry,
    UsageEnvironmentKey, UsageEnvironmentSnapshot, UsageForm, UsageHealthReason, UsageManagement,
    UsageRecoveryPoint, UsageRelationTarget, UsageRelationView, UsageSubjectVersion,
};
use skillhub_core::{
    reparse_physical_id_for_path, symlink_physical_id_for_path, AppCommandResult, AppError,
    AppResult, DeploymentMode, ErrorCode, OperationId, OperationPhase, OperationProgress,
    OperationRecord, RecoveryAction, Severity, SkillId, TargetChange, TargetPlan, VersionId,
};
use skillhub_storage::{CentralLibrary, Database, VersionStore, VisibleSkillRename};

use crate::relationship_governance_service::{
    capture_path_chain, create_dir_link, PathChainSnapshot,
};
use crate::LocalApplicationFacade;

const OPERATION_KIND: &str = "usage_release";
const MANAGE_OPERATION_KIND: &str = "usage_manage";
const MANAGE_BATCH_OPERATION_KIND: &str = "usage_manage_batch";
const MANAGED_USAGE_CHANGE_KIND: &str = "managed_usage_change";
const DUPLICATE_CLEANUP_KIND: &str = "usage_duplicate_cleanup";
const SHARED_USAGE_MIGRATION_KIND: &str = "shared_usage_migration";
const SUBJECT_RENAME_KIND: &str = "subject_runtime_rename";
const DERIVED_RENAME_KIND: &str = "usage_derived_rename";

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SubjectRenameJournal {
    request: PrepareUsageChange,
    prepared: PreparedUsageChange,
    original_skill: skillhub_core::catalog::Skill,
    previous_version_id: skillhub_core::VersionId,
    original_visible_hash: String,
    plans: Vec<SubjectRenamePlan>,
    new_version_id: Option<skillhub_core::VersionId>,
    new_version_hash: Option<String>,
    new_target_hash: Option<String>,
    staging_path: Option<String>,
    visible_rename: Option<VisibleSkillRename>,
    catalog_updated: bool,
    store_pointer_updated: bool,
    database_pointer_updated: bool,
    portable_updated: bool,
    metadata_committed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DerivedRenameJournal {
    request: PrepareUsageChange,
    prepared: PreparedUsageChange,
    original_skill: skillhub_core::catalog::Skill,
    source_version_id: VersionId,
    copy_request: SaveMarkdownAsCopy,
    child_operation_id: OperationId,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SubjectRenamePlan {
    original_deployment: skillhub_core::DeploymentRecord,
    deployment_id: String,
    target_id: String,
    previous_runtime_name: String,
    runtime_name: String,
    previous_path: String,
    path: String,
    backup_path: String,
    mode: DeploymentMode,
    expected_hash: String,
    observed_before: Option<String>,
    observed_identity: Option<String>,
    target_root_identity: String,
    created_new_entry: bool,
    moved_previous_entry: bool,
    deployment_record_updated: bool,
    backup_finalized: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct ReleaseJournal {
    request: PrepareUsageChange,
    prepared: PreparedUsageChange,
    plans: Vec<ReleasePlan>,
    completed: Vec<UsageChangeItemResult>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct DuplicateCleanupJournal {
    request: PrepareUsageChange,
    prepared: PreparedUsageChange,
    backup_anchor_chain: PathChainSnapshot,
    plans: Vec<DuplicateCleanupPlan>,
    completed: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct DuplicateCleanupPlan {
    entry_key: UsageEntryKey,
    source_path: String,
    fingerprint: String,
    physical_identity: String,
    retained: bool,
    source_parent_chain: PathChainSnapshot,
    backup_path: String,
    backup_created: bool,
    removal_started: bool,
    removed: bool,
    destination_path: Option<String>,
    destination_parent_chain: Option<PathChainSnapshot>,
    destination_started: bool,
    destination_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct SharedUsageMigrationJournal {
    request: PrepareUsageChange,
    prepared: PreparedUsageChange,
    backup_anchor_chain: PathChainSnapshot,
    source: SharedUsageMigrationSource,
    replacements: Vec<SharedUsageMigrationReplacementPlan>,
    completed: Vec<UsageChangeItemResult>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct SharedUsageMigrationSource {
    skill_id: SkillId,
    entry_key: UsageEntryKey,
    source_path: String,
    fingerprint: String,
    physical_identity: String,
    relation_ids: Vec<String>,
    expected_evidence_fingerprints: BTreeMap<String, Option<String>>,
    source_parent_chain: PathChainSnapshot,
    backup_path: String,
    backup_created: bool,
    removal_started: bool,
    removed: bool,
    decision_recorded: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct SharedUsageMigrationReplacementPlan {
    preview: SharedUsageReplacement,
    target: UsageRelationTarget,
    deployment_plan: Option<DeploymentPlan>,
    destination_path: Option<String>,
    reused_entry: Option<SharedUsageMigrationProof>,
    child_operation_id: Option<OperationId>,
    verified: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct SharedUsageMigrationProof {
    entry_key: UsageEntryKey,
    path: String,
    fingerprint: String,
    physical_identity: String,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct ManageBatchJournal {
    request: PrepareUsageChange,
    prepared: PreparedUsageChange,
    plans: Vec<ManageBatchPlan>,
    adoptions: Vec<ManageOriginalEntryPlan>,
    adoption_results: Vec<UsageOriginalEntryAdoptionResult>,
    completed: Vec<UsageChangeItemResult>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct ManagedUsageChangeJournal {
    request: PrepareUsageChange,
    prepared: PreparedUsageChange,
    plans: Vec<ManagedUsageChangePlan>,
    completed: Vec<UsageChangeItemResult>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct ManagedUsageChangePlan {
    deployment_id: skillhub_core::DeploymentId,
    destination: String,
    subject_version_id: VersionId,
    observed_before: Option<String>,
    #[serde(default)]
    observed_identity: Option<String>,
    backup_path: String,
    #[serde(default)]
    backup_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct UsageOriginalEntryAdoptionResult {
    pub(crate) skill_id: SkillId,
    pub(crate) version_id: Option<VersionId>,
    pub(crate) rewrites: Vec<UsageOriginalEntryRewriteResult>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct UsageOriginalEntryRewriteResult {
    pub(crate) relation_id: String,
    pub(crate) path: String,
    pub(crate) rewritten: bool,
    pub(crate) reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct ManageBatchPlan {
    relation_id: String,
    child_operation_id: OperationId,
    target_mode: RelationMigrationTargetMode,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct ManageOriginalEntryPlan {
    skill_id: SkillId,
    operation_id: OperationId,
    path: String,
    fingerprint: String,
    previous_version_id: Option<VersionId>,
    #[serde(default)]
    completed: bool,
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

pub(crate) fn manage_form_required_error() -> AppError {
    operation_conflict("usage_manage_form_required")
}

pub(crate) fn manage_form_not_applicable_error() -> AppError {
    operation_conflict("usage_change_field_not_applicable")
}

impl LocalApplicationFacade {
    pub fn prepare_usage_change(
        &self,
        request: PrepareUsageChange,
    ) -> AppResult<PreparedUsageChange> {
        if request.action == UsageChangeAction::RenameSubject {
            return self.prepare_subject_rename(request);
        }
        if request.action == UsageChangeAction::DeriveAndReplace {
            return self.prepare_derived_rename(request);
        }
        if request.action == UsageChangeAction::Manage {
            validate_manage_request(&request)?;
            return self.prepare_usage_manage(request);
        }
        if request.action == UsageChangeAction::ResolveDuplicate {
            validate_duplicate_cleanup_request(&request)?;
            return self.prepare_duplicate_cleanup(request);
        }
        if request.action == UsageChangeAction::MigrateSharedUsage {
            validate_shared_usage_migration_request(&request)?;
            return self.prepare_shared_usage_migration(request);
        }
        if matches!(
            request.action,
            UsageChangeAction::Sync | UsageChangeAction::Repair | UsageChangeAction::Restore
        ) {
            return self.prepare_managed_usage_change(request);
        }
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

    fn prepare_subject_rename(
        &self,
        request: PrepareUsageChange,
    ) -> AppResult<PreparedUsageChange> {
        validate_subject_rename_request(&request)?;
        let fingerprint = request_fingerprint(&request)?;
        {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("subject_rename.prepare.database"))?;
            if let Some(record) = database
                .operation_repository()
                .get_sync(request.operation_id)?
            {
                if record.kind != SUBJECT_RENAME_KIND {
                    return Err(operation_conflict("operation_id_reused"));
                }
                if record.request_fingerprint != fingerprint {
                    return Err(AppError::new(
                        ErrorCode::OperationIdReusedWithDifferentRequest,
                        Severity::Error,
                    )
                    .with_param("operation_id", request.operation_id.to_string()));
                }
                let journal: SubjectRenameJournal = serde_json::from_value(record.recovery_data)
                    .map_err(|_| operation_conflict("subject_rename_journal_invalid"))?;
                return Ok(journal.prepared);
            }
        }

        let skill_id = request
            .skill_id
            .ok_or_else(|| operation_conflict("subject_rename_skill_required"))?;
        let runtime_name = request
            .runtime_name
            .as_deref()
            .ok_or_else(|| operation_conflict("subject_rename_runtime_name_required"))?;
        skillhub_core::deployment::validate_runtime_name(runtime_name)?;
        let library = self.library_runtime.snapshot()?;
        let skill = self.with_database("subject_rename.load_skill", |database| {
            database
                .catalog_repository()?
                .get_sync(skill_id)?
                .ok_or_else(|| operation_conflict("usage_subject_missing"))
        })?;
        let previous_runtime_name = skill.runtime_name().to_owned();
        if previous_runtime_name.eq_ignore_ascii_case(runtime_name) {
            return Err(operation_conflict("subject_rename_runtime_name_unchanged"));
        }
        let current_version = library
            .current(skill_id)?
            .ok_or_else(|| operation_conflict("usage_subject_version_missing"))?;
        let old_visible_path = library.central.visible_skill_path(&skill);
        let old_visible_deployment_hash = DeploymentFilesystem::hash_tree(&old_visible_path)?;
        let old_visible_hash = library.store.hash_tree_read_only(&old_visible_path)?;

        let (deployments, relations, revision, scopes) = {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("subject_rename.prepare.database"))?;
            let deployments = database.deployment_repository().list_all()?;
            let relations = database.relationship_repository().list_relations()?;
            let revision = database.relationship_repository().relationship_revision()?;
            let mut scopes = BTreeMap::new();
            for deployment in deployments.iter().filter(|deployment| {
                deployment.skill_id == skill_id
                    && deployment.state == skillhub_core::DeploymentState::Deployed
            }) {
                let scope = database
                    .connection_for_test()
                    .query_row(
                        "SELECT scope FROM targets WHERE id=?1",
                        [&deployment.target_id],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|_| operation_conflict("subject_rename_target_missing"))?;
                scopes.insert(deployment.target_id.clone(), scope);
            }
            (deployments, relations, revision, scopes)
        };
        let active_deployments = deployments
            .iter()
            .filter(|deployment| {
                deployment.skill_id == skill_id
                    && deployment.state == skillhub_core::DeploymentState::Deployed
            })
            .collect::<Vec<_>>();
        if active_deployments
            .iter()
            .any(|deployment| !deployment.managed)
        {
            return Err(operation_conflict("subject_rename_unmanaged_use"));
        }
        let expected_relations = active_deployments
            .iter()
            .map(|deployment| format!("managed:{}", deployment.id))
            .collect::<BTreeSet<_>>();
        if relations.iter().any(|relation| {
            relation.active
                && relation.skill_id == Some(skill_id)
                && !expected_relations.contains(&relation.relation_id)
        }) || expected_relations.iter().any(|relation_id| {
            !relations.iter().any(|relation| {
                relation.active
                    && relation.skill_id == Some(skill_id)
                    && relation.relation_id == *relation_id
                    && relation.ownership == OwnershipState::SkillhubManaged
            })
        }) {
            return Err(operation_conflict("subject_rename_usage_scope_unverified"));
        }

        let prepared_id = OperationId::new();
        let mut prepared = PreparedUsageChange {
            operation_id: request.operation_id,
            prepared_id,
            action: UsageChangeAction::RenameSubject,
            relationship_revision: revision.to_string(),
            affected_skill_ids: vec![skill_id],
            subject_versions: vec![UsageSubjectVersion {
                skill_id,
                version_id: Some(current_version.clone()),
            }],
            entry_evidence: Vec::new(),
            consumers: Vec::new(),
            impacts: Vec::new(),
            limitations: Vec::new(),
            duplicate_cleanup: None,
            shared_usage_migration: None,
            subject_rename: None,
            derived_rename: None,
        };
        let mut preview_targets = Vec::new();
        let mut plans = Vec::new();
        for deployment in active_deployments {
            if deployment.runtime_name != previous_runtime_name {
                return Err(operation_conflict(
                    "subject_rename_deployment_name_mismatch",
                ));
            }
            let target_root = self.backend.target_root(deployment)?;
            let target_root_identity = skillhub_core::physical_id_for_path(&target_root)
                .ok_or_else(|| operation_conflict("subject_rename_target_identity_missing"))?;
            if target_root_identity != deployment.target_id {
                return Err(operation_conflict("subject_rename_target_identity_changed"));
            }
            let previous_path = target_root.join(&previous_runtime_name);
            let path = target_root.join(runtime_name);
            if fs::symlink_metadata(&path).is_ok()
                || deployments.iter().any(|candidate| {
                    candidate.target_id == deployment.target_id
                        && candidate.runtime_name.eq_ignore_ascii_case(runtime_name)
                        && candidate.id != deployment.id
                })
            {
                return Err(operation_conflict("subject_rename_target_name_conflict"));
            }
            let observed_before = entry_fingerprint(&previous_path)?
                .ok_or_else(|| operation_conflict("subject_rename_target_missing"))?;
            let observed_identity = entry_identity(&previous_path)?;
            match deployment.mode {
                DeploymentMode::ManagedCopy if observed_before != deployment.expected_hash => {
                    return Err(operation_conflict("subject_rename_target_copy_diverged"));
                }
                DeploymentMode::SymbolicLink | DeploymentMode::DirectoryJunction => {
                    let points_to_library = fs::canonicalize(&previous_path)
                        .ok()
                        .zip(fs::canonicalize(&old_visible_path).ok())
                        .is_some_and(|(target, visible)| target == visible);
                    if !points_to_library || observed_before != old_visible_deployment_hash {
                        return Err(operation_conflict("subject_rename_target_link_unverified"));
                    }
                }
                _ => {}
            }
            let backup_path = target_root.join(format!(
                ".skillhub-runtime-rename-{}-{}",
                request.operation_id, deployment.id
            ));
            if fs::symlink_metadata(&backup_path).is_ok() {
                return Err(operation_conflict("subject_rename_backup_path_occupied"));
            }
            let relation_id = format!("managed:{}", deployment.id);
            let relation = relations
                .iter()
                .find(|relation| relation.relation_id == relation_id && relation.active)
                .ok_or_else(|| operation_conflict("subject_rename_usage_scope_unverified"))?;
            let target_scope = scopes
                .get(&deployment.target_id)
                .ok_or_else(|| operation_conflict("subject_rename_target_missing"))?;
            let target_kind = if target_scope == "project" {
                RelationGovernanceTargetKind::Project
            } else {
                RelationGovernanceTargetKind::Agent
            };
            let target = UsageRelationTarget {
                kind: target_kind,
                directory_id: Some(deployment.target_id.clone()),
                agent_client_id: Some(relation.agent_client_id.clone()),
                directory_role: None,
                recognition: None,
            };
            let form = match deployment.mode {
                DeploymentMode::ManagedCopy => UsageForm::FullCopy,
                DeploymentMode::SymbolicLink | DeploymentMode::DirectoryJunction => UsageForm::Link,
            };
            let representation = match deployment.mode {
                DeploymentMode::ManagedCopy => FileRepresentation::Copy,
                DeploymentMode::SymbolicLink => FileRepresentation::SymbolicLink,
                DeploymentMode::DirectoryJunction => FileRepresentation::DirectoryJunction,
            };
            let relation_ids = vec![relation_id.clone()];
            prepared.entry_evidence.push(UsageEntryEvidence {
                skill_id,
                entry_key: UsageEntryKey {
                    directory_id: deployment.target_id.clone(),
                    relative_entry_path: previous_runtime_name.clone(),
                },
                relation_ids: relation_ids.clone(),
                physical_source_ids: vec![deployment.target_id.clone()],
                path: previous_path.to_string_lossy().into_owned(),
                directory_role: None,
                form: Some(form),
                management: UsageManagement::Managed,
                representation,
                content_fingerprint: Some(observed_before.clone()),
                physical_identity: observed_identity.clone(),
                link_target_path: fs::canonicalize(&previous_path)
                    .ok()
                    .map(|value| value.to_string_lossy().into_owned()),
                exists: true,
            });
            prepared.consumers.push(UsageChangeConsumer {
                relation_ids: relation_ids.clone(),
                skill_id: Some(skill_id),
                entry_key: Some(UsageEntryKey {
                    directory_id: deployment.target_id.clone(),
                    relative_entry_path: previous_runtime_name.clone(),
                }),
                target: target.clone(),
                path: Some(previous_path.to_string_lossy().into_owned()),
                form: Some(form),
                management: UsageManagement::Managed,
                representation,
                health_reasons: vec![UsageHealthReason::Normal],
                physical_source_ids: vec![deployment.target_id.clone()],
                content_fingerprint: Some(observed_before.clone()),
            });
            prepared.impacts.push(UsageChangeImpact {
                relation_ids,
                skill_id,
                target,
                action: UsageChangeImpactAction::RenameSubject,
                description: "按技能主体新运行名同步受管目标目录。".to_owned(),
            });
            preview_targets.push(skillhub_core::relationship::SubjectRenameTargetPreview {
                deployment_id: deployment.id.to_string(),
                target_id: deployment.target_id.clone(),
                previous_path: previous_path.to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                mode: deployment.mode,
            });
            plans.push(SubjectRenamePlan {
                original_deployment: deployment.clone(),
                deployment_id: deployment.id.to_string(),
                target_id: deployment.target_id.clone(),
                previous_runtime_name: previous_runtime_name.clone(),
                runtime_name: runtime_name.to_owned(),
                previous_path: previous_path.to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                backup_path: backup_path.to_string_lossy().into_owned(),
                mode: deployment.mode,
                expected_hash: deployment.expected_hash.clone(),
                observed_before: Some(observed_before),
                observed_identity,
                target_root_identity,
                created_new_entry: false,
                moved_previous_entry: false,
                deployment_record_updated: false,
                backup_finalized: false,
            });
        }
        preview_targets.sort_by(|left, right| left.previous_path.cmp(&right.previous_path));
        plans.sort_by(|left, right| left.previous_path.cmp(&right.previous_path));
        prepared.subject_rename = Some(skillhub_core::relationship::SubjectRenamePreview {
            skill_id,
            previous_runtime_name,
            runtime_name: runtime_name.to_owned(),
            targets: preview_targets,
        });
        let journal = SubjectRenameJournal {
            request: request.clone(),
            prepared: prepared.clone(),
            original_skill: skill.clone(),
            previous_version_id: current_version,
            original_visible_hash: old_visible_hash,
            plans,
            new_version_id: None,
            new_version_hash: None,
            new_target_hash: None,
            staging_path: None,
            visible_rename: None,
            catalog_updated: false,
            store_pointer_updated: false,
            database_pointer_updated: false,
            portable_updated: false,
            metadata_committed: false,
        };
        let mut record =
            OperationRecord::planned(request.operation_id, SUBJECT_RENAME_KIND, fingerprint);
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
            .map_err(|_| internal("subject_rename.prepare.database"))?;
        if database
            .operation_repository()
            .get_sync(request.operation_id)?
            .is_some()
        {
            return Err(operation_conflict("operation_id_reused"));
        }
        database.operation_repository().insert_sync(&record)?;
        Ok(prepared)
    }

    fn prepare_derived_rename(
        &self,
        request: PrepareUsageChange,
    ) -> AppResult<PreparedUsageChange> {
        validate_derived_rename_request(&request)?;
        let fingerprint = request_fingerprint(&request)?;
        {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("derived_rename.prepare.database"))?;
            if let Some(record) = database
                .operation_repository()
                .get_sync(request.operation_id)?
            {
                if record.kind != DERIVED_RENAME_KIND {
                    return Err(operation_conflict("operation_id_reused"));
                }
                if record.request_fingerprint != fingerprint {
                    return Err(AppError::new(
                        ErrorCode::OperationIdReusedWithDifferentRequest,
                        Severity::Error,
                    )
                    .with_param("operation_id", request.operation_id.to_string()));
                }
                let journal: DerivedRenameJournal = serde_json::from_value(record.recovery_data)
                    .map_err(|_| operation_conflict("derived_rename_journal_invalid"))?;
                return Ok(journal.prepared);
            }
        }

        let source_skill_id = request
            .skill_id
            .ok_or_else(|| operation_conflict("derived_rename_skill_required"))?;
        let base_version_id = request
            .base_version_id
            .clone()
            .ok_or_else(|| operation_conflict("derived_rename_base_version_required"))?;
        let runtime_name = request
            .runtime_name
            .as_deref()
            .ok_or_else(|| operation_conflict("derived_rename_runtime_name_required"))?;
        skillhub_core::deployment::validate_runtime_name(runtime_name)?;
        let library = self.library_runtime.snapshot()?;
        if library.current(source_skill_id)?.as_ref() != Some(&base_version_id) {
            return Err(operation_conflict("derived_rename_base_version_stale"));
        }
        let (expected_identity, source_markdown) =
            library.read_file(&base_version_id, "SKILL.md", 1_048_576)?;
        let source_markdown = String::from_utf8(source_markdown).map_err(|_| {
            AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("reason", "skill_markdown_not_utf8")
                .with_action(RecoveryAction::InspectTarget)
        })?;
        let markdown = rename_skill_frontmatter_content(&source_markdown, runtime_name)?;
        let source_skill = self.with_database("derived_rename.load_skill", |database| {
            database
                .catalog_repository()?
                .get_sync(source_skill_id)?
                .ok_or_else(|| operation_conflict("usage_subject_missing"))
        })?;
        let deployment_ids = request
            .selected_relation_ids
            .iter()
            .map(|relation_id| {
                relation_id
                    .strip_prefix("managed:")
                    .and_then(|raw| raw.parse::<skillhub_core::DeploymentId>().ok())
                    .ok_or_else(|| operation_conflict("derived_rename_relation_invalid"))
            })
            .collect::<AppResult<Vec<_>>>()?;
        let replacement_preview =
            match self.get_save_as_copy_replacement_preview(GetSaveAsCopyReplacementPreview {
                source_skill_id,
                targets: deployment_ids.clone(),
            })? {
                AppQueryResult::SaveAsCopyReplacementPreview(preview) => preview,
                _ => {
                    return Err(operation_conflict(
                        "derived_rename_replacement_preview_missing",
                    ))
                }
            };
        if replacement_preview.source_version_id != base_version_id {
            return Err(operation_conflict("derived_rename_base_version_stale"));
        }

        let (deployments, relations, revision, scopes) = {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("derived_rename.prepare.database"))?;
            let deployments = database.deployment_repository().list_all()?;
            let relations = database.relationship_repository().list_relations()?;
            let revision = database.relationship_repository().relationship_revision()?;
            let mut scopes = BTreeMap::new();
            for deployment in deployments
                .iter()
                .filter(|deployment| deployment_ids.contains(&deployment.id))
            {
                let scope = database
                    .connection_for_test()
                    .query_row(
                        "SELECT scope FROM targets WHERE id=?1",
                        [&deployment.target_id],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|_| operation_conflict("derived_rename_target_missing"))?;
                scopes.insert(deployment.target_id.clone(), scope);
            }
            (deployments, relations, revision, scopes)
        };

        let mut prepared = PreparedUsageChange {
            operation_id: request.operation_id,
            prepared_id: OperationId::new(),
            action: UsageChangeAction::DeriveAndReplace,
            relationship_revision: revision.to_string(),
            affected_skill_ids: vec![source_skill_id],
            subject_versions: vec![UsageSubjectVersion {
                skill_id: source_skill_id,
                version_id: Some(base_version_id.clone()),
            }],
            entry_evidence: Vec::new(),
            consumers: Vec::new(),
            impacts: Vec::new(),
            limitations: Vec::new(),
            duplicate_cleanup: None,
            shared_usage_migration: None,
            subject_rename: None,
            derived_rename: None,
        };
        let mut target_previews = Vec::new();
        let mut choices = Vec::new();
        for target_preview in &replacement_preview.targets {
            let deployment_id = target_preview.deployment_id;
            let relation_id = format!("managed:{deployment_id}");
            if target_preview.requires_shared_target_confirmation
                && !request.confirmed_shared_relation_ids.contains(&relation_id)
            {
                return Err(operation_conflict(
                    "derived_rename_shared_confirmation_required",
                ));
            }
            let deployment = deployments
                .iter()
                .find(|deployment| deployment.id == deployment_id)
                .filter(|deployment| {
                    deployment.skill_id == source_skill_id
                        && deployment.state == skillhub_core::DeploymentState::Deployed
                        && deployment.managed
                })
                .ok_or_else(|| operation_conflict("derived_rename_relation_missing"))?;
            let relation = relations
                .iter()
                .find(|relation| {
                    relation.relation_id == relation_id
                        && relation.active
                        && relation.skill_id == Some(source_skill_id)
                        && relation.ownership == OwnershipState::SkillhubManaged
                })
                .ok_or_else(|| operation_conflict("derived_rename_relation_unverified"))?;
            if target_preview.blocker.is_some() || !target_preview.managed {
                return Err(operation_conflict("derived_rename_target_blocked"));
            }
            let previous_path = PathBuf::from(&target_preview.path);
            let replacement_path = previous_path
                .parent()
                .ok_or_else(|| operation_conflict("derived_rename_target_missing"))?
                .join(runtime_name);
            if replacement_path != previous_path && fs::symlink_metadata(&replacement_path).is_ok()
            {
                return Err(operation_conflict("derived_rename_target_name_conflict"));
            }
            let target_scope = scopes
                .get(&deployment.target_id)
                .ok_or_else(|| operation_conflict("derived_rename_target_missing"))?;
            let target = UsageRelationTarget {
                kind: if target_scope == "project" {
                    RelationGovernanceTargetKind::Project
                } else {
                    RelationGovernanceTargetKind::Agent
                },
                directory_id: Some(deployment.target_id.clone()),
                agent_client_id: Some(relation.agent_client_id.clone()),
                directory_role: None,
                recognition: None,
            };
            let representation = match deployment.mode {
                DeploymentMode::ManagedCopy => FileRepresentation::Copy,
                DeploymentMode::SymbolicLink => FileRepresentation::SymbolicLink,
                DeploymentMode::DirectoryJunction => FileRepresentation::DirectoryJunction,
            };
            let form = if deployment.mode == DeploymentMode::ManagedCopy {
                UsageForm::FullCopy
            } else {
                UsageForm::Link
            };
            let path = previous_path.to_string_lossy().into_owned();
            let content_fingerprint = entry_fingerprint(&previous_path).ok().flatten();
            let physical_identity = entry_identity(&previous_path).unwrap_or_default();
            prepared.entry_evidence.push(UsageEntryEvidence {
                skill_id: source_skill_id,
                entry_key: UsageEntryKey {
                    directory_id: deployment.target_id.clone(),
                    relative_entry_path: deployment.runtime_name.clone(),
                },
                relation_ids: vec![relation_id.clone()],
                physical_source_ids: vec![deployment.target_id.clone()],
                path: path.clone(),
                directory_role: None,
                form: Some(form),
                management: UsageManagement::Managed,
                representation,
                content_fingerprint: content_fingerprint.clone(),
                physical_identity,
                link_target_path: fs::canonicalize(&previous_path)
                    .ok()
                    .map(|value| value.to_string_lossy().into_owned()),
                exists: fs::symlink_metadata(&previous_path).is_ok(),
            });
            prepared.consumers.push(UsageChangeConsumer {
                relation_ids: vec![relation_id.clone()],
                skill_id: Some(source_skill_id),
                entry_key: Some(UsageEntryKey {
                    directory_id: deployment.target_id.clone(),
                    relative_entry_path: deployment.runtime_name.clone(),
                }),
                target: target.clone(),
                path: Some(path),
                form: Some(form),
                management: UsageManagement::Managed,
                representation,
                health_reasons: vec![UsageHealthReason::Normal],
                physical_source_ids: vec![deployment.target_id.clone()],
                content_fingerprint,
            });
            prepared.impacts.push(UsageChangeImpact {
                relation_ids: vec![relation_id.clone()],
                skill_id: source_skill_id,
                target,
                action: UsageChangeImpactAction::DeriveAndReplace,
                description: "创建独立派生技能，并仅接管所选使用位置。".to_owned(),
            });
            target_previews.push(DerivedRenameTargetPreview {
                relation_id: relation_id.clone(),
                deployment_id: deployment_id.to_string(),
                previous_path: target_preview.path.clone(),
                replacement_path: replacement_path.to_string_lossy().into_owned(),
                requires_shared_target_confirmation: target_preview
                    .requires_shared_target_confirmation,
                blocker: None,
            });
            choices.push(SaveAsCopyReplacementChoice {
                deployment_id,
                confirm_shared_target_removal: request
                    .confirmed_shared_relation_ids
                    .contains(&relation_id),
            });
        }
        if target_previews.len() != request.selected_relation_ids.len() {
            return Err(operation_conflict("derived_rename_relation_scope_mismatch"));
        }
        target_previews.sort_by(|left, right| left.previous_path.cmp(&right.previous_path));
        prepared.derived_rename = Some(DerivedRenamePreview {
            source_skill_id,
            base_version_id: base_version_id.clone(),
            runtime_name: runtime_name.to_owned(),
            selected_relation_ids: request.selected_relation_ids.clone(),
            targets: target_previews,
        });
        let copy_request = SaveMarkdownAsCopy {
            skill_id: source_skill_id,
            path: "SKILL.md".to_owned(),
            markdown,
            expected_identity,
            origin: Some(SaveAsCopyOrigin {
                source_skill_id,
                source_version_id: base_version_id.clone(),
            }),
            inheritance: SaveAsCopyInheritance::ReplaceTargets {
                preview_id: replacement_preview.preview_id,
                targets: choices,
            },
            target_display_name: None,
            target_runtime_name: Some(runtime_name.to_owned()),
        };
        let journal = DerivedRenameJournal {
            request: request.clone(),
            prepared: prepared.clone(),
            original_skill: source_skill,
            source_version_id: base_version_id,
            copy_request,
            child_operation_id: OperationId::new(),
        };
        let mut record =
            OperationRecord::planned(request.operation_id, DERIVED_RENAME_KIND, fingerprint);
        set_phase(
            &mut record,
            OperationPhase::Prepared,
            0,
            journal.prepared.impacts.len() as u32,
        );
        record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
        record.result = Some(serde_json::to_value(&journal.prepared).map_err(serialization_error)?);
        let database = self
            .database
            .lock()
            .map_err(|_| internal("derived_rename.prepare.database"))?;
        if database
            .operation_repository()
            .get_sync(request.operation_id)?
            .is_some()
        {
            return Err(operation_conflict("operation_id_reused"));
        }
        database.operation_repository().insert_sync(&record)?;
        Ok(prepared)
    }

    fn prepare_managed_usage_change(
        &self,
        request: PrepareUsageChange,
    ) -> AppResult<PreparedUsageChange> {
        validate_managed_usage_change_request(&request)?;
        let fingerprint = request_fingerprint(&request)?;
        if let Some(record) = self
            .database
            .lock()
            .map_err(|_| internal("managed_usage_change.prepare.database"))?
            .operation_repository()
            .get_sync(request.operation_id)?
        {
            if record.kind != MANAGED_USAGE_CHANGE_KIND {
                return Err(operation_conflict("operation_id_reused"));
            }
            if record.request_fingerprint != fingerprint {
                return Err(AppError::new(
                    ErrorCode::OperationIdReusedWithDifferentRequest,
                    Severity::Error,
                )
                .with_param("operation_id", request.operation_id.to_string()));
            }
            let journal: ManagedUsageChangeJournal =
                serde_json::from_value(record.recovery_data)
                    .map_err(|_| operation_conflict("managed_usage_change_journal_invalid"))?;
            return Ok(journal.prepared);
        }

        let prepared_id = OperationId::new();
        let mut prepared = PreparedUsageChange {
            operation_id: request.operation_id,
            prepared_id,
            action: request.action,
            relationship_revision: String::new(),
            affected_skill_ids: Vec::new(),
            subject_versions: Vec::new(),
            entry_evidence: Vec::new(),
            consumers: Vec::new(),
            impacts: Vec::new(),
            limitations: Vec::new(),
            duplicate_cleanup: None,
            shared_usage_migration: None,
            subject_rename: None,
            derived_rename: None,
        };
        let mut plans = Vec::new();
        let library = self.library_runtime.snapshot()?;
        let database = self
            .database
            .lock()
            .map_err(|_| internal("managed_usage_change.prepare.database"))?;
        let repository = database.deployment_repository();
        let deployments = repository.list_all()?;
        let relations = database.relationship_repository().list_relations()?;
        let revision = database.relationship_repository().relationship_revision()?;
        let requested_relation_ids = request.relation_ids.iter().collect::<BTreeSet<_>>();
        let target_scopes = deployments
            .iter()
            .filter(|deployment| {
                requested_relation_ids.contains(&format!("managed:{}", deployment.id))
            })
            .map(|deployment| {
                let scope = database
                    .connection_for_test()
                    .query_row(
                        "SELECT scope FROM targets WHERE id=?1",
                        [&deployment.target_id],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|_| operation_conflict("managed_usage_change_target_missing"))?;
                Ok((deployment.target_id.clone(), scope))
            })
            .collect::<AppResult<BTreeMap<_, _>>>()?;
        drop(database);
        prepared.relationship_revision = revision.to_string();
        let requested_ids = request.relation_ids.iter().collect::<BTreeSet<_>>();

        for relation_id in &request.relation_ids {
            let deployment_id = relation_id
                .strip_prefix("managed:")
                .and_then(|id| id.parse::<skillhub_core::DeploymentId>().ok())
                .ok_or_else(|| operation_conflict("managed_usage_change_relation_invalid"))?;
            let deployment = deployments
                .iter()
                .find(|deployment| deployment.id == deployment_id)
                .filter(|deployment| {
                    deployment.state == skillhub_core::DeploymentState::Deployed
                        && deployment.managed
                })
                .cloned()
                .ok_or_else(|| operation_conflict("managed_usage_change_relation_missing"))?;
            let relation = relations
                .iter()
                .find(|relation| relation.relation_id == *relation_id && relation.active)
                .ok_or_else(|| operation_conflict("managed_usage_change_relation_missing"))?;
            let current = library
                .central
                .load_portable_skill(deployment.skill_id)?
                .and_then(|(_, version)| version)
                .ok_or_else(|| operation_conflict("usage_subject_version_missing"))?;
            let version_id = if request.action == UsageChangeAction::Restore {
                deployment.version_id.clone()
            } else {
                current
            };
            let target_root = self.backend.target_root(&deployment)?;
            if skillhub_core::physical_id_for_path(&target_root).as_deref()
                != Some(deployment.target_id.as_str())
            {
                return Err(operation_conflict(
                    "managed_usage_change_target_identity_changed",
                ));
            }
            let destination = target_root.join(&deployment.runtime_name);
            let metadata = match fs::symlink_metadata(&destination) {
                Ok(metadata) => Some(metadata),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => {
                    return Err(operation_conflict_with(
                        "managed_usage_change_target_unavailable",
                        error.to_string(),
                    ))
                }
            };
            match request.action {
                UsageChangeAction::Sync => {
                    if metadata.is_none() {
                        return Err(operation_conflict("usage_sync_missing_requires_restore"));
                    }
                    if deployment.mode == DeploymentMode::ManagedCopy {
                        let observed = DeploymentFilesystem::hash_tree(&destination)?;
                        if observed != deployment.expected_hash
                            && request.content_basis != Some(UsageContentBasis::LibraryCurrent)
                        {
                            return Err(operation_conflict("usage_sync_content_choice_required"));
                        }
                    }
                }
                UsageChangeAction::Repair => {
                    if !deployment.mode.is_directory_link() || metadata.is_none() {
                        return Err(operation_conflict("usage_repair_target_not_repairable"));
                    }
                    if request.content_basis != Some(UsageContentBasis::LibraryCurrent) {
                        return Err(operation_conflict("usage_repair_content_choice_required"));
                    }
                }
                UsageChangeAction::Restore => {
                    if metadata.is_some() {
                        return Err(operation_conflict("usage_restore_target_already_exists"));
                    }
                }
                UsageChangeAction::Release
                | UsageChangeAction::Manage
                | UsageChangeAction::ResolveDuplicate
                | UsageChangeAction::MigrateSharedUsage => unreachable!(),
                UsageChangeAction::RenameSubject => unreachable!(),
                UsageChangeAction::DeriveAndReplace => unreachable!(),
            }
            let observed_before = entry_fingerprint(&destination)?;
            let observed_identity = entry_identity(&destination)?;
            let backup_path = library.central.paths().backups_dir.join(format!(
                "managed-usage-{}-{}-{}",
                request.operation_id, deployment.id, prepared_id
            ));
            let target_scope = target_scopes
                .get(&deployment.target_id)
                .ok_or_else(|| operation_conflict("managed_usage_change_target_missing"))?;
            let target_kind = if target_scope == "project" {
                RelationGovernanceTargetKind::Project
            } else {
                RelationGovernanceTargetKind::Agent
            };
            let form = match deployment.mode {
                DeploymentMode::ManagedCopy => UsageForm::FullCopy,
                DeploymentMode::SymbolicLink | DeploymentMode::DirectoryJunction => UsageForm::Link,
            };
            let representation = match deployment.mode {
                DeploymentMode::ManagedCopy => FileRepresentation::Copy,
                DeploymentMode::SymbolicLink => FileRepresentation::SymbolicLink,
                DeploymentMode::DirectoryJunction => FileRepresentation::DirectoryJunction,
            };
            let target = UsageRelationTarget {
                kind: target_kind,
                directory_id: Some(deployment.target_id.clone()),
                agent_client_id: Some(relation.agent_client_id.clone()),
                directory_role: None,
                recognition: None,
            };
            let health_reasons = match relation.health_reasons.as_deref() {
                Some([]) => match relation.match_state {
                    skillhub_core::ObservedMatchState::ContentVerified => {
                        vec![UsageHealthReason::Normal]
                    }
                    skillhub_core::ObservedMatchState::NameOnly => {
                        vec![UsageHealthReason::UserConfirmation]
                    }
                    skillhub_core::ObservedMatchState::Diverged => {
                        vec![UsageHealthReason::ContentChanged]
                    }
                },
                Some(reasons) => reasons
                    .iter()
                    .map(|reason| match reason {
                        skillhub_core::relationship::RelationHealthReason::TargetEntryMissing => {
                            UsageHealthReason::FileMissing
                        }
                        skillhub_core::relationship::RelationHealthReason::TargetEntryReplaced
                        | skillhub_core::relationship::RelationHealthReason::TargetLinkUnavailable
                            if deployment.mode.is_directory_link() =>
                        {
                            UsageHealthReason::LinkAbnormal
                        }
                        skillhub_core::relationship::RelationHealthReason::ContentChanged => {
                            UsageHealthReason::ContentChanged
                        }
                        skillhub_core::relationship::RelationHealthReason::OperationFailed
                            if deployment.mode == DeploymentMode::ManagedCopy =>
                        {
                            UsageHealthReason::SyncFailed
                        }
                        skillhub_core::relationship::RelationHealthReason::ManagedTargetOccupied => {
                            UsageHealthReason::UserConfirmation
                        }
                        _ => UsageHealthReason::UnableToVerify,
                    })
                    .collect(),
                None => vec![UsageHealthReason::UnableToVerify],
            };
            let relation_ids = vec![relation_id.clone()];
            prepared.affected_skill_ids.push(deployment.skill_id);
            prepared.subject_versions.push(UsageSubjectVersion {
                skill_id: deployment.skill_id,
                version_id: Some(version_id.clone()),
            });
            prepared.entry_evidence.push(UsageEntryEvidence {
                skill_id: deployment.skill_id,
                entry_key: UsageEntryKey {
                    directory_id: deployment.target_id.clone(),
                    relative_entry_path: deployment.runtime_name.clone(),
                },
                relation_ids: relation_ids.clone(),
                physical_source_ids: vec![deployment.target_id.clone()],
                path: destination.to_string_lossy().into_owned(),
                directory_role: None,
                form: Some(form),
                management: UsageManagement::Managed,
                representation,
                content_fingerprint: observed_before.clone(),
                physical_identity: skillhub_core::physical_id_for_path(&destination),
                link_target_path: fs::canonicalize(&destination)
                    .ok()
                    .map(|path| path.to_string_lossy().into_owned()),
                exists: metadata.is_some(),
            });
            prepared.consumers.push(UsageChangeConsumer {
                relation_ids: relation_ids.clone(),
                skill_id: Some(deployment.skill_id),
                entry_key: prepared
                    .entry_evidence
                    .last()
                    .map(|evidence| evidence.entry_key.clone()),
                target: target.clone(),
                path: Some(destination.to_string_lossy().into_owned()),
                form: Some(form),
                management: UsageManagement::Managed,
                representation,
                health_reasons,
                physical_source_ids: vec![deployment.target_id.clone()],
                content_fingerprint: observed_before.clone(),
            });
            let action = match request.action {
                UsageChangeAction::Sync => UsageChangeImpactAction::Synchronize,
                UsageChangeAction::Repair => UsageChangeImpactAction::Repair,
                UsageChangeAction::Restore => UsageChangeImpactAction::Restore,
                UsageChangeAction::Release
                | UsageChangeAction::Manage
                | UsageChangeAction::ResolveDuplicate
                | UsageChangeAction::MigrateSharedUsage => unreachable!(),
                UsageChangeAction::RenameSubject => unreachable!(),
                UsageChangeAction::DeriveAndReplace => unreachable!(),
            };
            prepared.impacts.push(UsageChangeImpact {
                relation_ids,
                skill_id: deployment.skill_id,
                target,
                action,
                description: match request.action {
                    UsageChangeAction::Sync => "同步受管目标到技能库当前版本".to_owned(),
                    UsageChangeAction::Repair => "备份占用项并修复受管链接".to_owned(),
                    UsageChangeAction::Restore => "按原受管方式恢复目标".to_owned(),
                    UsageChangeAction::Release
                    | UsageChangeAction::Manage
                    | UsageChangeAction::ResolveDuplicate
                    | UsageChangeAction::MigrateSharedUsage => unreachable!(),
                    UsageChangeAction::RenameSubject => unreachable!(),
                    UsageChangeAction::DeriveAndReplace => unreachable!(),
                },
            });
            plans.push(ManagedUsageChangePlan {
                deployment_id,
                destination: destination.to_string_lossy().into_owned(),
                subject_version_id: version_id,
                observed_before,
                observed_identity,
                backup_path: backup_path.to_string_lossy().into_owned(),
                backup_created: false,
            });
        }
        if plans.len() != requested_ids.len() {
            return Err(operation_conflict("managed_usage_change_relation_missing"));
        }
        prepared
            .affected_skill_ids
            .sort_by_key(|skill_id| skill_id.to_string());
        prepared.affected_skill_ids.dedup();
        prepared
            .subject_versions
            .sort_by_key(|item| item.skill_id.to_string());
        prepared.subject_versions.dedup_by_key(|item| item.skill_id);
        let journal = ManagedUsageChangeJournal {
            request: request.clone(),
            prepared: prepared.clone(),
            plans,
            completed: Vec::new(),
        };
        let mut record =
            OperationRecord::planned(request.operation_id, MANAGED_USAGE_CHANGE_KIND, fingerprint);
        set_phase(
            &mut record,
            OperationPhase::Prepared,
            0,
            journal.plans.len() as u32,
        );
        record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
        record.result = Some(serde_json::to_value(&prepared).map_err(serialization_error)?);
        let database = self
            .database
            .lock()
            .map_err(|_| internal("managed_usage_change.prepare.database"))?;
        if database
            .operation_repository()
            .get_sync(request.operation_id)?
            .is_some()
        {
            return Err(operation_conflict("operation_id_reused"));
        }
        database.operation_repository().insert_sync(&record)?;
        Ok(prepared)
    }

    fn prepare_usage_manage(&self, request: PrepareUsageChange) -> AppResult<PreparedUsageChange> {
        if request.relation_ids.len() != 1
            || request.content_basis == Some(UsageContentBasis::OriginalEntry)
            || (request.content_basis == Some(UsageContentBasis::LibraryCurrent)
                && !self.usage_entry_matches_library_current(&request.relation_ids[0])?)
        {
            return self.prepare_usage_manage_batch(request);
        }
        self.prepare_usage_manage_single_current(request)
    }

    fn usage_entry_matches_library_current(&self, relation_id: &str) -> AppResult<bool> {
        let relation = self
            .database
            .lock()
            .map_err(|_| internal("usage_manage.prepare.database"))?
            .relationship_repository()
            .list_relations()?
            .into_iter()
            .find(|relation| relation.relation_id == relation_id)
            .ok_or_else(|| operation_conflict("usage_change_relation_missing"))?;
        let skill_id = relation
            .skill_id
            .ok_or_else(|| operation_conflict("usage_subject_unverified"))?;
        let library = self.library_runtime.snapshot()?;
        let Some((record, Some(_current_version))) =
            library.central.load_portable_skill(skill_id)?
        else {
            return Err(operation_conflict("usage_subject_version_missing"));
        };
        let current_path = library
            .central
            .visible_skill_path_for_runtime(skill_id, &record.runtime_name);
        let current_fingerprint = DeploymentFilesystem::hash_tree(&current_path)?;
        Ok(relation.content_fingerprint == current_fingerprint)
    }

    fn prepare_usage_manage_single_current(
        &self,
        request: PrepareUsageChange,
    ) -> AppResult<PreparedUsageChange> {
        let fingerprint = request_fingerprint(&request)?;
        let existing = {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("usage_manage.prepare.database"))?;
            database
                .operation_repository()
                .get_sync(request.operation_id)?
        };
        if let Some(record) = existing {
            if record.kind != MANAGE_OPERATION_KIND {
                return Err(operation_conflict("operation_id_reused"));
            }
            if record.request_fingerprint != fingerprint {
                return Err(AppError::new(
                    ErrorCode::OperationIdReusedWithDifferentRequest,
                    Severity::Error,
                )
                .with_param("operation_id", request.operation_id.to_string()));
            }
            if let Some(preview) = self.usage_manage_preview(request.operation_id)? {
                return Ok(preview);
            }
        }

        let relation_id = request.relation_ids[0].clone();
        let target_mode = match request.requested_form {
            Some(UsageForm::Link) => RelationMigrationTargetMode::ManagedLink,
            Some(UsageForm::FullCopy) => RelationMigrationTargetMode::ManagedCopy,
            None => return Err(operation_conflict("usage_manage_form_required")),
        };
        let relation = self.prepare_usage_relation_migration(
            request.operation_id,
            PrepareRelationMigration {
                relation_id,
                target_mode,
                backup_policy: RelationshipMigrationBackupPolicy::Required,
                confirmation_token: None,
            },
            fingerprint,
            request.content_basis == Some(UsageContentBasis::LibraryCurrent),
        )?;
        let (preview, relation_facts) = build_usage_manage_preview(self, &request, &relation)?;
        self.attach_usage_manage_preview(request.operation_id, preview.clone(), relation_facts)?;
        Ok(preview)
    }

    fn prepare_usage_manage_batch(
        &self,
        request: PrepareUsageChange,
    ) -> AppResult<PreparedUsageChange> {
        let fingerprint = request_fingerprint(&request)?;
        {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("usage_manage_batch.prepare.database"))?;
            if let Some(record) = database
                .operation_repository()
                .get_sync(request.operation_id)?
            {
                if record.kind != MANAGE_BATCH_OPERATION_KIND {
                    return Err(operation_conflict("operation_id_reused"));
                }
                if record.request_fingerprint != fingerprint {
                    return Err(AppError::new(
                        ErrorCode::OperationIdReusedWithDifferentRequest,
                        Severity::Error,
                    )
                    .with_param("operation_id", request.operation_id.to_string()));
                }
                let journal: ManageBatchJournal = serde_json::from_value(record.recovery_data)
                    .map_err(|_| operation_conflict("usage_manage_batch_journal_invalid"))?;
                return Ok(journal.prepared);
            }
        }

        let prepared_id = OperationId::new();
        let action = match request.requested_form {
            Some(UsageForm::Link) => RelationMigrationTargetMode::ManagedLink,
            Some(UsageForm::FullCopy) => RelationMigrationTargetMode::ManagedCopy,
            None => return Err(operation_conflict("usage_manage_form_required")),
        };
        let mut plans = Vec::new();
        let mut entry_previews = Vec::new();
        let mut seen_entries = BTreeSet::new();
        for relation_id in &request.relation_ids {
            let single_request = request_for_manage_entry(&request, relation_id);
            let (preview, _) = build_usage_manage_entry_preview(
                self,
                &single_request,
                relation_id,
                request.operation_id,
                prepared_id,
                None,
            )?;
            let evidence = preview
                .entry_evidence
                .first()
                .ok_or_else(|| operation_conflict("usage_change_evidence_missing"))?;
            let identity = (
                evidence.skill_id.to_string(),
                evidence.path.clone(),
                evidence.relation_ids.clone(),
            );
            if !seen_entries.insert(identity) {
                continue;
            }

            let child_operation_id = OperationId::new();
            if request.content_basis == Some(UsageContentBasis::LibraryCurrent) {
                let mut child = request_for_relation_migration(relation_id, action);
                child.confirmation_token = None;
                let child_fingerprint = request_fingerprint(&single_request)?;
                let migration = self.prepare_usage_relation_migration(
                    child_operation_id,
                    child,
                    child_fingerprint,
                    request.content_basis == Some(UsageContentBasis::LibraryCurrent),
                )?;
                if migration.relation.relation_id != *relation_id {
                    return Err(operation_conflict("usage_change_identity_conflict"));
                }
                entry_previews.push(preview);
            } else {
                entry_previews.push(preview);
            }
            plans.push(ManageBatchPlan {
                relation_id: relation_id.clone(),
                child_operation_id,
                target_mode: action,
            });
        }
        if plans.is_empty() {
            return Err(operation_conflict("usage_change_relation_missing"));
        }

        let mut prepared =
            merge_manage_entry_previews(request.operation_id, prepared_id, &entry_previews)?;
        let adoptions = if request.content_basis == Some(UsageContentBasis::OriginalEntry) {
            let mut by_skill = HashMap::<SkillId, (String, String, Option<VersionId>)>::new();
            for evidence in &prepared.entry_evidence {
                let fingerprint = evidence
                    .content_fingerprint
                    .clone()
                    .ok_or_else(|| operation_conflict("usage_change_original_basis_unverified"))?;
                let version_id = prepared
                    .subject_versions
                    .iter()
                    .find(|version| version.skill_id == evidence.skill_id)
                    .and_then(|version| version.version_id.clone());
                match by_skill.get(&evidence.skill_id) {
                    Some((_, previous_fingerprint, _)) if previous_fingerprint != &fingerprint => {
                        return Err(operation_conflict("usage_change_original_basis_ambiguous"));
                    }
                    Some(_) => {}
                    None => {
                        by_skill.insert(
                            evidence.skill_id,
                            (evidence.path.clone(), fingerprint, version_id),
                        );
                    }
                }
            }
            let mut adoptions = by_skill
                .into_iter()
                .map(|(skill_id, (path, fingerprint, previous_version_id))| {
                    ManageOriginalEntryPlan {
                        skill_id,
                        operation_id: OperationId::new(),
                        path,
                        fingerprint,
                        previous_version_id,
                        completed: false,
                    }
                })
                .collect::<Vec<_>>();
            adoptions.sort_by_key(|adoption| adoption.skill_id.to_string());
            add_original_entry_impacts(&mut prepared, &entry_previews);
            adoptions
        } else {
            Vec::new()
        };

        let journal = ManageBatchJournal {
            request: request.clone(),
            prepared: prepared.clone(),
            plans,
            adoptions,
            adoption_results: Vec::new(),
            completed: Vec::new(),
        };
        let mut record = OperationRecord::planned(
            request.operation_id,
            MANAGE_BATCH_OPERATION_KIND,
            fingerprint,
        );
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
            .map_err(|_| internal("usage_manage_batch.prepare.database"))?;
        if database
            .operation_repository()
            .get_sync(request.operation_id)?
            .is_some()
        {
            return Err(operation_conflict("operation_id_reused"));
        }
        database.operation_repository().insert_sync(&record)?;
        Ok(prepared)
    }

    fn prepare_duplicate_cleanup(
        &self,
        request: PrepareUsageChange,
    ) -> AppResult<PreparedUsageChange> {
        let fingerprint = request_fingerprint(&request)?;
        {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("duplicate_cleanup.prepare.database"))?;
            if let Some(record) = database
                .operation_repository()
                .get_sync(request.operation_id)?
            {
                if record.kind != DUPLICATE_CLEANUP_KIND {
                    return Err(operation_conflict("operation_id_reused"));
                }
                if record.request_fingerprint != fingerprint {
                    return Err(AppError::new(
                        ErrorCode::OperationIdReusedWithDifferentRequest,
                        Severity::Error,
                    )
                    .with_param("operation_id", request.operation_id.to_string()));
                }
                let journal: DuplicateCleanupJournal = serde_json::from_value(record.recovery_data)
                    .map_err(|_| operation_conflict("duplicate_cleanup_journal_invalid"))?;
                return Ok(journal.prepared);
            }
        }

        let journal = build_duplicate_cleanup_journal(self, request.clone(), OperationId::new())?;
        let mut record =
            OperationRecord::planned(request.operation_id, DUPLICATE_CLEANUP_KIND, fingerprint);
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
            .map_err(|_| internal("duplicate_cleanup.prepare.database"))?;
        if database
            .operation_repository()
            .get_sync(request.operation_id)?
            .is_some()
        {
            return Err(operation_conflict("operation_id_reused"));
        }
        database.operation_repository().insert_sync(&record)?;
        Ok(journal.prepared)
    }

    fn prepare_shared_usage_migration(
        &self,
        request: PrepareUsageChange,
    ) -> AppResult<PreparedUsageChange> {
        let fingerprint = request_fingerprint(&request)?;
        {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("shared_usage_migration.prepare.database"))?;
            if let Some(record) = database
                .operation_repository()
                .get_sync(request.operation_id)?
            {
                if record.kind != SHARED_USAGE_MIGRATION_KIND {
                    return Err(operation_conflict("operation_id_reused"));
                }
                if record.request_fingerprint != fingerprint {
                    return Err(AppError::new(
                        ErrorCode::OperationIdReusedWithDifferentRequest,
                        Severity::Error,
                    )
                    .with_param("operation_id", request.operation_id.to_string()));
                }
                let journal: SharedUsageMigrationJournal =
                    serde_json::from_value(record.recovery_data).map_err(|_| {
                        operation_conflict("shared_usage_migration_journal_invalid")
                    })?;
                return Ok(journal.prepared);
            }
        }

        let journal =
            build_shared_usage_migration_journal(self, request.clone(), OperationId::new())?;
        let mut record = OperationRecord::planned(
            request.operation_id,
            SHARED_USAGE_MIGRATION_KIND,
            fingerprint,
        );
        set_phase(
            &mut record,
            OperationPhase::Prepared,
            0,
            journal.replacements.len() as u32 + 1,
        );
        record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
        record.result = Some(serde_json::to_value(&journal.prepared).map_err(serialization_error)?);
        let database = self
            .database
            .lock()
            .map_err(|_| internal("shared_usage_migration.prepare.database"))?;
        if database
            .operation_repository()
            .get_sync(request.operation_id)?
            .is_some()
        {
            return Err(operation_conflict("operation_id_reused"));
        }
        database.operation_repository().insert_sync(&record)?;
        Ok(journal.prepared)
    }

    fn commit_duplicate_cleanup(&self, request: CommitUsageChange) -> AppResult<UsageChangeResult> {
        let _mutation = self
            .relation_migration_lock
            .lock()
            .map_err(|_| internal("duplicate_cleanup.commit.mutation_lock"))?;
        let (mut record, mut journal) = {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("duplicate_cleanup.commit.database"))?;
            let record = database
                .operation_repository()
                .get_sync(request.operation_id)?
                .ok_or_else(|| operation_conflict("usage_change_preview_missing"))?;
            if record.kind != DUPLICATE_CLEANUP_KIND {
                return Err(operation_conflict("operation_id_reused"));
            }
            let journal: DuplicateCleanupJournal =
                serde_json::from_value(record.recovery_data.clone())
                    .map_err(|_| operation_conflict("duplicate_cleanup_journal_invalid"))?;
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
            if record.phase != OperationPhase::Prepared {
                return Err(operation_conflict("usage_change_preview_not_prepared"));
            }
            (record, journal)
        };

        let current = build_duplicate_cleanup_journal(
            self,
            journal.request.clone(),
            journal.prepared.prepared_id,
        )?;
        if current.prepared != journal.prepared || current.plans != journal.plans {
            return Err(operation_conflict("usage_change_preview_stale"));
        }
        for plan in &journal.plans {
            validate_duplicate_cleanup_plan(self, plan)?;
        }

        {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("duplicate_cleanup.commit.database"))?;
            set_phase(
                &mut record,
                OperationPhase::Applying,
                0,
                journal.plans.len() as u32,
            );
            record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
            database.operation_repository().update_sync(&record)?;
        }

        let apply_result = apply_duplicate_cleanup_files(self, &mut record, &mut journal);
        if let Err(error) = apply_result {
            let rollback_result = rollback_duplicate_cleanup_files(self, &mut record, &mut journal);
            let database = self
                .database
                .lock()
                .map_err(|_| internal("duplicate_cleanup.commit.database"))?;
            if rollback_result.is_ok() {
                set_phase(
                    &mut record,
                    OperationPhase::RolledBack,
                    journal.completed.len() as u32,
                    journal.plans.len() as u32,
                );
            } else {
                set_phase(
                    &mut record,
                    OperationPhase::NeedsRecovery,
                    journal.completed.len() as u32,
                    journal.plans.len() as u32,
                );
            }
            record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
            record.error_code = Some(error.code);
            database.operation_repository().update_sync(&record)?;
            return Err(error);
        }

        let verified = verify_duplicate_cleanup_rescan(self, &journal);
        if let Err(error) = verified {
            let rollback_result = rollback_duplicate_cleanup_files(self, &mut record, &mut journal);
            let database = self
                .database
                .lock()
                .map_err(|_| internal("duplicate_cleanup.verify.database"))?;
            set_phase(
                &mut record,
                if rollback_result.is_ok() {
                    OperationPhase::RolledBack
                } else {
                    OperationPhase::NeedsRecovery
                },
                journal.completed.len() as u32,
                journal.plans.len() as u32,
            );
            record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
            record.error_code = Some(error.code);
            database.operation_repository().update_sync(&record)?;
            return Err(error);
        }

        let result = UsageChangeResult {
            operation_id: journal.prepared.operation_id,
            prepared_id: journal.prepared.prepared_id,
            item_results: Vec::new(),
            recovery_required: false,
            derived_skill_id: None,
            recovery_operation_id: None,
        };
        let database = self
            .database
            .lock()
            .map_err(|_| internal("duplicate_cleanup.commit.database"))?;
        record.result = Some(serde_json::to_value(&result).map_err(serialization_error)?);
        record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
        set_phase(
            &mut record,
            OperationPhase::Committed,
            journal.plans.len() as u32,
            journal.plans.len() as u32,
        );
        database.operation_repository().update_sync(&record)?;
        Ok(result)
    }

    pub fn commit_usage_change(&self, request: CommitUsageChange) -> AppResult<UsageChangeResult> {
        let operation_kind = {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("usage_change.commit.database"))?;
            database
                .operation_repository()
                .get_sync(request.operation_id)?
                .map(|record| record.kind)
        };
        if operation_kind.as_deref() == Some(MANAGE_OPERATION_KIND) {
            return self.commit_usage_manage(request);
        }
        if operation_kind.as_deref() == Some(MANAGE_BATCH_OPERATION_KIND) {
            return self.commit_usage_manage_batch(request);
        }
        if operation_kind.as_deref() == Some(MANAGED_USAGE_CHANGE_KIND) {
            return self.commit_managed_usage_change(request);
        }
        if operation_kind.as_deref() == Some(DUPLICATE_CLEANUP_KIND) {
            return self.commit_duplicate_cleanup(request);
        }
        if operation_kind.as_deref() == Some(DERIVED_RENAME_KIND) {
            return self.commit_derived_rename(request);
        }

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
            derived_skill_id: None,
            recovery_operation_id: None,
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

    fn commit_derived_rename(&self, request: CommitUsageChange) -> AppResult<UsageChangeResult> {
        let _mutation = self
            .relation_migration_lock
            .lock()
            .map_err(|_| internal("derived_rename.commit.mutation_lock"))?;
        let (mut record, journal) = {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("derived_rename.commit.database"))?;
            let record = database
                .operation_repository()
                .get_sync(request.operation_id)?
                .ok_or_else(|| operation_conflict("derived_rename_preview_missing"))?;
            if record.kind != DERIVED_RENAME_KIND {
                return Err(operation_conflict("operation_id_reused"));
            }
            let journal: DerivedRenameJournal =
                serde_json::from_value(record.recovery_data.clone())
                    .map_err(|_| operation_conflict("derived_rename_journal_invalid"))?;
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
            if record.phase != OperationPhase::Prepared {
                return Err(operation_conflict("derived_rename_recovery_required"));
            }
            (record, journal)
        };
        let library = self.library_runtime.snapshot()?;
        let source_skill_id = journal.original_skill.id();
        let current_skill = self.with_database("derived_rename.validate.skill", |database| {
            database
                .catalog_repository()?
                .get_sync(source_skill_id)?
                .ok_or_else(|| operation_conflict("usage_change_preview_stale"))
        })?;
        if current_skill != journal.original_skill
            || library.current(source_skill_id)?.as_ref() != Some(&journal.source_version_id)
            || self
                .with_database("derived_rename.validate.version", |database| {
                    database.current_version(source_skill_id)
                })?
                .as_ref()
                != Some(&journal.source_version_id)
        {
            return Err(operation_conflict("usage_change_preview_stale"));
        }
        let revision = self
            .database
            .lock()
            .map_err(|_| internal("derived_rename.validate.database"))?
            .relationship_repository()
            .relationship_revision()?;
        if revision.to_string() != journal.prepared.relationship_revision {
            return Err(operation_conflict("usage_change_preview_stale"));
        }
        set_phase(
            &mut record,
            OperationPhase::Applying,
            0,
            journal.prepared.impacts.len() as u32,
        );
        record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
        self.database
            .lock()
            .map_err(|_| internal("derived_rename.checkpoint.database"))?
            .operation_repository()
            .update_sync(&record)?;

        let child_exists = self
            .database
            .lock()
            .map_err(|_| internal("derived_rename.child.database"))?
            .operation_repository()
            .get_sync(journal.child_operation_id)?
            .is_some();
        if !child_exists {
            self.journal_begin(journal.child_operation_id, "save_markdown_as_copy");
        }
        let saved = self
            .save_markdown_as_copy_flow(journal.copy_request.clone(), journal.child_operation_id);
        let saved = match saved {
            Ok(AppCommandResult::SavedSkillCopy(saved)) => saved,
            Ok(_) => return Err(operation_conflict("derived_rename_copy_result_invalid")),
            Err(error) => {
                let mut failed = record;
                failed.error_code = Some(error.code);
                let child_phase = self
                    .database
                    .lock()
                    .map_err(|_| internal("derived_rename.child_phase.database"))?
                    .operation_repository()
                    .get_sync(journal.child_operation_id)?
                    .map(|child| child.phase);
                set_phase(
                    &mut failed,
                    if matches!(
                        child_phase,
                        Some(OperationPhase::Applying | OperationPhase::NeedsRecovery)
                    ) {
                        OperationPhase::NeedsRecovery
                    } else {
                        OperationPhase::RolledBack
                    },
                    0,
                    journal.prepared.impacts.len() as u32,
                );
                failed.recovery_data =
                    serde_json::to_value(&journal).map_err(serialization_error)?;
                self.database
                    .lock()
                    .map_err(|_| internal("derived_rename.failure.database"))?
                    .operation_repository()
                    .update_sync(&failed)?;
                return Err(error);
            }
        };
        let replacement_items = match &saved.inheritance {
            SaveAsCopyInheritanceOutcome::NotRequested => Vec::new(),
            SaveAsCopyInheritanceOutcome::Replaced { items }
            | SaveAsCopyInheritanceOutcome::PartiallyReplaced { items } => items.clone(),
        };
        let item_results = replacement_items
            .iter()
            .map(|item| {
                let relation_id = format!("managed:{}", item.deployment_id);
                let impact = journal
                    .prepared
                    .impacts
                    .iter()
                    .find(|impact| impact.relation_ids.iter().any(|id| id == &relation_id))
                    .ok_or_else(|| operation_conflict("derived_rename_result_target_missing"))?;
                Ok(UsageChangeItemResult {
                    relation_ids: vec![relation_id],
                    skill_id: saved.skill_id,
                    target: impact.target.clone(),
                    action: UsageChangeImpactAction::DeriveAndReplace,
                    status: match item.status {
                        SaveAsCopyTargetStatus::Applied => UsageChangeItemStatus::Applied,
                        SaveAsCopyTargetStatus::Failed => UsageChangeItemStatus::Failed,
                    },
                    reason: item.error_code.map(|code| code.as_str().to_owned()),
                    recovery_point: None,
                })
            })
            .collect::<AppResult<Vec<_>>>()?;
        let result = UsageChangeResult {
            operation_id: journal.prepared.operation_id,
            prepared_id: journal.prepared.prepared_id,
            item_results,
            recovery_required: saved.recovery_operation_id.is_some(),
            derived_skill_id: Some(saved.skill_id),
            recovery_operation_id: saved.recovery_operation_id,
        };
        record.result = Some(serde_json::to_value(&result).map_err(serialization_error)?);
        record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
        set_phase(
            &mut record,
            OperationPhase::Committed,
            result.item_results.len() as u32,
            journal.prepared.impacts.len() as u32,
        );
        self.database
            .lock()
            .map_err(|_| internal("derived_rename.finish.database"))?
            .operation_repository()
            .update_sync(&record)?;
        Ok(result)
    }

    async fn commit_subject_rename(
        &self,
        request: CommitUsageChange,
    ) -> AppResult<UsageChangeResult> {
        let _mutation = self
            .relation_migration_lock
            .lock()
            .map_err(|_| internal("subject_rename.commit.mutation_lock"))?;
        let (mut record, mut journal) = {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("subject_rename.commit.database"))?;
            let record = database
                .operation_repository()
                .get_sync(request.operation_id)?
                .ok_or_else(|| operation_conflict("subject_rename_preview_missing"))?;
            if record.kind != SUBJECT_RENAME_KIND {
                return Err(operation_conflict("operation_id_reused"));
            }
            let journal: SubjectRenameJournal =
                serde_json::from_value(record.recovery_data.clone())
                    .map_err(|_| operation_conflict("subject_rename_journal_invalid"))?;
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
                if journal.metadata_committed {
                    drop(database);
                    return self.finish_subject_rename(record, journal);
                }
                return Err(operation_conflict("subject_rename_rollback_required"));
            }
            if record.phase != OperationPhase::Prepared {
                return Err(operation_conflict("usage_change_preview_not_prepared"));
            }
            (record, journal)
        };

        if let Err(error) = self.validate_subject_rename_snapshot(&journal) {
            return Err(error);
        }
        persist_subject_rename(self, &mut record, &journal, OperationPhase::Applying)?;
        if let Err(error) = self.apply_subject_rename(&mut record, &mut journal) {
            return self.fail_subject_rename(record, journal, error);
        }
        journal.metadata_committed = true;
        persist_subject_rename(self, &mut record, &journal, OperationPhase::Applying)?;
        self.finish_subject_rename(record, journal)
    }

    fn validate_subject_rename_snapshot(&self, journal: &SubjectRenameJournal) -> AppResult<()> {
        let library = self.library_runtime.snapshot()?;
        let skill_id = journal.original_skill.id();
        let current_skill = self.with_database("subject_rename.validate.skill", |database| {
            database
                .catalog_repository()?
                .get_sync(skill_id)?
                .ok_or_else(|| operation_conflict("usage_change_preview_stale"))
        })?;
        if current_skill != journal.original_skill
            || library.current(skill_id)?.as_ref() != Some(&journal.previous_version_id)
            || self
                .with_database("subject_rename.validate.version", |database| {
                    database.current_version(skill_id)
                })?
                .as_ref()
                != Some(&journal.previous_version_id)
        {
            return Err(operation_conflict("usage_change_preview_stale"));
        }
        let old_visible = library.central.visible_skill_path(&journal.original_skill);
        if library.store.hash_tree_read_only(&old_visible)? != journal.original_visible_hash {
            return Err(operation_conflict("usage_change_preview_stale"));
        }
        let renamed_skill = renamed_skill(journal)?;
        let new_visible = library.central.visible_skill_path(&renamed_skill);
        if fs::symlink_metadata(&new_visible).is_ok() {
            return Err(operation_conflict("subject_rename_visible_name_conflict"));
        }

        let (deployments, relations, revision) = {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("subject_rename.validate.database"))?;
            (
                database.deployment_repository().list_all()?,
                database.relationship_repository().list_relations()?,
                database.relationship_repository().relationship_revision()?,
            )
        };
        if revision.to_string() != journal.prepared.relationship_revision {
            return Err(operation_conflict("usage_change_preview_stale"));
        }
        let actual = deployments
            .iter()
            .filter(|deployment| {
                deployment.skill_id == skill_id
                    && deployment.state == skillhub_core::DeploymentState::Deployed
            })
            .collect::<Vec<_>>();
        if actual.len() != journal.plans.len()
            || journal.plans.iter().any(|plan| {
                actual
                    .iter()
                    .find(|deployment| deployment.id.to_string() == plan.deployment_id)
                    .is_none_or(|deployment| **deployment != plan.original_deployment)
            })
        {
            return Err(operation_conflict("usage_change_preview_stale"));
        }
        let expected_relations = journal
            .plans
            .iter()
            .map(|plan| format!("managed:{}", plan.deployment_id))
            .collect::<BTreeSet<_>>();
        if relations.iter().any(|relation| {
            relation.active
                && relation.skill_id == Some(skill_id)
                && !expected_relations.contains(&relation.relation_id)
        }) || expected_relations.iter().any(|relation_id| {
            !relations
                .iter()
                .any(|relation| relation.active && relation.relation_id == *relation_id)
        }) {
            return Err(operation_conflict("usage_change_preview_stale"));
        }

        for plan in &journal.plans {
            let root = self.backend.target_root(&plan.original_deployment)?;
            if skillhub_core::physical_id_for_path(&root).as_deref()
                != Some(plan.target_root_identity.as_str())
                || fs::symlink_metadata(&Path::new(&plan.path)).is_ok()
                || fs::symlink_metadata(&Path::new(&plan.backup_path)).is_ok()
                || entry_fingerprint(Path::new(&plan.previous_path))?.as_deref()
                    != plan.observed_before.as_deref()
                || entry_identity(Path::new(&plan.previous_path))? != plan.observed_identity
            {
                return Err(operation_conflict("usage_change_preview_stale"));
            }
        }
        Ok(())
    }

    fn apply_subject_rename(
        &self,
        record: &mut OperationRecord,
        journal: &mut SubjectRenameJournal,
    ) -> AppResult<()> {
        let skill_id = journal.original_skill.id();
        let library = self.library_runtime.snapshot()?;
        if journal.new_version_id.is_none() {
            let staging = skillhub_core::LibraryPaths::from_root(library.root.clone())
                .tmp_dir
                .join(format!(
                    "subject-runtime-rename-{skill_id}-{}",
                    journal.request.operation_id
                ));
            if fs::symlink_metadata(&staging).is_ok() {
                return Err(operation_conflict("subject_rename_staging_path_occupied"));
            }
            journal.staging_path = Some(staging.to_string_lossy().into_owned());
            persist_subject_rename(self, record, journal, OperationPhase::Applying)?;
            fs::create_dir(&staging).map_err(subject_rename_io_error)?;
            let result = (|| -> AppResult<_> {
                library
                    .store
                    .materialize(&journal.previous_version_id, &staging)?;
                rename_skill_frontmatter(
                    &staging.join("SKILL.md"),
                    &journal
                        .prepared
                        .subject_rename
                        .as_ref()
                        .expect("rename preview")
                        .runtime_name,
                )?;
                let version = library.store.capture(skill_id, &staging)?;
                let target_hash = DeploymentFilesystem::hash_tree(&staging)?;
                self.with_database("subject_rename.record_version", |database| {
                    database.record_version(skill_id, &version)
                })?;
                Ok((version, target_hash))
            })();
            let cleanup = fs::remove_dir_all(&staging).map_err(subject_rename_io_error);
            if let Err(error) = cleanup {
                if result.is_ok() {
                    return Err(error);
                }
            }
            let (version, target_hash) = result?;
            journal.new_version_hash = Some(version.manifest.tree_hash.clone());
            journal.new_target_hash = Some(target_hash);
            journal.new_version_id = Some(version.id.clone());
            journal.staging_path = None;
            persist_subject_rename(self, record, journal, OperationPhase::Applying)?;
        }

        let new_version_id = journal
            .new_version_id
            .clone()
            .ok_or_else(|| operation_conflict("subject_rename_version_missing"))?;
        let new_hash = journal
            .new_target_hash
            .clone()
            .ok_or_else(|| operation_conflict("subject_rename_version_hash_missing"))?;
        let renamed_skill = renamed_skill(journal)?;
        if journal.visible_rename.is_none() {
            let previous_output = library.central.visible_skill_path(&journal.original_skill);
            let output = library.central.visible_skill_path(&renamed_skill);
            let backup = skillhub_core::LibraryPaths::from_root(library.root.clone())
                .tmp_dir
                .join(format!(
                    "visible-runtime-rename-{skill_id}-{}",
                    journal.request.operation_id
                ));
            journal.visible_rename = Some(VisibleSkillRename {
                skill_id,
                previous_output,
                output,
                backup,
                expected_tree_hash: journal
                    .new_version_hash
                    .clone()
                    .ok_or_else(|| operation_conflict("subject_rename_version_hash_missing"))?,
                expected_backup_tree_hash: journal.original_visible_hash.clone(),
            });
            persist_subject_rename(self, record, journal, OperationPhase::Applying)?;
        }
        let visible_rename = journal
            .visible_rename
            .clone()
            .ok_or_else(|| operation_conflict("subject_rename_visible_journal_missing"))?;
        if fs::symlink_metadata(&visible_rename.previous_output).is_ok()
            && fs::symlink_metadata(&visible_rename.backup).is_err()
        {
            library.central.prepare_visible_skill_rename_with_backup(
                &journal.original_skill,
                &renamed_skill,
                &new_version_id,
                &visible_rename.backup,
                &journal.original_visible_hash,
            )?;
        } else if fs::symlink_metadata(&visible_rename.output).is_err()
            || fs::symlink_metadata(&visible_rename.backup).is_err()
        {
            return Err(operation_conflict("subject_rename_visible_paths_changed"));
        }

        for index in 0..journal.plans.len() {
            let plan = journal.plans[index].clone();
            let previous = Path::new(&plan.previous_path);
            let destination = Path::new(&plan.path);
            let backup = Path::new(&plan.backup_path);
            let root = self.backend.target_root(&plan.original_deployment)?;
            if skillhub_core::physical_id_for_path(&root).as_deref()
                != Some(plan.target_root_identity.as_str())
            {
                return Err(operation_conflict("subject_rename_target_identity_changed"));
            }
            if fs::symlink_metadata(destination).is_err() && !plan.created_new_entry {
                match plan.mode {
                    DeploymentMode::ManagedCopy => {
                        super::copy_directory_tree(&visible_rename.output, destination)?;
                    }
                    DeploymentMode::SymbolicLink | DeploymentMode::DirectoryJunction => {
                        create_dir_link(&visible_rename.output, destination)?;
                    }
                }
                if DeploymentFilesystem::hash_tree(destination)? != new_hash {
                    return Err(operation_conflict(
                        "subject_rename_target_verification_failed",
                    ));
                }
                journal.plans[index].created_new_entry = true;
                persist_subject_rename(self, record, journal, OperationPhase::Applying)?;
            } else if fs::symlink_metadata(destination).is_ok() {
                if entry_fingerprint(destination)?.as_deref() != Some(new_hash.as_str()) {
                    return Err(operation_conflict("subject_rename_target_changed"));
                }
                journal.plans[index].created_new_entry = true;
            }
            if fs::symlink_metadata(backup).is_err() && !plan.moved_previous_entry {
                if entry_identity(previous)? != plan.observed_identity {
                    return Err(operation_conflict("subject_rename_target_identity_changed"));
                }
                if plan.mode == DeploymentMode::ManagedCopy
                    && entry_fingerprint(previous)?.as_deref() != plan.observed_before.as_deref()
                {
                    return Err(operation_conflict("subject_rename_target_changed"));
                }
                fs::rename(previous, backup).map_err(subject_rename_io_error)?;
                journal.plans[index].moved_previous_entry = true;
                persist_subject_rename(self, record, journal, OperationPhase::Applying)?;
            } else if fs::symlink_metadata(backup).is_ok() {
                if entry_identity(backup)? != plan.observed_identity {
                    return Err(operation_conflict("subject_rename_backup_changed"));
                }
                journal.plans[index].moved_previous_entry = true;
            }

            if !plan.deployment_record_updated {
                let mut updated = plan.original_deployment.clone();
                updated.runtime_name = plan.runtime_name.clone();
                updated.version_id = new_version_id.clone();
                updated.expected_hash = new_hash.clone();
                updated.observed_hash = Some(new_hash.clone());
                self.with_database("subject_rename.record_deployment", |database| {
                    database
                        .deployment_repository()
                        .rename_runtime_sync(&updated, &plan.previous_runtime_name)
                })?;
                journal.plans[index].deployment_record_updated = true;
                persist_subject_rename(self, record, journal, OperationPhase::Applying)?;
            }
        }

        if !journal.store_pointer_updated {
            library.store.set_current(skill_id, &new_version_id)?;
            journal.store_pointer_updated = true;
            persist_subject_rename(self, record, journal, OperationPhase::Applying)?;
        }
        if !journal.database_pointer_updated {
            let manifest = library.store.load_manifest(&new_version_id)?;
            let version = skillhub_core::VersionRecord {
                id: new_version_id,
                manifest,
            };
            self.with_database("subject_rename.record_current_version", |database| {
                database.record_current_version(skill_id, &version)
            })?;
            journal.database_pointer_updated = true;
            persist_subject_rename(self, record, journal, OperationPhase::Applying)?;
        }
        if !journal.portable_updated {
            library
                .central
                .save_portable_skill(&renamed_skill, journal.new_version_id.as_ref())?;
            journal.portable_updated = true;
            persist_subject_rename(self, record, journal, OperationPhase::Applying)?;
        }
        if !journal.catalog_updated {
            self.with_database("subject_rename.update_catalog", |database| {
                database.catalog_repository()?.insert_sync(&renamed_skill)
            })?;
            journal.catalog_updated = true;
            persist_subject_rename(self, record, journal, OperationPhase::Applying)?;
        }
        Ok(())
    }

    fn finish_subject_rename(
        &self,
        mut record: OperationRecord,
        mut journal: SubjectRenameJournal,
    ) -> AppResult<UsageChangeResult> {
        let result = (|| -> AppResult<UsageChangeResult> {
            let library = self.library_runtime.snapshot()?;
            let filesystem = DeploymentFilesystem::new();
            for index in 0..journal.plans.len() {
                if journal.plans[index].backup_finalized {
                    continue;
                }
                let plan = &journal.plans[index];
                let backup = Path::new(&plan.backup_path);
                if fs::symlink_metadata(backup).is_ok() {
                    if entry_identity(backup)? != plan.observed_identity {
                        return Err(operation_conflict("subject_rename_backup_changed"));
                    }
                    if plan.mode == DeploymentMode::ManagedCopy
                        && entry_fingerprint(backup)?.as_deref() != plan.observed_before.as_deref()
                    {
                        return Err(operation_conflict("subject_rename_backup_changed"));
                    }
                    filesystem.remove_residue(backup, plan.mode)?;
                }
                journal.plans[index].backup_finalized = true;
                persist_subject_rename(self, &mut record, &journal, OperationPhase::Applying)?;
            }
            if let Some(visible_rename) = journal.visible_rename.clone() {
                library
                    .central
                    .finalize_visible_skill_rename(visible_rename)?;
            }
            let result = subject_rename_result(&journal);
            record.result = Some(serde_json::to_value(&result).map_err(serialization_error)?);
            record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
            set_phase(
                &mut record,
                OperationPhase::Committed,
                journal.plans.len() as u32,
                journal.plans.len() as u32,
            );
            let database = self
                .database
                .lock()
                .map_err(|_| internal("subject_rename.finish.database"))?;
            database.operation_repository().update_sync(&record)?;
            Ok(result)
        })();
        match result {
            Ok(result) => Ok(result),
            Err(error) => self.mark_subject_rename_needs_recovery(record, journal, error),
        }
    }

    fn mark_subject_rename_needs_recovery<T>(
        &self,
        mut record: OperationRecord,
        journal: SubjectRenameJournal,
        error: AppError,
    ) -> AppResult<T> {
        record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
        record.error_code = Some(error.code);
        set_phase(
            &mut record,
            OperationPhase::NeedsRecovery,
            journal
                .plans
                .iter()
                .filter(|plan| plan.backup_finalized)
                .count() as u32,
            journal.plans.len() as u32,
        );
        let database = self
            .database
            .lock()
            .map_err(|_| internal("subject_rename.recovery.database"))?;
        database.operation_repository().update_sync(&record)?;
        Err(error)
    }

    fn fail_subject_rename(
        &self,
        mut record: OperationRecord,
        mut journal: SubjectRenameJournal,
        error: AppError,
    ) -> AppResult<UsageChangeResult> {
        let rollback = rollback_subject_rename_state(self, &mut journal);
        record.error_code = Some(error.code);
        record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
        set_phase(
            &mut record,
            if rollback.is_ok() {
                OperationPhase::RolledBack
            } else {
                OperationPhase::NeedsRecovery
            },
            journal.plans.len() as u32,
            journal.plans.len() as u32,
        );
        let database = self
            .database
            .lock()
            .map_err(|_| internal("subject_rename.fail.database"))?;
        database.operation_repository().update_sync(&record)?;
        match rollback {
            Ok(()) => Err(error),
            Err(_) => Err(
                operation_conflict("subject_rename_rollback_incomplete").with_param(
                    "original_reason",
                    error
                        .params
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("subject_rename_failed"),
                ),
            ),
        }
    }

    pub(crate) async fn resolve_subject_rename_recovery(
        &self,
        operation_id: OperationId,
        action: RecoveryAction,
    ) -> AppResult<bool> {
        let _mutation = self
            .relation_migration_lock
            .lock()
            .map_err(|_| internal("subject_rename.recovery.mutation_lock"))?;
        let (mut record, mut journal) = {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("subject_rename.recovery.database"))?;
            let Some(record) = database.operation_repository().get_sync(operation_id)? else {
                return Ok(false);
            };
            if record.kind != SUBJECT_RENAME_KIND {
                return Ok(false);
            }
            let journal: SubjectRenameJournal =
                serde_json::from_value(record.recovery_data.clone())
                    .map_err(|_| operation_conflict("subject_rename_journal_invalid"))?;
            (record, journal)
        };
        match action {
            RecoveryAction::RollbackOperation if !journal.metadata_committed => {
                rollback_subject_rename_state(self, &mut journal)?;
                record.recovery_data =
                    serde_json::to_value(&journal).map_err(serialization_error)?;
                set_phase(
                    &mut record,
                    OperationPhase::RolledBack,
                    journal.plans.len() as u32,
                    journal.plans.len() as u32,
                );
            }
            RecoveryAction::CompleteOperation if journal.metadata_committed => {
                self.finish_subject_rename(record, journal)?;
                return Ok(true);
            }
            RecoveryAction::RollbackOperation => {
                return Err(operation_conflict("subject_rename_cleanup_must_complete"));
            }
            RecoveryAction::CompleteOperation => {
                return Err(operation_conflict("subject_rename_rollback_required"));
            }
            _ => {
                return Err(operation_conflict(
                    "subject_rename.recovery_action_unsupported",
                ))
            }
        }
        let database = self
            .database
            .lock()
            .map_err(|_| internal("subject_rename.recovery.database"))?;
        database.operation_repository().update_sync(&record)?;
        Ok(true)
    }

    pub(crate) async fn commit_usage_change_command(
        &self,
        request: CommitUsageChange,
    ) -> AppResult<UsageChangeResult> {
        let kind = self
            .database
            .lock()
            .map_err(|_| internal("usage_change.commit.database"))?
            .operation_repository()
            .get_sync(request.operation_id)?
            .map(|record| record.kind);
        match kind.as_deref() {
            Some(SHARED_USAGE_MIGRATION_KIND) => self.commit_shared_usage_migration(request).await,
            Some(SUBJECT_RENAME_KIND) => self.commit_subject_rename(request).await,
            _ => self.commit_usage_change(request),
        }
    }

    pub(crate) async fn resolve_shared_usage_migration_recovery(
        &self,
        operation_id: OperationId,
        action: RecoveryAction,
    ) -> AppResult<bool> {
        let prepared_id = {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("shared_usage_migration.recovery.database"))?;
            let Some(record) = database.operation_repository().get_sync(operation_id)? else {
                return Ok(false);
            };
            if record.kind != SHARED_USAGE_MIGRATION_KIND {
                return Ok(false);
            }
            if action != RecoveryAction::CompleteOperation {
                return Err(operation_conflict(
                    "shared_usage_migration_rollback_unsupported",
                ));
            }
            let journal: SharedUsageMigrationJournal = serde_json::from_value(record.recovery_data)
                .map_err(|_| operation_conflict("shared_usage_migration_journal_invalid"))?;
            journal.prepared.prepared_id
        };
        let result = self
            .commit_shared_usage_migration(CommitUsageChange {
                operation_id,
                prepared_id,
            })
            .await?;
        if result.recovery_required {
            return Err(operation_conflict(
                "shared_usage_migration_recovery_incomplete",
            ));
        }
        Ok(true)
    }

    async fn commit_shared_usage_migration(
        &self,
        request: CommitUsageChange,
    ) -> AppResult<UsageChangeResult> {
        let (mut record, mut journal) = {
            let _mutation = self
                .relation_migration_lock
                .lock()
                .map_err(|_| internal("shared_usage_migration.commit.mutation_lock"))?;
            let database = self
                .database
                .lock()
                .map_err(|_| internal("shared_usage_migration.commit.database"))?;
            let mut record = database
                .operation_repository()
                .get_sync(request.operation_id)?
                .ok_or_else(|| operation_conflict("shared_usage_migration_preview_missing"))?;
            if record.kind != SHARED_USAGE_MIGRATION_KIND {
                return Err(operation_conflict("operation_id_reused"));
            }
            let journal: SharedUsageMigrationJournal =
                serde_json::from_value(record.recovery_data.clone())
                    .map_err(|_| operation_conflict("shared_usage_migration_journal_invalid"))?;
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
            if !matches!(
                record.phase,
                OperationPhase::Prepared | OperationPhase::NeedsRecovery
            ) {
                return Err(operation_conflict(
                    "shared_usage_migration_already_applying",
                ));
            }
            drop(database);
            if record.phase == OperationPhase::Prepared {
                let fresh = build_shared_usage_migration_journal(
                    self,
                    journal.request.clone(),
                    journal.prepared.prepared_id,
                )?;
                if fresh.prepared != journal.prepared
                    || fresh.source != journal.source
                    || fresh.replacements != journal.replacements
                {
                    return Err(operation_conflict("usage_change_preview_stale"));
                }
            }
            persist_shared_migration(self, &mut record, &journal, OperationPhase::Applying)?;
            (record, journal)
        };

        let library = self.library_runtime.snapshot()?;
        let mut index = 0;
        while index < journal.replacements.len() {
            if journal.replacements[index].verified {
                if let Some(proof) = journal.replacements[index].reused_entry.as_ref() {
                    if verify_shared_migration_proof(proof, &library.store).is_err() {
                        return self.fail_shared_migration(
                            &mut record,
                            &mut journal,
                            index,
                            operation_conflict("shared_usage_migration_replacement_changed"),
                        );
                    }
                }
                index += 1;
                continue;
            }

            if let Some(proof) = journal.replacements[index].reused_entry.clone() {
                if let Err(error) = verify_shared_migration_proof(&proof, &library.store) {
                    return self.fail_shared_migration(&mut record, &mut journal, index, error);
                }
                journal.replacements[index].verified = true;
                self.upsert_shared_migration_result(
                    &mut journal,
                    index,
                    UsageChangeItemStatus::Applied,
                    None,
                );
                persist_shared_migration(self, &mut record, &journal, OperationPhase::Applying)?;
                index += 1;
                continue;
            }

            if self
                .verify_shared_migration_deployment(&journal.replacements[index], &journal.source)
                .is_ok()
            {
                journal.replacements[index].verified = true;
                self.upsert_shared_migration_result(
                    &mut journal,
                    index,
                    UsageChangeItemStatus::Applied,
                    None,
                );
                persist_shared_migration(self, &mut record, &journal, OperationPhase::Applying)?;
                index += 1;
                continue;
            }

            let mut child_operation_id = journal.replacements[index].child_operation_id;
            if let Some(child_id) = child_operation_id {
                let child = self
                    .database
                    .lock()
                    .map_err(|_| internal("shared_usage_migration.child.database"))?
                    .operation_repository()
                    .get_sync(child_id)?;
                match child.map(|record| record.phase) {
                    Some(OperationPhase::NeedsRecovery) => {
                        return self.fail_shared_migration(
                            &mut record,
                            &mut journal,
                            index,
                            operation_conflict("shared_usage_migration_child_needs_recovery"),
                        );
                    }
                    Some(OperationPhase::Committed) => {
                        return self.fail_shared_migration(
                            &mut record,
                            &mut journal,
                            index,
                            operation_conflict("shared_usage_migration_replacement_unverified"),
                        );
                    }
                    Some(OperationPhase::Planned) => {
                        child_operation_id = None;
                        journal.replacements[index].child_operation_id = None;
                        persist_shared_migration(
                            self,
                            &mut record,
                            &journal,
                            OperationPhase::Applying,
                        )?;
                    }
                    Some(
                        OperationPhase::Prepared
                        | OperationPhase::Applying
                        | OperationPhase::Verifying,
                    ) => {}
                    Some(OperationPhase::RolledBack) | None => {
                        child_operation_id = None;
                        journal.replacements[index].child_operation_id = None;
                        persist_shared_migration(
                            self,
                            &mut record,
                            &journal,
                            OperationPhase::Applying,
                        )?;
                    }
                }
            }

            if child_operation_id.is_none() {
                let plan = journal.replacements[index]
                    .deployment_plan
                    .clone()
                    .ok_or_else(|| operation_conflict("shared_usage_migration_plan_missing"))?;
                let prepared = match self.prepare_deployment(plan).await? {
                    AppCommandResult::PreparedDeployment(prepared) => prepared,
                    _ => return Err(internal("shared_usage_migration.deployment_prepare")),
                };
                child_operation_id = Some(prepared.id);
                journal.replacements[index].child_operation_id = child_operation_id;
                persist_shared_migration(self, &mut record, &journal, OperationPhase::Applying)?;
            }

            let child_id = child_operation_id.expect("prepared deployment id");
            match self.commit_deployment(child_id).await {
                Ok(AppCommandResult::DeploymentSummary(summary)) if summary.committed => {
                    if let Err(error) = self.verify_shared_migration_deployment(
                        &journal.replacements[index],
                        &journal.source,
                    ) {
                        return self.fail_shared_migration(&mut record, &mut journal, index, error);
                    }
                    journal.replacements[index].verified = true;
                    self.upsert_shared_migration_result(
                        &mut journal,
                        index,
                        UsageChangeItemStatus::Applied,
                        None,
                    );
                    persist_shared_migration(
                        self,
                        &mut record,
                        &journal,
                        OperationPhase::Applying,
                    )?;
                }
                Ok(AppCommandResult::DeploymentSummary(summary)) => {
                    let residue = summary.targets.iter().any(|target| target.residue);
                    let reason = summary
                        .targets
                        .iter()
                        .find_map(|target| target.error_code.clone())
                        .unwrap_or_else(|| "shared_usage_migration_target_failed".to_owned());
                    if !residue {
                        journal.replacements[index].child_operation_id = None;
                    }
                    return self.fail_shared_migration(
                        &mut record,
                        &mut journal,
                        index,
                        operation_conflict(&reason),
                    );
                }
                Ok(_) => {
                    return self.fail_shared_migration(
                        &mut record,
                        &mut journal,
                        index,
                        internal("shared_usage_migration.deployment_result"),
                    );
                }
                Err(error) => {
                    journal.replacements[index].child_operation_id = None;
                    return self.fail_shared_migration(&mut record, &mut journal, index, error);
                }
            }
            index += 1;
        }

        if journal
            .replacements
            .iter()
            .any(|replacement| !replacement.verified)
        {
            return Err(operation_conflict(
                "shared_usage_migration_replacements_incomplete",
            ));
        }
        if let Err(error) = self.remove_shared_migration_source(&mut record, &mut journal) {
            let failed_index = journal.replacements.len();
            return self.fail_shared_migration(&mut record, &mut journal, failed_index, error);
        }
        self.rescan_shared_migration_source(&journal.source)?;
        let result = UsageChangeResult {
            operation_id: journal.prepared.operation_id,
            prepared_id: journal.prepared.prepared_id,
            recovery_required: false,
            item_results: journal.completed.clone(),
            derived_skill_id: None,
            recovery_operation_id: None,
        };
        record.result = Some(serde_json::to_value(&result).map_err(serialization_error)?);
        persist_shared_migration(self, &mut record, &journal, OperationPhase::Committed)?;
        Ok(result)
    }

    fn verify_shared_migration_deployment(
        &self,
        replacement: &SharedUsageMigrationReplacementPlan,
        source: &SharedUsageMigrationSource,
    ) -> AppResult<SharedUsageMigrationProof> {
        let plan = replacement
            .deployment_plan
            .as_ref()
            .ok_or_else(|| operation_conflict("shared_usage_migration_plan_missing"))?;
        let target_plan = plan
            .targets
            .first()
            .filter(|_| plan.targets.len() == 1)
            .ok_or_else(|| operation_conflict("shared_usage_migration_plan_invalid"))?;
        let destination = PathBuf::from(
            replacement
                .destination_path
                .as_deref()
                .ok_or_else(|| operation_conflict("shared_usage_migration_destination_missing"))?,
        );
        let library = self.library_runtime.snapshot()?;
        let deployment_fingerprint = DeploymentFilesystem::hash_tree(&destination)?;
        let proof = verify_shared_migration_path(
            &destination,
            &source.fingerprint,
            &replacement.target,
            &plan.runtime_name,
            &library.store,
        )?;
        let deployments = self
            .database
            .lock()
            .map_err(|_| internal("shared_usage_migration.verify.database"))?
            .deployment_repository()
            .list_all()?;
        if !deployments.iter().any(|deployment| {
            deployment.skill_id == source.skill_id
                && deployment.version_id == plan.version_id
                && deployment.target_id == target_plan.physical_target_id
                && deployment.runtime_name == plan.runtime_name
                && deployment.expected_hash == deployment_fingerprint
                && deployment.observed_hash.as_deref() == Some(deployment_fingerprint.as_str())
                && deployment.managed
                && deployment.state == skillhub_core::DeploymentState::Deployed
        }) {
            return Err(operation_conflict(
                "shared_usage_migration_deployment_evidence_missing",
            ));
        }
        Ok(proof)
    }

    fn remove_shared_migration_source(
        &self,
        record: &mut OperationRecord,
        journal: &mut SharedUsageMigrationJournal,
    ) -> AppResult<()> {
        let library = self.library_runtime.snapshot()?;
        if journal.source.removed && journal.source.decision_recorded {
            self.verify_shared_migration_backup(journal, &library.store)?;
            return Ok(());
        }
        let source_path = PathBuf::from(&journal.source.source_path);
        if !journal.source.removed {
            verify_shared_migration_source(&journal.source, &library.store)?;
        }
        self.verify_shared_migration_backup_anchor(journal)?;
        if !journal.source.backup_created {
            if fs::symlink_metadata(&journal.source.backup_path).is_ok() {
                verify_shared_migration_backup_path(
                    journal,
                    &self.verify_shared_migration_backup_anchor(journal)?,
                )?;
                self.verify_shared_migration_backup(journal, &library.store)?;
            } else {
                verify_shared_migration_backup_path(
                    journal,
                    &self.verify_shared_migration_backup_anchor(journal)?,
                )?;
                backup_entry(&source_path, Path::new(&journal.source.backup_path))?;
            }
            journal.source.backup_created = true;
            persist_shared_migration(self, record, journal, OperationPhase::Applying)?;
        } else {
            self.verify_shared_migration_backup(journal, &library.store)?;
        }
        if !journal.source.removed {
            journal.source.removal_started = true;
            persist_shared_migration(self, record, journal, OperationPhase::Applying)?;
        }
        if !journal.source.removed && fs::symlink_metadata(&source_path).is_ok() {
            if let Err(remove_error) = remove_plain_entry(&source_path) {
                let restore = restore_shared_migration_source(journal, &library.store);
                journal.source.removal_started = false;
                journal.source.removed = false;
                persist_shared_migration(self, record, journal, OperationPhase::NeedsRecovery)?;
                return Err(restore.err().unwrap_or(remove_error));
            }
        }
        if !journal.source.removed {
            if fs::symlink_metadata(&source_path).is_ok() {
                return Err(operation_conflict(
                    "shared_usage_migration_source_still_exists",
                ));
            }
            journal.source.removed = true;
            persist_shared_migration(self, record, journal, OperationPhase::Applying)?;
        }

        let decision = UsageDecisionRecord {
            decision_id: format!("shared-usage-migration:{}", journal.prepared.operation_id),
            skill_id: journal.source.skill_id,
            entry_key: journal.source.entry_key.clone(),
            relation_ids: journal.source.relation_ids.clone(),
            physical_source_ids: journal.prepared.entry_evidence[0]
                .physical_source_ids
                .clone(),
            decision: UsageDecision::Released,
            content_fingerprint: Some(journal.source.fingerprint.clone()),
            decided_at: super::now_epoch_seconds(),
            operation_id: Some(journal.prepared.operation_id.to_string()),
        };
        let decision_result = self
            .database
            .lock()
            .map_err(|_| internal("shared_usage_migration.decision.database"))?
            .record_usage_decision_with_expected_evidence_fingerprints(
                &decision,
                &journal.source.expected_evidence_fingerprints,
            );
        if let Err(error) = decision_result {
            let restore = restore_shared_migration_source(journal, &library.store);
            journal.source.removal_started = false;
            journal.source.removed = false;
            persist_shared_migration(self, record, journal, OperationPhase::NeedsRecovery)?;
            return Err(restore.err().unwrap_or(error));
        }
        journal.source.decision_recorded = true;
        let result_item = UsageChangeItemResult {
            relation_ids: journal.source.relation_ids.clone(),
            skill_id: journal.source.skill_id,
            target: journal.prepared.impacts[0].target.clone(),
            action: UsageChangeImpactAction::RemoveCopyWithBackup,
            status: UsageChangeItemStatus::Applied,
            reason: None,
            recovery_point: Some(UsageRecoveryPoint {
                path: journal.source.backup_path.clone(),
                fingerprint: Some(journal.source.fingerprint.clone()),
                representation: FileRepresentation::Copy,
            }),
        };
        journal
            .completed
            .retain(|item| item.action != UsageChangeImpactAction::RemoveCopyWithBackup);
        journal.completed.push(result_item);
        persist_shared_migration(self, record, journal, OperationPhase::Applying)
    }

    fn verify_shared_migration_backup_anchor(
        &self,
        journal: &SharedUsageMigrationJournal,
    ) -> AppResult<PathBuf> {
        let anchor = journal
            .backup_anchor_chain
            .nodes
            .first()
            .map(|node| PathBuf::from(&node.path))
            .ok_or_else(|| operation_conflict("usage_backup_anchor_unverified"))?;
        let metadata = fs::symlink_metadata(&anchor)
            .map_err(|_| operation_conflict("usage_backup_anchor_identity_changed"))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || capture_path_chain(&anchor)? != journal.backup_anchor_chain
            || anchor.file_name().and_then(|name| name.to_str()) != Some(".skillhub")
        {
            return Err(operation_conflict("usage_backup_anchor_identity_changed"));
        }
        Ok(anchor)
    }

    fn verify_shared_migration_backup(
        &self,
        journal: &SharedUsageMigrationJournal,
        store: &VersionStore,
    ) -> AppResult<()> {
        let backup = Path::new(&journal.source.backup_path);
        let metadata = fs::symlink_metadata(backup)
            .map_err(|_| operation_conflict("shared_usage_migration_backup_missing"))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || store.hash_tree_read_only(backup)? != journal.source.fingerprint
        {
            return Err(operation_conflict("shared_usage_migration_backup_invalid"));
        }
        Ok(())
    }

    fn rescan_shared_migration_source(&self, source: &SharedUsageMigrationSource) -> AppResult<()> {
        let (_, snapshots) = self.scan_usage_environment_state()?;
        if snapshots
            .iter()
            .flat_map(|snapshot| &snapshot.discovered_entries)
            .any(|entry| usage_entry_key(entry) == source.entry_key)
        {
            return Err(operation_conflict(
                "shared_usage_migration_source_rescan_failed",
            ));
        }
        Ok(())
    }

    fn upsert_shared_migration_result(
        &self,
        journal: &mut SharedUsageMigrationJournal,
        index: usize,
        status: UsageChangeItemStatus,
        reason: Option<String>,
    ) {
        let replacement = &journal.replacements[index];
        let result = UsageChangeItemResult {
            relation_ids: Vec::new(),
            skill_id: journal.source.skill_id,
            target: replacement.target.clone(),
            action: UsageChangeImpactAction::RecordOnly,
            status,
            reason,
            recovery_point: None,
        };
        journal.completed.retain(|item| {
            !(item.action == UsageChangeImpactAction::RecordOnly && item.target == result.target)
        });
        journal.completed.push(result);
    }

    fn fail_shared_migration(
        &self,
        record: &mut OperationRecord,
        journal: &mut SharedUsageMigrationJournal,
        index: usize,
        error: AppError,
    ) -> AppResult<UsageChangeResult> {
        let recovery_required = true;
        if index < journal.replacements.len() {
            self.upsert_shared_migration_result(
                journal,
                index,
                UsageChangeItemStatus::RecoveryRequired,
                error
                    .params
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| Some(error.code.as_str().to_owned())),
            );
        } else {
            let impact = journal
                .prepared
                .impacts
                .first()
                .ok_or_else(|| operation_conflict("shared_usage_migration_impact_missing"))?;
            journal
                .completed
                .retain(|item| item.action != UsageChangeImpactAction::RemoveCopyWithBackup);
            journal.completed.push(UsageChangeItemResult {
                relation_ids: impact.relation_ids.clone(),
                skill_id: impact.skill_id,
                target: impact.target.clone(),
                action: impact.action,
                status: UsageChangeItemStatus::RecoveryRequired,
                reason: Some(error.code.as_str().to_owned()),
                recovery_point: Some(UsageRecoveryPoint {
                    path: journal.source.backup_path.clone(),
                    fingerprint: Some(journal.source.fingerprint.clone()),
                    representation: FileRepresentation::Copy,
                }),
            });
        }
        record.error_code = Some(error.code);
        persist_shared_migration(self, record, journal, OperationPhase::NeedsRecovery)?;
        Ok(UsageChangeResult {
            operation_id: journal.prepared.operation_id,
            prepared_id: journal.prepared.prepared_id,
            recovery_required,
            item_results: journal.completed.clone(),
            derived_skill_id: None,
            recovery_operation_id: None,
        })
    }

    fn commit_managed_usage_change(
        &self,
        request: CommitUsageChange,
    ) -> AppResult<UsageChangeResult> {
        let _mutation = self
            .relation_migration_lock
            .lock()
            .map_err(|_| internal("managed_usage_change.commit.mutation_lock"))?;
        let (mut record, mut journal) = {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("managed_usage_change.commit.database"))?;
            let record = database
                .operation_repository()
                .get_sync(request.operation_id)?
                .ok_or_else(|| operation_conflict("managed_usage_change_preview_missing"))?;
            if record.kind != MANAGED_USAGE_CHANGE_KIND {
                return Err(operation_conflict("operation_id_reused"));
            }
            let journal: ManagedUsageChangeJournal =
                serde_json::from_value(record.recovery_data.clone())
                    .map_err(|_| operation_conflict("managed_usage_change_journal_invalid"))?;
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

        let (current_revision, current_deployments) =
            self.with_database("managed_usage_change.commit.snapshot", |database| {
                Ok((
                    database.relationship_repository().relationship_revision()?,
                    database.deployment_repository().list_all()?,
                ))
            })?;
        if current_revision.to_string() != journal.prepared.relationship_revision {
            return Err(operation_conflict("usage_change_preview_stale"));
        }
        for plan in &journal.plans {
            let deployment = current_deployments
                .iter()
                .find(|deployment| deployment.id == plan.deployment_id)
                .filter(|deployment| {
                    deployment.managed
                        && deployment.state == skillhub_core::DeploymentState::Deployed
                })
                .ok_or_else(|| operation_conflict("usage_change_preview_stale"))?;
            let target_root = self.backend.target_root(deployment)?;
            if skillhub_core::physical_id_for_path(&target_root).as_deref()
                != Some(deployment.target_id.as_str())
            {
                return Err(operation_conflict("usage_change_preview_stale"));
            }
            let destination = target_root.join(&deployment.runtime_name);
            let current_hash = entry_fingerprint(&destination)?;
            let current_identity = entry_identity(&destination)?;
            if current_hash != plan.observed_before || current_identity != plan.observed_identity {
                return Err(operation_conflict("usage_change_preview_stale"));
            }
            match journal.request.action {
                UsageChangeAction::Restore if current_hash.is_some() => {
                    return Err(operation_conflict("usage_change_preview_stale"));
                }
                UsageChangeAction::Sync
                | UsageChangeAction::Repair
                | UsageChangeAction::Restore => {}
                UsageChangeAction::Release
                | UsageChangeAction::Manage
                | UsageChangeAction::ResolveDuplicate
                | UsageChangeAction::MigrateSharedUsage => unreachable!(),
                UsageChangeAction::RenameSubject => unreachable!(),
                UsageChangeAction::DeriveAndReplace => unreachable!(),
            }
        }

        set_phase(
            &mut record,
            OperationPhase::Applying,
            0,
            journal.plans.len() as u32,
        );
        record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
        self.with_database("managed_usage_change.commit.start", |database| {
            database.operation_repository().update_sync(&record)
        })?;

        for index in 0..journal.plans.len() {
            let outcome = self.apply_managed_usage_change_plan(
                request.operation_id,
                journal.request.action,
                journal.request.content_basis,
                &mut journal.plans[index],
            );
            let plan = &journal.plans[index];
            let impact = journal
                .prepared
                .impacts
                .iter()
                .find(|impact| {
                    impact
                        .relation_ids
                        .first()
                        .is_some_and(|id| id == &format!("managed:{}", plan.deployment_id))
                })
                .ok_or_else(|| operation_conflict("managed_usage_change_impact_missing"))?;
            let mut item = match outcome {
                Ok(()) => UsageChangeItemResult {
                    relation_ids: impact.relation_ids.clone(),
                    skill_id: impact.skill_id,
                    target: impact.target.clone(),
                    action: impact.action,
                    status: UsageChangeItemStatus::Applied,
                    reason: None,
                    recovery_point: (journal.request.action == UsageChangeAction::Repair
                        || journal.plans[index].backup_created)
                        .then(|| UsageRecoveryPoint {
                            path: journal.plans[index].backup_path.clone(),
                            fingerprint: journal.plans[index].observed_before.clone(),
                            representation: journal.prepared.entry_evidence[index].representation,
                        }),
                },
                Err((error, recovery_required)) => UsageChangeItemResult {
                    relation_ids: impact.relation_ids.clone(),
                    skill_id: impact.skill_id,
                    target: impact.target.clone(),
                    action: impact.action,
                    status: if recovery_required {
                        UsageChangeItemStatus::RecoveryRequired
                    } else {
                        UsageChangeItemStatus::Failed
                    },
                    reason: error
                        .params
                        .get("reason")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .or_else(|| Some(error.code.as_str().to_owned())),
                    recovery_point: journal.plans[index].backup_created.then(|| {
                        UsageRecoveryPoint {
                            path: journal.plans[index].backup_path.clone(),
                            fingerprint: journal.plans[index].observed_before.clone(),
                            representation: journal.prepared.entry_evidence[index].representation,
                        }
                    }),
                },
            };
            if item.status != UsageChangeItemStatus::Applied {
                let failure_recorded =
                    self.with_database("managed_usage_change.commit.record_failure", |database| {
                        database
                            .deployment_repository()
                            .mark_managed_usage_change_failed(journal.plans[index].deployment_id)
                    });
                if let Err(error) = failure_recorded {
                    item.status = UsageChangeItemStatus::RecoveryRequired;
                    item.reason = Some(format!(
                        "usage_change_failure_fact_unrecorded:{}",
                        error.code.as_str()
                    ));
                }
            }
            journal.completed.push(item);
            record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
            set_phase(
                &mut record,
                OperationPhase::Applying,
                journal.completed.len() as u32,
                journal.plans.len() as u32,
            );
            self.with_database("managed_usage_change.commit.progress", |database| {
                database.operation_repository().update_sync(&record)
            })?;
        }
        let result = UsageChangeResult {
            operation_id: journal.prepared.operation_id,
            prepared_id: journal.prepared.prepared_id,
            recovery_required: journal
                .completed
                .iter()
                .any(|item| item.status == UsageChangeItemStatus::RecoveryRequired),
            item_results: journal.completed.clone(),
            derived_skill_id: None,
            recovery_operation_id: None,
        };
        set_phase(
            &mut record,
            if result.recovery_required {
                OperationPhase::NeedsRecovery
            } else {
                OperationPhase::Committed
            },
            journal.completed.len() as u32,
            journal.plans.len() as u32,
        );
        record.result = Some(serde_json::to_value(&result).map_err(serialization_error)?);
        record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
        self.with_database("managed_usage_change.commit.finish", |database| {
            database.operation_repository().update_sync(&record)
        })?;
        Ok(result)
    }

    fn apply_managed_usage_change_plan(
        &self,
        operation_id: OperationId,
        action: UsageChangeAction,
        content_basis: Option<UsageContentBasis>,
        plan: &mut ManagedUsageChangePlan,
    ) -> Result<(), (AppError, bool)> {
        let deployment = self
            .with_database("managed_usage_change.apply.deployment", |database| {
                database
                    .deployment_repository()
                    .list_all()?
                    .into_iter()
                    .find(|record| record.id == plan.deployment_id)
                    .ok_or_else(|| operation_conflict("managed_usage_change_relation_missing"))
            })
            .map_err(|error| (error, false))?;
        let destination = PathBuf::from(&plan.destination);
        let source_plan = managed_target_plan(
            &self.backend,
            &deployment,
            &plan.subject_version_id,
            &destination,
        )
        .map_err(|error| (error, false))?;
        let source_path = PathBuf::from(&source_plan.source_path);
        let filesystem = DeploymentFilesystem::new();

        if action == UsageChangeAction::Sync && deployment.mode.is_directory_link() {
            let proof = self
                .backend
                .deployment_proof(&deployment)
                .map_err(|error| (error, false))?;
            filesystem
                .verify_ownership(&proof)
                .map_err(|error| (error, false))?;
            let current_target = fs::canonicalize(&destination).map_err(|error| {
                (
                    operation_conflict_with("usage_sync_link_unavailable", error.to_string()),
                    false,
                )
            })?;
            let expected_target = fs::canonicalize(&source_path).map_err(|error| {
                (
                    operation_conflict_with("usage_sync_source_unavailable", error.to_string()),
                    false,
                )
            })?;
            if current_target != expected_target {
                return Err((operation_conflict("usage_sync_link_requires_repair"), false));
            }
            let expected =
                DeploymentFilesystem::hash_tree(&source_path).map_err(|error| (error, false))?;
            let observed =
                DeploymentFilesystem::hash_tree(&destination).map_err(|error| (error, false))?;
            if observed != expected {
                return Err((
                    operation_conflict("usage_sync_link_content_mismatch"),
                    false,
                ));
            }
            let recorded = self
                .with_database("managed_usage_change.apply.link", |database| {
                    database
                        .deployment_repository()
                        .update_reconcile_facts_sync(
                            deployment.id,
                            &plan.subject_version_id,
                            &expected,
                            Some(&observed),
                        )
                })
                .map_err(|error| (error, false));
            return recorded;
        }

        let mut backup_ready = false;
        if action == UsageChangeAction::Sync && deployment.mode == DeploymentMode::ManagedCopy {
            let observed =
                DeploymentFilesystem::hash_tree(&destination).map_err(|error| (error, false))?;
            if observed != deployment.expected_hash
                && content_basis != Some(UsageContentBasis::LibraryCurrent)
            {
                return Err((
                    operation_conflict("usage_sync_content_choice_required"),
                    false,
                ));
            }
            backup_entry(&destination, Path::new(&plan.backup_path))
                .map_err(|error| (error, false))?;
            plan.backup_created = true;
            self.persist_managed_usage_change_backup(operation_id, plan)
                .map_err(|error| (error, false))?;
            backup_ready = true;
            let proof = self
                .backend
                .deployment_proof(&deployment)
                .map_err(|error| (error, false))?;
            if let Err(error) = filesystem.replace_owned(&proof) {
                return Err((error, false));
            }
        } else if action == UsageChangeAction::Repair {
            let metadata = fs::symlink_metadata(&destination).map_err(|error| {
                (
                    operation_conflict_with("usage_repair_target_changed", error.to_string()),
                    false,
                )
            })?;
            if metadata.file_type().is_symlink()
                || DeploymentFilesystem::is_directory_link_entry(&destination)
            {
                return Err((
                    operation_conflict("usage_repair_link_replacement_unsupported"),
                    false,
                ));
            }
            if let Ok(proof) = self.backend.deployment_proof(&deployment) {
                if filesystem.verify_ownership(&proof).is_ok() {
                    return Err((
                        operation_conflict("usage_repair_target_already_healthy"),
                        false,
                    ));
                }
            }
            backup_entry(&destination, Path::new(&plan.backup_path))
                .map_err(|error| (error, false))?;
            plan.backup_created = true;
            self.persist_managed_usage_change_backup(operation_id, plan)
                .map_err(|error| (error, false))?;
            backup_ready = true;
            remove_plain_entry(&destination).map_err(|error| (error, false))?;
        } else if action == UsageChangeAction::Sync {
            let proof = self
                .backend
                .deployment_proof(&deployment)
                .map_err(|error| (error, false))?;
            if let Err(error) = filesystem.replace_owned(&proof) {
                return Err((error, false));
            }
        }

        let applied = (|| -> AppResult<String> {
            let effective = source_plan;
            let prepared = filesystem.prepare(&effective)?;
            let applied = filesystem.apply(prepared)?;
            filesystem.verify(&applied)?;
            Ok(applied.observed_tree_hash)
        })();
        match applied {
            Ok(observed) => self
                .with_database("managed_usage_change.apply.record", |database| {
                    database
                        .deployment_repository()
                        .update_reconcile_facts_sync(
                            deployment.id,
                            &plan.subject_version_id,
                            &observed,
                            Some(&observed),
                        )
                })
                .map_err(|error| {
                    if backup_ready {
                        (error, true)
                    } else {
                        (error, false)
                    }
                }),
            Err(error) => {
                let restore = if backup_ready {
                    remove_created_entry(&filesystem, &destination, deployment.mode)
                        .and_then(|()| restore_entry(Path::new(&plan.backup_path), &destination))
                } else if fs::symlink_metadata(&destination).is_ok() {
                    remove_created_entry(&filesystem, &destination, deployment.mode)
                } else {
                    Ok(())
                };
                if let Err(restore_error) = restore {
                    Err((
                        operation_conflict_with(
                            "usage_change_restore_unverified",
                            restore_error.to_string(),
                        ),
                        true,
                    ))
                } else {
                    Err((error, false))
                }
            }
        }
    }

    fn persist_managed_usage_change_backup(
        &self,
        operation_id: OperationId,
        plan: &ManagedUsageChangePlan,
    ) -> AppResult<()> {
        self.with_database("managed_usage_change.persist_backup", |database| {
            let mut record = database
                .operation_repository()
                .get_sync(operation_id)?
                .ok_or_else(|| operation_conflict("managed_usage_change_preview_missing"))?;
            let mut journal: ManagedUsageChangeJournal =
                serde_json::from_value(record.recovery_data.clone())
                    .map_err(|_| operation_conflict("managed_usage_change_journal_invalid"))?;
            let stored = journal
                .plans
                .iter_mut()
                .find(|stored| stored.deployment_id == plan.deployment_id)
                .ok_or_else(|| operation_conflict("managed_usage_change_relation_missing"))?;
            stored.backup_created = true;
            record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
            database.operation_repository().update_sync(&record)
        })
    }

    fn commit_usage_manage(&self, request: CommitUsageChange) -> AppResult<UsageChangeResult> {
        let preview = self
            .usage_manage_preview(request.operation_id)?
            .ok_or_else(|| operation_conflict("usage_manage_preview_missing"))?;
        if preview.operation_id != request.operation_id
            || preview.prepared_id != request.prepared_id
            || preview.action != UsageChangeAction::Manage
        {
            return Err(operation_conflict("usage_change_preview_mismatch"));
        }
        if let Some(result) = self.usage_manage_result(request.operation_id)? {
            return Ok(result);
        }
        let library = self.library_runtime.snapshot()?;
        for subject in &preview.subject_versions {
            if library.current(subject.skill_id)? != subject.version_id {
                return Err(operation_conflict("usage_change_preview_stale"));
            }
        }
        let current_revision = self
            .database
            .lock()
            .map_err(|_| internal("usage_manage.commit.revision"))?
            .relationship_repository()
            .relationship_revision()?;
        if current_revision.to_string() != preview.relationship_revision {
            return Err(operation_conflict("usage_change_preview_stale"));
        }
        let migration = self.commit_relation_migration(CommitRelationMigration {
            prepared_relation_migration_id: request.operation_id,
        })?;
        let AppCommandResult::RelationMigrationResult(migration) = migration else {
            return Err(operation_conflict("usage_manage_result_invalid"));
        };
        let impact = preview
            .impacts
            .first()
            .ok_or_else(|| operation_conflict("usage_manage_impact_missing"))?;
        let status = match migration.state {
            skillhub_core::RelationMigrationState::Committed => UsageChangeItemStatus::Applied,
            skillhub_core::RelationMigrationState::Failed
                if migration
                    .detail
                    .as_deref()
                    .is_some_and(|detail| detail.starts_with("recovery_required:")) =>
            {
                UsageChangeItemStatus::RecoveryRequired
            }
            skillhub_core::RelationMigrationState::Failed
            | skillhub_core::RelationMigrationState::RolledBack
            | skillhub_core::RelationMigrationState::Cancelled
            | skillhub_core::RelationMigrationState::Prepared => UsageChangeItemStatus::Failed,
        };
        let recovery_point = migration
            .backup_path
            .as_ref()
            .map(|path| UsageRecoveryPoint {
                path: path.clone(),
                fingerprint: preview
                    .entry_evidence
                    .first()
                    .and_then(|entry| entry.content_fingerprint.clone()),
                representation: preview
                    .entry_evidence
                    .first()
                    .map(|entry| entry.representation)
                    .unwrap_or(FileRepresentation::Unknown),
            });
        let result = UsageChangeResult {
            operation_id: preview.operation_id,
            prepared_id: preview.prepared_id,
            recovery_required: status == UsageChangeItemStatus::RecoveryRequired,
            derived_skill_id: None,
            recovery_operation_id: None,
            item_results: vec![UsageChangeItemResult {
                relation_ids: impact.relation_ids.clone(),
                skill_id: impact.skill_id,
                target: impact.target.clone(),
                action: impact.action,
                status,
                reason: migration.error_code.map(|error| error.as_str().to_owned()),
                recovery_point,
            }],
        };
        self.store_usage_manage_result(request.operation_id, result.clone())?;
        Ok(result)
    }

    fn commit_usage_manage_batch(
        &self,
        request: CommitUsageChange,
    ) -> AppResult<UsageChangeResult> {
        let (mut record, mut journal) = {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("usage_manage_batch.commit.database"))?;
            let record = database
                .operation_repository()
                .get_sync(request.operation_id)?
                .ok_or_else(|| operation_conflict("usage_change_preview_missing"))?;
            if record.kind != MANAGE_BATCH_OPERATION_KIND {
                return Err(operation_conflict("operation_id_reused"));
            }
            let journal: ManageBatchJournal = serde_json::from_value(record.recovery_data.clone())
                .map_err(|_| operation_conflict("usage_manage_batch_journal_invalid"))?;
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
            if !matches!(
                record.phase,
                OperationPhase::Prepared | OperationPhase::Applying
            ) {
                return Err(operation_conflict("usage_change_preview_not_prepared"));
            }
            (record, journal)
        };

        if record.phase == OperationPhase::Prepared {
            let refreshed = build_manage_batch_snapshot(
                self,
                &journal.request,
                &journal.plans,
                journal.prepared.prepared_id,
            )?;
            if refreshed != journal.prepared {
                return Err(operation_conflict("usage_change_preview_stale"));
            }
            record.phase = OperationPhase::Applying;
            record.progress.phase = OperationPhase::Applying;
            record.progress.total = journal.plans.len() as u32;
            record.progress.message_code = "operation.usage_manage_batch.applying".to_owned();
            record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
            self.database
                .lock()
                .map_err(|_| internal("usage_manage_batch.commit.database"))?
                .operation_repository()
                .update_sync(&record)?;
        }

        for adoption_index in 0..journal.adoptions.len() {
            let adoption = journal.adoptions[adoption_index].clone();
            if journal
                .adoption_results
                .iter()
                .any(|result| result.skill_id == adoption.skill_id)
            {
                journal.adoptions[adoption_index].completed = true;
                continue;
            }
            let result = match self.adopt_original_entry_for_usage_change(
                adoption.skill_id,
                Path::new(&adoption.path),
                &adoption.fingerprint,
                adoption.previous_version_id.as_ref(),
                adoption.operation_id,
            ) {
                Ok(result) => result,
                Err(error) => {
                    record.error_code = Some(error.code);
                    record.phase = if self.operation_needs_recovery(adoption.operation_id) {
                        OperationPhase::NeedsRecovery
                    } else {
                        OperationPhase::RolledBack
                    };
                    record.progress.phase = record.phase;
                    record.progress.message_code =
                        format!("operation.usage_manage_batch.{}", phase_code(record.phase));
                    record.recovery_data =
                        serde_json::to_value(&journal).map_err(serialization_error)?;
                    self.database
                        .lock()
                        .map_err(|_| internal("usage_manage_batch.commit.database"))?
                        .operation_repository()
                        .update_sync(&record)?;
                    return Err(error);
                }
            };
            journal.adoptions[adoption_index].completed = true;
            journal.adoption_results.push(result);
            self.persist_manage_batch_progress(&mut record, &journal)?;
        }

        for impact in &journal.prepared.impacts {
            if impact.action != UsageChangeImpactAction::RecordOnly
                || journal
                    .completed
                    .iter()
                    .any(|item| item.relation_ids == impact.relation_ids)
            {
                continue;
            }
            let relation_id = impact.relation_ids.first().cloned().unwrap_or_default();
            let rewrite = journal
                .adoption_results
                .iter()
                .find(|result| result.skill_id == impact.skill_id)
                .and_then(|result| {
                    result
                        .rewrites
                        .iter()
                        .find(|rewrite| rewrite.relation_id == relation_id)
                });
            let status = match rewrite {
                Some(rewrite) if rewrite.rewritten => UsageChangeItemStatus::Applied,
                Some(_) => UsageChangeItemStatus::Failed,
                None => UsageChangeItemStatus::Applied,
            };
            journal.completed.push(UsageChangeItemResult {
                relation_ids: impact.relation_ids.clone(),
                skill_id: impact.skill_id,
                target: impact.target.clone(),
                action: impact.action,
                status,
                reason: rewrite.and_then(|rewrite| rewrite.reason.clone()),
                recovery_point: None,
            });
            self.persist_manage_batch_progress(&mut record, &journal)?;
        }

        for (index, plan) in journal.plans.iter().enumerate() {
            let impact = journal
                .prepared
                .impacts
                .iter()
                .find(|impact| impact.relation_ids.contains(&plan.relation_id))
                .ok_or_else(|| operation_conflict("usage_manage_impact_missing"))?;
            if journal
                .completed
                .iter()
                .any(|item| item.relation_ids == impact.relation_ids)
            {
                continue;
            }
            if journal.request.content_basis == Some(UsageContentBasis::OriginalEntry) {
                let single_request = request_for_manage_entry(&journal.request, &plan.relation_id);
                let child = request_for_relation_migration(&plan.relation_id, plan.target_mode);
                let child_fingerprint = request_fingerprint(&single_request)?;
                if let Err(error) = self.prepare_usage_relation_migration(
                    plan.child_operation_id,
                    child,
                    child_fingerprint,
                    journal.request.content_basis.is_some(),
                ) {
                    journal.completed.push(failed_manage_item(impact, &error));
                    self.persist_manage_batch_progress(&mut record, &journal)?;
                    continue;
                }
            }
            let result = self.commit_relation_migration(CommitRelationMigration {
                prepared_relation_migration_id: plan.child_operation_id,
            });
            match result {
                Ok(AppCommandResult::RelationMigrationResult(migration)) => {
                    journal
                        .completed
                        .push(manage_migration_item(impact, migration));
                }
                Ok(_) => {
                    return Err(operation_conflict("usage_manage_result_invalid"));
                }
                Err(error) => {
                    let item = failed_manage_item(impact, &error);
                    let needs_recovery = item.status == UsageChangeItemStatus::RecoveryRequired;
                    journal.completed.push(item);
                    self.persist_manage_batch_progress(&mut record, &journal)?;
                    if needs_recovery {
                        record.phase = OperationPhase::NeedsRecovery;
                        record.error_code = Some(error.code);
                        record.progress.phase = record.phase;
                        record.progress.message_code =
                            "operation.usage_manage_batch.needs_recovery".to_owned();
                        record.recovery_data =
                            serde_json::to_value(&journal).map_err(serialization_error)?;
                        self.database
                            .lock()
                            .map_err(|_| internal("usage_manage_batch.commit.database"))?
                            .operation_repository()
                            .update_sync(&record)?;
                        return Err(error);
                    }
                }
            }
            record.progress.completed = (index + 1) as u32;
            self.persist_manage_batch_progress(&mut record, &journal)?;
        }

        let result = UsageChangeResult {
            operation_id: journal.prepared.operation_id,
            prepared_id: journal.prepared.prepared_id,
            recovery_required: journal
                .completed
                .iter()
                .any(|item| item.status == UsageChangeItemStatus::RecoveryRequired),
            item_results: journal.completed.clone(),
            derived_skill_id: None,
            recovery_operation_id: None,
        };
        record.phase = OperationPhase::Committed;
        record.progress.phase = record.phase;
        record.progress.completed = journal.plans.len() as u32;
        record.progress.total = journal.plans.len() as u32;
        record.progress.message_code = "operation.usage_manage_batch.committed".to_owned();
        record.result = Some(serde_json::to_value(&result).map_err(serialization_error)?);
        record.recovery_data = serde_json::to_value(&journal).map_err(serialization_error)?;
        self.database
            .lock()
            .map_err(|_| internal("usage_manage_batch.commit.database"))?
            .operation_repository()
            .update_sync(&record)?;
        Ok(result)
    }

    fn operation_needs_recovery(&self, operation_id: OperationId) -> bool {
        self.database
            .lock()
            .ok()
            .and_then(|database| {
                database
                    .operation_repository()
                    .get_sync(operation_id)
                    .ok()
                    .flatten()
            })
            .is_some_and(|record| record.phase == OperationPhase::NeedsRecovery)
    }

    fn persist_manage_batch_progress(
        &self,
        record: &mut OperationRecord,
        journal: &ManageBatchJournal,
    ) -> AppResult<()> {
        record.recovery_data = serde_json::to_value(journal).map_err(serialization_error)?;
        let database = self
            .database
            .lock()
            .map_err(|_| internal("usage_manage_batch.commit.database"))?;
        database.operation_repository().update_sync(record)
    }
}

fn request_for_manage_entry(request: &PrepareUsageChange, relation_id: &str) -> PrepareUsageChange {
    let mut entry_request = request.clone();
    entry_request.relation_ids = vec![relation_id.to_owned()];
    entry_request
}

fn request_for_relation_migration(
    relation_id: &str,
    target_mode: RelationMigrationTargetMode,
) -> PrepareRelationMigration {
    PrepareRelationMigration {
        relation_id: relation_id.to_owned(),
        target_mode,
        backup_policy: RelationshipMigrationBackupPolicy::Required,
        confirmation_token: None,
    }
}

fn merge_manage_entry_previews(
    operation_id: OperationId,
    prepared_id: OperationId,
    previews: &[PreparedUsageChange],
) -> AppResult<PreparedUsageChange> {
    let first = previews
        .first()
        .ok_or_else(|| operation_conflict("usage_change_relation_missing"))?;
    if previews
        .iter()
        .any(|preview| preview.relationship_revision != first.relationship_revision)
    {
        return Err(operation_conflict(
            "usage_change_facts_changed_during_prepare",
        ));
    }
    let mut affected_skill_ids = HashSet::new();
    let mut subject_versions = HashMap::new();
    let mut entries = BTreeMap::new();
    let mut consumers = BTreeMap::new();
    let mut impacts = BTreeMap::new();
    let mut limitations = BTreeSet::new();
    for preview in previews {
        affected_skill_ids.extend(preview.affected_skill_ids.iter().copied());
        for version in &preview.subject_versions {
            if subject_versions
                .insert(version.skill_id, version.clone())
                .is_some_and(|existing| existing != *version)
            {
                return Err(operation_conflict("usage_change_preview_stale"));
            }
        }
        for evidence in &preview.entry_evidence {
            entries.insert(evidence.relation_ids.clone(), evidence.clone());
        }
        for consumer in &preview.consumers {
            consumers.insert(consumer.relation_ids.clone(), consumer.clone());
        }
        for impact in &preview.impacts {
            impacts.insert(impact.relation_ids.clone(), impact.clone());
        }
        limitations.extend(preview.limitations.iter().cloned());
    }
    let mut affected_skill_ids = affected_skill_ids.into_iter().collect::<Vec<_>>();
    affected_skill_ids.sort_by_key(ToString::to_string);
    let mut subject_versions = subject_versions.into_values().collect::<Vec<_>>();
    subject_versions.sort_by_key(|version: &UsageSubjectVersion| version.skill_id.to_string());
    Ok(PreparedUsageChange {
        operation_id,
        prepared_id,
        action: UsageChangeAction::Manage,
        relationship_revision: first.relationship_revision.clone(),
        affected_skill_ids,
        subject_versions,
        entry_evidence: entries.into_values().collect(),
        consumers: consumers.into_values().collect(),
        impacts: impacts.into_values().collect(),
        limitations: limitations.into_iter().collect(),
        duplicate_cleanup: None,
        shared_usage_migration: None,
        subject_rename: None,
        derived_rename: None,
    })
}

fn add_original_entry_impacts(
    prepared: &mut PreparedUsageChange,
    entry_previews: &[PreparedUsageChange],
) {
    let selected_ids = entry_previews
        .iter()
        .flat_map(|preview| preview.entry_evidence.iter())
        .flat_map(|evidence| evidence.relation_ids.iter().cloned())
        .collect::<BTreeSet<_>>();
    let selected_skill_ids = prepared
        .entry_evidence
        .iter()
        .map(|evidence| evidence.skill_id)
        .collect::<HashSet<_>>();
    let mut impacts = prepared
        .impacts
        .iter()
        .map(|impact| (impact.relation_ids.clone(), impact.clone()))
        .collect::<BTreeMap<_, _>>();
    for consumer in &prepared.consumers {
        let Some(skill_id) = consumer.skill_id else {
            continue;
        };
        if !selected_skill_ids.contains(&skill_id)
            || consumer.management != UsageManagement::Managed
            || consumer
                .relation_ids
                .iter()
                .any(|relation_id| selected_ids.contains(relation_id))
        {
            continue;
        }
        impacts
            .entry(consumer.relation_ids.clone())
            .or_insert_with(|| UsageChangeImpact {
                relation_ids: consumer.relation_ids.clone(),
                skill_id,
                target: consumer.target.clone(),
                action: UsageChangeImpactAction::RecordOnly,
                description: "采用原使用位置内容后同步更新此受管目标。".to_owned(),
            });
    }
    prepared.impacts = impacts.into_values().collect();
}

fn build_manage_batch_snapshot(
    facade: &LocalApplicationFacade,
    request: &PrepareUsageChange,
    plans: &[ManageBatchPlan],
    prepared_id: OperationId,
) -> AppResult<PreparedUsageChange> {
    let mut previews = Vec::with_capacity(plans.len());
    for plan in plans {
        let single_request = request_for_manage_entry(request, &plan.relation_id);
        let (preview, _) = build_usage_manage_entry_preview(
            facade,
            &single_request,
            &plan.relation_id,
            request.operation_id,
            prepared_id,
            None,
        )?;
        previews.push(preview);
    }
    let mut prepared = merge_manage_entry_previews(request.operation_id, prepared_id, &previews)?;
    // prepared_id participates in the frozen snapshot; callers replace the
    // ephemeral value with the persisted one before comparing.
    if request.content_basis == Some(UsageContentBasis::OriginalEntry) {
        add_original_entry_impacts(&mut prepared, &previews);
    }
    Ok(prepared)
}

fn manage_migration_item(
    impact: &UsageChangeImpact,
    migration: skillhub_core::RelationMigrationResult,
) -> UsageChangeItemResult {
    let status = match migration.state {
        skillhub_core::RelationMigrationState::Committed => UsageChangeItemStatus::Applied,
        skillhub_core::RelationMigrationState::Failed
            if migration
                .detail
                .as_deref()
                .is_some_and(|detail| detail.starts_with("recovery_required:")) =>
        {
            UsageChangeItemStatus::RecoveryRequired
        }
        skillhub_core::RelationMigrationState::Failed
        | skillhub_core::RelationMigrationState::RolledBack
        | skillhub_core::RelationMigrationState::Cancelled
        | skillhub_core::RelationMigrationState::Prepared => UsageChangeItemStatus::Failed,
    };
    UsageChangeItemResult {
        relation_ids: impact.relation_ids.clone(),
        skill_id: impact.skill_id,
        target: impact.target.clone(),
        action: impact.action,
        status,
        reason: migration.error_code.map(|error| error.as_str().to_owned()),
        recovery_point: migration.backup_path.map(|path| UsageRecoveryPoint {
            path,
            fingerprint: None,
            representation: FileRepresentation::Unknown,
        }),
    }
}

fn failed_manage_item(impact: &UsageChangeImpact, error: &AppError) -> UsageChangeItemResult {
    let reason = error
        .params
        .get("reason")
        .and_then(Value::as_str)
        .map(str::to_owned);
    UsageChangeItemResult {
        relation_ids: impact.relation_ids.clone(),
        skill_id: impact.skill_id,
        target: impact.target.clone(),
        action: impact.action,
        status: if reason
            .as_deref()
            .is_some_and(|reason| reason.contains("recovery"))
        {
            UsageChangeItemStatus::RecoveryRequired
        } else {
            UsageChangeItemStatus::Failed
        },
        reason,
        recovery_point: None,
    }
}

fn build_usage_manage_preview(
    facade: &LocalApplicationFacade,
    request: &PrepareUsageChange,
    migration: &skillhub_core::PreparedRelationMigration,
) -> AppResult<(PreparedUsageChange, Vec<DeploymentRelationFact>)> {
    let relation_id = request
        .relation_ids
        .first()
        .ok_or_else(|| operation_conflict("usage_change_relation_missing"))?;
    build_usage_manage_entry_preview(
        facade,
        request,
        relation_id,
        request.operation_id,
        migration.operation_id,
        Some(migration),
    )
}

fn build_usage_manage_entry_preview(
    facade: &LocalApplicationFacade,
    request: &PrepareUsageChange,
    relation_id: &str,
    operation_id: OperationId,
    prepared_id: OperationId,
    migration: Option<&skillhub_core::PreparedRelationMigration>,
) -> AppResult<(PreparedUsageChange, Vec<DeploymentRelationFact>)> {
    let revision_before = facade
        .database
        .lock()
        .map_err(|_| internal("usage_manage.prepare.revision"))?
        .relationship_repository()
        .relationship_revision()?;
    let projection = match facade.get_agent_directory_projection()? {
        AppQueryResult::AgentDirectoryProjection(projection) => projection,
        _ => unreachable!("Agent directory query returns its projection"),
    };
    let overview = match facade.get_relationship_overview(RelationshipOverviewScope::All)? {
        AppQueryResult::RelationshipOverview(overview) => overview,
        _ => unreachable!("relationship overview query returns its projection"),
    };
    let facts = {
        let database = facade
            .database
            .lock()
            .map_err(|_| internal("usage_manage.prepare.database"))?;
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
    let revision_after = facade
        .database
        .lock()
        .map_err(|_| internal("usage_manage.prepare.revision"))?
        .relationship_repository()
        .relationship_revision()?;
    if revision_before != revision_after || facts.revision != revision_after {
        return Err(operation_conflict(
            "usage_change_facts_changed_during_prepare",
        ));
    }

    let matching_views = overview
        .usage_relations
        .iter()
        .filter(|view| {
            view.active
                && (view.relation_id == *relation_id
                    || view
                        .evidence_relation_ids
                        .iter()
                        .any(|evidence_id| evidence_id == relation_id))
        })
        .collect::<Vec<_>>();
    let [view] = matching_views.as_slice() else {
        return Err(operation_conflict("usage_change_relation_missing"));
    };
    let skill_id = view
        .skill_id
        .ok_or_else(|| operation_conflict("usage_subject_unverified"))?;
    if migration.is_some_and(|migration| Some(skill_id) != migration.relation.skill_id) {
        return Err(operation_conflict("usage_change_identity_conflict"));
    }
    let evidence_ids = sorted_unique(view.evidence_relation_ids.clone())?;
    if !evidence_ids
        .iter()
        .any(|evidence_id| evidence_id == relation_id)
    {
        return Err(operation_conflict("usage_change_evidence_ambiguous"));
    }
    let entry_key = view
        .entry_key
        .clone()
        .ok_or_else(|| operation_conflict("usage_entry_identity_unverified"))?;
    let entries = raw_entries(&facts, &projection)?;
    let entry = entries
        .get(relation_id)
        .ok_or_else(|| operation_conflict("usage_change_evidence_missing"))?;
    let path = PathBuf::from(&entry.path);
    if migration.is_some_and(|migration| entry.path != migration.relation.path) {
        return Err(operation_conflict("usage_change_identity_conflict"));
    }
    fs::symlink_metadata(&path).map_err(|_| operation_conflict("usage_entry_access_unverified"))?;
    let representation = view.file_representation;
    if !reported_representation_matches_actual(
        representation,
        FilesystemRelationshipProbe.directory_representation(&path),
    ) {
        return Err(operation_conflict("usage_entry_representation_changed"));
    }
    let fingerprint = DeploymentFilesystem::hash_tree(&path)?;
    if migration.is_some_and(|migration| fingerprint != migration.current_content_fingerprint) {
        return Err(operation_conflict("usage_change_preview_stale"));
    }
    let relation_facts = evidence_ids
        .iter()
        .map(|evidence_id| {
            facts
                .deployments
                .iter()
                .find(|fact| fact.relation_id == *evidence_id)
                .cloned()
                .ok_or_else(|| operation_conflict("usage_change_evidence_ambiguous"))
        })
        .collect::<AppResult<Vec<_>>>()?;
    if relation_facts.iter().any(|fact| {
        fact.skill_id != Some(skill_id)
            || fact.path != entry.path
            || fact.file_representation != representation
            || fact.content_fingerprint != fingerprint
    }) {
        return Err(operation_conflict("usage_change_evidence_ambiguous"));
    }
    if relation_facts.len() > 1 {
        if view.target.kind != RelationGovernanceTargetKind::SharedDirectory {
            return Err(operation_conflict("usage_change_evidence_ambiguous"));
        }
        let database = facade
            .database
            .lock()
            .map_err(|_| internal("usage_manage.prepare.shared_targets"))?;
        for fact in &relation_facts {
            if !LocalApplicationFacade::relation_target_is_shared(&database, fact)? {
                return Err(operation_conflict("usage_change_evidence_ambiguous"));
            }
        }
    }
    let physical_identity = match representation {
        FileRepresentation::SymbolicLink => symlink_physical_id_for_path(&path),
        FileRepresentation::DirectoryJunction => reparse_physical_id_for_path(&path),
        FileRepresentation::Copy | FileRepresentation::Directory => {
            skillhub_core::physical_id_for_path(&path)
        }
        FileRepresentation::Unknown => None,
    };
    let evidence = UsageEntryEvidence {
        skill_id,
        entry_key: entry_key.clone(),
        relation_ids: evidence_ids.clone(),
        physical_source_ids: entry.physical_source_id.clone().into_iter().collect(),
        path: entry.path.clone(),
        directory_role: view.target.directory_role,
        form: view.form,
        management: view.management,
        representation,
        content_fingerprint: Some(fingerprint.clone()),
        physical_identity,
        link_target_path: view.link_target_path.clone(),
        exists: true,
    };

    let mut consumers = overview
        .usage_relations
        .iter()
        .filter(|consumer_view| consumer_view.active)
        .filter_map(|consumer_view| consumer_for_view(consumer_view, &entries))
        .collect::<Vec<_>>();
    let shared_consumers = shared_directory_consumers(
        &projection,
        &facts.directory_capabilities,
        view,
        &path,
        &consumers,
    )?;
    consumers.extend(shared_consumers);
    consumers.sort_by(|left, right| {
        left.relation_ids.cmp(&right.relation_ids).then_with(|| {
            left.target
                .agent_client_id
                .cmp(&right.target.agent_client_id)
        })
    });

    let action = match request.requested_form {
        Some(UsageForm::Link) => UsageChangeImpactAction::ManageLink,
        Some(UsageForm::FullCopy) => UsageChangeImpactAction::ManageCopy,
        None => return Err(operation_conflict("usage_manage_form_required")),
    };
    let description = match action {
        UsageChangeImpactAction::ManageLink => "将使用位置转换为受管链接。",
        UsageChangeImpactAction::ManageCopy => "将使用位置转换为受管完整拷贝。",
        _ => return Err(operation_conflict("usage_manage_action_invalid")),
    };
    let current_version = facade.library_runtime.snapshot()?.current(skill_id)?;
    let subject_version = UsageSubjectVersion {
        skill_id,
        version_id: current_version,
    };
    Ok((
        PreparedUsageChange {
            operation_id,
            prepared_id,
            action: UsageChangeAction::Manage,
            relationship_revision: facts.revision.to_string(),
            affected_skill_ids: vec![skill_id],
            subject_versions: vec![subject_version],
            entry_evidence: vec![evidence],
            consumers,
            impacts: vec![UsageChangeImpact {
                relation_ids: evidence_ids,
                skill_id,
                target: view.target.clone(),
                action,
                description: description.to_owned(),
            }],
            limitations: migration
                .map(|migration| {
                    migration
                        .governance_tasks
                        .iter()
                        .map(|task| task.detail.clone())
                        .collect()
                })
                .unwrap_or_default(),
            duplicate_cleanup: None,
            shared_usage_migration: None,
            subject_rename: None,
            derived_rename: None,
        },
        relation_facts,
    ))
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
            UsageChangeImpactAction::ManageLink => "将使用位置转换为受管链接。",
            UsageChangeImpactAction::ManageCopy => "将使用位置转换为受管完整拷贝。",
            UsageChangeImpactAction::Synchronize => "同步受管目标到技能库当前版本。",
            UsageChangeImpactAction::Repair => "备份占用项并修复受管入口。",
            UsageChangeImpactAction::Restore => "按目标原受管方式恢复入口。",
            UsageChangeImpactAction::RenameSubject => "按主体新运行名同步所有受管入口。",
            UsageChangeImpactAction::DeriveAndReplace => "创建独立派生技能，并仅接管所选使用位置。",
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
        duplicate_cleanup: None,
        shared_usage_migration: None,
        subject_rename: None,
        derived_rename: None,
    };
    Ok(ReleaseJournal {
        request,
        prepared,
        plans,
        completed: Vec::new(),
    })
}

fn validate_duplicate_cleanup_request(request: &PrepareUsageChange) -> AppResult<()> {
    let Some(problem_id) = request.problem_id.as_deref() else {
        return Err(operation_conflict("duplicate_cleanup_problem_required"));
    };
    let Some(retain_entry_key) = request.retain_entry_key.as_ref() else {
        return Err(operation_conflict(
            "duplicate_cleanup_retained_entry_required",
        ));
    };
    let selected = request
        .selected_entry_keys
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if request.action != UsageChangeAction::ResolveDuplicate
        || problem_id.trim().is_empty()
        || !request.relation_ids.is_empty()
        || request.skill_id.is_some()
        || request.selected_entry_keys.len() < 2
        || selected.len() != request.selected_entry_keys.len()
        || !selected.contains(retain_entry_key)
        || request.requested_form.is_some()
        || request.copy_disposition.is_some()
        || request.content_basis.is_some()
        || request.runtime_name.is_some()
        || request.base_version_id.is_some()
        || !request.selected_relation_ids.is_empty()
        || !request.confirmed_shared_relation_ids.is_empty()
        || request
            .non_recognized_destination
            .as_ref()
            .is_some_and(|path| path.trim().is_empty())
    {
        return Err(operation_conflict("duplicate_cleanup_selection_invalid"));
    }
    Ok(())
}

fn validate_shared_usage_migration_request(request: &PrepareUsageChange) -> AppResult<()> {
    let Some(problem_id) = request.problem_id.as_deref() else {
        return Err(operation_conflict(
            "shared_usage_migration_problem_required",
        ));
    };
    if request.action != UsageChangeAction::MigrateSharedUsage
        || problem_id.trim().is_empty()
        || !request.relation_ids.is_empty()
        || request.skill_id.is_some()
        || request.requested_form.is_some()
        || request.copy_disposition.is_some()
        || request.content_basis.is_some()
        || request.retain_entry_key.is_some()
        || !request.selected_entry_keys.is_empty()
        || request.runtime_name.is_some()
        || request.base_version_id.is_some()
        || !request.selected_relation_ids.is_empty()
        || !request.confirmed_shared_relation_ids.is_empty()
        || request.non_recognized_destination.is_some()
    {
        return Err(operation_conflict("shared_usage_migration_request_invalid"));
    }
    Ok(())
}

fn build_shared_usage_migration_journal(
    facade: &LocalApplicationFacade,
    request: PrepareUsageChange,
    prepared_id: OperationId,
) -> AppResult<SharedUsageMigrationJournal> {
    validate_shared_usage_migration_request(&request)?;
    let (analysis, snapshots) = facade.scan_usage_environment_state()?;
    let problem_id = request
        .problem_id
        .as_deref()
        .ok_or_else(|| operation_conflict("shared_usage_migration_problem_required"))?;
    let problem = analysis
        .problems
        .iter()
        .find(|problem| problem.problem_id == problem_id)
        .cloned()
        .ok_or_else(|| operation_conflict("shared_usage_migration_problem_stale"))?;
    if problem.closed || problem.kind != EnvironmentProblemKind::SameSkill {
        return Err(operation_conflict("shared_usage_migration_not_same_skill"));
    }

    let shared_entries = problem
        .entries
        .iter()
        .filter(|entry| entry.directory_role == Some(AgentDirectoryRole::SharedDirectory))
        .collect::<Vec<_>>();
    if shared_entries.len() != 1 {
        return Err(operation_conflict(
            "shared_usage_migration_shared_entry_unknown",
        ));
    }
    let shared_entry = shared_entries[0];
    let skill_id = shared_entry
        .skill_id
        .ok_or_else(|| operation_conflict("shared_usage_migration_skill_unknown"))?;
    let shared_fingerprint = shared_entry
        .content_fingerprint
        .as_deref()
        .ok_or_else(|| operation_conflict("shared_usage_migration_fingerprint_unknown"))?;
    let runtime_name = shared_entry
        .runtime_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| operation_conflict("shared_usage_migration_runtime_name_unknown"))?;
    let (detail, discovery, projects, relationship_revision) = {
        let database = facade
            .database
            .lock()
            .map_err(|_| internal("shared_usage_migration.prepare.database"))?;
        let detail = database
            .catalog_repository()?
            .get_detail(skill_id)?
            .ok_or_else(|| operation_conflict("shared_usage_migration_skill_missing"))?;
        let discovery = database
            .agent_repository()
            .load()?
            .unwrap_or_else(crate::empty_discovery);
        let projects = database.project_repository().list()?;
        let revision = database
            .relationship_repository()
            .relationship_revision()?
            .to_string();
        (detail, discovery, projects, revision)
    };
    if skillhub_core::normalize_runtime_name(&detail.runtime_name)
        != skillhub_core::normalize_runtime_name(runtime_name)
    {
        return Err(operation_conflict(
            "shared_usage_migration_subject_name_changed",
        ));
    }
    let library = facade.library_runtime.snapshot()?;
    let version_id = library
        .store
        .current(skill_id)?
        .ok_or_else(|| operation_conflict("shared_usage_migration_subject_version_missing"))?;
    let central_source = library
        .central
        .visible_skill_path_for_runtime(skill_id, &detail.runtime_name);
    let central_fingerprint = library.store.hash_tree_read_only(&central_source)?;
    if central_fingerprint != shared_fingerprint {
        return Err(operation_conflict(
            "shared_usage_migration_source_content_changed",
        ));
    }
    let shared_proof = verified_plain_usage_entry(shared_entry, &library.store)?;
    let shared_key = usage_entry_key(shared_entry);
    let mut relation_ids = shared_entry.relation_ids.clone();
    relation_ids.sort();
    relation_ids.dedup();
    if relation_ids.is_empty() {
        return Err(operation_conflict(
            "shared_usage_migration_relations_unknown",
        ));
    }
    let expected_evidence_fingerprints = relation_ids
        .iter()
        .map(|id| (id.clone(), Some(shared_fingerprint.to_owned())))
        .collect::<BTreeMap<_, _>>();
    let physical_source_ids = snapshots
        .iter()
        .flat_map(|snapshot| snapshot.usage_relations.iter())
        .filter(|relation| relation.entry_key.as_ref() == Some(&shared_key))
        .flat_map(|relation| relation.physical_source_ids_evidence.iter().cloned())
        .collect::<BTreeSet<_>>();

    let consumers = sorted_unique_environments(&problem.consumers);
    if consumers.is_empty() {
        return Err(operation_conflict(
            "shared_usage_migration_consumers_unknown",
        ));
    }
    let snapshots_by_environment = snapshots
        .iter()
        .map(|snapshot| (usage_environment_identity(&snapshot.environment), snapshot))
        .collect::<BTreeMap<_, _>>();
    let mut replacements = Vec::with_capacity(consumers.len());
    let mut replacement_plans = Vec::with_capacity(consumers.len());
    for environment in consumers {
        let environment_id = usage_environment_identity(&environment);
        let snapshot = snapshots_by_environment
            .get(&environment_id)
            .copied()
            .ok_or_else(|| operation_conflict("shared_usage_migration_consumer_unknown"))?;
        if !snapshot.probe_limitations.is_empty() {
            return Err(operation_conflict(
                "shared_usage_migration_environment_incomplete",
            ));
        }
        if analysis.problems.iter().any(|candidate| {
            candidate.kind == EnvironmentProblemKind::NameConflict
                && !candidate.closed
                && candidate
                    .environment_results
                    .iter()
                    .any(|result| usage_environment_identity(&result.environment) == environment_id)
                && candidate.entries.iter().any(|entry| {
                    entry.runtime_name.as_deref().is_some_and(|name| {
                        skillhub_core::normalize_runtime_name(name)
                            == skillhub_core::normalize_runtime_name(runtime_name)
                    })
                })
        }) {
            return Err(operation_conflict("shared_usage_migration_name_conflict"));
        }

        if let Some(entry) = snapshot.discovered_entries.iter().find(|entry| {
            entry.directory_role == Some(AgentDirectoryRole::Builtin)
                && entry.content_fingerprint.as_deref() == Some(shared_fingerprint)
        }) {
            let proof = verified_plain_usage_entry(entry, &library.store)?;
            let target = target_from_environment_entry(entry, &environment);
            replacements.push(SharedUsageReplacement {
                environment,
                target_ids: Vec::new(),
                form: None,
                reused_existing: true,
                relationship_revision: snapshot.relationship_revision.clone(),
            });
            replacement_plans.push(SharedUsageMigrationReplacementPlan {
                preview: replacements.last().expect("just added replacement").clone(),
                target,
                deployment_plan: None,
                destination_path: None,
                reused_entry: Some(proof),
                child_operation_id: None,
                verified: false,
            });
            continue;
        }

        let direct_usage = snapshot.discovered_entries.iter().find_map(|entry| {
            if entry.directory_role == Some(AgentDirectoryRole::SharedDirectory)
                || entry.directory_role == Some(AgentDirectoryRole::Builtin)
                || entry.content_fingerprint.as_deref() != Some(shared_fingerprint)
            {
                return None;
            }
            snapshot
                .usage_relations
                .iter()
                .find(|relation| {
                    relation.active
                        && relation.skill_id == Some(skill_id)
                        && relation.entry_key.as_ref() == Some(&usage_entry_key(entry))
                        && relation.target.kind != RelationGovernanceTargetKind::SharedDirectory
                        && relation.target.agent_client_id.as_deref()
                            == Some(environment.agent_client_id.as_str())
                        && relation.target.kind
                            == if environment.project_id.is_some() {
                                RelationGovernanceTargetKind::Project
                            } else {
                                RelationGovernanceTargetKind::Agent
                            }
                        && relation
                            .health_reasons
                            .iter()
                            .all(|reason| *reason == UsageHealthReason::Normal)
                })
                .map(|relation| (entry, relation))
        });
        if let Some((entry, relation)) = direct_usage {
            let proof = verified_plain_usage_entry(entry, &library.store)?;
            replacements.push(SharedUsageReplacement {
                environment,
                target_ids: Vec::new(),
                form: relation.form,
                reused_existing: true,
                relationship_revision: snapshot.relationship_revision.clone(),
            });
            replacement_plans.push(SharedUsageMigrationReplacementPlan {
                preview: replacements.last().expect("just added replacement").clone(),
                target: relation.target.clone(),
                deployment_plan: None,
                destination_path: None,
                reused_entry: Some(proof),
                child_operation_id: None,
                verified: false,
            });
            continue;
        }

        let target_id = select_shared_migration_target(&environment, &discovery, &projects)?;
        let plan = match facade.get_deployment_plan(DeploymentPlanRequest {
            skill_id,
            version_id: version_id.clone(),
            runtime_name: detail.runtime_name.clone(),
            logical_target_ids: vec![target_id.clone()],
            mode_override: None,
        })? {
            AppQueryResult::DeploymentPlan(plan) => plan,
            _ => return Err(internal("shared_usage_migration.deployment_plan")),
        };
        if !plan.conflicts.is_empty() || plan.targets.len() != 1 {
            return Err(operation_conflict("shared_usage_migration_target_conflict"));
        }
        let target_plan = plan.targets[0].clone();
        if target_plan.change != TargetChange::Create {
            return Err(operation_conflict(
                "shared_usage_migration_target_not_empty",
            ));
        }
        let destination = Path::new(&target_plan.destination_path);
        let destination_parent = destination
            .parent()
            .ok_or_else(|| operation_conflict("shared_usage_migration_destination_invalid"))?;
        let destination_name = destination
            .file_name()
            .ok_or_else(|| operation_conflict("shared_usage_migration_destination_invalid"))?;
        let canonical_destination = fs::canonicalize(destination_parent)
            .map_err(|_| operation_conflict("shared_usage_migration_destination_unavailable"))?
            .join(destination_name);
        let form = usage_form_for_deployment_mode(target_plan.mode);
        replacements.push(SharedUsageReplacement {
            environment: environment.clone(),
            target_ids: vec![target_id],
            form: Some(form),
            reused_existing: false,
            relationship_revision: snapshot.relationship_revision.clone(),
        });
        replacement_plans.push(SharedUsageMigrationReplacementPlan {
            preview: replacements.last().expect("just added replacement").clone(),
            target: target_for_new_replacement(&environment, &target_plan, snapshot)?,
            destination_path: Some(canonical_destination.to_string_lossy().into_owned()),
            deployment_plan: Some(plan),
            reused_entry: None,
            child_operation_id: None,
            verified: false,
        });
    }

    let backup_anchor_chain =
        capture_backup_anchor(&library.root, &library.central.paths().management_dir)?;
    let management = backup_anchor_chain
        .nodes
        .first()
        .map(|node| PathBuf::from(&node.path))
        .ok_or_else(|| operation_conflict("usage_backup_anchor_unverified"))?;
    let source = SharedUsageMigrationSource {
        skill_id,
        entry_key: shared_key.clone(),
        source_path: shared_proof.path.clone(),
        fingerprint: shared_proof.fingerprint.clone(),
        physical_identity: shared_proof.physical_identity.clone(),
        relation_ids,
        expected_evidence_fingerprints,
        source_parent_chain: capture_path_chain(
            Path::new(&shared_proof.path).parent().ok_or_else(|| {
                operation_conflict("shared_usage_migration_source_parent_missing")
            })?,
        )?,
        backup_path: management
            .join("usage-shared-migration-backups")
            .join(request.operation_id.to_string())
            .join("shared-entry")
            .to_string_lossy()
            .into_owned(),
        backup_created: false,
        removal_started: false,
        removed: false,
        decision_recorded: false,
    };
    let entry_evidence = UsageEntryEvidence {
        skill_id,
        entry_key: shared_key,
        relation_ids: source.relation_ids.clone(),
        physical_source_ids: physical_source_ids.into_iter().collect(),
        path: source.source_path.clone(),
        directory_role: Some(AgentDirectoryRole::SharedDirectory),
        form: Some(UsageForm::FullCopy),
        management: UsageManagement::Unmanaged,
        representation: FileRepresentation::Copy,
        content_fingerprint: Some(source.fingerprint.clone()),
        physical_identity: Some(source.physical_identity.clone()),
        link_target_path: None,
        exists: true,
    };
    let source_target = UsageRelationTarget {
        kind: RelationGovernanceTargetKind::SharedDirectory,
        directory_id: Some(entry_evidence.entry_key.directory_id.clone()),
        agent_client_id: None,
        directory_role: Some(AgentDirectoryRole::SharedDirectory),
        recognition: Some(skillhub_core::relationship::DirectoryRecognition::Supported),
    };
    let prepared = PreparedUsageChange {
        operation_id: request.operation_id,
        prepared_id,
        action: UsageChangeAction::MigrateSharedUsage,
        relationship_revision,
        affected_skill_ids: vec![skill_id],
        subject_versions: vec![UsageSubjectVersion {
            skill_id,
            version_id: Some(version_id),
        }],
        entry_evidence: vec![entry_evidence],
        consumers: Vec::new(),
        impacts: vec![UsageChangeImpact {
            relation_ids: source.relation_ids.clone(),
            skill_id,
            target: source_target,
            action: UsageChangeImpactAction::RemoveCopyWithBackup,
            description: "所有替代使用核验通过后，备份并移除共享技能入口。".to_owned(),
        }],
        limitations: Vec::new(),
        duplicate_cleanup: None,
        shared_usage_migration: Some(SharedUsageMigrationPreview {
            problem,
            replacements,
        }),
        subject_rename: None,
        derived_rename: None,
    };
    Ok(SharedUsageMigrationJournal {
        request,
        prepared,
        backup_anchor_chain,
        source,
        replacements: replacement_plans,
        completed: Vec::new(),
    })
}

fn persist_shared_migration(
    facade: &LocalApplicationFacade,
    record: &mut OperationRecord,
    journal: &SharedUsageMigrationJournal,
    phase: OperationPhase,
) -> AppResult<()> {
    record.recovery_data = serde_json::to_value(journal).map_err(serialization_error)?;
    set_phase(
        record,
        phase,
        journal.completed.len() as u32,
        journal.replacements.len() as u32 + 1,
    );
    let database = facade
        .database
        .lock()
        .map_err(|_| internal("shared_usage_migration.persist.database"))?;
    database.operation_repository().update_sync(record)
}

fn verify_shared_migration_proof(
    proof: &SharedUsageMigrationProof,
    store: &VersionStore,
) -> AppResult<()> {
    let path = Path::new(&proof.path);
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| operation_conflict("shared_usage_migration_entry_unavailable"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(operation_conflict(
            "shared_usage_migration_entry_representation_unsupported",
        ));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|_| operation_conflict("shared_usage_migration_entry_unavailable"))?;
    if canonical.to_string_lossy() != proof.path
        || store.hash_tree_read_only(&canonical)? != proof.fingerprint
        || skillhub_core::physical_id_for_path(&canonical).as_deref()
            != Some(proof.physical_identity.as_str())
    {
        return Err(operation_conflict(
            "shared_usage_migration_replacement_changed",
        ));
    }
    Ok(())
}

fn verify_shared_migration_path(
    path: &Path,
    fingerprint: &str,
    target: &UsageRelationTarget,
    runtime_name: &str,
    store: &VersionStore,
) -> AppResult<SharedUsageMigrationProof> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| operation_conflict("shared_usage_migration_entry_unavailable"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(operation_conflict(
            "shared_usage_migration_entry_representation_unsupported",
        ));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|_| operation_conflict("shared_usage_migration_entry_unavailable"))?;
    if canonical.to_string_lossy() != path.to_string_lossy()
        || store.hash_tree_read_only(&canonical)? != fingerprint
    {
        return Err(operation_conflict(
            "shared_usage_migration_replacement_changed",
        ));
    }
    let directory_id = target
        .directory_id
        .clone()
        .ok_or_else(|| operation_conflict("shared_usage_migration_target_directory_unknown"))?;
    let physical_identity = skillhub_core::physical_id_for_path(&canonical)
        .ok_or_else(|| operation_conflict("shared_usage_migration_identity_unknown"))?;
    Ok(SharedUsageMigrationProof {
        entry_key: UsageEntryKey {
            directory_id,
            relative_entry_path: safe_relative_entry_path(runtime_name)?
                .to_string_lossy()
                .into_owned(),
        },
        path: canonical.to_string_lossy().into_owned(),
        fingerprint: fingerprint.to_owned(),
        physical_identity,
    })
}

fn verify_shared_migration_source(
    source: &SharedUsageMigrationSource,
    store: &VersionStore,
) -> AppResult<()> {
    let path = Path::new(&source.source_path);
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && source.removal_started
                && source.backup_created =>
        {
            return Ok(());
        }
        Err(_) => {
            return Err(operation_conflict(
                "shared_usage_migration_source_unavailable",
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(operation_conflict(
            "shared_usage_migration_source_representation_changed",
        ));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|_| operation_conflict("shared_usage_migration_source_unavailable"))?;
    if canonical.to_string_lossy() != source.source_path
        || capture_path_chain(
            path.parent().ok_or_else(|| {
                operation_conflict("shared_usage_migration_source_parent_missing")
            })?,
        )? != source.source_parent_chain
        || store.hash_tree_read_only(&canonical)? != source.fingerprint
        || skillhub_core::physical_id_for_path(&canonical).as_deref()
            != Some(source.physical_identity.as_str())
    {
        return Err(operation_conflict("shared_usage_migration_source_changed"));
    }
    Ok(())
}

fn verify_shared_migration_backup_path(
    journal: &SharedUsageMigrationJournal,
    anchor: &Path,
) -> AppResult<()> {
    let backup = Path::new(&journal.source.backup_path);
    let relative = backup
        .strip_prefix(anchor)
        .map_err(|_| operation_conflict("shared_usage_migration_backup_path_invalid"))?;
    let relative = safe_relative_entry_path(&relative.to_string_lossy())?;
    let mut current = anchor.to_path_buf();
    for component in relative.parent().into_iter().flat_map(Path::components) {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(operation_conflict(
                    "shared_usage_migration_backup_path_invalid",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(operation_conflict(
                    "shared_usage_migration_backup_path_invalid",
                ));
            }
        }
    }
    if backup == anchor {
        return Err(operation_conflict(
            "shared_usage_migration_backup_path_invalid",
        ));
    }
    Ok(())
}

fn restore_shared_migration_source(
    journal: &mut SharedUsageMigrationJournal,
    store: &VersionStore,
) -> AppResult<()> {
    let backup = Path::new(&journal.source.backup_path);
    let destination = Path::new(&journal.source.source_path);
    if store.hash_tree_read_only(backup)? != journal.source.fingerprint {
        return Err(operation_conflict("shared_usage_migration_backup_invalid"));
    }
    if fs::symlink_metadata(destination).is_ok() {
        let current_identity = entry_identity(destination)?;
        let current_fingerprint = store.hash_tree_read_only(destination)?;
        if current_fingerprint == journal.source.fingerprint {
            journal.source.physical_identity = current_identity
                .ok_or_else(|| operation_conflict("shared_usage_migration_identity_unknown"))?;
            return Ok(());
        }
        if current_identity.as_deref() != Some(journal.source.physical_identity.as_str()) {
            return Err(operation_conflict(
                "shared_usage_migration_restore_destination_changed",
            ));
        }
        remove_plain_entry(destination)?;
    }
    restore_entry(backup, destination)?;
    journal.source.physical_identity = skillhub_core::physical_id_for_path(destination)
        .ok_or_else(|| operation_conflict("shared_usage_migration_identity_unknown"))?;
    Ok(())
}

fn sorted_unique_environments(environments: &[UsageEnvironmentKey]) -> Vec<UsageEnvironmentKey> {
    let mut by_identity = environments
        .iter()
        .cloned()
        .map(|environment| (usage_environment_identity(&environment), environment))
        .collect::<BTreeMap<_, _>>();
    std::mem::take(&mut by_identity).into_values().collect()
}

fn verified_plain_usage_entry(
    entry: &UsageEnvironmentEntry,
    store: &VersionStore,
) -> AppResult<SharedUsageMigrationProof> {
    let root = entry
        .directory_path
        .as_deref()
        .ok_or_else(|| operation_conflict("shared_usage_migration_directory_unknown"))?;
    let root = fs::canonicalize(root)
        .map_err(|_| operation_conflict("shared_usage_migration_directory_unavailable"))?;
    let relative = safe_relative_entry_path(&entry.relative_entry_path)?;
    let path = root.join(relative);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| operation_conflict("shared_usage_migration_entry_unavailable"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(operation_conflict(
            "shared_usage_migration_entry_representation_unsupported",
        ));
    }
    let canonical = fs::canonicalize(&path)
        .map_err(|_| operation_conflict("shared_usage_migration_entry_unavailable"))?;
    if !canonical.starts_with(&root) {
        return Err(operation_conflict(
            "shared_usage_migration_entry_outside_directory",
        ));
    }
    let fingerprint = store.hash_tree_read_only(&canonical)?;
    let physical_identity = skillhub_core::physical_id_for_path(&canonical)
        .ok_or_else(|| operation_conflict("shared_usage_migration_identity_unknown"))?;
    if entry.content_fingerprint.as_deref() != Some(fingerprint.as_str())
        || entry.physical_identity.as_deref() != Some(physical_identity.as_str())
    {
        return Err(operation_conflict("shared_usage_migration_entry_changed"));
    }
    Ok(SharedUsageMigrationProof {
        entry_key: usage_entry_key(entry),
        path: canonical.to_string_lossy().into_owned(),
        fingerprint,
        physical_identity,
    })
}

fn select_shared_migration_target(
    environment: &UsageEnvironmentKey,
    discovery: &skillhub_core::agent::DiscoverySnapshot,
    projects: &[skillhub_core::project::Project],
) -> AppResult<String> {
    if let Some(project_id) = environment.project_id {
        if projects.iter().any(|project| project.id == project_id) {
            return Ok(project_id.to_string());
        }
        return Err(operation_conflict("shared_usage_migration_project_unknown"));
    }
    let mut candidates = discovery
        .logical_targets
        .iter()
        .filter(|target| {
            target.client_id == environment.agent_client_id
                && !target.shared_reference
                && !target.builtin
                && target.exists
                && target.readable
                && target.writable
                && target.available
                && target.physical_identity_verified
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        let left_preferred =
            left.precedence == skillhub_core::agent::DirectoryPrecedence::Preferred;
        let right_preferred =
            right.precedence == skillhub_core::agent::DirectoryPrecedence::Preferred;
        right_preferred
            .cmp(&left_preferred)
            .then_with(|| left.id.cmp(&right.id))
    });
    candidates
        .first()
        .map(|target| target.id.clone())
        .ok_or_else(|| operation_conflict("shared_usage_migration_target_unknown"))
}

fn usage_form_for_deployment_mode(mode: DeploymentMode) -> UsageForm {
    match mode {
        DeploymentMode::SymbolicLink | DeploymentMode::DirectoryJunction => UsageForm::Link,
        DeploymentMode::ManagedCopy => UsageForm::FullCopy,
    }
}

fn target_from_environment_entry(
    entry: &UsageEnvironmentEntry,
    environment: &UsageEnvironmentKey,
) -> UsageRelationTarget {
    UsageRelationTarget {
        kind: if environment.project_id.is_some() {
            RelationGovernanceTargetKind::Project
        } else {
            RelationGovernanceTargetKind::Agent
        },
        directory_id: Some(entry.directory_id.clone()),
        agent_client_id: Some(environment.agent_client_id.clone()),
        directory_role: entry.directory_role,
        recognition: Some(skillhub_core::relationship::DirectoryRecognition::Supported),
    }
}

fn target_for_new_replacement(
    environment: &UsageEnvironmentKey,
    target: &TargetPlan,
    snapshot: &UsageEnvironmentSnapshot,
) -> AppResult<UsageRelationTarget> {
    let destination_parent = Path::new(&target.destination_path)
        .parent()
        .ok_or_else(|| operation_conflict("shared_usage_migration_destination_invalid"))?;
    let destination_parent = fs::canonicalize(destination_parent)
        .map_err(|_| operation_conflict("shared_usage_migration_destination_unavailable"))?;
    let directory = snapshot
        .recognized_directories
        .iter()
        .find(|directory| {
            (if environment.project_id.is_some() {
                directory.role == AgentDirectoryRole::Project
            } else {
                matches!(
                    directory.role,
                    AgentDirectoryRole::AgentUser
                        | AgentDirectoryRole::AgentWorkspace
                        | AgentDirectoryRole::AgentNative
                )
            }) && directory.consumers.iter().any(|consumer| {
                usage_environment_identity(consumer) == usage_environment_identity(environment)
            }) && fs::canonicalize(&directory.path).is_ok_and(|path| path == destination_parent)
        })
        .ok_or_else(|| operation_conflict("shared_usage_migration_target_directory_unknown"))?;
    Ok(UsageRelationTarget {
        kind: if environment.project_id.is_some() {
            RelationGovernanceTargetKind::Project
        } else {
            RelationGovernanceTargetKind::Agent
        },
        directory_id: Some(directory.directory_id.clone()),
        agent_client_id: Some(environment.agent_client_id.clone()),
        directory_role: Some(directory.role),
        recognition: Some(directory.recognition),
    })
}

fn build_duplicate_cleanup_journal(
    facade: &LocalApplicationFacade,
    request: PrepareUsageChange,
    prepared_id: OperationId,
) -> AppResult<DuplicateCleanupJournal> {
    validate_duplicate_cleanup_request(&request)?;
    let (analysis, snapshots) = facade.scan_usage_environment_state()?;
    let library = facade.library_runtime.snapshot()?;
    let problem_id = request
        .problem_id
        .as_deref()
        .ok_or_else(|| operation_conflict("duplicate_cleanup_problem_required"))?;
    let problem = analysis
        .problems
        .into_iter()
        .find(|problem| problem.problem_id == problem_id)
        .ok_or_else(|| operation_conflict("duplicate_cleanup_problem_stale"))?;
    if problem.closed || problem.kind != EnvironmentProblemKind::SameSkill {
        return Err(operation_conflict("duplicate_cleanup_not_same_skill"));
    }
    let expected_keys = problem
        .entries
        .iter()
        .map(|entry| usage_entry_key(entry))
        .collect::<BTreeSet<_>>();
    let selected_keys = request
        .selected_entry_keys
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if expected_keys.len() < 2 || selected_keys != expected_keys {
        return Err(operation_conflict("duplicate_cleanup_selection_stale"));
    }

    let affected_environments = problem
        .environment_results
        .iter()
        .map(|result| usage_environment_identity(&result.environment))
        .collect::<BTreeSet<_>>();
    for snapshot in snapshots.iter().filter(|snapshot| {
        affected_environments.contains(&usage_environment_identity(&snapshot.environment))
    }) {
        if !snapshot.probe_limitations.is_empty() {
            return Err(operation_conflict(
                "duplicate_cleanup_environment_incomplete",
            ));
        }
    }

    let mut entries =
        BTreeMap::<UsageEntryKey, (UsageEnvironmentEntry, String, AgentDirectoryRole)>::new();
    for entry in &problem.entries {
        let key = usage_entry_key(entry);
        let observations = snapshots
            .iter()
            .filter(|snapshot| {
                affected_environments.contains(&usage_environment_identity(&snapshot.environment))
            })
            .filter_map(|snapshot| {
                let observed = snapshot.discovered_entries.iter().find(|observed| {
                    observed.directory_id == key.directory_id
                        && observed.relative_entry_path == key.relative_entry_path
                })?;
                let directory = snapshot
                    .recognized_directories
                    .iter()
                    .find(|directory| directory.directory_id == key.directory_id)?;
                Some((
                    observed.clone(),
                    directory.path.clone(),
                    directory.role,
                    directory.recognition,
                ))
            })
            .collect::<Vec<_>>();
        let Some((first, root, role, recognition)) = observations.first().cloned() else {
            return Err(operation_conflict("duplicate_cleanup_entry_stale"));
        };
        if recognition != skillhub_core::relationship::DirectoryRecognition::Supported
            || first.content_fingerprint != entry.content_fingerprint
            || first.physical_identity != entry.physical_identity
            || observations
                .iter()
                .any(|(other, other_root, other_role, other_recognition)| {
                    other.content_fingerprint != first.content_fingerprint
                        || other.physical_identity != first.physical_identity
                        || other_root != &root
                        || other_role != &role
                        || *other_recognition != recognition
                })
        {
            return Err(operation_conflict("duplicate_cleanup_entry_changed"));
        }
        let relative = safe_relative_entry_path(&key.relative_entry_path)?;
        let root_path = fs::canonicalize(&root)
            .map_err(|_| operation_conflict("duplicate_cleanup_directory_unavailable"))?;
        let source = root_path.join(relative);
        let canonical_source = fs::canonicalize(&source)
            .map_err(|_| operation_conflict("duplicate_cleanup_entry_unavailable"))?;
        if !canonical_source.starts_with(&root_path) {
            return Err(operation_conflict(
                "duplicate_cleanup_entry_outside_directory",
            ));
        }
        let metadata = fs::symlink_metadata(&source)
            .map_err(|_| operation_conflict("duplicate_cleanup_entry_unavailable"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(operation_conflict("duplicate_cleanup_entry_changed"));
        }
        if skillhub_core::physical_id_for_path(&source).as_deref()
            != entry.physical_identity.as_deref()
        {
            return Err(operation_conflict(
                "duplicate_cleanup_entry_identity_changed",
            ));
        }
        if library.store.hash_tree_read_only(&source).ok().as_deref()
            != entry.content_fingerprint.as_deref()
        {
            return Err(operation_conflict(
                "duplicate_cleanup_entry_fingerprint_changed",
            ));
        }
        entries.insert(key, (first, source.to_string_lossy().into_owned(), role));
    }

    let retain = request
        .retain_entry_key
        .as_ref()
        .ok_or_else(|| operation_conflict("duplicate_cleanup_retained_entry_required"))?;
    let builtin_keys = entries
        .iter()
        .filter(|(_, (_, _, role))| *role == AgentDirectoryRole::Builtin)
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    if !builtin_keys.is_empty() && (builtin_keys.len() != 1 || builtin_keys[0] != *retain) {
        return Err(operation_conflict(
            "duplicate_cleanup_builtin_must_be_retained",
        ));
    }

    let destination = request
        .non_recognized_destination
        .as_deref()
        .map(PathBuf::from);
    let destination_parent_chain = if let Some(destination) = destination.as_ref() {
        validate_duplicate_destination(destination, &snapshots, &entries)?;
        Some(capture_path_chain(destination.parent().ok_or_else(
            || operation_conflict("duplicate_cleanup_destination_invalid"),
        )?)?)
    } else {
        None
    };
    if destination.is_some() && !builtin_keys.is_empty() {
        return Err(operation_conflict("duplicate_cleanup_builtin_cannot_move"));
    }

    let backup_anchor_chain =
        capture_backup_anchor(&library.root, &library.central.paths().management_dir)?;
    let management = backup_anchor_chain
        .nodes
        .first()
        .map(|node| PathBuf::from(&node.path))
        .ok_or_else(|| operation_conflict("usage_backup_anchor_unverified"))?;
    let mut plans = Vec::with_capacity(entries.len());
    for (index, (entry_key, (entry, source, _role))) in entries.iter().enumerate() {
        let source_path = PathBuf::from(source);
        let source_parent_chain = capture_path_chain(
            source_path
                .parent()
                .ok_or_else(|| operation_conflict("duplicate_cleanup_entry_parent_missing"))?,
        )?;
        let backup_path = management
            .join("usage-duplicate-backups")
            .join(request.operation_id.to_string())
            .join(index.to_string())
            .join("entry");
        if fs::symlink_metadata(&backup_path).is_ok() {
            return Err(operation_conflict("duplicate_cleanup_backup_occupied"));
        }
        plans.push(DuplicateCleanupPlan {
            entry_key: entry_key.clone(),
            source_path: source.clone(),
            fingerprint: entry
                .content_fingerprint
                .clone()
                .ok_or_else(|| operation_conflict("duplicate_cleanup_fingerprint_missing"))?,
            physical_identity: entry
                .physical_identity
                .clone()
                .ok_or_else(|| operation_conflict("duplicate_cleanup_identity_missing"))?,
            retained: entry_key == retain,
            source_parent_chain,
            backup_path: backup_path.to_string_lossy().into_owned(),
            backup_created: false,
            removal_started: false,
            removed: false,
            destination_path: if entry_key == retain {
                destination
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned())
            } else {
                None
            },
            destination_parent_chain: if entry_key == retain {
                destination_parent_chain.clone()
            } else {
                None
            },
            destination_started: false,
            destination_created: false,
        });
    }

    let mut affected_skill_ids = problem
        .entries
        .iter()
        .filter_map(|entry| entry.skill_id)
        .collect::<Vec<_>>();
    affected_skill_ids.sort_by_key(ToString::to_string);
    affected_skill_ids.dedup();
    let selected_entry_keys = entries.keys().cloned().collect::<Vec<_>>();
    let prepared = PreparedUsageChange {
        operation_id: request.operation_id,
        prepared_id,
        action: UsageChangeAction::ResolveDuplicate,
        relationship_revision: problem
            .environment_results
            .iter()
            .map(|result| result.relationship_revision.clone())
            .min()
            .unwrap_or_default(),
        affected_skill_ids,
        subject_versions: Vec::new(),
        entry_evidence: Vec::new(),
        consumers: Vec::new(),
        impacts: Vec::new(),
        limitations: Vec::new(),
        duplicate_cleanup: Some(DuplicateCleanupPreview {
            problem,
            retain_entry_key: retain.clone(),
            selected_entry_keys,
            non_recognized_destination: destination
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
        }),
        shared_usage_migration: None,
        subject_rename: None,
        derived_rename: None,
    };
    Ok(DuplicateCleanupJournal {
        request,
        prepared,
        backup_anchor_chain,
        plans,
        completed: Vec::new(),
    })
}

fn usage_entry_key(entry: &UsageEnvironmentEntry) -> UsageEntryKey {
    UsageEntryKey {
        directory_id: entry.directory_id.clone(),
        relative_entry_path: entry.relative_entry_path.clone(),
    }
}

fn usage_environment_identity(environment: &UsageEnvironmentKey) -> String {
    format!(
        "{}:{}",
        environment.agent_client_id,
        environment
            .project_id
            .map(|id| id.to_string())
            .unwrap_or_default()
    )
}

fn safe_relative_entry_path(relative: &str) -> AppResult<PathBuf> {
    let path = Path::new(relative);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(operation_conflict("duplicate_cleanup_entry_path_invalid"));
    }
    Ok(path.to_path_buf())
}

fn validate_duplicate_destination(
    destination: &Path,
    snapshots: &[UsageEnvironmentSnapshot],
    entries: &BTreeMap<UsageEntryKey, (UsageEnvironmentEntry, String, AgentDirectoryRole)>,
) -> AppResult<()> {
    if !destination.is_absolute()
        || destination
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        || destination.file_name().is_none()
        || fs::symlink_metadata(destination).is_ok()
    {
        return Err(operation_conflict("duplicate_cleanup_destination_invalid"));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| operation_conflict("duplicate_cleanup_destination_invalid"))?;
    let parent_metadata = fs::symlink_metadata(parent)
        .map_err(|_| operation_conflict("duplicate_cleanup_destination_parent_unavailable"))?;
    if !parent_metadata.is_dir() || parent_metadata.file_type().is_symlink() {
        return Err(operation_conflict(
            "duplicate_cleanup_destination_parent_unavailable",
        ));
    }
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|_| operation_conflict("duplicate_cleanup_destination_parent_unavailable"))?;
    let canonical_destination = canonical_parent.join(
        destination
            .file_name()
            .ok_or_else(|| operation_conflict("duplicate_cleanup_destination_invalid"))?,
    );
    for snapshot in snapshots {
        for directory in &snapshot.recognized_directories {
            let registered = fs::canonicalize(&directory.path)
                .map_err(|_| operation_conflict("duplicate_cleanup_environment_incomplete"))?;
            if canonical_destination.starts_with(&registered) {
                return Err(operation_conflict(
                    "duplicate_cleanup_destination_recognized",
                ));
            }
        }
    }
    if entries.values().any(|(_, source, _)| {
        let source = Path::new(source);
        canonical_destination == source || canonical_destination.starts_with(source)
    }) {
        return Err(operation_conflict("duplicate_cleanup_destination_conflict"));
    }
    Ok(())
}

fn validate_duplicate_cleanup_plan(
    facade: &LocalApplicationFacade,
    plan: &DuplicateCleanupPlan,
) -> AppResult<()> {
    let source = Path::new(&plan.source_path);
    let parent = source
        .parent()
        .ok_or_else(|| operation_conflict("duplicate_cleanup_entry_parent_missing"))?;
    if capture_path_chain(parent)? != plan.source_parent_chain {
        return Err(operation_conflict("duplicate_cleanup_entry_parent_changed"));
    }
    let metadata = fs::symlink_metadata(source)
        .map_err(|_| operation_conflict("duplicate_cleanup_entry_unavailable"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || skillhub_core::physical_id_for_path(source).as_deref()
            != Some(plan.physical_identity.as_str())
        || duplicate_entry_fingerprint(facade, source)?.as_str() != plan.fingerprint
        || fs::symlink_metadata(&plan.backup_path).is_ok()
    {
        return Err(operation_conflict("duplicate_cleanup_entry_changed"));
    }
    if let Some(parent_chain) = &plan.destination_parent_chain {
        let destination = Path::new(
            plan.destination_path
                .as_deref()
                .ok_or_else(|| operation_conflict("duplicate_cleanup_destination_invalid"))?,
        );
        let destination_parent = destination
            .parent()
            .ok_or_else(|| operation_conflict("duplicate_cleanup_destination_invalid"))?;
        if capture_path_chain(destination_parent)? != *parent_chain
            || fs::symlink_metadata(destination).is_ok()
        {
            return Err(operation_conflict("duplicate_cleanup_destination_changed"));
        }
    }
    Ok(())
}

fn apply_duplicate_cleanup_files(
    facade: &LocalApplicationFacade,
    record: &mut OperationRecord,
    journal: &mut DuplicateCleanupJournal,
) -> AppResult<()> {
    let backup_anchor = verify_duplicate_backup_anchor(journal)?;
    for index in 0..journal.plans.len() {
        let removes_source =
            !journal.plans[index].retained || journal.plans[index].destination_path.is_some();
        if !removes_source {
            continue;
        }
        let plan = &journal.plans[index];
        verify_duplicate_backup_path(plan, &backup_anchor)?;
        backup_entry(Path::new(&plan.source_path), Path::new(&plan.backup_path))?;
        if duplicate_entry_fingerprint(facade, Path::new(&plan.backup_path))?.as_str()
            != plan.fingerprint
        {
            return Err(operation_conflict(
                "duplicate_cleanup_backup_verification_failed",
            ));
        }
        journal.plans[index].backup_created = true;
        persist_duplicate_cleanup(facade, record, journal, OperationPhase::Applying)?;
    }

    for index in 0..journal.plans.len() {
        let destination = journal.plans[index].destination_path.clone();
        let Some(destination) = destination else {
            continue;
        };
        let plan = journal.plans[index].clone();
        if !plan.retained || !plan.backup_created {
            return Err(operation_conflict("duplicate_cleanup_journal_invalid"));
        }
        verify_duplicate_destination_parent(&plan)?;
        journal.plans[index].destination_started = true;
        persist_duplicate_cleanup(facade, record, journal, OperationPhase::Applying)?;
        restore_entry(Path::new(&plan.backup_path), Path::new(&destination))?;
        journal.plans[index].destination_created = true;
        persist_duplicate_cleanup(facade, record, journal, OperationPhase::Applying)?;
    }

    for index in 0..journal.plans.len() {
        let plan = &journal.plans[index];
        let removes_source = !plan.retained || plan.destination_path.is_some();
        if !removes_source {
            continue;
        }
        validate_duplicate_cleanup_plan_after_backup(facade, plan)?;
        journal.plans[index].removal_started = true;
        persist_duplicate_cleanup(facade, record, journal, OperationPhase::Applying)?;
        remove_plain_entry(Path::new(&journal.plans[index].source_path))?;
        journal.plans[index].removed = true;
        journal.completed.push(format!(
            "{}:{}",
            journal.plans[index].entry_key.directory_id,
            journal.plans[index].entry_key.relative_entry_path
        ));
        persist_duplicate_cleanup(facade, record, journal, OperationPhase::Applying)?;
    }
    Ok(())
}

fn validate_duplicate_cleanup_plan_after_backup(
    facade: &LocalApplicationFacade,
    plan: &DuplicateCleanupPlan,
) -> AppResult<()> {
    let source = Path::new(&plan.source_path);
    let parent = source
        .parent()
        .ok_or_else(|| operation_conflict("duplicate_cleanup_entry_parent_missing"))?;
    if capture_path_chain(parent)? != plan.source_parent_chain
        || !plan.backup_created
        || duplicate_entry_fingerprint(facade, Path::new(&plan.backup_path))?.as_str()
            != plan.fingerprint
    {
        return Err(operation_conflict(
            "duplicate_cleanup_backup_verification_failed",
        ));
    }
    let metadata = fs::symlink_metadata(source)
        .map_err(|_| operation_conflict("duplicate_cleanup_entry_unavailable"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || skillhub_core::physical_id_for_path(source).as_deref()
            != Some(plan.physical_identity.as_str())
        || duplicate_entry_fingerprint(facade, source)?.as_str() != plan.fingerprint
    {
        return Err(operation_conflict("duplicate_cleanup_entry_changed"));
    }
    Ok(())
}

fn rollback_duplicate_cleanup_files(
    facade: &LocalApplicationFacade,
    record: &mut OperationRecord,
    journal: &mut DuplicateCleanupJournal,
) -> AppResult<()> {
    let _backup_anchor = verify_duplicate_backup_anchor(journal)?;
    for index in (0..journal.plans.len()).rev() {
        let plan = journal.plans[index].clone();
        if plan.destination_started || plan.destination_created {
            let destination = Path::new(
                plan.destination_path
                    .as_deref()
                    .ok_or_else(|| operation_conflict("duplicate_cleanup_journal_invalid"))?,
            );
            if fs::symlink_metadata(destination).is_ok() {
                if plan.destination_parent_chain.as_ref()
                    != destination
                        .parent()
                        .map(capture_path_chain)
                        .transpose()?
                        .as_ref()
                {
                    return Err(operation_conflict("duplicate_cleanup_destination_changed"));
                }
                let metadata = fs::symlink_metadata(destination)
                    .map_err(|_| operation_conflict("duplicate_cleanup_destination_changed"))?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(operation_conflict("duplicate_cleanup_destination_changed"));
                }
                if duplicate_entry_fingerprint(facade, destination)?.as_str() != plan.fingerprint {
                    return Err(operation_conflict("duplicate_cleanup_destination_changed"));
                }
                remove_plain_entry(destination)?;
            }
            journal.plans[index].destination_started = false;
            journal.plans[index].destination_created = false;
        }
        if plan.removal_started && plan.backup_created {
            let source = Path::new(&plan.source_path);
            match fs::symlink_metadata(source) {
                Ok(_) => {
                    if duplicate_entry_fingerprint(facade, source)?.as_str() != plan.fingerprint {
                        return Err(operation_conflict(
                            "duplicate_cleanup_rollback_source_changed",
                        ));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let parent = source.parent().ok_or_else(|| {
                        operation_conflict("duplicate_cleanup_entry_parent_missing")
                    })?;
                    if capture_path_chain(parent)? != plan.source_parent_chain {
                        return Err(operation_conflict("duplicate_cleanup_entry_parent_changed"));
                    }
                    restore_entry(Path::new(&plan.backup_path), source)?;
                }
                Err(_) => {
                    return Err(operation_conflict(
                        "duplicate_cleanup_rollback_source_unavailable",
                    ))
                }
            }
            journal.plans[index].removed = false;
            journal.plans[index].removal_started = false;
        }
        persist_duplicate_cleanup(facade, record, journal, OperationPhase::Applying)?;
    }
    Ok(())
}

fn verify_duplicate_cleanup_rescan(
    facade: &LocalApplicationFacade,
    journal: &DuplicateCleanupJournal,
) -> AppResult<()> {
    let (analysis, snapshots) = facade.scan_usage_environment_state()?;
    let preview = journal
        .prepared
        .duplicate_cleanup
        .as_ref()
        .ok_or_else(|| operation_conflict("duplicate_cleanup_preview_missing"))?;
    let environments = preview
        .problem
        .environment_results
        .iter()
        .map(|result| usage_environment_identity(&result.environment))
        .collect::<BTreeSet<_>>();
    for snapshot in snapshots.iter().filter(|snapshot| {
        environments.contains(&usage_environment_identity(&snapshot.environment))
    }) {
        if !snapshot.probe_limitations.is_empty() {
            return Err(operation_conflict("duplicate_cleanup_rescan_incomplete"));
        }
    }
    let selected = preview
        .selected_entry_keys
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if analysis.problems.iter().any(|problem| {
        problem
            .entries
            .iter()
            .any(|entry| selected.contains(&usage_entry_key(entry)))
    }) {
        return Err(operation_conflict("duplicate_cleanup_still_pending"));
    }
    Ok(())
}

fn persist_duplicate_cleanup(
    facade: &LocalApplicationFacade,
    record: &mut OperationRecord,
    journal: &DuplicateCleanupJournal,
    phase: OperationPhase,
) -> AppResult<()> {
    let database = facade
        .database
        .lock()
        .map_err(|_| internal("duplicate_cleanup.persist.database"))?;
    record.recovery_data = serde_json::to_value(journal).map_err(serialization_error)?;
    set_phase(
        record,
        phase,
        journal.completed.len() as u32,
        journal.plans.len() as u32,
    );
    database.operation_repository().update_sync(record)
}

fn verify_duplicate_backup_anchor(journal: &DuplicateCleanupJournal) -> AppResult<PathBuf> {
    let anchor = journal
        .backup_anchor_chain
        .nodes
        .first()
        .map(|node| PathBuf::from(&node.path))
        .ok_or_else(|| operation_conflict("usage_backup_anchor_unverified"))?;
    let metadata = fs::symlink_metadata(&anchor)
        .map_err(|_| operation_conflict("usage_backup_anchor_identity_changed"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || capture_path_chain(&anchor)? != journal.backup_anchor_chain
        || anchor.file_name().and_then(|name| name.to_str()) != Some(".skillhub")
    {
        return Err(operation_conflict("usage_backup_anchor_identity_changed"));
    }
    Ok(anchor)
}

fn verify_duplicate_backup_path(plan: &DuplicateCleanupPlan, anchor: &Path) -> AppResult<()> {
    let backup = Path::new(&plan.backup_path);
    let parent = backup
        .parent()
        .ok_or_else(|| operation_conflict("duplicate_cleanup_backup_path_invalid"))?;
    if !backup.starts_with(anchor) || parent.exists() || fs::symlink_metadata(backup).is_ok() {
        return Err(operation_conflict("duplicate_cleanup_backup_path_invalid"));
    }
    Ok(())
}

fn verify_duplicate_destination_parent(plan: &DuplicateCleanupPlan) -> AppResult<()> {
    let destination = Path::new(
        plan.destination_path
            .as_deref()
            .ok_or_else(|| operation_conflict("duplicate_cleanup_destination_invalid"))?,
    );
    let parent = destination
        .parent()
        .ok_or_else(|| operation_conflict("duplicate_cleanup_destination_invalid"))?;
    if plan.destination_parent_chain.as_ref() != Some(&capture_path_chain(parent)?)
        || fs::symlink_metadata(destination).is_ok()
    {
        return Err(operation_conflict("duplicate_cleanup_destination_changed"));
    }
    Ok(())
}

fn duplicate_entry_fingerprint(facade: &LocalApplicationFacade, path: &Path) -> AppResult<String> {
    facade
        .library_runtime
        .snapshot()?
        .store
        .hash_tree_read_only(path)
        .map_err(|_| operation_conflict("duplicate_cleanup_fingerprint_unavailable"))
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
                derived_skill_id: None,
                recovery_operation_id: None,
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

pub(crate) fn rollback_duplicate_cleanup_operation(
    database: &Database,
    operation_id: OperationId,
) -> AppResult<()> {
    let mut record = database
        .operation_repository()
        .get_sync(operation_id)?
        .ok_or_else(|| operation_conflict("duplicate_cleanup_recovery_missing"))?;
    if record.kind != DUPLICATE_CLEANUP_KIND {
        return Ok(());
    }
    if !matches!(
        record.phase,
        OperationPhase::Prepared
            | OperationPhase::Applying
            | OperationPhase::Verifying
            | OperationPhase::NeedsRecovery
    ) {
        return Err(operation_conflict("duplicate_cleanup_not_recoverable"));
    }
    let mut journal: DuplicateCleanupJournal = serde_json::from_value(record.recovery_data.clone())
        .map_err(|_| operation_conflict("duplicate_cleanup_journal_invalid"))?;
    let anchor = verify_duplicate_backup_anchor(&journal)?;
    let library_root = anchor
        .parent()
        .ok_or_else(|| operation_conflict("usage_backup_anchor_identity_changed"))?;
    let library = CentralLibrary::open_existing(library_root)
        .map_err(|_| operation_conflict("usage_backup_anchor_identity_changed"))?;
    let store = VersionStore::from_library(&library);

    for index in (0..journal.plans.len()).rev() {
        let plan = journal.plans[index].clone();
        let fingerprint = |path: &Path| -> AppResult<String> {
            store
                .hash_tree_read_only(path)
                .map_err(|_| operation_conflict("duplicate_cleanup_fingerprint_unavailable"))
        };
        if plan.destination_started || plan.destination_created {
            let destination = Path::new(
                plan.destination_path
                    .as_deref()
                    .ok_or_else(|| operation_conflict("duplicate_cleanup_journal_invalid"))?,
            );
            let parent = destination
                .parent()
                .ok_or_else(|| operation_conflict("duplicate_cleanup_destination_invalid"))?;
            if plan.destination_parent_chain.as_ref() != Some(&capture_path_chain(parent)?) {
                return Err(operation_conflict("duplicate_cleanup_destination_changed"));
            }
            match fs::symlink_metadata(destination) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink()
                        || !metadata.is_dir()
                        || fingerprint(destination)?.as_str() != plan.fingerprint
                    {
                        return Err(operation_conflict("duplicate_cleanup_destination_changed"));
                    }
                    remove_plain_entry(destination)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(operation_conflict("duplicate_cleanup_destination_changed")),
            }
            journal.plans[index].destination_started = false;
            journal.plans[index].destination_created = false;
        }

        if plan.removal_started {
            if !plan.backup_created {
                return Err(operation_conflict("duplicate_cleanup_backup_missing"));
            }
            let backup = Path::new(&plan.backup_path);
            if fingerprint(backup)?.as_str() != plan.fingerprint {
                return Err(operation_conflict(
                    "duplicate_cleanup_backup_verification_failed",
                ));
            }
            let source = Path::new(&plan.source_path);
            let parent = source
                .parent()
                .ok_or_else(|| operation_conflict("duplicate_cleanup_entry_parent_missing"))?;
            if capture_path_chain(parent)? != plan.source_parent_chain {
                return Err(operation_conflict("duplicate_cleanup_entry_parent_changed"));
            }
            match fs::symlink_metadata(source) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink()
                        || !metadata.is_dir()
                        || fingerprint(source)?.as_str() != plan.fingerprint
                    {
                        return Err(operation_conflict(
                            "duplicate_cleanup_rollback_source_changed",
                        ));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    restore_entry(backup, source)?;
                }
                Err(_) => {
                    return Err(operation_conflict(
                        "duplicate_cleanup_rollback_source_unavailable",
                    ))
                }
            }
            journal.plans[index].removed = false;
            journal.plans[index].removal_started = false;
        }
        persist_duplicate_cleanup_database(
            database,
            &mut record,
            &journal,
            OperationPhase::NeedsRecovery,
        )?;
    }

    set_phase(
        &mut record,
        OperationPhase::RolledBack,
        journal.plans.len() as u32,
        journal.plans.len() as u32,
    );
    record.recovery_data = serde_json::to_value(journal).map_err(serialization_error)?;
    database.operation_repository().update_sync(&record)
}

fn persist_duplicate_cleanup_database(
    database: &Database,
    record: &mut OperationRecord,
    journal: &DuplicateCleanupJournal,
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
        derived_skill_id: None,
        recovery_operation_id: None,
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
        || !request.selected_relation_ids.is_empty()
        || !request.confirmed_shared_relation_ids.is_empty()
        || request.non_recognized_destination.is_some()
    {
        return Err(operation_conflict("usage_change_field_not_applicable"));
    }
    Ok(())
}

fn validate_subject_rename_request(request: &PrepareUsageChange) -> AppResult<()> {
    let fields_match = request.action == UsageChangeAction::RenameSubject
        && request.skill_id.is_some()
        && request
            .runtime_name
            .as_deref()
            .is_some_and(|name| !name.trim().is_empty())
        && request.relation_ids.is_empty()
        && request.problem_id.is_none()
        && request.requested_form.is_none()
        && request.copy_disposition.is_none()
        && request.content_basis.is_none()
        && request.retain_entry_key.is_none()
        && request.selected_entry_keys.is_empty()
        && request.base_version_id.is_none()
        && request.selected_relation_ids.is_empty()
        && request.confirmed_shared_relation_ids.is_empty()
        && request.non_recognized_destination.is_none();
    if fields_match {
        Ok(())
    } else {
        Err(operation_conflict("subject_rename_request_invalid"))
    }
}

fn validate_derived_rename_request(request: &PrepareUsageChange) -> AppResult<()> {
    let selected = request
        .selected_relation_ids
        .iter()
        .collect::<BTreeSet<_>>();
    let confirmed = request
        .confirmed_shared_relation_ids
        .iter()
        .collect::<BTreeSet<_>>();
    let fields_match = request.action == UsageChangeAction::DeriveAndReplace
        && request.skill_id.is_some()
        && request.base_version_id.is_some()
        && request
            .runtime_name
            .as_deref()
            .is_some_and(|name| !name.trim().is_empty())
        && request.relation_ids.is_empty()
        && request.problem_id.is_none()
        && request.requested_form.is_none()
        && request.copy_disposition.is_none()
        && request.content_basis.is_none()
        && request.retain_entry_key.is_none()
        && request.selected_entry_keys.is_empty()
        && request.non_recognized_destination.is_none()
        && !selected.is_empty()
        && selected.len() == request.selected_relation_ids.len()
        && confirmed.len() == request.confirmed_shared_relation_ids.len()
        && confirmed.is_subset(&selected);
    if fields_match {
        Ok(())
    } else {
        Err(operation_conflict("derived_rename_request_invalid"))
    }
}

fn validate_managed_usage_change_request(request: &PrepareUsageChange) -> AppResult<()> {
    let mut relation_ids = BTreeSet::new();
    let content_basis_valid = match request.action {
        UsageChangeAction::Sync | UsageChangeAction::Repair => matches!(
            request.content_basis,
            None | Some(UsageContentBasis::LibraryCurrent)
        ),
        UsageChangeAction::Restore => request.content_basis.is_none(),
        UsageChangeAction::Release
        | UsageChangeAction::Manage
        | UsageChangeAction::ResolveDuplicate
        | UsageChangeAction::MigrateSharedUsage => false,
        UsageChangeAction::RenameSubject => false,
        UsageChangeAction::DeriveAndReplace => false,
    };
    if !matches!(
        request.action,
        UsageChangeAction::Sync | UsageChangeAction::Repair | UsageChangeAction::Restore
    ) || request.relation_ids.is_empty()
        || request
            .relation_ids
            .iter()
            .any(|relation_id| relation_id.trim().is_empty() || !relation_ids.insert(relation_id))
        || !content_basis_valid
        || request.problem_id.is_some()
        || request.skill_id.is_some()
        || request.requested_form.is_some()
        || request.copy_disposition.is_some()
        || request.retain_entry_key.is_some()
        || !request.selected_entry_keys.is_empty()
        || request.runtime_name.is_some()
        || request.base_version_id.is_some()
        || !request.selected_relation_ids.is_empty()
        || !request.confirmed_shared_relation_ids.is_empty()
        || request.non_recognized_destination.is_some()
    {
        return Err(operation_conflict("managed_usage_change_selection_invalid"));
    }
    Ok(())
}

fn managed_target_plan(
    backend: &super::LocalDeploymentBackend,
    deployment: &skillhub_core::DeploymentRecord,
    version_id: &VersionId,
    destination: &Path,
) -> AppResult<TargetPlan> {
    let library = backend.library_runtime.snapshot()?;
    let source = library
        .root
        .join("versions")
        .join(deployment.skill_id.to_string())
        .join(version_id.as_str());
    let mut target = TargetPlan {
        physical_target_id: deployment.target_id.clone(),
        logical_target_ids: Vec::new(),
        target_path: destination
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_string_lossy()
            .into_owned(),
        destination_path: destination.to_string_lossy().into_owned(),
        source_path: source.to_string_lossy().into_owned(),
        runtime_name: deployment.runtime_name.clone(),
        skill_id: deployment.skill_id,
        version_id: version_id.clone(),
        mode: deployment.mode,
        change: TargetChange::Create,
        warnings: Vec::new(),
        conflicts: Vec::new(),
    };
    let materialized = backend.materialized_source(&target)?;
    target.source_path = materialized.to_string_lossy().into_owned();
    Ok(target)
}

fn entry_fingerprint(path: &Path) -> AppResult<Option<String>> {
    match fs::symlink_metadata(path) {
        Ok(_) => DeploymentFilesystem::hash_tree(path).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(operation_conflict_with(
            "managed_usage_change_target_unavailable",
            error.to_string(),
        )),
    }
}

fn entry_identity(path: &Path) -> AppResult<Option<String>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(operation_conflict_with(
                "managed_usage_change_target_unavailable",
                error.to_string(),
            ));
        }
    };
    let identity = if metadata.file_type().is_symlink() {
        symlink_physical_id_for_path(path)
    } else if DeploymentFilesystem::is_directory_link_entry(path) {
        reparse_physical_id_for_path(path)
    } else {
        skillhub_core::physical_id_for_path(path)
    };
    identity
        .map(Some)
        .ok_or_else(|| operation_conflict("managed_usage_change_target_identity_unavailable"))
}

fn backup_entry(source: &Path, backup: &Path) -> AppResult<()> {
    let metadata = fs::symlink_metadata(source).map_err(|error| {
        operation_conflict_with("usage_backup_source_unavailable", error.to_string())
    })?;
    if metadata.file_type().is_symlink() || DeploymentFilesystem::is_directory_link_entry(source) {
        return Err(operation_conflict("usage_backup_link_unsupported"));
    }
    if fs::symlink_metadata(backup).is_ok() {
        return Err(operation_conflict("usage_backup_path_occupied"));
    }
    let parent = backup
        .parent()
        .ok_or_else(|| operation_conflict("usage_backup_parent_missing"))?;
    fs::create_dir_all(parent)
        .map_err(|error| operation_conflict_with("usage_backup_unavailable", error.to_string()))?;
    if metadata.is_dir() {
        super::copy_directory_tree(source, backup)?;
    } else if metadata.is_file() {
        fs::copy(source, backup).map_err(|error| {
            operation_conflict_with("usage_backup_unavailable", error.to_string())
        })?;
    } else {
        return Err(operation_conflict("usage_backup_entry_unsupported"));
    }
    if entry_fingerprint(source)? != entry_fingerprint(backup)? {
        return Err(operation_conflict("usage_backup_verification_failed"));
    }
    Ok(())
}

fn restore_entry(backup: &Path, destination: &Path) -> AppResult<()> {
    if fs::symlink_metadata(destination).is_ok() {
        return Err(operation_conflict("usage_restore_destination_occupied"));
    }
    let metadata = fs::symlink_metadata(backup).map_err(|error| {
        operation_conflict_with("usage_backup_verification_failed", error.to_string())
    })?;
    if metadata.file_type().is_symlink() || DeploymentFilesystem::is_directory_link_entry(backup) {
        return Err(operation_conflict("usage_backup_verification_failed"));
    }
    if metadata.is_dir() {
        super::copy_directory_tree(backup, destination)?;
    } else if metadata.is_file() {
        fs::copy(backup, destination)
            .map_err(|error| operation_conflict_with("usage_restore_failed", error.to_string()))?;
    } else {
        return Err(operation_conflict("usage_backup_verification_failed"));
    }
    if entry_fingerprint(backup)? != entry_fingerprint(destination)? {
        return Err(operation_conflict("usage_restore_verification_failed"));
    }
    Ok(())
}

fn remove_plain_entry(path: &Path) -> AppResult<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(operation_conflict_with(
                "usage_change_target_unavailable",
                error.to_string(),
            ));
        }
    };
    if metadata.file_type().is_symlink() || DeploymentFilesystem::is_directory_link_entry(path) {
        return Err(operation_conflict("usage_change_target_is_link"));
    }
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|error| {
            operation_conflict_with("usage_change_target_remove_failed", error.to_string())
        })
    } else if metadata.is_file() {
        fs::remove_file(path).map_err(|error| {
            operation_conflict_with("usage_change_target_remove_failed", error.to_string())
        })
    } else {
        Err(operation_conflict("usage_change_target_unsupported"))
    }
}

fn remove_created_entry(
    filesystem: &DeploymentFilesystem,
    path: &Path,
    mode: DeploymentMode,
) -> AppResult<()> {
    if fs::symlink_metadata(path).is_err() {
        return Ok(());
    }
    if DeploymentFilesystem::is_directory_link_entry(path) {
        filesystem.remove_residue(path, mode)
    } else {
        remove_plain_entry(path)
    }
}

fn operation_conflict_with(reason: &str, detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("reason", reason)
        .with_param("detail", detail.into())
        .with_action(RecoveryAction::InspectTarget)
}

fn validate_manage_request(request: &PrepareUsageChange) -> AppResult<()> {
    let mut relation_ids = BTreeSet::new();
    if request.action != UsageChangeAction::Manage
        || request.relation_ids.is_empty()
        || request
            .relation_ids
            .iter()
            .any(|relation_id| relation_id.trim().is_empty() || !relation_ids.insert(relation_id))
        || request.requested_form.is_none()
        || request.problem_id.is_some()
        || request.skill_id.is_some()
        || request.copy_disposition.is_some()
        || request.content_basis.is_none()
        || request.retain_entry_key.is_some()
        || !request.selected_entry_keys.is_empty()
        || request.runtime_name.is_some()
        || request.base_version_id.is_some()
        || !request.selected_relation_ids.is_empty()
        || !request.confirmed_shared_relation_ids.is_empty()
        || request.non_recognized_destination.is_some()
    {
        return Err(operation_conflict("usage_change_selection_invalid"));
    }
    Ok(())
}

fn request_fingerprint(request: &PrepareUsageChange) -> AppResult<String> {
    let encoded = serde_json::to_vec(request).map_err(serialization_error)?;
    let digest = Sha256::digest(encoded);
    Ok(format!("sha256:{digest:x}"))
}

fn renamed_skill(journal: &SubjectRenameJournal) -> AppResult<skillhub_core::catalog::Skill> {
    let runtime_name = journal
        .prepared
        .subject_rename
        .as_ref()
        .ok_or_else(|| operation_conflict("subject_rename_preview_missing"))?
        .runtime_name
        .clone();
    let mut skill = journal.original_skill.clone();
    skill.set_runtime_name(runtime_name)?;
    Ok(skill)
}

fn rename_skill_frontmatter(path: &Path, runtime_name: &str) -> AppResult<()> {
    let content = fs::read_to_string(path).map_err(subject_rename_io_error)?;
    let renamed = rename_skill_frontmatter_content(&content, runtime_name)?;
    fs::write(path, renamed).map_err(subject_rename_io_error)
}

fn rename_skill_frontmatter_content(content: &str, runtime_name: &str) -> AppResult<String> {
    let mut lines = content
        .split_inclusive('\n')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if lines.is_empty() || lines[0].trim_end_matches(['\r', '\n']) != "---" {
        return Err(operation_conflict("subject_rename_frontmatter_missing"));
    }
    let closing = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, line)| line.trim_end_matches(['\r', '\n']) == "---")
        .map(|(index, _)| index)
        .ok_or_else(|| operation_conflict("subject_rename_frontmatter_unclosed"))?;
    let name_lines = (1..closing)
        .filter(|index| {
            let content = lines[*index].trim_end_matches(['\r', '\n']);
            let key = content.trim_start();
            key.strip_prefix("name:").is_some_and(|value| {
                value.is_empty() || value.chars().next().is_some_and(char::is_whitespace)
            })
        })
        .collect::<Vec<_>>();
    if name_lines.len() != 1 {
        return Err(operation_conflict(
            "subject_rename_frontmatter_name_ambiguous",
        ));
    }
    let index = name_lines[0];
    let line = &lines[index];
    let line_ending = if line.ends_with("\r\n") {
        "\r\n"
    } else if line.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    let content = line.trim_end_matches(['\r', '\n']);
    let indent_len = content.len() - content.trim_start().len();
    let simple_scalar = !runtime_name.is_empty()
        && runtime_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && !runtime_name.starts_with('-')
        && !runtime_name.bytes().all(|byte| byte.is_ascii_digit())
        && !matches!(
            runtime_name.to_ascii_lowercase().as_str(),
            "true" | "false" | "null"
        );
    let scalar = if simple_scalar {
        runtime_name.to_owned()
    } else {
        serde_json::to_string(runtime_name).map_err(serialization_error)?
    };
    lines[index] = format!("{}name: {scalar}{line_ending}", &content[..indent_len]);
    Ok(lines.concat())
}

fn persist_subject_rename(
    facade: &LocalApplicationFacade,
    record: &mut OperationRecord,
    journal: &SubjectRenameJournal,
    phase: OperationPhase,
) -> AppResult<()> {
    record.recovery_data = serde_json::to_value(journal).map_err(serialization_error)?;
    let completed = journal
        .plans
        .iter()
        .filter(|plan| {
            plan.created_new_entry || plan.moved_previous_entry || plan.deployment_record_updated
        })
        .count() as u32;
    set_phase(record, phase, completed, journal.plans.len() as u32);
    let database = facade
        .database
        .lock()
        .map_err(|_| internal("subject_rename.persist.database"))?;
    database.operation_repository().update_sync(record)
}

fn subject_rename_result(journal: &SubjectRenameJournal) -> UsageChangeResult {
    UsageChangeResult {
        operation_id: journal.prepared.operation_id,
        prepared_id: journal.prepared.prepared_id,
        item_results: journal
            .prepared
            .impacts
            .iter()
            .map(|impact| UsageChangeItemResult {
                relation_ids: impact.relation_ids.clone(),
                skill_id: impact.skill_id,
                target: impact.target.clone(),
                action: impact.action,
                status: UsageChangeItemStatus::Applied,
                reason: None,
                recovery_point: None,
            })
            .collect(),
        recovery_required: false,
        derived_skill_id: None,
        recovery_operation_id: None,
    }
}

fn rollback_subject_rename_state(
    facade: &LocalApplicationFacade,
    journal: &mut SubjectRenameJournal,
) -> AppResult<()> {
    let library = facade.library_runtime.snapshot()?;
    let restored_skill = &journal.original_skill;
    let renamed = renamed_skill(journal)?;
    let renamed_visible = library.central.visible_skill_path(&renamed);
    let filesystem = DeploymentFilesystem::new();
    let new_hash = journal.new_target_hash.as_deref();

    for plan in journal.plans.iter().rev() {
        let previous = Path::new(&plan.previous_path);
        let destination = Path::new(&plan.path);
        let backup = Path::new(&plan.backup_path);
        let root = facade.backend.target_root(&plan.original_deployment)?;
        if skillhub_core::physical_id_for_path(&root).as_deref()
            != Some(plan.target_root_identity.as_str())
        {
            return Err(operation_conflict("subject_rename_target_identity_changed"));
        }

        if fs::symlink_metadata(destination).is_ok() {
            let expected_hash = new_hash
                .ok_or_else(|| operation_conflict("subject_rename_version_hash_missing"))?;
            if entry_fingerprint(destination)?.as_deref() != Some(expected_hash) {
                return Err(operation_conflict("subject_rename_target_changed"));
            }
            if matches!(
                plan.mode,
                DeploymentMode::SymbolicLink | DeploymentMode::DirectoryJunction
            ) && fs::canonicalize(destination).ok() != fs::canonicalize(&renamed_visible).ok()
            {
                return Err(operation_conflict("subject_rename_target_link_changed"));
            }
            filesystem.remove_residue(destination, plan.mode)?;
        }

        if fs::symlink_metadata(backup).is_ok() {
            if entry_identity(backup)? != plan.observed_identity {
                return Err(operation_conflict("subject_rename_backup_changed"));
            }
            if plan.mode == DeploymentMode::ManagedCopy
                && entry_fingerprint(backup)?.as_deref() != plan.observed_before.as_deref()
            {
                return Err(operation_conflict("subject_rename_backup_changed"));
            }
            if fs::symlink_metadata(previous).is_ok() {
                return Err(operation_conflict("subject_rename_previous_path_occupied"));
            }
            fs::rename(backup, previous).map_err(subject_rename_io_error)?;
        } else if fs::symlink_metadata(previous).is_err()
            || entry_identity(previous)? != plan.observed_identity
            || (plan.mode == DeploymentMode::ManagedCopy
                && entry_fingerprint(previous)?.as_deref() != plan.observed_before.as_deref())
        {
            return Err(operation_conflict(
                "subject_rename_previous_entry_unavailable",
            ));
        }

        let current =
            facade.with_database("subject_rename.rollback.deployment_read", |database| {
                Ok(database
                    .deployment_repository()
                    .list_all()?
                    .into_iter()
                    .find(|deployment| deployment.id.to_string() == plan.deployment_id))
            })?;
        let current =
            current.ok_or_else(|| operation_conflict("subject_rename_deployment_missing"))?;
        if current.runtime_name == plan.runtime_name {
            facade.with_database("subject_rename.rollback.deployment", |database| {
                database
                    .deployment_repository()
                    .rename_runtime_sync(&plan.original_deployment, &plan.runtime_name)
            })?;
        } else if current != plan.original_deployment {
            return Err(operation_conflict("subject_rename_deployment_changed"));
        }
    }

    if let Some(rename) = journal.visible_rename.as_ref() {
        let previous_exists = fs::symlink_metadata(&rename.previous_output).is_ok();
        let backup_exists = fs::symlink_metadata(&rename.backup).is_ok();
        match (previous_exists, backup_exists) {
            (true, false) => {
                if library.store.hash_tree_read_only(&rename.previous_output)?
                    != journal.original_visible_hash
                {
                    return Err(operation_conflict(
                        "subject_rename_visible_original_changed",
                    ));
                }
            }
            (false, true) => library.central.rollback_visible_skill_rename(rename)?,
            _ => {
                return Err(operation_conflict(
                    "subject_rename_visible_recovery_paths_changed",
                ))
            }
        }
    }

    if let Some(new_version_id) = journal.new_version_id.as_ref() {
        let store_current = library.current(restored_skill.id())?;
        if store_current.as_ref() == Some(new_version_id) {
            library
                .store
                .set_current(restored_skill.id(), &journal.previous_version_id)?;
        } else if store_current.as_ref() != Some(&journal.previous_version_id) {
            return Err(operation_conflict("subject_rename_store_pointer_changed"));
        }
        facade.with_database(
            "subject_rename.rollback.version_pointer",
            |database| match database.current_version(restored_skill.id())? {
                Some(current) if &current == new_version_id => database
                    .restore_current_version_pointer(
                        restored_skill.id(),
                        Some(&journal.previous_version_id),
                    ),
                Some(current) if current == journal.previous_version_id => Ok(()),
                _ => Err(operation_conflict(
                    "subject_rename_database_pointer_changed",
                )),
            },
        )?;
    }

    facade.with_database("subject_rename.rollback.catalog", |database| {
        let repository = database.catalog_repository()?;
        match repository.get_sync(restored_skill.id())? {
            Some(current) if current.runtime_name() == renamed.runtime_name() => {
                repository.insert_sync(restored_skill)
            }
            Some(current) if current == *restored_skill => Ok(()),
            _ => Err(operation_conflict("subject_rename_catalog_changed")),
        }
    })?;
    let portable = library.central.load_portable_skill(restored_skill.id())?;
    if portable
        .as_ref()
        .is_none_or(|(record, _)| record.runtime_name == renamed.runtime_name())
    {
        library
            .central
            .save_portable_skill(restored_skill, Some(&journal.previous_version_id))?;
    } else if portable.as_ref().is_some_and(|(record, current)| {
        record.runtime_name != restored_skill.runtime_name()
            || current.as_ref() != Some(&journal.previous_version_id)
    }) {
        return Err(operation_conflict(
            "subject_rename_portable_catalog_changed",
        ));
    }
    if let Some(staging_path) = journal.staging_path.as_ref() {
        let expected = skillhub_core::LibraryPaths::from_root(library.root.clone())
            .tmp_dir
            .join(format!(
                "subject-runtime-rename-{}-{}",
                restored_skill.id(),
                journal.request.operation_id
            ));
        if Path::new(staging_path) != expected {
            return Err(operation_conflict("subject_rename_staging_path_changed"));
        }
        if fs::symlink_metadata(&expected).is_ok() {
            if !fs::symlink_metadata(&expected)
                .map_err(subject_rename_io_error)?
                .is_dir()
            {
                return Err(operation_conflict("subject_rename_staging_path_changed"));
            }
            fs::remove_dir_all(expected).map_err(subject_rename_io_error)?;
        }
        journal.staging_path = None;
    }
    Ok(())
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

fn subject_rename_io_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("reason", "subject_rename_io_failed")
        .with_param("detail", error.to_string())
        .with_action(RecoveryAction::InspectTarget)
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
