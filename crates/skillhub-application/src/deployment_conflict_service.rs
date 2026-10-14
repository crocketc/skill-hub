use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use skillhub_adapters::deployment::{DeploymentFilesystem, OwnershipProof};
use skillhub_core::api::DeploymentPairPreview;
use skillhub_core::catalog::CatalogRepository;
use skillhub_core::deployment::{DeploymentRecord, DeploymentState, TargetPlan};
use skillhub_core::{
    AppError, AppResult, DeploymentId, ErrorCode, OperationId, RecoveryAction, Severity,
};
use skillhub_storage::{Database, LibraryPaths};

use crate::library_runtime::LibraryRuntime;

pub(crate) const OPERATION_KIND: &str = "deployment_conflict_replace";
pub(crate) const UNKNOWN_REPLACEMENT_KIND: &str = "deployment_conflict_unknown_replace";
pub(crate) const BACKUP_RESTORE_KIND: &str = "deployment_conflict_backup_restore";

#[derive(Clone, Debug)]
pub(crate) struct ReplacementReceipt {
    pub operation_id: OperationId,
    pub deployment_id: DeploymentId,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReplacementCheckpoint {
    CopyPrepared,
    OriginalBackedUp,
    ReplacementApplied,
    ReplacementInstalled,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoverySnapshot {
    schema_version: u8,
    pair_id: String,
    target: TargetPlan,
    target_root: PathBuf,
    target_root_identity: String,
    stage_path: PathBuf,
    copy_stage_path: Option<PathBuf>,
    backup_path: PathBuf,
    original_deployment: DeploymentRecord,
    original_ownership: OwnershipSnapshot,
    replacement_deployment: DeploymentRecord,
    prepared_copy_ownership: Option<OwnershipSnapshot>,
    replacement_ownership: Option<OwnershipSnapshot>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum EntryKind {
    Directory,
    File,
    SymbolicLink,
    DirectoryLink,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct EntrySnapshot {
    kind: EntryKind,
    identity: String,
    content_fingerprint: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DurableBackupSnapshot {
    schema_version: u8,
    backup_id: String,
    pair_id: String,
    target_root: PathBuf,
    target_root_identity: String,
    destination_path: PathBuf,
    backup_path: PathBuf,
    target_label: String,
    entry_name: String,
    entry: EntrySnapshot,
    deployment: Option<DeploymentRecord>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct UnknownReplacementSnapshot {
    schema_version: u8,
    pair_id: String,
    target: TargetPlan,
    target_root: PathBuf,
    target_root_identity: String,
    destination_path: PathBuf,
    stage_path: PathBuf,
    copy_stage_path: Option<PathBuf>,
    original: EntrySnapshot,
    backup: DurableBackupSnapshot,
    replacement_deployment: DeploymentRecord,
    previous_deployment: Option<DeploymentRecord>,
    prepared_copy_ownership: Option<OwnershipSnapshot>,
    replacement_ownership: Option<OwnershipSnapshot>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct BackupRestoreSnapshot {
    schema_version: u8,
    selected_backup: DurableBackupSnapshot,
    current_backup: DurableBackupSnapshot,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnershipSnapshot {
    mode: skillhub_core::DeploymentMode,
    destination_path: PathBuf,
    source_path: PathBuf,
    expected_hash: String,
    target_identity: String,
    link_anchor_paths: Vec<PathBuf>,
    skill_id: skillhub_core::SkillId,
    version_id: skillhub_core::VersionId,
    runtime_name: String,
}

impl From<&OwnershipProof> for OwnershipSnapshot {
    fn from(proof: &OwnershipProof) -> Self {
        Self {
            mode: proof.mode,
            destination_path: proof.destination_path.clone(),
            source_path: proof.source_path.clone(),
            expected_hash: proof.expected_hash.clone(),
            target_identity: proof.target_identity.clone(),
            link_anchor_paths: proof.link_anchor_paths.clone(),
            skill_id: proof.skill_id,
            version_id: proof.version_id.clone(),
            runtime_name: proof.runtime_name.clone(),
        }
    }
}

impl OwnershipSnapshot {
    fn proof_at(&self, destination_path: PathBuf) -> OwnershipProof {
        OwnershipProof {
            mode: self.mode,
            destination_path,
            source_path: self.source_path.clone(),
            expected_hash: self.expected_hash.clone(),
            target_identity: self.target_identity.clone(),
            link_anchor_paths: self.link_anchor_paths.clone(),
            skill_id: self.skill_id,
            version_id: self.version_id.clone(),
            runtime_name: self.runtime_name.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Position {
    Untouched,
    OriginalInBackup,
    ReplacementStaged,
    ReplacementInstalled { backup_exists: bool },
    OriginalRestored,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UnknownReplacementPosition {
    Untouched,
    OriginalAndReplacementStaged,
    OriginalInBackup,
    ReplacementStaged,
    ReplacementInstalled { database_accounted: bool },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BackupRestorePosition {
    Untouched,
    CurrentPreserved,
    SelectedRestored,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UnknownReplacementCheckpoint {
    ReplacementStaged,
    OriginalBackedUp,
    ReplacementInstalled,
    DeploymentAccounted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BackupRestoreCheckpoint {
    CurrentPreserved,
    SelectedRestored,
    DeploymentAccounted,
}

fn execute_unknown_conflict_action(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    operation_id: OperationId,
    pair: &DeploymentPairPreview,
    target: &TargetPlan,
) -> AppResult<ReplacementReceipt> {
    execute_unknown_conflict_action_with_checkpoint(
        database,
        library_runtime,
        operation_id,
        pair,
        target,
        |_| Ok(()),
    )
}

fn execute_unknown_conflict_action_with_checkpoint(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    operation_id: OperationId,
    pair: &DeploymentPairPreview,
    target: &TargetPlan,
    mut after_checkpoint: impl FnMut(UnknownReplacementCheckpoint) -> AppResult<()>,
) -> AppResult<ReplacementReceipt> {
    let occupant = single_unknown_occupant(pair)?;
    let destination = PathBuf::from(&target.destination_path);
    let target_root = PathBuf::from(&target.target_path);
    let expected_destination = target_root.join(&target.runtime_name);
    let root_identity = skillhub_core::physical_id_for_path(&target_root)
        .ok_or_else(|| changed("the target root identity is unavailable"))?;
    let current = entry_snapshot(&destination)?;
    if destination != expected_destination
        || target.physical_target_id != root_identity
        || pair.target_path != target.target_path
        || pair.runtime_name != target.runtime_name
        || pair.skill_id != target.skill_id
        || pair.version_id != target.version_id
        || occupant.target_path != destination.to_string_lossy()
        || occupant.physical_target_id != root_identity
        || occupant.entry_identity != current.identity
        || occupant.content_fingerprint.as_deref() != Some(&current.content_fingerprint)
    {
        return Err(changed("the unknown target no longer matches its preview"));
    }

    let previous_deployment = {
        let database = database
            .lock()
            .map_err(|_| internal("deployment_conflict.unknown.load_deployment"))?;
        database
            .deployment_repository()
            .list_all()?
            .into_iter()
            .find(|record| {
                record.target_id == target.physical_target_id
                    && record.runtime_name == target.runtime_name
            })
    };
    if previous_deployment
        .as_ref()
        .is_some_and(|record| record.state != DeploymentState::Removed || !record.managed)
    {
        return Err(changed("the unknown target has a deployment record"));
    }
    let backend =
        super::LocalDeploymentBackend::new(Arc::clone(database), Arc::clone(library_runtime));
    let source_path = backend.materialized_source(target)?;
    let expected_hash = DeploymentFilesystem::hash_tree(&source_path)?;
    let replacement_deployment = DeploymentRecord {
        id: previous_deployment
            .as_ref()
            .map(|record| record.id)
            .unwrap_or_else(DeploymentId::new),
        skill_id: target.skill_id,
        version_id: target.version_id.clone(),
        target_id: target.physical_target_id.clone(),
        state: DeploymentState::Deployed,
        mode: target.mode,
        managed: true,
        runtime_name: target.runtime_name.clone(),
        expected_hash,
        observed_hash: None,
    };
    let backup_path = target_root.join(format!(".skillhub-conflict-backup-{operation_id}"));
    let stage_path = target_root.join(format!(".skillhub-conflict-stage-{operation_id}"));
    let copy_stage_path = (target.mode == skillhub_core::DeploymentMode::ManagedCopy)
        .then(|| target_root.join(format!(".skillhub-conflict-copy-{operation_id}")));
    if entry_exists(&backup_path)?
        || entry_exists(&stage_path)?
        || copy_stage_path
            .as_deref()
            .map(entry_exists)
            .transpose()?
            .unwrap_or(false)
    {
        return Err(changed("a recovery path for this operation already exists"));
    }
    let backup = DurableBackupSnapshot {
        schema_version: 1,
        backup_id: OperationId::new().to_string(),
        pair_id: pair.pair_id.clone(),
        target_root: target_root.clone(),
        target_root_identity: root_identity.clone(),
        destination_path: destination.clone(),
        backup_path: backup_path.clone(),
        target_label: pair.target_label.clone(),
        entry_name: target.runtime_name.clone(),
        entry: current.clone(),
        deployment: None,
    };
    let mut snapshot = UnknownReplacementSnapshot {
        schema_version: 1,
        pair_id: pair.pair_id.clone(),
        target: target.clone(),
        target_root: target_root.clone(),
        target_root_identity: root_identity,
        destination_path: destination,
        stage_path: stage_path.clone(),
        copy_stage_path: copy_stage_path.clone(),
        original: current,
        backup,
        replacement_deployment,
        previous_deployment,
        prepared_copy_ownership: None,
        replacement_ownership: None,
    };
    persist_unknown_snapshot(
        database,
        operation_id,
        &snapshot,
        skillhub_core::OperationPhase::Prepared,
    )?;
    persist_unknown_snapshot(
        database,
        operation_id,
        &snapshot,
        skillhub_core::OperationPhase::Applying,
    )?;

    let mut staged_target = target.clone();
    staged_target.destination_path = stage_path.to_string_lossy().into_owned();
    staged_target.source_path = source_path.to_string_lossy().into_owned();
    staged_target.conflicts.clear();
    let filesystem = DeploymentFilesystem::new();
    let prepared =
        match filesystem.prepare_with_staging_path(&staged_target, copy_stage_path.clone()) {
            Ok(prepared) => prepared,
            Err(error) => {
                settle_unknown(
                    database,
                    operation_id,
                    skillhub_core::OperationPhase::RolledBack,
                )?;
                return Err(error);
            }
        };
    if let (Some(copy_path), Some(staging_path)) =
        (copy_stage_path.as_ref(), prepared.staging_path.as_ref())
    {
        let identity = filesystem.recovery_entry_identity(target.mode, staging_path)?;
        if copy_path != staging_path
            || DeploymentFilesystem::hash_tree(staging_path)? != prepared.expected_tree_hash
        {
            settle_unknown(
                database,
                operation_id,
                skillhub_core::OperationPhase::NeedsRecovery,
            )?;
            return Err(changed("the staged replacement does not match its journal"));
        }
        snapshot.prepared_copy_ownership = Some(OwnershipSnapshot {
            mode: target.mode,
            destination_path: copy_path.clone(),
            source_path: prepared.source_path.clone(),
            expected_hash: prepared.expected_tree_hash.clone(),
            target_identity: identity,
            link_anchor_paths: vec![prepared.source_path.clone()],
            skill_id: prepared.skill_id,
            version_id: prepared.version_id.clone(),
            runtime_name: prepared.runtime_name.clone(),
        });
    }
    persist_unknown_snapshot(
        database,
        operation_id,
        &snapshot,
        skillhub_core::OperationPhase::Applying,
    )?;
    if let Err(error) = after_checkpoint(UnknownReplacementCheckpoint::ReplacementStaged) {
        settle_unknown(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    if !entry_matches(&snapshot.destination_path, &snapshot.original)
        || skillhub_core::physical_id_for_path(&snapshot.target_root).as_deref()
            != Some(snapshot.target_root_identity.as_str())
    {
        let _ = cleanup_unknown_stages(&filesystem, &snapshot);
        settle_unknown(
            database,
            operation_id,
            skillhub_core::OperationPhase::RolledBack,
        )?;
        return Err(changed("the unknown target changed before replacement"));
    }
    let applied = match filesystem.apply(prepared) {
        Ok(applied) => applied,
        Err(error) => {
            let clean = cleanup_unknown_stages(&filesystem, &snapshot);
            settle_unknown(
                database,
                operation_id,
                if clean {
                    skillhub_core::OperationPhase::RolledBack
                } else {
                    skillhub_core::OperationPhase::NeedsRecovery
                },
            )?;
            return Err(error);
        }
    };
    if let Err(error) = filesystem.verify(&applied) {
        let _ = cleanup_unknown_stages(&filesystem, &snapshot);
        settle_unknown(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    snapshot.replacement_deployment.expected_hash = applied.ownership.expected_hash.clone();
    snapshot.replacement_deployment.observed_hash = Some(applied.observed_tree_hash.clone());
    snapshot.replacement_ownership = Some(OwnershipSnapshot::from(&applied.ownership));
    persist_unknown_snapshot(
        database,
        operation_id,
        &snapshot,
        skillhub_core::OperationPhase::Applying,
    )?;

    if !entry_matches(&snapshot.destination_path, &snapshot.original)
        || entry_exists(&snapshot.backup.backup_path)?
    {
        settle_unknown(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(changed(
            "the original entry changed before it was backed up",
        ));
    }
    if let Err(error) = std::fs::rename(&snapshot.destination_path, &snapshot.backup.backup_path) {
        let rollback = cleanup_unknown_stages(&filesystem, &snapshot)
            && entry_matches(&snapshot.destination_path, &snapshot.original);
        settle_unknown(
            database,
            operation_id,
            if rollback {
                skillhub_core::OperationPhase::RolledBack
            } else {
                skillhub_core::OperationPhase::NeedsRecovery
            },
        )?;
        return Err(filesystem_error("backup unknown deployment target", error));
    }
    if !entry_matches(&snapshot.backup.backup_path, &snapshot.original) {
        settle_unknown(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(changed(
            "the backed up original no longer matches its preview",
        ));
    }
    if let Err(error) = after_checkpoint(UnknownReplacementCheckpoint::OriginalBackedUp) {
        settle_unknown(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    let replacement_proof = snapshot
        .replacement_ownership
        .as_ref()
        .expect("replacement proof was checkpointed")
        .proof_at(snapshot.stage_path.clone());
    if let Err(error) = filesystem.rename_recovery_entry(
        target.mode,
        &snapshot.stage_path,
        &snapshot.destination_path,
        &replacement_proof.target_identity,
    ) {
        settle_unknown(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    let mut installed_proof = replacement_proof.clone();
    installed_proof.destination_path = snapshot.destination_path.clone();
    if let Err(error) = filesystem.verify_ownership(&installed_proof) {
        settle_unknown(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    if let Err(error) = after_checkpoint(UnknownReplacementCheckpoint::ReplacementInstalled) {
        settle_unknown(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    let effective_id = {
        let database = database
            .lock()
            .map_err(|_| internal("deployment_conflict.unknown.account"))?;
        super::LocalDeploymentBackend::ensure_targets_row(&database, &snapshot.target)?;
        database
            .deployment_repository()
            .insert_sync(&snapshot.replacement_deployment)?
    };
    if effective_id != snapshot.replacement_deployment.id {
        settle_unknown(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(changed("the managed deployment identity changed"));
    }
    if let Err(error) = after_checkpoint(UnknownReplacementCheckpoint::DeploymentAccounted) {
        settle_unknown(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    persist_unknown_snapshot(
        database,
        operation_id,
        &snapshot,
        skillhub_core::OperationPhase::Committed,
    )?;
    Ok(ReplacementReceipt {
        operation_id,
        deployment_id: effective_id,
    })
}

fn single_unknown_occupant(
    pair: &DeploymentPairPreview,
) -> AppResult<&skillhub_core::api::DeploymentConflictOccupant> {
    let occupants = &pair
        .conflict
        .as_ref()
        .ok_or_else(|| changed("the stored pair is not a conflict"))?
        .occupants;
    if occupants.len() != 1
        || occupants[0].ownership != skillhub_core::ExistingOwnership::Unknown
        || occupants[0].deployment_id.is_some()
        || occupants[0].skill_id.is_some()
        || occupants[0].version_id.is_some()
        || occupants[0].content_fingerprint.is_none()
    {
        return Err(changed(
            "the conflict occupant is not a verifiable unknown entry",
        ));
    }
    Ok(&occupants[0])
}

fn entry_snapshot(path: &Path) -> AppResult<EntrySnapshot> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| filesystem_error("inspect unknown deployment target", error))?;
    let file_type = metadata.file_type();
    let kind = if file_type.is_symlink() {
        EntryKind::SymbolicLink
    } else if DeploymentFilesystem::is_directory_link_entry(path) {
        EntryKind::DirectoryLink
    } else if file_type.is_dir() {
        EntryKind::Directory
    } else if file_type.is_file() {
        EntryKind::File
    } else {
        return Err(changed("this target entry type cannot be safely replaced"));
    };
    let identity = super::conflict_entry_identity(path)
        .ok_or_else(|| changed("the target entry identity is unavailable"))?;
    let content_fingerprint = super::conflict_content_fingerprint(path)
        .ok_or_else(|| changed("the target entry contents cannot be verified"))?;
    Ok(EntrySnapshot {
        kind,
        identity,
        content_fingerprint,
    })
}

pub(crate) fn can_backup_unknown_entry(path: &Path) -> bool {
    entry_snapshot(path).is_ok()
}

pub(crate) fn list_backups(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
) -> AppResult<Vec<skillhub_core::api::DeploymentConflictBackup>> {
    let records = {
        let database = database
            .lock()
            .map_err(|_| internal("deployment_conflict.backups.list"))?;
        database.operation_repository().list_sync()?
    };
    let mut backups = records
        .iter()
        .filter_map(durable_backup_from_record)
        .filter(|backup| durable_backup_is_restorable(database, library_runtime, backup))
        .map(|backup| skillhub_core::api::DeploymentConflictBackup {
            backup_id: backup.backup_id,
            target_label: backup.target_label,
            entry_name: backup.entry_name,
            entry_kind: match backup.entry.kind {
                EntryKind::Directory => {
                    skillhub_core::api::DeploymentConflictBackupEntryKind::Directory
                }
                EntryKind::File => skillhub_core::api::DeploymentConflictBackupEntryKind::File,
                EntryKind::SymbolicLink => {
                    skillhub_core::api::DeploymentConflictBackupEntryKind::SymbolicLink
                }
                EntryKind::DirectoryLink => {
                    skillhub_core::api::DeploymentConflictBackupEntryKind::DirectoryLink
                }
            },
        })
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| left.backup_id.cmp(&right.backup_id));
    Ok(backups)
}

pub(crate) fn restore_backup(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    backup_id: &str,
) -> AppResult<OperationId> {
    restore_backup_with_checkpoint(database, library_runtime, backup_id, |_| Ok(()))
}

fn restore_backup_with_checkpoint(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    backup_id: &str,
    mut after_checkpoint: impl FnMut(BackupRestoreCheckpoint) -> AppResult<()>,
) -> AppResult<OperationId> {
    if let Some(operation_id) = committed_restore_for_backup(database, backup_id)? {
        return Ok(operation_id);
    }
    let records = {
        let database = database
            .lock()
            .map_err(|_| internal("deployment_conflict.backups.restore_lookup"))?;
        database.operation_repository().list_sync()?
    };
    let selected_backup = records
        .iter()
        .filter_map(durable_backup_from_record)
        .find(|backup| backup.backup_id == backup_id)
        .ok_or_else(|| changed("the replaced content is no longer available"))?;
    if !durable_backup_is_restorable(database, library_runtime, &selected_backup) {
        return Err(changed("the replaced content or its target has changed"));
    }

    let active_deployment = active_deployment_at(
        database,
        &selected_backup.target_root_identity,
        &selected_backup.entry_name,
    )?;
    if selected_backup
        .deployment
        .as_ref()
        .zip(active_deployment.as_ref())
        .is_some_and(|(selected, active)| selected.id != active.id)
    {
        return Err(changed("the deployment identity changed since this backup"));
    }
    let current_entry = entry_snapshot(&selected_backup.destination_path)?;
    if let Some(deployment) = &active_deployment {
        verify_managed_entry_at(
            database,
            library_runtime,
            deployment,
            &selected_backup.destination_path,
        )?;
    }
    let operation_id = OperationId::new();
    let current_backup_path = selected_backup
        .target_root
        .join(format!(".skillhub-conflict-backup-{operation_id}"));
    if entry_exists(&current_backup_path)? {
        return Err(changed("a recovery path for this restore already exists"));
    }
    let current_backup = DurableBackupSnapshot {
        schema_version: 1,
        backup_id: OperationId::new().to_string(),
        pair_id: selected_backup.pair_id.clone(),
        target_root: selected_backup.target_root.clone(),
        target_root_identity: selected_backup.target_root_identity.clone(),
        destination_path: selected_backup.destination_path.clone(),
        backup_path: current_backup_path.clone(),
        target_label: selected_backup.target_label.clone(),
        entry_name: selected_backup.entry_name.clone(),
        entry: current_entry,
        deployment: active_deployment.clone(),
    };
    let snapshot = BackupRestoreSnapshot {
        schema_version: 1,
        selected_backup: selected_backup.clone(),
        current_backup,
    };
    persist_backup_restore_snapshot(
        database,
        operation_id,
        &snapshot,
        skillhub_core::OperationPhase::Applying,
    )?;

    if !backup_restore_accounting_matches(database, &snapshot, BackupRestoreAccounting::Current)? {
        settle_backup_restore(
            database,
            operation_id,
            skillhub_core::OperationPhase::RolledBack,
        )?;
        return Err(changed(
            "the deployment accounting changed before backup restore",
        ));
    }

    if !entry_matches(
        &snapshot.selected_backup.backup_path,
        &snapshot.selected_backup.entry,
    ) || !entry_matches(
        &snapshot.selected_backup.destination_path,
        &snapshot.current_backup.entry,
    ) {
        settle_backup_restore(
            database,
            operation_id,
            skillhub_core::OperationPhase::RolledBack,
        )?;
        return Err(changed(
            "the backup or current target changed before restore",
        ));
    }
    if let Err(error) = std::fs::rename(
        &snapshot.selected_backup.destination_path,
        &snapshot.current_backup.backup_path,
    ) {
        settle_backup_restore(
            database,
            operation_id,
            skillhub_core::OperationPhase::RolledBack,
        )?;
        return Err(filesystem_error(
            "preserve current deployment before restore",
            error,
        ));
    }
    if !entry_matches(
        &snapshot.current_backup.backup_path,
        &snapshot.current_backup.entry,
    ) {
        settle_backup_restore(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(changed("the current target changed while being preserved"));
    }
    if let Err(error) = after_checkpoint(BackupRestoreCheckpoint::CurrentPreserved) {
        settle_backup_restore(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    if let Err(error) = std::fs::rename(
        &snapshot.selected_backup.backup_path,
        &snapshot.selected_backup.destination_path,
    ) {
        settle_backup_restore(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(filesystem_error("restore replaced content", error));
    }
    if !entry_matches(
        &snapshot.selected_backup.destination_path,
        &snapshot.selected_backup.entry,
    ) {
        settle_backup_restore(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(changed("the restored entry no longer matches its backup"));
    }
    if let Err(error) = after_checkpoint(BackupRestoreCheckpoint::SelectedRestored) {
        settle_backup_restore(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    if let Some(deployment) = &snapshot.selected_backup.deployment {
        if let Err(error) = verify_managed_entry_at(
            database,
            library_runtime,
            deployment,
            &snapshot.selected_backup.destination_path,
        ) {
            settle_backup_restore(
                database,
                operation_id,
                skillhub_core::OperationPhase::NeedsRecovery,
            )?;
            return Err(error);
        }
    }
    if let Err(error) = account_backup_restore(database, &snapshot, true) {
        settle_backup_restore(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    if let Err(error) = after_checkpoint(BackupRestoreCheckpoint::DeploymentAccounted) {
        settle_backup_restore(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    persist_backup_restore_snapshot(
        database,
        operation_id,
        &snapshot,
        skillhub_core::OperationPhase::Committed,
    )?;
    Ok(operation_id)
}

fn durable_backup_from_record(
    record: &skillhub_core::OperationRecord,
) -> Option<DurableBackupSnapshot> {
    if record.phase != skillhub_core::OperationPhase::Committed {
        return None;
    }
    let backup = match record.kind.as_str() {
        UNKNOWN_REPLACEMENT_KIND => {
            serde_json::from_value::<UnknownReplacementSnapshot>(record.recovery_data.clone())
                .ok()
                .map(|snapshot| snapshot.backup)
        }
        BACKUP_RESTORE_KIND => {
            serde_json::from_value::<BackupRestoreSnapshot>(record.recovery_data.clone())
                .ok()
                .map(|snapshot| snapshot.current_backup)
        }
        _ => None,
    }?;
    let expected_backup_path = backup
        .target_root
        .join(format!(".skillhub-conflict-backup-{}", record.operation_id));
    (backup.schema_version == 1
        && !backup.backup_id.trim().is_empty()
        && !backup.pair_id.trim().is_empty()
        && !backup.entry_name.is_empty()
        && backup.destination_path == backup.target_root.join(&backup.entry_name)
        && backup.backup_path == expected_backup_path
        && backup.destination_path.parent() == Some(backup.target_root.as_path())
        && backup.backup_path.parent() == Some(backup.target_root.as_path()))
    .then_some(backup)
}

fn registered_target_path_matches(
    database: &Arc<Mutex<Database>>,
    target_id: &str,
    target_root: &Path,
) -> AppResult<bool> {
    let database = database
        .lock()
        .map_err(|_| internal("deployment_conflict.backups.target_path"))?;
    let paths = database.target_repository().paths_by_id()?;
    Ok(paths
        .get(target_id)
        .is_some_and(|registered_path| Path::new(registered_path) == target_root))
}

fn is_committed_backup_snapshot(
    database: &Arc<Mutex<Database>>,
    expected: &DurableBackupSnapshot,
) -> AppResult<bool> {
    let records = {
        let database = database
            .lock()
            .map_err(|_| internal("deployment_conflict.backups.verify_source"))?;
        database.operation_repository().list_sync()?
    };
    Ok(records
        .iter()
        .any(|record| durable_backup_from_record(record).as_ref() == Some(expected)))
}

fn durable_backup_is_restorable(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    backup: &DurableBackupSnapshot,
) -> bool {
    if backup.schema_version != 1
        || backup.backup_id.trim().is_empty()
        || backup.entry_name.is_empty()
        || backup.destination_path != backup.target_root.join(&backup.entry_name)
        || backup.destination_path.parent() != Some(backup.target_root.as_path())
        || backup.backup_path.parent() != Some(backup.target_root.as_path())
        || backup.backup_path == backup.destination_path
        || skillhub_core::physical_id_for_path(&backup.target_root).as_deref()
            != Some(backup.target_root_identity.as_str())
        || !registered_target_path_matches(
            database,
            &backup.target_root_identity,
            &backup.target_root,
        )
        .unwrap_or(false)
        || !entry_matches(&backup.backup_path, &backup.entry)
        || !entry_snapshot(&backup.destination_path).is_ok()
        || !is_committed_backup_snapshot(database, backup).unwrap_or(false)
    {
        return false;
    }
    let Ok(metadata) = std::fs::metadata(&backup.target_root) else {
        return false;
    };
    if metadata.permissions().readonly() {
        return false;
    }
    if let Some(deployment) = &backup.deployment {
        if deployment.state != DeploymentState::Deployed
            || !deployment.managed
            || deployment.target_id != backup.target_root_identity
            || deployment.runtime_name != backup.entry_name
        {
            return false;
        }
        // A deployment ownership proof is anchored to its live runtime path.
        // The durable entry identity/fingerprint above proves the same entry
        // is now held at this private backup path.
    }
    if active_deployment_at(database, &backup.target_root_identity, &backup.entry_name)
        .ok()
        .flatten()
        .as_ref()
        .is_some_and(|deployment| {
            backup
                .deployment
                .as_ref()
                .is_some_and(|saved| saved.id != deployment.id)
                || verify_managed_entry_at(
                    database,
                    library_runtime,
                    deployment,
                    &backup.destination_path,
                )
                .is_err()
        })
    {
        return false;
    }
    true
}

fn active_deployment_at(
    database: &Arc<Mutex<Database>>,
    target_id: &str,
    runtime_name: &str,
) -> AppResult<Option<DeploymentRecord>> {
    let database = database
        .lock()
        .map_err(|_| internal("deployment_conflict.backups.active_deployment"))?;
    Ok(database
        .deployment_repository()
        .list_all()?
        .into_iter()
        .find(|deployment| {
            deployment.target_id == target_id
                && deployment.runtime_name == runtime_name
                && deployment.state == DeploymentState::Deployed
                && deployment.managed
        }))
}

fn verify_managed_entry_at(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    deployment: &DeploymentRecord,
    path: &Path,
) -> AppResult<()> {
    let backend =
        super::LocalDeploymentBackend::new(Arc::clone(database), Arc::clone(library_runtime));
    let proof = backend.deployment_proof(deployment)?;
    DeploymentFilesystem::new()
        .verify_ownership(&OwnershipSnapshot::from(&proof).proof_at(path.to_path_buf()))
}

fn committed_restore_for_backup(
    database: &Arc<Mutex<Database>>,
    backup_id: &str,
) -> AppResult<Option<OperationId>> {
    let database = database
        .lock()
        .map_err(|_| internal("deployment_conflict.backups.restore_idempotency"))?;
    Ok(database
        .operation_repository()
        .list_sync()?
        .into_iter()
        .filter(|record| {
            record.kind == BACKUP_RESTORE_KIND
                && record.phase == skillhub_core::OperationPhase::Committed
        })
        .find_map(|record| {
            serde_json::from_value::<BackupRestoreSnapshot>(record.recovery_data)
                .ok()
                .filter(|snapshot| snapshot.selected_backup.backup_id == backup_id)
                .map(|_| record.operation_id)
        }))
}

fn persist_backup_restore_snapshot(
    database: &Arc<Mutex<Database>>,
    operation_id: OperationId,
    snapshot: &BackupRestoreSnapshot,
    phase: skillhub_core::OperationPhase,
) -> AppResult<()> {
    let payload = serde_json::to_value(snapshot)
        .map_err(|_| changed("the backup restore facts could not be saved"))?;
    let database = database
        .lock()
        .map_err(|_| internal("deployment_conflict.backups.restore_journal"))?;
    let repository = database.operation_repository();
    let existing = repository.get_sync(operation_id)?;
    let mut record = match existing.as_ref() {
        Some(record) if record.kind == BACKUP_RESTORE_KIND => record.clone(),
        Some(_) => return Err(changed("the operation id is already in use")),
        None => skillhub_core::OperationRecord::planned(operation_id, BACKUP_RESTORE_KIND, ""),
    };
    record.phase = phase;
    record.progress.phase = phase;
    record.progress.total = 1;
    record.progress.completed = u32::from(phase == skillhub_core::OperationPhase::Committed);
    record.progress.message_code = format!("operation.{BACKUP_RESTORE_KIND}.{}", phase_code(phase));
    record.error_code = (phase == skillhub_core::OperationPhase::NeedsRecovery)
        .then_some(ErrorCode::OperationConflict);
    record.recovery_data = payload;
    record.result = Some(serde_json::json!({
        "restored_backup_id": snapshot.selected_backup.backup_id,
        "new_backup_id": snapshot.current_backup.backup_id,
    }));
    match existing {
        Some(_) => repository.update_sync(&record),
        None => repository.insert_sync(&record),
    }
}

fn settle_backup_restore(
    database: &Arc<Mutex<Database>>,
    operation_id: OperationId,
    phase: skillhub_core::OperationPhase,
) -> AppResult<()> {
    let database = database
        .lock()
        .map_err(|_| internal("deployment_conflict.backups.restore_settle"))?;
    let mut record = database
        .operation_repository()
        .get_sync(operation_id)?
        .ok_or_else(|| changed("the backup restore journal is missing"))?;
    if record.kind != BACKUP_RESTORE_KIND {
        return Err(changed("the operation journal has another kind"));
    }
    record.phase = phase;
    record.progress.phase = phase;
    record.progress.completed = u32::from(phase == skillhub_core::OperationPhase::Committed);
    record.progress.message_code = format!("operation.{BACKUP_RESTORE_KIND}.{}", phase_code(phase));
    record.error_code = (phase == skillhub_core::OperationPhase::NeedsRecovery)
        .then_some(ErrorCode::OperationConflict);
    database.operation_repository().update_sync(&record)
}

fn entry_matches(path: &Path, expected: &EntrySnapshot) -> bool {
    entry_snapshot(path).is_ok_and(|current| {
        current.identity == expected.identity
            && current.content_fingerprint == expected.content_fingerprint
            && current.kind == expected.kind
    })
}

fn persist_unknown_snapshot(
    database: &Arc<Mutex<Database>>,
    operation_id: OperationId,
    snapshot: &UnknownReplacementSnapshot,
    phase: skillhub_core::OperationPhase,
) -> AppResult<()> {
    let payload = serde_json::to_value(snapshot)
        .map_err(|_| changed("the unknown replacement facts could not be saved"))?;
    let database = database
        .lock()
        .map_err(|_| internal("deployment_conflict.unknown.journal"))?;
    let repository = database.operation_repository();
    let existing = repository.get_sync(operation_id)?;
    let mut record = match existing.as_ref() {
        Some(record) if record.kind == UNKNOWN_REPLACEMENT_KIND => record.clone(),
        Some(_) => return Err(changed("the operation id is already in use")),
        None => skillhub_core::OperationRecord::planned(operation_id, UNKNOWN_REPLACEMENT_KIND, ""),
    };
    record.phase = phase;
    record.progress.phase = phase;
    record.progress.total = 1;
    record.progress.completed = u32::from(phase == skillhub_core::OperationPhase::Committed);
    record.progress.message_code =
        format!("operation.{UNKNOWN_REPLACEMENT_KIND}.{}", phase_code(phase));
    record.error_code = (phase == skillhub_core::OperationPhase::NeedsRecovery)
        .then_some(ErrorCode::OperationConflict);
    record.recovery_data = payload;
    record.result = Some(serde_json::json!({
        "pair_id": snapshot.pair_id,
        "backup_id": snapshot.backup.backup_id,
        "deployment_id": snapshot.replacement_deployment.id,
    }));
    match existing {
        Some(_) => repository.update_sync(&record),
        None => repository.insert_sync(&record),
    }
}

fn settle_unknown(
    database: &Arc<Mutex<Database>>,
    operation_id: OperationId,
    phase: skillhub_core::OperationPhase,
) -> AppResult<()> {
    let database = database
        .lock()
        .map_err(|_| internal("deployment_conflict.unknown.settle"))?;
    let mut record = database
        .operation_repository()
        .get_sync(operation_id)?
        .ok_or_else(|| changed("the unknown replacement journal is missing"))?;
    if record.kind != UNKNOWN_REPLACEMENT_KIND {
        return Err(changed("the operation journal has another kind"));
    }
    record.phase = phase;
    record.progress.phase = phase;
    record.progress.completed = u32::from(phase == skillhub_core::OperationPhase::Committed);
    record.progress.message_code =
        format!("operation.{UNKNOWN_REPLACEMENT_KIND}.{}", phase_code(phase));
    record.error_code = (phase == skillhub_core::OperationPhase::NeedsRecovery)
        .then_some(ErrorCode::OperationConflict);
    database.operation_repository().update_sync(&record)
}

fn cleanup_unknown_stages(
    filesystem: &DeploymentFilesystem,
    snapshot: &UnknownReplacementSnapshot,
) -> bool {
    let mut clean = true;
    if let Some(ownership) = &snapshot.replacement_ownership {
        let proof = ownership.proof_at(snapshot.stage_path.clone());
        if entry_exists(&snapshot.stage_path).unwrap_or(false)
            && filesystem.remove_owned(&proof).is_err()
        {
            clean = false;
        }
    }
    if let (Some(path), Some(ownership)) = (
        snapshot.copy_stage_path.as_deref(),
        snapshot.prepared_copy_ownership.as_ref(),
    ) {
        if entry_exists(path).unwrap_or(false)
            && filesystem
                .remove_owned(&ownership.proof_at(path.to_path_buf()))
                .is_err()
        {
            clean = false;
        }
    }
    clean
}

pub(crate) fn execute_conflict_action(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    operation_id: OperationId,
    pair: &DeploymentPairPreview,
    target: &TargetPlan,
) -> AppResult<ReplacementReceipt> {
    if single_unknown_occupant(pair).is_ok() {
        return execute_unknown_conflict_action(
            database,
            library_runtime,
            operation_id,
            pair,
            target,
        );
    }
    execute_conflict_action_with_checkpoint(
        database,
        library_runtime,
        operation_id,
        pair,
        target,
        |_| Ok(()),
    )
}

fn execute_conflict_action_with_checkpoint(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    operation_id: OperationId,
    pair: &DeploymentPairPreview,
    target: &TargetPlan,
    mut after_checkpoint: impl FnMut(ReplacementCheckpoint) -> AppResult<()>,
) -> AppResult<ReplacementReceipt> {
    if single_unknown_occupant(pair).is_ok() {
        return execute_unknown_conflict_action(
            database,
            library_runtime,
            operation_id,
            pair,
            target,
        );
    }
    let occupant = single_managed_occupant(pair)?;
    let library = library_runtime.snapshot()?;
    let original = {
        let database = database
            .lock()
            .map_err(|_| internal("deployment_conflict.load_occupant"))?;
        database
            .deployment_repository()
            .list_all()?
            .into_iter()
            .find(|record| Some(record.id) == occupant.deployment_id)
            .ok_or_else(|| changed("the managed occupant no longer exists"))?
    };
    if !original.managed
        || original.state != DeploymentState::Deployed
        || Some(original.skill_id) != occupant.skill_id
        || Some(&original.version_id) != occupant.version_id.as_ref()
        || original.target_id != occupant.physical_target_id
        || original.runtime_name != pair.runtime_name
        || original.skill_id == pair.skill_id
        || target.skill_id != pair.skill_id
        || target.version_id != pair.version_id
        || target.runtime_name != pair.runtime_name
        || target.physical_target_id != original.target_id
    {
        return Err(changed(
            "the managed occupant does not match the stored conflict",
        ));
    }

    let backend =
        super::LocalDeploymentBackend::new(Arc::clone(database), Arc::clone(library_runtime));
    let original_ownership = backend.deployment_proof(&original)?;
    let filesystem = DeploymentFilesystem::new();
    filesystem.verify_ownership(&original_ownership)?;
    let target_root = PathBuf::from(&target.target_path);
    let destination = target_root.join(&target.runtime_name);
    if original_ownership.destination_path != destination
        || target.destination_path != destination.to_string_lossy()
        || pair.target_path != target.target_path
        || occupant.target_path != destination.to_string_lossy()
        || skillhub_core::physical_id_for_path(&target_root).as_deref()
            != Some(original.target_id.as_str())
    {
        return Err(changed("the registered target path or identity changed"));
    }

    library.store.load_manifest(&target.version_id)?;
    let source_path = backend.materialized_source(target)?;
    let expected_hash = DeploymentFilesystem::hash_tree(&source_path)?;
    let stage_path = destination
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join(format!(".skillhub-conflict-stage-{operation_id}"));
    let copy_stage_path = (target.mode == skillhub_core::DeploymentMode::ManagedCopy).then(|| {
        destination
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join(format!(".skillhub-conflict-copy-{operation_id}"))
    });
    let backup_path = destination
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join(format!(".skillhub-conflict-backup-{operation_id}"));
    if entry_exists(&stage_path)?
        || entry_exists(&backup_path)?
        || copy_stage_path
            .as_deref()
            .is_some_and(|path| entry_exists(path).unwrap_or(true))
    {
        return Err(changed("a recovery path for this operation already exists"));
    }
    let mut staged_target = target.clone();
    staged_target.destination_path = stage_path.to_string_lossy().into_owned();
    staged_target.source_path = source_path.to_string_lossy().into_owned();
    staged_target.conflicts.clear();
    let target_root_identity = skillhub_core::physical_id_for_path(&target_root)
        .ok_or_else(|| changed("the target root identity is unavailable"))?;
    let replacement = DeploymentRecord {
        id: original.id,
        skill_id: target.skill_id,
        version_id: target.version_id.clone(),
        target_id: original.target_id.clone(),
        state: DeploymentState::Deployed,
        mode: target.mode,
        managed: true,
        runtime_name: target.runtime_name.clone(),
        expected_hash: expected_hash.clone(),
        observed_hash: Some(expected_hash),
    };
    let mut recovery = RecoverySnapshot {
        schema_version: 1,
        pair_id: pair.pair_id.clone(),
        target: target.clone(),
        target_root,
        target_root_identity,
        stage_path,
        copy_stage_path,
        backup_path,
        original_deployment: original.clone(),
        original_ownership: OwnershipSnapshot::from(&original_ownership),
        replacement_deployment: replacement,
        prepared_copy_ownership: None,
        replacement_ownership: None,
    };

    persist_snapshot(
        database,
        operation_id,
        &recovery,
        skillhub_core::OperationPhase::Prepared,
    )?;
    // The copy staging path is already journaled and deterministic. Mark the
    // operation as applying before the adapter creates any staging entry so
    // a crash during a large tree copy cannot be treated as an abandoned,
    // side-effect-free Prepared operation.
    persist_snapshot(
        database,
        operation_id,
        &recovery,
        skillhub_core::OperationPhase::Applying,
    )?;
    let prepared = match filesystem
        .prepare_with_staging_path(&staged_target, recovery.copy_stage_path.clone())
    {
        Ok(prepared) => prepared,
        Err(error) => {
            let cleaned = remove_prepared_copy(&filesystem, &recovery);
            let original_unchanged = filesystem.verify_ownership(&original_ownership).is_ok();
            settle(
                database,
                operation_id,
                if cleaned && original_unchanged {
                    skillhub_core::OperationPhase::RolledBack
                } else {
                    skillhub_core::OperationPhase::NeedsRecovery
                },
            )?;
            return Err(error);
        }
    };
    if prepared.staging_path.is_some() {
        if let Err(error) = after_checkpoint(ReplacementCheckpoint::CopyPrepared) {
            settle(
                database,
                operation_id,
                skillhub_core::OperationPhase::NeedsRecovery,
            )?;
            return Err(error);
        }
    }
    if let (Some(copy_path), Some(staging_path)) = (
        recovery.copy_stage_path.as_ref(),
        prepared.staging_path.as_ref(),
    ) {
        let identity = filesystem.recovery_entry_identity(target.mode, staging_path)?;
        if copy_path != staging_path
            || DeploymentFilesystem::hash_tree(staging_path)? != prepared.expected_tree_hash
        {
            settle(
                database,
                operation_id,
                skillhub_core::OperationPhase::NeedsRecovery,
            )?;
            return Err(changed(
                "the prepared replacement copy does not match its journal",
            ));
        }
        recovery.prepared_copy_ownership = Some(OwnershipSnapshot {
            mode: target.mode,
            destination_path: copy_path.clone(),
            source_path: prepared.source_path.clone(),
            expected_hash: prepared.expected_tree_hash.clone(),
            target_identity: identity,
            link_anchor_paths: vec![prepared.source_path.clone()],
            skill_id: prepared.skill_id,
            version_id: prepared.version_id.clone(),
            runtime_name: prepared.runtime_name.clone(),
        });
        if let Some(proof) = &recovery.prepared_copy_ownership {
            filesystem.verify_ownership(&proof.proof_at(copy_path.clone()))?;
        }
    }
    // The full ownership proof is durable before the old entry moves. The
    // only filesystem artifacts created so far are a private staging copy.
    if let Err(error) = persist_snapshot(
        database,
        operation_id,
        &recovery,
        skillhub_core::OperationPhase::Applying,
    ) {
        let cleaned = remove_prepared_copy(&filesystem, &recovery);
        let original_unchanged = filesystem.verify_ownership(&original_ownership).is_ok();
        settle(
            database,
            operation_id,
            if cleaned && original_unchanged {
                skillhub_core::OperationPhase::RolledBack
            } else {
                skillhub_core::OperationPhase::NeedsRecovery
            },
        )?;
        return Err(error);
    }
    let target_root_still_matches = skillhub_core::physical_id_for_path(&recovery.target_root)
        .as_deref()
        == Some(recovery.target_root_identity.as_str());
    if !target_root_still_matches {
        settle(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(changed(
            "the registered target root changed before replacement",
        ));
    }
    if entry_exists(&recovery.backup_path)?
        || filesystem.verify_ownership(&original_ownership).is_err()
    {
        let cleaned = remove_prepared_copy(&filesystem, &recovery);
        settle(
            database,
            operation_id,
            if cleaned {
                skillhub_core::OperationPhase::RolledBack
            } else {
                skillhub_core::OperationPhase::NeedsRecovery
            },
        )?;
        return Err(changed(
            "the original target, target root, or backup path changed before replacement",
        ));
    }
    if let Err(error) = filesystem.rename_recovery_entry(
        original_ownership.mode,
        &original_ownership.destination_path,
        &recovery.backup_path,
        &original_ownership.target_identity,
    ) {
        let original_still_in_place = filesystem.verify_ownership(&original_ownership).is_ok();
        let backup_is_absent = !entry_exists(&recovery.backup_path)?;
        let cleaned = remove_prepared_copy(&filesystem, &recovery);
        if original_still_in_place && backup_is_absent && cleaned {
            settle(
                database,
                operation_id,
                skillhub_core::OperationPhase::RolledBack,
            )?;
        } else {
            settle(
                database,
                operation_id,
                skillhub_core::OperationPhase::NeedsRecovery,
            )?;
        }
        return Err(error);
    }
    let backup_proof = recovery
        .original_ownership
        .proof_at(recovery.backup_path.clone());
    if let Err(error) = filesystem.verify_ownership(&backup_proof) {
        settle(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    if let Err(error) = after_checkpoint(ReplacementCheckpoint::OriginalBackedUp) {
        settle(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }

    let applied = match filesystem.apply(prepared) {
        Ok(applied) => applied,
        Err(error) => {
            let restored = restore_original(&filesystem, &recovery, None);
            settle(
                database,
                operation_id,
                if restored {
                    skillhub_core::OperationPhase::RolledBack
                } else {
                    skillhub_core::OperationPhase::NeedsRecovery
                },
            )?;
            return Err(error);
        }
    };
    if let Err(error) = after_checkpoint(ReplacementCheckpoint::ReplacementApplied) {
        settle(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    if let Err(error) = filesystem.verify(&applied) {
        let restored = restore_original(&filesystem, &recovery, Some(&applied.ownership));
        settle(
            database,
            operation_id,
            if restored {
                skillhub_core::OperationPhase::RolledBack
            } else {
                skillhub_core::OperationPhase::NeedsRecovery
            },
        )?;
        return Err(error);
    }
    recovery.replacement_ownership = Some(OwnershipSnapshot::from(&applied.ownership));
    if let Err(error) = persist_snapshot(
        database,
        operation_id,
        &recovery,
        skillhub_core::OperationPhase::Applying,
    ) {
        let restored = restore_original(&filesystem, &recovery, Some(&applied.ownership));
        settle(
            database,
            operation_id,
            if restored {
                skillhub_core::OperationPhase::RolledBack
            } else {
                skillhub_core::OperationPhase::NeedsRecovery
            },
        )?;
        return Err(error);
    }

    if let Err(error) = filesystem.rename_recovery_entry(
        target.mode,
        &recovery.stage_path,
        &destination,
        &recovery
            .replacement_ownership
            .as_ref()
            .expect("checkpointed replacement proof")
            .target_identity,
    ) {
        settle(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    let replacement_proof = recovery
        .replacement_ownership
        .as_ref()
        .expect("checkpointed replacement proof")
        .proof_at(destination.clone());
    if let Err(error) = filesystem.verify_ownership(&replacement_proof) {
        settle(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    if let Err(error) = after_checkpoint(ReplacementCheckpoint::ReplacementInstalled) {
        settle(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }

    if let Err(error) = reassign_deployment(database, &recovery) {
        let restored = restore_original(&filesystem, &recovery, Some(&replacement_proof));
        settle(
            database,
            operation_id,
            if restored {
                skillhub_core::OperationPhase::RolledBack
            } else {
                skillhub_core::OperationPhase::NeedsRecovery
            },
        )?;
        return Err(error);
    }
    if let Err(error) = filesystem.remove_owned(&backup_proof) {
        settle(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    if let Err(error) = append_replacement_history(database, &recovery, operation_id) {
        settle(
            database,
            operation_id,
            skillhub_core::OperationPhase::NeedsRecovery,
        )?;
        return Err(error);
    }
    settle(
        database,
        operation_id,
        skillhub_core::OperationPhase::Committed,
    )?;
    Ok(ReplacementReceipt {
        operation_id,
        deployment_id: original.id,
    })
}

pub(crate) fn recovery_actions(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    record: &skillhub_core::OperationRecord,
) -> Vec<RecoveryAction> {
    let Ok((snapshot, position)) = validate_and_classify(database, library_runtime, record) else {
        return Vec::new();
    };
    let _ = snapshot;
    match position {
        Position::Untouched | Position::OriginalInBackup | Position::OriginalRestored => {
            vec![RecoveryAction::RollbackOperation]
        }
        Position::ReplacementStaged
        | Position::ReplacementInstalled {
            backup_exists: true,
        } => {
            vec![
                RecoveryAction::CompleteOperation,
                RecoveryAction::RollbackOperation,
            ]
        }
        Position::ReplacementInstalled {
            backup_exists: false,
        } => {
            vec![RecoveryAction::CompleteOperation]
        }
    }
}

pub(crate) fn resolve_recovery(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    operation_id: OperationId,
    action: RecoveryAction,
) -> AppResult<()> {
    let record = {
        let database = database
            .lock()
            .map_err(|_| internal("deployment_conflict.recovery.load"))?;
        database
            .operation_repository()
            .get_sync(operation_id)?
            .ok_or_else(|| changed("the replacement operation no longer exists"))?
    };
    let (snapshot, position) = validate_and_classify(database, library_runtime, &record)?;
    match (action, position) {
        (RecoveryAction::RollbackOperation, _) => {
            let replacement_proof = snapshot
                .replacement_ownership
                .as_ref()
                .map(|proof| proof.proof_at(PathBuf::from(&snapshot.target.destination_path)));
            if !restore_original(
                &DeploymentFilesystem::new(),
                &snapshot,
                replacement_proof.as_ref(),
            ) {
                settle(
                    database,
                    operation_id,
                    skillhub_core::OperationPhase::NeedsRecovery,
                )?;
                return Err(changed("the original target could not be safely restored"));
            }
            rollback_accounting(database, &snapshot)?;
            settle(
                database,
                operation_id,
                skillhub_core::OperationPhase::RolledBack,
            )
        }
        (RecoveryAction::CompleteOperation, Position::ReplacementStaged) => {
            let filesystem = DeploymentFilesystem::new();
            let proof = snapshot
                .replacement_ownership
                .as_ref()
                .expect("staged replacement has an ownership proof")
                .proof_at(snapshot.stage_path.clone());
            filesystem.verify_ownership(&proof)?;
            let destination = PathBuf::from(&snapshot.target.destination_path);
            if entry_exists(&destination)? {
                return Err(changed("the replacement destination is occupied"));
            }
            filesystem.rename_recovery_entry(
                snapshot.target.mode,
                &snapshot.stage_path,
                &destination,
                &snapshot
                    .replacement_ownership
                    .as_ref()
                    .expect("staged replacement has an ownership proof")
                    .target_identity,
            )?;
            filesystem.verify_ownership(
                &snapshot
                    .replacement_ownership
                    .as_ref()
                    .expect("staged replacement has an ownership proof")
                    .proof_at(destination.clone()),
            )?;
            finish_replacement(database, operation_id, &snapshot)
        }
        (RecoveryAction::CompleteOperation, Position::ReplacementInstalled { .. }) => {
            finish_replacement(database, operation_id, &snapshot)
        }
        _ => Err(changed(
            "the requested recovery action is not supported for the observed files",
        )),
    }
}

pub(crate) fn unknown_replacement_recovery_actions(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    record: &skillhub_core::OperationRecord,
) -> Vec<RecoveryAction> {
    let Ok((_, position)) = classify_unknown_replacement(database, library_runtime, record) else {
        return Vec::new();
    };
    match position {
        UnknownReplacementPosition::Untouched | UnknownReplacementPosition::OriginalInBackup => {
            vec![RecoveryAction::RollbackOperation]
        }
        UnknownReplacementPosition::OriginalAndReplacementStaged
        | UnknownReplacementPosition::ReplacementStaged
        | UnknownReplacementPosition::ReplacementInstalled { .. } => vec![
            RecoveryAction::CompleteOperation,
            RecoveryAction::RollbackOperation,
        ],
    }
}

pub(crate) fn resolve_unknown_replacement_recovery(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    operation_id: OperationId,
    action: RecoveryAction,
) -> AppResult<()> {
    let record = {
        let database = database
            .lock()
            .map_err(|_| internal("deployment_conflict.unknown_recovery.load"))?;
        database
            .operation_repository()
            .get_sync(operation_id)?
            .ok_or_else(|| changed("the unknown replacement operation no longer exists"))?
    };
    let (snapshot, position) = classify_unknown_replacement(database, library_runtime, &record)?;
    match action {
        RecoveryAction::RollbackOperation => {
            rollback_unknown_replacement(database, &snapshot)?;
            settle_unknown(
                database,
                operation_id,
                skillhub_core::OperationPhase::RolledBack,
            )
        }
        RecoveryAction::CompleteOperation
            if matches!(
                position,
                UnknownReplacementPosition::OriginalAndReplacementStaged
                    | UnknownReplacementPosition::ReplacementStaged
                    | UnknownReplacementPosition::ReplacementInstalled { .. }
            ) =>
        {
            complete_unknown_replacement(database, operation_id, &snapshot)
        }
        _ => Err(changed(
            "the requested recovery action is not supported for the observed files",
        )),
    }
}

fn classify_unknown_replacement(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    record: &skillhub_core::OperationRecord,
) -> AppResult<(UnknownReplacementSnapshot, UnknownReplacementPosition)> {
    if record.kind != UNKNOWN_REPLACEMENT_KIND
        || !matches!(
            record.phase,
            skillhub_core::OperationPhase::Applying | skillhub_core::OperationPhase::NeedsRecovery
        )
    {
        return Err(changed(
            "the unknown replacement journal phase is not recoverable",
        ));
    }
    let mut snapshot: UnknownReplacementSnapshot =
        serde_json::from_value(record.recovery_data.clone())
            .map_err(|_| changed("the unknown replacement recovery record is invalid"))?;
    let operation_id = record.operation_id;
    if snapshot.schema_version != 1
        || snapshot.pair_id.trim().is_empty()
        || snapshot.target.runtime_name.trim().is_empty()
        || snapshot.target.skill_id != snapshot.replacement_deployment.skill_id
        || snapshot.target.version_id != snapshot.replacement_deployment.version_id
        || snapshot.target.physical_target_id != snapshot.replacement_deployment.target_id
        || snapshot.target.runtime_name != snapshot.replacement_deployment.runtime_name
        || snapshot.target.mode != snapshot.replacement_deployment.mode
        || snapshot.replacement_deployment.state != DeploymentState::Deployed
        || !snapshot.replacement_deployment.managed
        || snapshot
            .replacement_deployment
            .expected_hash
            .trim()
            .is_empty()
        || snapshot.target.target_path != snapshot.target_root.to_string_lossy()
        || snapshot.destination_path != snapshot.target_root.join(&snapshot.target.runtime_name)
        || snapshot.target.destination_path != snapshot.destination_path.to_string_lossy()
        || snapshot.target_root_identity != snapshot.target.physical_target_id
        || skillhub_core::physical_id_for_path(&snapshot.target_root).as_deref()
            != Some(snapshot.target_root_identity.as_str())
        || snapshot.backup.target_root != snapshot.target_root
        || snapshot.backup.target_root_identity != snapshot.target_root_identity
        || snapshot.backup.destination_path != snapshot.destination_path
        || snapshot.backup.backup_path
            != snapshot
                .target_root
                .join(format!(".skillhub-conflict-backup-{operation_id}"))
        || snapshot.stage_path
            != snapshot
                .target_root
                .join(format!(".skillhub-conflict-stage-{operation_id}"))
        || snapshot.copy_stage_path
            != (snapshot.target.mode == skillhub_core::DeploymentMode::ManagedCopy).then(|| {
                snapshot
                    .target_root
                    .join(format!(".skillhub-conflict-copy-{operation_id}"))
            })
        || snapshot.backup.entry != snapshot.original
        || snapshot.backup.entry_name != snapshot.target.runtime_name
        || snapshot.backup.deployment.is_some()
    {
        return Err(changed(
            "the unknown replacement recovery facts do not match its journal",
        ));
    }
    if !registered_target_path_matches(
        database,
        &snapshot.target_root_identity,
        &snapshot.target_root,
    )? {
        return Err(changed("the registered target path changed"));
    }
    let library = library_runtime.snapshot()?;
    let manifest = library.store.load_manifest(&snapshot.target.version_id)?;
    if manifest.skill_id != snapshot.target.skill_id {
        return Err(changed("the replacement Skill version changed"));
    }

    if snapshot.replacement_ownership.is_none() && entry_exists(&snapshot.stage_path)? {
        snapshot.replacement_ownership =
            derive_unknown_replacement_ownership(library_runtime, &snapshot)?;
    }
    if let Some(ownership) = &snapshot.replacement_ownership {
        if ownership.mode != snapshot.target.mode
            || ownership.expected_hash != snapshot.replacement_deployment.expected_hash
            || ownership.skill_id != snapshot.target.skill_id
            || ownership.version_id != snapshot.target.version_id
            || ownership.runtime_name != snapshot.target.runtime_name
            || ownership.link_anchor_paths != vec![ownership.source_path.clone()]
        {
            return Err(changed("the replacement ownership proof is inconsistent"));
        }
    }

    let filesystem = DeploymentFilesystem::new();
    let old_at_destination = entry_matches(&snapshot.destination_path, &snapshot.original);
    let old_in_backup = entry_matches(&snapshot.backup.backup_path, &snapshot.original);
    let new_at_stage = snapshot
        .replacement_ownership
        .as_ref()
        .is_some_and(|ownership| verify_at(&filesystem, ownership, &snapshot.stage_path));
    let new_at_destination = snapshot
        .replacement_ownership
        .as_ref()
        .is_some_and(|ownership| verify_at(&filesystem, ownership, &snapshot.destination_path));
    let stage_exists = entry_exists(&snapshot.stage_path)?;
    let backup_exists = entry_exists(&snapshot.backup.backup_path)?;
    if backup_exists && !old_in_backup {
        return Err(changed("the unknown original backup has changed"));
    }
    if old_at_destination && backup_exists {
        return Err(changed("the unknown original exists at two locations"));
    }
    if stage_exists && !new_at_stage {
        return Err(changed(
            "the staged replacement has no verifiable ownership proof",
        ));
    }
    if new_at_destination && old_at_destination {
        return Err(changed("the replacement destination is ambiguous"));
    }

    let deployment_rows = {
        let database = database
            .lock()
            .map_err(|_| internal("deployment_conflict.unknown_recovery.deployment"))?;
        database.deployment_repository().list_all()?
    };
    let current_deployment = deployment_rows
        .iter()
        .find(|deployment| deployment.id == snapshot.replacement_deployment.id);
    let database_is_replacement = current_deployment == Some(&snapshot.replacement_deployment);
    let database_is_previous = match (&snapshot.previous_deployment, current_deployment) {
        (Some(previous), Some(current)) => previous == current,
        (None, None) => true,
        _ => false,
    };
    if !database_is_replacement && !database_is_previous {
        return Err(changed(
            "the deployment accounting changed during replacement",
        ));
    }

    let position = if old_at_destination && !backup_exists && !stage_exists && database_is_previous
    {
        UnknownReplacementPosition::Untouched
    } else if old_at_destination && !backup_exists && new_at_stage && database_is_previous {
        UnknownReplacementPosition::OriginalAndReplacementStaged
    } else if old_in_backup
        && !entry_exists(&snapshot.destination_path)?
        && !stage_exists
        && database_is_previous
    {
        UnknownReplacementPosition::OriginalInBackup
    } else if old_in_backup
        && !entry_exists(&snapshot.destination_path)?
        && new_at_stage
        && database_is_previous
    {
        UnknownReplacementPosition::ReplacementStaged
    } else if old_in_backup && new_at_destination && !stage_exists {
        UnknownReplacementPosition::ReplacementInstalled {
            database_accounted: database_is_replacement,
        }
    } else {
        return Err(changed(
            "the unknown replacement filesystem state is ambiguous",
        ));
    };
    Ok((snapshot, position))
}

fn derive_unknown_replacement_ownership(
    library_runtime: &Arc<LibraryRuntime>,
    snapshot: &UnknownReplacementSnapshot,
) -> AppResult<Option<OwnershipSnapshot>> {
    let filesystem = DeploymentFilesystem::new();
    if snapshot.target.mode == skillhub_core::DeploymentMode::ManagedCopy {
        let Some(prepared) = snapshot.prepared_copy_ownership.as_ref() else {
            return Ok(None);
        };
        if verify_at(&filesystem, prepared, &snapshot.stage_path) {
            let mut proof = prepared.clone();
            proof.destination_path = snapshot.stage_path.clone();
            return Ok(Some(proof));
        }
        return Ok(None);
    }
    let library = library_runtime.snapshot()?;
    let paths = LibraryPaths::from_root(library.root.clone());
    let mut sources = vec![paths
        .management_dir
        .join("deployment-trees")
        .join(snapshot.target.skill_id.to_string())
        .join(skillhub_core::deployment::deployment_tree_dir_name(
            &snapshot.target.version_id,
        ))];
    if let Some((portable, current)) = library
        .central
        .load_portable_skill(snapshot.target.skill_id)
        .ok()
        .flatten()
    {
        if current.as_ref() == Some(&snapshot.target.version_id) {
            sources.push(
                library.central.visible_skill_path_for_runtime(
                    snapshot.target.skill_id,
                    &portable.runtime_name,
                ),
            );
        }
    }
    let target_identity =
        filesystem.recovery_entry_identity(snapshot.target.mode, &snapshot.stage_path)?;
    for source_path in sources {
        if !DeploymentFilesystem::hash_tree(&source_path)
            .is_ok_and(|hash| hash == snapshot.replacement_deployment.expected_hash)
        {
            continue;
        }
        let proof = OwnershipSnapshot {
            mode: snapshot.target.mode,
            destination_path: snapshot.stage_path.clone(),
            source_path: source_path.clone(),
            expected_hash: snapshot.replacement_deployment.expected_hash.clone(),
            target_identity: target_identity.clone(),
            link_anchor_paths: vec![source_path],
            skill_id: snapshot.target.skill_id,
            version_id: snapshot.target.version_id.clone(),
            runtime_name: snapshot.target.runtime_name.clone(),
        };
        if filesystem
            .verify_ownership(&proof.proof_at(snapshot.stage_path.clone()))
            .is_ok()
        {
            return Ok(Some(proof));
        }
    }
    Ok(None)
}

fn complete_unknown_replacement(
    database: &Arc<Mutex<Database>>,
    operation_id: OperationId,
    snapshot: &UnknownReplacementSnapshot,
) -> AppResult<()> {
    let filesystem = DeploymentFilesystem::new();
    if entry_matches(&snapshot.destination_path, &snapshot.original) {
        if entry_exists(&snapshot.backup.backup_path)? {
            return Err(changed("the original backup path is occupied"));
        }
        std::fs::rename(&snapshot.destination_path, &snapshot.backup.backup_path)
            .map_err(|error| filesystem_error("backup unknown deployment target", error))?;
    }
    if entry_exists(&snapshot.stage_path)? {
        let proof = snapshot
            .replacement_ownership
            .as_ref()
            .ok_or_else(|| changed("replacement ownership proof is missing"))?;
        filesystem.verify_ownership(&proof.proof_at(snapshot.stage_path.clone()))?;
        if entry_exists(&snapshot.destination_path)? {
            return Err(changed("the replacement destination is occupied"));
        }
        filesystem.rename_recovery_entry(
            snapshot.target.mode,
            &snapshot.stage_path,
            &snapshot.destination_path,
            &proof.target_identity,
        )?;
    }
    let proof = snapshot
        .replacement_ownership
        .as_ref()
        .ok_or_else(|| changed("replacement ownership proof is missing"))?;
    filesystem.verify_ownership(&proof.proof_at(snapshot.destination_path.clone()))?;
    if !entry_matches(&snapshot.backup.backup_path, &snapshot.original) {
        return Err(changed("the original backup could not be verified"));
    }
    account_unknown_replacement(database, snapshot)?;
    let mut committed = snapshot.clone();
    committed.replacement_deployment.observed_hash =
        Some(committed.replacement_deployment.expected_hash.clone());
    persist_unknown_snapshot(
        database,
        operation_id,
        &committed,
        skillhub_core::OperationPhase::Committed,
    )
}

fn rollback_unknown_replacement(
    database: &Arc<Mutex<Database>>,
    snapshot: &UnknownReplacementSnapshot,
) -> AppResult<()> {
    let filesystem = DeploymentFilesystem::new();
    for path in [&snapshot.destination_path, &snapshot.stage_path] {
        if !entry_exists(path)? {
            continue;
        }
        let Some(ownership) = snapshot.replacement_ownership.as_ref() else {
            return Err(changed("replacement ownership proof is missing"));
        };
        filesystem.remove_owned(&ownership.proof_at(path.to_path_buf()))?;
    }
    if !cleanup_unknown_stages(&filesystem, snapshot) {
        return Err(changed(
            "the private replacement staging entry could not be removed safely",
        ));
    }
    if entry_exists(&snapshot.backup.backup_path)? {
        if !entry_matches(&snapshot.backup.backup_path, &snapshot.original)
            || entry_exists(&snapshot.destination_path)?
        {
            return Err(changed("the original entry could not be safely restored"));
        }
        std::fs::rename(&snapshot.backup.backup_path, &snapshot.destination_path)
            .map_err(|error| filesystem_error("restore unknown deployment target", error))?;
    } else if !entry_matches(&snapshot.destination_path, &snapshot.original) {
        return Err(changed("the original entry is no longer available"));
    }
    rollback_unknown_accounting(database, snapshot)
}

fn account_unknown_replacement(
    database: &Arc<Mutex<Database>>,
    snapshot: &UnknownReplacementSnapshot,
) -> AppResult<()> {
    let database = database
        .lock()
        .map_err(|_| internal("deployment_conflict.unknown.account_recovery"))?;
    let current = database
        .deployment_repository()
        .list_all()?
        .into_iter()
        .find(|record| record.id == snapshot.replacement_deployment.id);
    if current.as_ref() == Some(&snapshot.replacement_deployment) {
        return Ok(());
    }
    let unchanged = match (&snapshot.previous_deployment, current.as_ref()) {
        (Some(previous), Some(current)) => previous == current,
        (None, None) => true,
        _ => false,
    };
    if !unchanged {
        return Err(changed("the deployment accounting changed during recovery"));
    }
    super::LocalDeploymentBackend::ensure_targets_row(&database, &snapshot.target)?;
    database
        .deployment_repository()
        .insert_sync(&snapshot.replacement_deployment)?;
    Ok(())
}

fn rollback_unknown_accounting(
    database: &Arc<Mutex<Database>>,
    snapshot: &UnknownReplacementSnapshot,
) -> AppResult<()> {
    let database = database
        .lock()
        .map_err(|_| internal("deployment_conflict.unknown.rollback_accounting"))?;
    let current = database
        .deployment_repository()
        .list_all()?
        .into_iter()
        .find(|record| record.id == snapshot.replacement_deployment.id);
    if current.as_ref() == snapshot.previous_deployment.as_ref() {
        return Ok(());
    }
    if current.as_ref() != Some(&snapshot.replacement_deployment) {
        return Err(changed("the deployment accounting changed during rollback"));
    }
    if let Some(previous) = &snapshot.previous_deployment {
        database.deployment_repository().insert_sync(previous)?;
    } else {
        database
            .deployment_repository()
            .mark_removed_sync(snapshot.replacement_deployment.id)?;
    }
    Ok(())
}

pub(crate) fn backup_restore_recovery_actions(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    record: &skillhub_core::OperationRecord,
) -> Vec<RecoveryAction> {
    let Ok(position) = classify_backup_restore(database, library_runtime, record) else {
        return Vec::new();
    };
    match position {
        BackupRestorePosition::Untouched => vec![RecoveryAction::RollbackOperation],
        BackupRestorePosition::CurrentPreserved | BackupRestorePosition::SelectedRestored => vec![
            RecoveryAction::CompleteOperation,
            RecoveryAction::RollbackOperation,
        ],
    }
}

pub(crate) fn resolve_backup_restore_recovery(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    operation_id: OperationId,
    action: RecoveryAction,
) -> AppResult<()> {
    let record = {
        let database = database
            .lock()
            .map_err(|_| internal("deployment_conflict.backups.recovery.load"))?;
        database
            .operation_repository()
            .get_sync(operation_id)?
            .ok_or_else(|| changed("the backup restore operation no longer exists"))?
    };
    let position = classify_backup_restore(database, library_runtime, &record)?;
    let snapshot: BackupRestoreSnapshot = serde_json::from_value(record.recovery_data.clone())
        .map_err(|_| changed("the backup restore recovery record is invalid"))?;
    match action {
        RecoveryAction::RollbackOperation => {
            rollback_backup_restore(database, &snapshot)?;
            settle_backup_restore(
                database,
                operation_id,
                skillhub_core::OperationPhase::RolledBack,
            )
        }
        RecoveryAction::CompleteOperation if position != BackupRestorePosition::Untouched => {
            complete_backup_restore(database, operation_id, &snapshot)
        }
        _ => Err(changed(
            "the requested recovery action is not supported for the observed files",
        )),
    }
}

fn classify_backup_restore(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    record: &skillhub_core::OperationRecord,
) -> AppResult<BackupRestorePosition> {
    if record.kind != BACKUP_RESTORE_KIND
        || !matches!(
            record.phase,
            skillhub_core::OperationPhase::Applying | skillhub_core::OperationPhase::NeedsRecovery
        )
    {
        return Err(changed(
            "the backup restore journal phase is not recoverable",
        ));
    }
    let snapshot: BackupRestoreSnapshot = serde_json::from_value(record.recovery_data.clone())
        .map_err(|_| changed("the backup restore recovery record is invalid"))?;
    let selected = &snapshot.selected_backup;
    let current = &snapshot.current_backup;
    if snapshot.schema_version != 1
        || selected.schema_version != 1
        || current.schema_version != 1
        || selected.backup_id.trim().is_empty()
        || current.backup_id.trim().is_empty()
        || selected.target_root != current.target_root
        || selected.target_root_identity != current.target_root_identity
        || selected.destination_path != current.destination_path
        || selected.entry_name != current.entry_name
        || selected.backup_path.parent() != Some(selected.target_root.as_path())
        || current.backup_path
            != current
                .target_root
                .join(format!(".skillhub-conflict-backup-{}", record.operation_id))
        || selected.backup_path == selected.destination_path
        || current.backup_path == selected.destination_path
        || selected.destination_path != selected.target_root.join(&selected.entry_name)
        || skillhub_core::physical_id_for_path(&selected.target_root).as_deref()
            != Some(selected.target_root_identity.as_str())
        || selected.deployment.as_ref().is_some_and(|deployment| {
            !deployment.managed
                || deployment.state != DeploymentState::Deployed
                || deployment.target_id != selected.target_root_identity
                || deployment.runtime_name != selected.entry_name
        })
        || current.deployment.as_ref().is_some_and(|deployment| {
            !deployment.managed
                || deployment.state != DeploymentState::Deployed
                || deployment.target_id != current.target_root_identity
                || deployment.runtime_name != current.entry_name
        })
        || selected
            .deployment
            .as_ref()
            .zip(current.deployment.as_ref())
            .is_some_and(|(selected, current)| selected.id != current.id)
        || !registered_target_path_matches(
            database,
            &selected.target_root_identity,
            &selected.target_root,
        )?
        || !is_committed_backup_snapshot(database, selected)?
    {
        return Err(changed(
            "the backup restore recovery facts do not match its journal",
        ));
    }
    if !entry_matches(&current.backup_path, &current.entry) && entry_exists(&current.backup_path)? {
        return Err(changed("the preserved current target has changed"));
    }
    let selected_in_backup = entry_matches(&selected.backup_path, &selected.entry);
    let selected_at_destination = entry_matches(&selected.destination_path, &selected.entry);
    let current_at_backup = entry_matches(&current.backup_path, &current.entry);
    let current_at_destination = entry_matches(&current.destination_path, &current.entry);
    if let Some(deployment) = &selected.deployment {
        if !deployment.managed || deployment.state != DeploymentState::Deployed {
            return Err(changed("the selected deployment backup is invalid"));
        }
        if selected_at_destination {
            verify_managed_entry_at(
                database,
                library_runtime,
                deployment,
                &selected.destination_path,
            )?;
        }
    }
    if let Some(deployment) = &current.deployment {
        if !deployment.managed || deployment.state != DeploymentState::Deployed {
            return Err(changed("the current deployment snapshot is invalid"));
        }
        if current_at_destination {
            verify_managed_entry_at(
                database,
                library_runtime,
                deployment,
                &current.destination_path,
            )?;
        }
    }
    let position = if selected_in_backup
        && current_at_destination
        && !entry_exists(&current.backup_path)?
    {
        BackupRestorePosition::Untouched
    } else if selected_in_backup && !entry_exists(&selected.destination_path)? && current_at_backup
    {
        BackupRestorePosition::CurrentPreserved
    } else if !entry_exists(&selected.backup_path)? && selected_at_destination && current_at_backup
    {
        BackupRestorePosition::SelectedRestored
    } else {
        return Err(changed("the backup restore filesystem state is ambiguous"));
    };
    let current_accounting_matches =
        backup_restore_accounting_matches(database, &snapshot, BackupRestoreAccounting::Current)?;
    let restored_accounting_matches = position == BackupRestorePosition::SelectedRestored
        && backup_restore_accounting_matches(
            database,
            &snapshot,
            BackupRestoreAccounting::Restored,
        )?;
    if !current_accounting_matches && !restored_accounting_matches {
        return Err(changed(
            "the deployment accounting changed during backup restore",
        ));
    }
    Ok(position)
}

fn complete_backup_restore(
    database: &Arc<Mutex<Database>>,
    operation_id: OperationId,
    snapshot: &BackupRestoreSnapshot,
) -> AppResult<()> {
    let selected = &snapshot.selected_backup;
    let current = &snapshot.current_backup;
    ensure_backup_restore_accounting_known(database, snapshot)?;
    if !entry_matches(&current.backup_path, &current.entry) {
        return Err(changed(
            "the preserved current target changed before recovery",
        ));
    }
    if entry_exists(&selected.backup_path)? {
        if !entry_matches(&selected.backup_path, &selected.entry)
            || entry_exists(&selected.destination_path)?
        {
            return Err(changed("the selected backup cannot be safely restored"));
        }
        std::fs::rename(&selected.backup_path, &selected.destination_path)
            .map_err(|error| filesystem_error("restore replaced content", error))?;
    }
    if !entry_matches(&selected.destination_path, &selected.entry) {
        return Err(changed("the restored entry no longer matches its backup"));
    }
    if !entry_matches(&current.backup_path, &current.entry) {
        return Err(changed(
            "the preserved current target changed during recovery",
        ));
    }
    account_backup_restore(database, snapshot, true)?;
    persist_backup_restore_snapshot(
        database,
        operation_id,
        snapshot,
        skillhub_core::OperationPhase::Committed,
    )?;
    let _ = current;
    Ok(())
}

fn rollback_backup_restore(
    database: &Arc<Mutex<Database>>,
    snapshot: &BackupRestoreSnapshot,
) -> AppResult<()> {
    let selected = &snapshot.selected_backup;
    let current = &snapshot.current_backup;
    ensure_backup_restore_accounting_known(database, snapshot)?;
    if entry_exists(&selected.destination_path)?
        && entry_matches(&selected.destination_path, &selected.entry)
        && !entry_exists(&selected.backup_path)?
    {
        std::fs::rename(&selected.destination_path, &selected.backup_path)
            .map_err(|error| filesystem_error("return replaced content to backup", error))?;
    }
    if entry_exists(&current.backup_path)? {
        if !entry_matches(&current.backup_path, &current.entry)
            || entry_exists(&current.destination_path)?
        {
            return Err(changed("the current target cannot be safely restored"));
        }
        std::fs::rename(&current.backup_path, &current.destination_path)
            .map_err(|error| filesystem_error("restore current target", error))?;
    }
    if !entry_matches(&current.destination_path, &current.entry)
        || !entry_matches(&selected.backup_path, &selected.entry)
    {
        return Err(changed("the original backup state could not be restored"));
    }
    account_backup_restore(database, snapshot, false)
}

fn account_backup_restore(
    database: &Arc<Mutex<Database>>,
    snapshot: &BackupRestoreSnapshot,
    select_backup: bool,
) -> AppResult<()> {
    let selected_deployment = snapshot.selected_backup.deployment.as_ref();
    let current_deployment = snapshot.current_backup.deployment.as_ref();
    let (activate, deactivate) = if select_backup {
        (selected_deployment, current_deployment)
    } else {
        (current_deployment, selected_deployment)
    };
    let database = database
        .lock()
        .map_err(|_| internal("deployment_conflict.backups.account_recovery"))?;
    ensure_backup_restore_accounting_known_locked(&database, snapshot)?;
    let repository = database.deployment_repository();
    if let Some(deployment) = activate {
        if repository.list_all()?.into_iter().any(|record| {
            record.target_id == deployment.target_id
                && record.runtime_name == deployment.runtime_name
                && record.id != deployment.id
        }) {
            return Err(changed(
                "the deployment identity changed during backup restore",
            ));
        }
    }
    if let Some(deployment) = activate {
        let effective_id = repository.insert_sync(deployment)?;
        if effective_id != deployment.id {
            return Err(changed(
                "the deployment identity changed during backup restore",
            ));
        }
    }
    if let Some(deployment) = deactivate {
        if activate.is_none_or(|active| active.id != deployment.id) {
            let current = repository
                .list_all()?
                .into_iter()
                .find(|record| record.id == deployment.id);
            if current.is_some_and(|record| record.state == DeploymentState::Deployed) {
                repository.mark_removed_sync(deployment.id)?;
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum BackupRestoreAccounting {
    Current,
    Restored,
}

fn backup_restore_accounting_matches(
    database: &Arc<Mutex<Database>>,
    snapshot: &BackupRestoreSnapshot,
    accounting: BackupRestoreAccounting,
) -> AppResult<bool> {
    let database = database
        .lock()
        .map_err(|_| internal("deployment_conflict.backups.accounting_check"))?;
    backup_restore_accounting_matches_locked(&database, snapshot, accounting)
}

fn backup_restore_accounting_matches_locked(
    database: &Database,
    snapshot: &BackupRestoreSnapshot,
    accounting: BackupRestoreAccounting,
) -> AppResult<bool> {
    let target_id = &snapshot.selected_backup.target_root_identity;
    let runtime_name = &snapshot.selected_backup.entry_name;
    let expected = match accounting {
        BackupRestoreAccounting::Current => snapshot.current_backup.deployment.clone(),
        BackupRestoreAccounting::Restored => {
            snapshot.selected_backup.deployment.clone().or_else(|| {
                snapshot
                    .current_backup
                    .deployment
                    .clone()
                    .map(|mut deployment| {
                        deployment.state = DeploymentState::Removed;
                        deployment
                    })
            })
        }
    };
    let actual = database
        .deployment_repository()
        .list_all()?
        .into_iter()
        .find(|deployment| {
            deployment.target_id == *target_id && deployment.runtime_name == *runtime_name
        });
    Ok(match expected {
        Some(expected) => actual.as_ref() == Some(&expected),
        None => actual
            .as_ref()
            .is_none_or(|deployment| deployment.state == DeploymentState::Removed),
    })
}

fn ensure_backup_restore_accounting_known(
    database: &Arc<Mutex<Database>>,
    snapshot: &BackupRestoreSnapshot,
) -> AppResult<()> {
    let database = database
        .lock()
        .map_err(|_| internal("deployment_conflict.backups.accounting_check"))?;
    ensure_backup_restore_accounting_known_locked(&database, snapshot)
}

fn ensure_backup_restore_accounting_known_locked(
    database: &Database,
    snapshot: &BackupRestoreSnapshot,
) -> AppResult<()> {
    if !backup_restore_accounting_matches_locked(
        database,
        snapshot,
        BackupRestoreAccounting::Current,
    )? && !backup_restore_accounting_matches_locked(
        database,
        snapshot,
        BackupRestoreAccounting::Restored,
    )? {
        return Err(changed(
            "the deployment accounting changed during backup restore",
        ));
    }
    Ok(())
}

fn finish_replacement(
    database: &Arc<Mutex<Database>>,
    operation_id: OperationId,
    snapshot: &RecoverySnapshot,
) -> AppResult<()> {
    let filesystem = DeploymentFilesystem::new();
    let replacement_proof = snapshot
        .replacement_ownership
        .as_ref()
        .ok_or_else(|| changed("replacement ownership proof is missing"))?
        .proof_at(PathBuf::from(&snapshot.target.destination_path));
    filesystem.verify_ownership(&replacement_proof)?;
    let original_backup = snapshot
        .original_ownership
        .proof_at(snapshot.backup_path.clone());
    let backup_exists = entry_exists(&snapshot.backup_path)?;
    if backup_exists {
        filesystem.verify_ownership(&original_backup)?;
    }
    reassign_deployment(database, snapshot)?;
    if backup_exists {
        filesystem.remove_owned(&original_backup)?;
    }
    append_replacement_history(database, snapshot, operation_id)?;
    settle(
        database,
        operation_id,
        skillhub_core::OperationPhase::Committed,
    )
}

fn validate_and_classify(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    record: &skillhub_core::OperationRecord,
) -> AppResult<(RecoverySnapshot, Position)> {
    if record.kind != OPERATION_KIND
        || !matches!(
            record.phase,
            skillhub_core::OperationPhase::Applying | skillhub_core::OperationPhase::NeedsRecovery
        )
    {
        return Err(changed("the replacement journal phase is not recoverable"));
    }
    let mut snapshot: RecoverySnapshot = serde_json::from_value(record.recovery_data.clone())
        .map_err(|_| changed("the replacement recovery record is invalid"))?;
    validate_snapshot(database, library_runtime, record.operation_id, &snapshot)?;
    if snapshot.replacement_ownership.is_none() && entry_exists(&snapshot.stage_path)? {
        snapshot.replacement_ownership =
            derive_uncheckpointed_replacement_ownership(library_runtime, &snapshot)?;
    }
    let current = {
        let database = database
            .lock()
            .map_err(|_| internal("deployment_conflict.recovery.inspect"))?;
        database
            .deployment_repository()
            .list_all()?
            .into_iter()
            .find(|deployment| deployment.id == snapshot.original_deployment.id)
            .ok_or_else(|| changed("the managed deployment row is missing"))?
    };
    let old_in_place = verify_at(
        &DeploymentFilesystem::new(),
        &snapshot.original_ownership,
        Path::new(&snapshot.target.destination_path),
    );
    let old_in_backup = verify_at(
        &DeploymentFilesystem::new(),
        &snapshot.original_ownership,
        &snapshot.backup_path,
    );
    let new_at_stage = snapshot
        .replacement_ownership
        .as_ref()
        .is_some_and(|proof| verify_at(&DeploymentFilesystem::new(), proof, &snapshot.stage_path));
    let new_in_place = snapshot
        .replacement_ownership
        .as_ref()
        .is_some_and(|proof| {
            verify_at(
                &DeploymentFilesystem::new(),
                proof,
                Path::new(&snapshot.target.destination_path),
            )
        });
    let prepared_copy_exists = snapshot
        .copy_stage_path
        .as_deref()
        .map(entry_exists)
        .transpose()?
        .unwrap_or(false);
    let prepared_copy_matches = snapshot
        .prepared_copy_ownership
        .as_ref()
        .is_some_and(|proof| {
            snapshot
                .copy_stage_path
                .as_deref()
                .is_some_and(|path| verify_at(&DeploymentFilesystem::new(), proof, path))
        });
    let backup_exists = entry_exists(&snapshot.backup_path)?;
    let stage_exists = entry_exists(&snapshot.stage_path)?;
    if backup_exists && !old_in_backup {
        return Err(changed(
            "the original backup no longer matches its ownership proof",
        ));
    }
    if stage_exists && snapshot.replacement_ownership.is_some() && !new_at_stage {
        return Err(changed(
            "the staged replacement no longer matches its ownership proof",
        ));
    }
    if stage_exists && snapshot.replacement_ownership.is_none() {
        return Err(changed(
            "the replacement staging entry has no verifiable ownership proof",
        ));
    }
    if prepared_copy_exists && snapshot.prepared_copy_ownership.is_some() && !prepared_copy_matches
    {
        return Err(changed(
            "the prepared replacement copy no longer matches its ownership proof",
        ));
    }
    let database_is_original = current == snapshot.original_deployment;
    let database_is_replacement = current == snapshot.replacement_deployment;
    let position = if old_in_place && !backup_exists && !stage_exists && database_is_original {
        Position::Untouched
    } else if old_in_place && !backup_exists && database_is_replacement {
        Position::OriginalRestored
    } else if old_in_backup
        && !entry_exists(Path::new(&snapshot.target.destination_path))?
        && !stage_exists
        && database_is_original
    {
        Position::OriginalInBackup
    } else if old_in_backup && new_at_stage && database_is_original {
        Position::ReplacementStaged
    } else if new_in_place && !old_in_place && (database_is_original || database_is_replacement) {
        if !backup_exists && !database_is_replacement {
            return Err(changed(
                "the original backup is missing before replacement accounting",
            ));
        }
        Position::ReplacementInstalled { backup_exists }
    } else {
        return Err(changed("the replacement filesystem state is ambiguous"));
    };
    Ok((snapshot, position))
}

fn derive_uncheckpointed_replacement_ownership(
    library_runtime: &Arc<LibraryRuntime>,
    snapshot: &RecoverySnapshot,
) -> AppResult<Option<OwnershipSnapshot>> {
    let filesystem = DeploymentFilesystem::new();
    if snapshot.target.mode == skillhub_core::DeploymentMode::ManagedCopy {
        let Some(prepared) = snapshot.prepared_copy_ownership.as_ref() else {
            return Ok(None);
        };
        if verify_at(&filesystem, prepared, &snapshot.stage_path) {
            let mut proof = prepared.clone();
            proof.destination_path = snapshot.stage_path.clone();
            return Ok(Some(proof));
        }
        return Ok(None);
    }

    let library = library_runtime.snapshot()?;
    let paths = LibraryPaths::from_root(library.root.clone());
    let mut candidates = vec![paths
        .management_dir
        .join("deployment-trees")
        .join(snapshot.target.skill_id.to_string())
        .join(skillhub_core::deployment::deployment_tree_dir_name(
            &snapshot.target.version_id,
        ))];
    if let Some((portable, current)) = library
        .central
        .load_portable_skill(snapshot.target.skill_id)
        .ok()
        .flatten()
    {
        if current.as_ref() == Some(&snapshot.target.version_id) {
            candidates.push(
                library.central.visible_skill_path_for_runtime(
                    snapshot.target.skill_id,
                    &portable.runtime_name,
                ),
            );
        }
    }

    let target_identity =
        filesystem.recovery_entry_identity(snapshot.target.mode, &snapshot.stage_path)?;
    for source_path in candidates {
        let Ok(hash) = DeploymentFilesystem::hash_tree(&source_path) else {
            continue;
        };
        if hash != snapshot.replacement_deployment.expected_hash {
            continue;
        }
        let proof = OwnershipSnapshot {
            mode: snapshot.target.mode,
            destination_path: snapshot.stage_path.clone(),
            source_path: source_path.clone(),
            expected_hash: snapshot.replacement_deployment.expected_hash.clone(),
            target_identity: target_identity.clone(),
            link_anchor_paths: vec![source_path],
            skill_id: snapshot.target.skill_id,
            version_id: snapshot.target.version_id.clone(),
            runtime_name: snapshot.target.runtime_name.clone(),
        };
        if filesystem
            .verify_ownership(&proof.proof_at(snapshot.stage_path.clone()))
            .is_ok()
        {
            return Ok(Some(proof));
        }
    }
    Ok(None)
}

fn validate_snapshot(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    operation_id: OperationId,
    snapshot: &RecoverySnapshot,
) -> AppResult<()> {
    if snapshot.schema_version != 1
        || snapshot.pair_id.trim().is_empty()
        || snapshot.target.runtime_name.trim().is_empty()
        || snapshot.target.physical_target_id != snapshot.original_deployment.target_id
        || snapshot.target.skill_id != snapshot.replacement_deployment.skill_id
        || snapshot.target.version_id != snapshot.replacement_deployment.version_id
        || snapshot.target.runtime_name != snapshot.replacement_deployment.runtime_name
        || snapshot.target.mode != snapshot.replacement_deployment.mode
        || snapshot.replacement_deployment.id != snapshot.original_deployment.id
        || snapshot.original_deployment.state != DeploymentState::Deployed
        || !snapshot.original_deployment.managed
        || snapshot.replacement_deployment.state != DeploymentState::Deployed
        || !snapshot.replacement_deployment.managed
        || snapshot.original_deployment.skill_id == snapshot.replacement_deployment.skill_id
        || snapshot.target.target_path != snapshot.target_root.to_string_lossy()
        || snapshot.target.destination_path
            != snapshot
                .target_root
                .join(&snapshot.target.runtime_name)
                .to_string_lossy()
        || snapshot.target_root_identity != snapshot.original_deployment.target_id
        || skillhub_core::physical_id_for_path(&snapshot.target_root).as_deref()
            != Some(snapshot.target_root_identity.as_str())
        || snapshot.stage_path
            != snapshot
                .target_root
                .join(format!(".skillhub-conflict-stage-{operation_id}"))
        || snapshot.backup_path
            != snapshot
                .target_root
                .join(format!(".skillhub-conflict-backup-{operation_id}"))
        || snapshot.copy_stage_path
            != (snapshot.target.mode == skillhub_core::DeploymentMode::ManagedCopy).then(|| {
                snapshot
                    .target_root
                    .join(format!(".skillhub-conflict-copy-{operation_id}"))
            })
        || snapshot.original_ownership.mode != snapshot.original_deployment.mode
        || snapshot.original_ownership.destination_path != snapshot.target.destination_path
        || snapshot.original_ownership.expected_hash != snapshot.original_deployment.expected_hash
        || snapshot.original_ownership.skill_id != snapshot.original_deployment.skill_id
        || snapshot.original_ownership.version_id != snapshot.original_deployment.version_id
        || snapshot.original_ownership.runtime_name != snapshot.original_deployment.runtime_name
        || snapshot
            .replacement_deployment
            .expected_hash
            .trim()
            .is_empty()
        || snapshot
            .prepared_copy_ownership
            .as_ref()
            .is_some_and(|ownership| {
                snapshot.copy_stage_path.as_ref() != Some(&ownership.destination_path)
                    || ownership.mode != skillhub_core::DeploymentMode::ManagedCopy
                    || ownership.expected_hash != snapshot.replacement_deployment.expected_hash
                    || ownership.skill_id != snapshot.target.skill_id
                    || ownership.version_id != snapshot.target.version_id
                    || ownership.runtime_name != snapshot.target.runtime_name
                    || ownership.source_path == PathBuf::new()
                    || ownership.target_identity.trim().is_empty()
            })
    {
        return Err(changed(
            "the replacement recovery facts do not match their journal",
        ));
    }
    let target_root_in_database: String = {
        let database = database
            .lock()
            .map_err(|_| internal("deployment_conflict.recovery.target"))?;
        database
            .connection_for_test()
            .query_row(
                "SELECT path FROM targets WHERE id=?1",
                [snapshot.original_deployment.target_id.as_str()],
                |row| row.get(0),
            )
            .map_err(|_| changed("the registered deployment target is missing"))?
    };
    if Path::new(&target_root_in_database) != snapshot.target_root.as_path() {
        return Err(changed("the registered target path changed"));
    }
    let library = library_runtime.snapshot()?;
    let original_manifest = library
        .store
        .load_manifest(&snapshot.original_deployment.version_id)?;
    let replacement_manifest = library.store.load_manifest(&snapshot.target.version_id)?;
    let original_source = library
        .root
        .join("versions")
        .join(snapshot.original_deployment.skill_id.to_string())
        .join(snapshot.original_deployment.version_id.as_str());
    let replacement_source = library
        .root
        .join("versions")
        .join(snapshot.target.skill_id.to_string())
        .join(snapshot.target.version_id.as_str());
    let replacement_ownership_source = snapshot.replacement_ownership.as_ref().map(|ownership| {
        let paths = LibraryPaths::from_root(library.root.clone());
        let mut candidates = vec![paths
            .management_dir
            .join("deployment-trees")
            .join(snapshot.target.skill_id.to_string())
            .join(skillhub_core::deployment::deployment_tree_dir_name(
                &snapshot.target.version_id,
            ))];
        if snapshot.target.mode.is_directory_link() {
            if let Some((portable, current)) = library
                .central
                .load_portable_skill(snapshot.target.skill_id)
                .ok()
                .flatten()
            {
                if current.as_ref() == Some(&snapshot.target.version_id) {
                    candidates.push(library.central.visible_skill_path_for_runtime(
                        snapshot.target.skill_id,
                        &portable.runtime_name,
                    ));
                }
            }
        }
        candidates.iter().any(|candidate| {
            ownership.source_path == *candidate
                && DeploymentFilesystem::hash_tree(candidate)
                    .is_ok_and(|hash| hash == snapshot.replacement_deployment.expected_hash)
        })
    });
    if original_manifest.skill_id != snapshot.original_deployment.skill_id
        || replacement_manifest.skill_id != snapshot.target.skill_id
        || snapshot.original_ownership.source_path != original_source
        || snapshot.target.source_path != replacement_source.to_string_lossy()
        || replacement_ownership_source == Some(false)
    {
        return Err(changed(
            "a Skill version required for replacement recovery changed",
        ));
    }
    if let Some(ownership) = &snapshot.replacement_ownership {
        if ownership.mode != snapshot.target.mode
            || ownership.expected_hash != snapshot.replacement_deployment.expected_hash
            || ownership.skill_id != snapshot.target.skill_id
            || ownership.version_id != snapshot.target.version_id
            || ownership.runtime_name != snapshot.target.runtime_name
            || ownership.link_anchor_paths != vec![ownership.source_path.clone()]
        {
            return Err(changed("the replacement ownership proof is inconsistent"));
        }
    }
    Ok(())
}

fn reassign_deployment(
    database: &Arc<Mutex<Database>>,
    snapshot: &RecoverySnapshot,
) -> AppResult<()> {
    let database = database
        .lock()
        .map_err(|_| internal("deployment_conflict.account"))?;
    let current = database
        .deployment_repository()
        .list_all()?
        .into_iter()
        .find(|record| record.id == snapshot.original_deployment.id)
        .ok_or_else(|| changed("the managed deployment row is missing"))?;
    if current == snapshot.replacement_deployment {
        return Ok(());
    }
    if current != snapshot.original_deployment {
        return Err(changed("the managed deployment row changed"));
    }
    database
        .deployment_repository()
        .derive_managed_runtime_sync(
            &snapshot.replacement_deployment,
            snapshot.original_deployment.skill_id,
            &snapshot.original_deployment.runtime_name,
        )
}

fn rollback_accounting(
    database: &Arc<Mutex<Database>>,
    snapshot: &RecoverySnapshot,
) -> AppResult<()> {
    let database = database
        .lock()
        .map_err(|_| internal("deployment_conflict.rollback_accounting"))?;
    let current = database
        .deployment_repository()
        .list_all()?
        .into_iter()
        .find(|record| record.id == snapshot.original_deployment.id)
        .ok_or_else(|| changed("the managed deployment row is missing"))?;
    if current == snapshot.original_deployment {
        return Ok(());
    }
    if current != snapshot.replacement_deployment {
        return Err(changed(
            "the managed deployment row changed during rollback",
        ));
    }
    database
        .deployment_repository()
        .derive_managed_runtime_sync(
            &snapshot.original_deployment,
            snapshot.replacement_deployment.skill_id,
            &snapshot.replacement_deployment.runtime_name,
        )
}

fn append_replacement_history(
    database: &Arc<Mutex<Database>>,
    snapshot: &RecoverySnapshot,
    operation_id: OperationId,
) -> AppResult<()> {
    let (database, skill) = {
        let database = database
            .lock()
            .map_err(|_| internal("deployment_conflict.history"))?;
        let skill = database
            .catalog_repository()?
            .get_sync(snapshot.replacement_deployment.skill_id)?
            .ok_or_else(|| changed("the replacement Skill was removed"))?;
        (database, skill)
    };
    super::append_replace_inheritance_history(
        &database,
        &snapshot.original_deployment,
        &skill,
        Path::new(&snapshot.target.destination_path),
        operation_id,
    )
}

fn restore_original(
    filesystem: &DeploymentFilesystem,
    snapshot: &RecoverySnapshot,
    replacement_proof: Option<&OwnershipProof>,
) -> bool {
    let final_path = Path::new(&snapshot.target.destination_path);
    let staged_path = &snapshot.stage_path;
    if let Some(replacement_proof) = replacement_proof {
        for path in [final_path, staged_path] {
            let mut proof = replacement_proof.clone();
            proof.destination_path = path.to_path_buf();
            if entry_exists(path).unwrap_or(false) && filesystem.remove_owned(&proof).is_err() {
                return false;
            }
        }
    }
    if !remove_prepared_copy(filesystem, snapshot) {
        return false;
    }
    let original_at_final = snapshot
        .original_ownership
        .proof_at(final_path.to_path_buf());
    if filesystem.verify_ownership(&original_at_final).is_ok() {
        return true;
    }
    let original_at_backup = snapshot
        .original_ownership
        .proof_at(snapshot.backup_path.clone());
    if filesystem.verify_ownership(&original_at_backup).is_err()
        || entry_exists(final_path).unwrap_or(true)
    {
        return false;
    }
    if filesystem
        .rename_recovery_entry(
            snapshot.original_ownership.mode,
            &snapshot.backup_path,
            final_path,
            &snapshot.original_ownership.target_identity,
        )
        .is_err()
    {
        return false;
    }
    filesystem.verify_ownership(&original_at_final).is_ok()
}

fn remove_prepared_copy(filesystem: &DeploymentFilesystem, snapshot: &RecoverySnapshot) -> bool {
    let Some(path) = snapshot.copy_stage_path.as_deref() else {
        return true;
    };
    match entry_exists(path) {
        Ok(false) => true,
        Err(_) => false,
        Ok(true) => match snapshot.prepared_copy_ownership.as_ref() {
            Some(ownership) if ownership.destination_path == path => filesystem
                .remove_owned(&ownership.proof_at(path.to_path_buf()))
                .is_ok(),
            Some(_) => false,
            None => filesystem
                .recovery_entry_identity(skillhub_core::DeploymentMode::ManagedCopy, path)
                .and_then(|identity| {
                    filesystem.remove_recovery_entry_if_identity(
                        skillhub_core::DeploymentMode::ManagedCopy,
                        path,
                        &identity,
                    )
                })
                .is_ok(),
        },
    }
}

fn verify_at(filesystem: &DeploymentFilesystem, snapshot: &OwnershipSnapshot, path: &Path) -> bool {
    filesystem
        .verify_ownership(&snapshot.proof_at(path.to_path_buf()))
        .is_ok()
}

fn persist_snapshot(
    database: &Arc<Mutex<Database>>,
    operation_id: OperationId,
    snapshot: &RecoverySnapshot,
    phase: skillhub_core::OperationPhase,
) -> AppResult<()> {
    let payload = serde_json::to_value(snapshot)
        .map_err(|_| changed("the replacement recovery facts could not be saved"))?;
    let database = database
        .lock()
        .map_err(|_| internal("deployment_conflict.journal"))?;
    let repository = database.operation_repository();
    let existing = repository.get_sync(operation_id)?;
    let mut record = match existing.as_ref() {
        Some(record) if record.kind == OPERATION_KIND => record.clone(),
        Some(_) => return Err(changed("the operation id is already in use")),
        None => skillhub_core::OperationRecord::planned(operation_id, OPERATION_KIND, ""),
    };
    record.phase = phase;
    record.progress.phase = phase;
    record.progress.total = 1;
    record.progress.completed = u32::from(phase == skillhub_core::OperationPhase::Committed);
    record.progress.message_code = format!("operation.{OPERATION_KIND}.{}", phase_code(phase));
    record.error_code = None;
    record.recovery_data = payload;
    record.result = Some(serde_json::json!({
        "pair_id": snapshot.pair_id,
        "deployment_id": snapshot.replacement_deployment.id,
    }));
    match existing {
        Some(_) => repository.update_sync(&record),
        None => repository.insert_sync(&record),
    }
}

fn settle(
    database: &Arc<Mutex<Database>>,
    operation_id: OperationId,
    phase: skillhub_core::OperationPhase,
) -> AppResult<()> {
    let database = database
        .lock()
        .map_err(|_| internal("deployment_conflict.settle"))?;
    let mut record = database
        .operation_repository()
        .get_sync(operation_id)?
        .ok_or_else(|| changed("the replacement operation journal is missing"))?;
    if record.kind != OPERATION_KIND {
        return Err(changed(
            "the replacement operation journal has another kind",
        ));
    }
    record.phase = phase;
    record.progress.phase = phase;
    record.progress.completed = u32::from(phase == skillhub_core::OperationPhase::Committed);
    record.progress.message_code = format!("operation.{OPERATION_KIND}.{}", phase_code(phase));
    record.error_code = (phase == skillhub_core::OperationPhase::NeedsRecovery)
        .then_some(ErrorCode::OperationConflict);
    database.operation_repository().update_sync(&record)
}

fn single_managed_occupant(
    pair: &DeploymentPairPreview,
) -> AppResult<&skillhub_core::api::DeploymentConflictOccupant> {
    let occupants = &pair
        .conflict
        .as_ref()
        .ok_or_else(|| changed("the stored pair is not a conflict"))?
        .occupants;
    if occupants.len() != 1 {
        return Err(changed("the conflict does not have one managed occupant"));
    }
    let occupant = &occupants[0];
    if occupant.ownership != skillhub_core::ExistingOwnership::Managed
        || occupant.deployment_id.is_none()
        || occupant.skill_id.is_none()
        || occupant.version_id.is_none()
    {
        return Err(changed(
            "the conflict occupant is not a known managed deployment",
        ));
    }
    Ok(occupant)
}

fn entry_exists(path: &Path) -> AppResult<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(filesystem_error("inspect replacement path", error)),
    }
}

fn phase_code(phase: skillhub_core::OperationPhase) -> &'static str {
    match phase {
        skillhub_core::OperationPhase::Planned => "planned",
        skillhub_core::OperationPhase::Prepared => "prepared",
        skillhub_core::OperationPhase::Applying => "applying",
        skillhub_core::OperationPhase::Verifying => "verifying",
        skillhub_core::OperationPhase::Committed => "committed",
        skillhub_core::OperationPhase::NeedsRecovery => "needs_recovery",
        skillhub_core::OperationPhase::RolledBack => "rolled_back",
    }
}

fn changed(detail: &str) -> AppError {
    AppError::new(ErrorCode::TargetChanged, Severity::Error)
        .with_param("detail", detail)
        .with_action(RecoveryAction::InspectTarget)
}

fn internal(operation: &'static str) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("operation", operation)
        .with_action(RecoveryAction::Retry)
}

fn filesystem_error(operation: &'static str, error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("operation", operation)
        .with_param("io_kind", format!("{:?}", error.kind()))
        .with_action(RecoveryAction::Retry)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use skillhub_adapters::deployment::DeploymentFilesystem;
    use skillhub_core::api::{
        DeploymentConflictOccupant, DeploymentConflictPreview, DeploymentPairPreview,
    };
    use skillhub_core::catalog::Skill;
    use skillhub_core::deployment::{
        DeploymentBlockReason, DeploymentConflictAction, DeploymentMode, DeploymentPreference,
        DeploymentPreviewDisposition, DeploymentRecord, DeploymentState, TargetChange, TargetPlan,
    };
    use skillhub_core::{AppError, ErrorCode, OperationId, RecoveryAction, Severity};
    use skillhub_storage::{CentralLibrary, Database, VersionStore};
    use tempfile::TempDir;

    use crate::library_runtime::{LibraryContext, LibraryRuntime};

    use super::{
        backup_restore_recovery_actions, execute_conflict_action_with_checkpoint,
        execute_unknown_conflict_action_with_checkpoint, list_backups, recovery_actions,
        resolve_backup_restore_recovery, resolve_recovery, resolve_unknown_replacement_recovery,
        restore_backup_with_checkpoint, unknown_replacement_recovery_actions,
        validate_and_classify, BackupRestoreCheckpoint, ReplacementCheckpoint,
        UnknownReplacementCheckpoint,
    };

    struct Fixture {
        database: Arc<Mutex<Database>>,
        library_runtime: Arc<LibraryRuntime>,
        _library_root: TempDir,
        target_root: TempDir,
        old_skill: Skill,
        new_skill: Skill,
        old_version: skillhub_core::VersionId,
        new_version: skillhub_core::VersionId,
        deployment_id: skillhub_core::DeploymentId,
        pair: DeploymentPairPreview,
        target: TargetPlan,
        original_contents: String,
        replacement_contents: String,
    }

    fn fixture() -> Fixture {
        let database = Arc::new(Mutex::new(Database::open_in_memory().expect("database")));
        let old_skill = Skill::new(skillhub_core::SkillId::new(), "Original");
        let new_skill = Skill::new(skillhub_core::SkillId::new(), "Replacement");
        {
            let database = database.lock().expect("database lock");
            database
                .catalog_repository()
                .expect("catalog")
                .insert_sync(&old_skill)
                .expect("insert original Skill");
            database
                .catalog_repository()
                .expect("catalog")
                .insert_sync(&new_skill)
                .expect("insert replacement Skill");
        }

        let library_root = tempfile::tempdir().expect("library root");
        let library = CentralLibrary::initialize(library_root.path()).expect("library");
        let original_contents =
            "---\nname: shared-runtime\ndescription: original\n---\n\noriginal\n".to_owned();
        let replacement_contents =
            "---\nname: shared-runtime\ndescription: replacement\n---\n\nreplacement\n".to_owned();
        let mut versions = Vec::new();
        for (skill, contents) in [
            (&old_skill, &original_contents),
            (&new_skill, &replacement_contents),
        ] {
            let source = tempfile::tempdir().expect("skill source");
            std::fs::write(source.path().join("SKILL.md"), contents).expect("write source");
            let version = VersionStore::from_library(&library)
                .capture(skill.id(), source.path())
                .expect("capture version");
            library
                .save_portable_skill(skill, Some(&version.id))
                .expect("save portable Skill");
            database
                .lock()
                .expect("database lock")
                .connection_for_test()
                .execute(
                    "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, ?3, '{}', 0)",
                    rusqlite::params![
                        version.id.to_string(),
                        skill.id().to_string(),
                        version.manifest.tree_hash,
                    ],
                )
                .expect("insert version row");
            versions.push(version.id);
        }

        let target_root = tempfile::tempdir().expect("target root");
        let target_id = skillhub_core::physical_id_for_path(target_root.path())
            .expect("target physical identity");
        database
            .lock()
            .expect("database lock")
            .target_repository()
            .upsert_physical_target(&skillhub_storage::PhysicalTargetRegistration {
                id: &target_id,
                agent_id: "deployment-conflict-test",
                project_id: None,
                scope: "global",
                path: target_root.path().to_string_lossy().as_ref(),
            })
            .expect("register target");
        let destination = target_root.path().join("shared-runtime");
        std::fs::create_dir(&destination).expect("create original deployment");
        std::fs::write(destination.join("SKILL.md"), &original_contents)
            .expect("write original deployment");
        let original_hash = DeploymentFilesystem::hash_tree(&destination).expect("tree hash");
        let deployment_id = skillhub_core::DeploymentId::new();
        database
            .lock()
            .expect("database lock")
            .deployment_repository()
            .insert_sync(&DeploymentRecord {
                id: deployment_id,
                skill_id: old_skill.id(),
                version_id: versions[0].clone(),
                target_id: target_id.clone(),
                state: DeploymentState::Deployed,
                mode: DeploymentMode::ManagedCopy,
                managed: true,
                runtime_name: "shared-runtime".into(),
                expected_hash: original_hash.clone(),
                observed_hash: Some(original_hash.clone()),
            })
            .expect("insert deployment");

        let library_source_root = library.paths().root.clone();
        let library_runtime = Arc::new(LibraryRuntime::from_active(Arc::new(
            LibraryContext::from_library(library),
        )));
        let target_path = target_root.path().to_string_lossy().into_owned();
        let destination_path = destination.to_string_lossy().into_owned();
        let pair = DeploymentPairPreview {
            pair_id: format!("{}:{target_id}", new_skill.id()),
            skill_id: new_skill.id(),
            skill_display_name: new_skill.display_name().to_owned(),
            version_id: versions[1].clone(),
            runtime_name: "shared-runtime".into(),
            logical_target_ids: vec!["target".into()],
            target_label: "Target".into(),
            target_path: target_path.clone(),
            destination_path: destination_path.clone(),
            preference: DeploymentPreference::Copy,
            disposition: DeploymentPreviewDisposition::ConflictDecisionRequired,
            conflict: Some(DeploymentConflictPreview {
                occupants: vec![DeploymentConflictOccupant {
                    ownership: skillhub_core::ExistingOwnership::Managed,
                    deployment_id: Some(deployment_id),
                    skill_id: Some(old_skill.id()),
                    version_id: Some(versions[0].clone()),
                    skill_display_name: Some(old_skill.display_name().to_owned()),
                    physical_target_id: target_id.clone(),
                    runtime_name: "shared-runtime".into(),
                    target_path: destination_path.clone(),
                    consumers: vec![deployment_id],
                    entry_identity: skillhub_core::physical_id_for_path(&destination)
                        .expect("entry identity"),
                    content_fingerprint: Some(original_hash),
                }],
                available_actions: vec![
                    DeploymentConflictAction::ReplaceTarget,
                    DeploymentConflictAction::Skip,
                ],
                default_action: DeploymentConflictAction::Skip,
            }),
            mode: Some(DeploymentMode::ManagedCopy),
            fallback_mode: None,
            block_reason: Some(DeploymentBlockReason::TargetOccupied),
            warnings: Vec::new(),
            confirmation_preserved: false,
            confirmation_fingerprint: "test-fingerprint".into(),
            technical_error: None,
        };
        let operation_source_path = library_source_root
            .join("versions")
            .join(new_skill.id().to_string())
            .join(versions[1].as_str());
        let target = TargetPlan {
            physical_target_id: target_id,
            logical_target_ids: vec!["target".into()],
            target_path,
            destination_path,
            source_path: operation_source_path.to_string_lossy().into_owned(),
            runtime_name: "shared-runtime".into(),
            skill_id: new_skill.id(),
            version_id: versions[1].clone(),
            mode: DeploymentMode::ManagedCopy,
            change: TargetChange::Create,
            warnings: Vec::new(),
            conflicts: Vec::new(),
        };
        Fixture {
            database,
            library_runtime,
            _library_root: library_root,
            target_root,
            old_skill,
            new_skill,
            old_version: versions[0].clone(),
            new_version: versions[1].clone(),
            deployment_id,
            pair,
            target,
            original_contents,
            replacement_contents,
        }
    }

    fn injected_interruption() -> AppError {
        AppError::new(ErrorCode::OperationConflict, Severity::Error)
            .with_param("reason", "injected_interruption")
            .with_action(RecoveryAction::Retry)
    }

    fn mark_fixture_occupant_unknown(fixture: &mut Fixture) {
        let destination = fixture.target_root.path().join("shared-runtime");
        let entry = super::entry_snapshot(&destination).expect("unknown entry facts");
        fixture
            .database
            .lock()
            .expect("database lock")
            .deployment_repository()
            .mark_removed_sync(fixture.deployment_id)
            .expect("mark previous deployment removed");
        let occupant = &mut fixture.pair.conflict.as_mut().expect("conflict").occupants[0];
        occupant.ownership = skillhub_core::ExistingOwnership::Unknown;
        occupant.deployment_id = None;
        occupant.skill_id = None;
        occupant.version_id = None;
        occupant.skill_display_name = None;
        occupant.consumers.clear();
        occupant.entry_identity = entry.identity;
        occupant.content_fingerprint = Some(entry.content_fingerprint);
    }

    #[test]
    fn interrupted_unknown_replacement_can_be_rolled_back_without_losing_original() {
        let mut fixture = fixture();
        mark_fixture_occupant_unknown(&mut fixture);
        let operation_id = OperationId::new();
        execute_unknown_conflict_action_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            operation_id,
            &fixture.pair,
            &fixture.target,
            |checkpoint| {
                if checkpoint == UnknownReplacementCheckpoint::OriginalBackedUp {
                    Err(injected_interruption())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("interrupt after preserving the unknown original");

        let record = fixture
            .database
            .lock()
            .unwrap()
            .operation_repository()
            .get_sync(operation_id)
            .unwrap()
            .expect("operation journal");
        assert_eq!(record.phase, skillhub_core::OperationPhase::NeedsRecovery);
        assert_eq!(
            unknown_replacement_recovery_actions(
                &fixture.database,
                &fixture.library_runtime,
                &record,
            ),
            vec![
                RecoveryAction::CompleteOperation,
                RecoveryAction::RollbackOperation
            ]
        );
        resolve_unknown_replacement_recovery(
            &fixture.database,
            &fixture.library_runtime,
            operation_id,
            RecoveryAction::RollbackOperation,
        )
        .expect("restore unknown original");

        assert_eq!(
            std::fs::read_to_string(fixture.target_root.path().join("shared-runtime/SKILL.md"))
                .expect("original target"),
            fixture.original_contents
        );
        let deployment = fixture
            .database
            .lock()
            .unwrap()
            .deployment_repository()
            .list_all()
            .unwrap()
            .into_iter()
            .find(|record| record.id == fixture.deployment_id)
            .expect("previous deployment row");
        assert_eq!(deployment.state, DeploymentState::Removed);
    }

    #[test]
    fn interrupted_unknown_replacement_can_complete_and_keeps_a_durable_backup() {
        let mut fixture = fixture();
        mark_fixture_occupant_unknown(&mut fixture);
        let operation_id = OperationId::new();
        execute_unknown_conflict_action_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            operation_id,
            &fixture.pair,
            &fixture.target,
            |checkpoint| {
                if checkpoint == UnknownReplacementCheckpoint::ReplacementInstalled {
                    Err(injected_interruption())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("interrupt after installing replacement");

        let record = fixture
            .database
            .lock()
            .unwrap()
            .operation_repository()
            .get_sync(operation_id)
            .unwrap()
            .expect("operation journal");
        assert_eq!(
            unknown_replacement_recovery_actions(
                &fixture.database,
                &fixture.library_runtime,
                &record,
            ),
            vec![
                RecoveryAction::CompleteOperation,
                RecoveryAction::RollbackOperation
            ]
        );
        resolve_unknown_replacement_recovery(
            &fixture.database,
            &fixture.library_runtime,
            operation_id,
            RecoveryAction::CompleteOperation,
        )
        .expect("commit installed replacement");

        let completed = fixture
            .database
            .lock()
            .unwrap()
            .operation_repository()
            .get_sync(operation_id)
            .unwrap()
            .expect("committed journal");
        assert_eq!(completed.phase, skillhub_core::OperationPhase::Committed);
        assert!(!skillhub_core::operation_requires_recovery_gate(
            &completed.kind,
            completed.phase
        ));
        assert_eq!(
            list_backups(&fixture.database, &fixture.library_runtime)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn interrupted_backup_restore_can_roll_back_or_finish_without_losing_either_entry() {
        let mut fixture = fixture();
        mark_fixture_occupant_unknown(&mut fixture);
        super::execute_unknown_conflict_action(
            &fixture.database,
            &fixture.library_runtime,
            OperationId::new(),
            &fixture.pair,
            &fixture.target,
        )
        .expect("replace unknown original");
        let backup = list_backups(&fixture.database, &fixture.library_runtime)
            .unwrap()
            .pop()
            .expect("unknown original backup");

        let interrupted = restore_backup_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            &backup.backup_id,
            |checkpoint| {
                if checkpoint == BackupRestoreCheckpoint::CurrentPreserved {
                    Err(injected_interruption())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("interrupt after preserving current target");
        assert_eq!(interrupted.code, ErrorCode::OperationConflict);
        let restore_record = fixture
            .database
            .lock()
            .unwrap()
            .operation_repository()
            .list_sync()
            .unwrap()
            .into_iter()
            .find(|record| record.kind == super::BACKUP_RESTORE_KIND)
            .expect("restore journal");
        assert_eq!(
            backup_restore_recovery_actions(
                &fixture.database,
                &fixture.library_runtime,
                &restore_record,
            ),
            vec![
                RecoveryAction::CompleteOperation,
                RecoveryAction::RollbackOperation
            ]
        );
        resolve_backup_restore_recovery(
            &fixture.database,
            &fixture.library_runtime,
            restore_record.operation_id,
            RecoveryAction::RollbackOperation,
        )
        .expect("return current deployment to its target");
        assert_eq!(
            std::fs::read_to_string(fixture.target_root.path().join("shared-runtime/SKILL.md"))
                .expect("current managed deployment"),
            fixture.replacement_contents
        );
        assert_eq!(
            list_backups(&fixture.database, &fixture.library_runtime)
                .unwrap()
                .len(),
            1
        );

        restore_backup_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            &backup.backup_id,
            |checkpoint| {
                if checkpoint == BackupRestoreCheckpoint::SelectedRestored {
                    Err(injected_interruption())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("interrupt after restoring selected backup");
        let restore_record = fixture
            .database
            .lock()
            .unwrap()
            .operation_repository()
            .list_sync()
            .unwrap()
            .into_iter()
            .find(|record| {
                record.kind == super::BACKUP_RESTORE_KIND
                    && record.phase == skillhub_core::OperationPhase::NeedsRecovery
            })
            .expect("second restore journal");
        resolve_backup_restore_recovery(
            &fixture.database,
            &fixture.library_runtime,
            restore_record.operation_id,
            RecoveryAction::CompleteOperation,
        )
        .expect("finish restoring selected backup");
        assert_eq!(
            std::fs::read_to_string(fixture.target_root.path().join("shared-runtime/SKILL.md"))
                .expect("restored unknown original"),
            fixture.original_contents
        );
        assert_eq!(
            list_backups(&fixture.database, &fixture.library_runtime)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn unknown_file_replacement_restores_exact_bytes_and_preserves_replacement_backup() {
        let mut fixture = fixture();
        let destination = fixture.target_root.path().join("shared-runtime");
        std::fs::remove_dir_all(&destination).expect("remove managed fixture directory");
        let original = b"user-owned file bytes\n";
        std::fs::write(&destination, original).expect("create unknown file target");
        mark_fixture_occupant_unknown(&mut fixture);
        let operation_id = OperationId::new();
        execute_unknown_conflict_action_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            operation_id,
            &fixture.pair,
            &fixture.target,
            |_| Ok(()),
        )
        .expect("replace unknown file target");

        let backup = list_backups(&fixture.database, &fixture.library_runtime)
            .unwrap()
            .pop()
            .expect("file backup candidate");
        assert_eq!(
            backup.entry_kind,
            skillhub_core::api::DeploymentConflictBackupEntryKind::File
        );
        super::restore_backup(
            &fixture.database,
            &fixture.library_runtime,
            &backup.backup_id,
        )
        .expect("restore original file");
        assert_eq!(std::fs::read(&destination).unwrap(), original);

        let preserved_replacement = list_backups(&fixture.database, &fixture.library_runtime)
            .unwrap()
            .pop()
            .expect("current replacement preserved as a backup");
        assert_eq!(
            preserved_replacement.entry_kind,
            skillhub_core::api::DeploymentConflictBackupEntryKind::Directory
        );
    }

    #[cfg(unix)]
    #[test]
    fn unknown_symlink_replacement_restores_link_without_touching_external_content() {
        use std::os::unix::fs::symlink;

        let mut fixture = fixture();
        let external = TempDir::new().expect("external link target");
        let external_file = external.path().join("keep.txt");
        std::fs::write(&external_file, b"external bytes stay unchanged\n")
            .expect("write external target");
        let destination = fixture.target_root.path().join("shared-runtime");
        std::fs::remove_dir_all(&destination).expect("remove managed fixture directory");
        symlink(external.path(), &destination).expect("create unknown directory symlink");
        mark_fixture_occupant_unknown(&mut fixture);
        execute_unknown_conflict_action_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            OperationId::new(),
            &fixture.pair,
            &fixture.target,
            |_| Ok(()),
        )
        .expect("replace unknown symlink target");

        let backup = list_backups(&fixture.database, &fixture.library_runtime)
            .unwrap()
            .pop()
            .expect("symlink backup candidate");
        assert_eq!(
            backup.entry_kind,
            skillhub_core::api::DeploymentConflictBackupEntryKind::SymbolicLink
        );
        super::restore_backup(
            &fixture.database,
            &fixture.library_runtime,
            &backup.backup_id,
        )
        .expect("restore original symlink");

        assert_eq!(std::fs::read_link(&destination).unwrap(), external.path());
        assert_eq!(
            std::fs::read(&external_file).unwrap(),
            b"external bytes stay unchanged\n"
        );
    }

    #[test]
    fn readonly_target_hides_unknown_backup_and_rejects_restore_without_writes() {
        let mut fixture = fixture();
        mark_fixture_occupant_unknown(&mut fixture);
        super::execute_unknown_conflict_action(
            &fixture.database,
            &fixture.library_runtime,
            OperationId::new(),
            &fixture.pair,
            &fixture.target,
        )
        .expect("replace unknown target");
        let backup = list_backups(&fixture.database, &fixture.library_runtime)
            .unwrap()
            .pop()
            .expect("original backup");
        let destination = fixture.target_root.path().join("shared-runtime");
        let original_permissions = std::fs::metadata(fixture.target_root.path())
            .unwrap()
            .permissions();
        let mut readonly_permissions = original_permissions.clone();
        readonly_permissions.set_readonly(true);
        std::fs::set_permissions(fixture.target_root.path(), readonly_permissions)
            .expect("make registered target readonly");

        assert!(list_backups(&fixture.database, &fixture.library_runtime)
            .unwrap()
            .is_empty());
        assert!(super::restore_backup(
            &fixture.database,
            &fixture.library_runtime,
            &backup.backup_id,
        )
        .is_err());
        std::fs::set_permissions(fixture.target_root.path(), original_permissions)
            .expect("restore target permissions");

        assert_eq!(
            list_backups(&fixture.database, &fixture.library_runtime)
                .unwrap()
                .first()
                .map(|candidate| candidate.backup_id.as_str()),
            Some(backup.backup_id.as_str())
        );
        assert_eq!(
            std::fs::read_to_string(destination.join("SKILL.md")).unwrap(),
            fixture.replacement_contents
        );
    }

    #[test]
    fn changed_unknown_backup_is_hidden_and_cannot_replace_current_target() {
        let mut fixture = fixture();
        mark_fixture_occupant_unknown(&mut fixture);
        let operation_id = OperationId::new();
        execute_unknown_conflict_action_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            operation_id,
            &fixture.pair,
            &fixture.target,
            |_| Ok(()),
        )
        .expect("replace unknown target");
        let backup = list_backups(&fixture.database, &fixture.library_runtime)
            .unwrap()
            .pop()
            .expect("original backup");
        let destination = fixture.target_root.path().join("shared-runtime");
        let record = fixture
            .database
            .lock()
            .unwrap()
            .operation_repository()
            .get_sync(operation_id)
            .unwrap()
            .expect("replacement operation");
        let snapshot: super::UnknownReplacementSnapshot =
            serde_json::from_value(record.recovery_data).expect("replacement snapshot");
        std::fs::write(
            snapshot.backup.backup_path.join("SKILL.md"),
            "tampered after the backup was committed",
        )
        .expect("modify preserved backup");

        assert!(list_backups(&fixture.database, &fixture.library_runtime)
            .unwrap()
            .is_empty());
        assert!(super::restore_backup(
            &fixture.database,
            &fixture.library_runtime,
            &backup.backup_id,
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(destination.join("SKILL.md")).unwrap(),
            fixture.replacement_contents
        );
    }

    #[test]
    fn changed_registered_target_path_hides_and_rejects_backup_restore() {
        let mut fixture = fixture();
        mark_fixture_occupant_unknown(&mut fixture);
        super::execute_unknown_conflict_action(
            &fixture.database,
            &fixture.library_runtime,
            OperationId::new(),
            &fixture.pair,
            &fixture.target,
        )
        .expect("replace unknown target");
        let original_backup = list_backups(&fixture.database, &fixture.library_runtime)
            .unwrap()
            .pop()
            .expect("original backup");
        super::restore_backup(
            &fixture.database,
            &fixture.library_runtime,
            &original_backup.backup_id,
        )
        .expect("restore unknown original");
        let backup = list_backups(&fixture.database, &fixture.library_runtime)
            .unwrap()
            .pop()
            .expect("preserved managed replacement backup");
        let other_root = tempfile::tempdir().expect("different registered target path");
        fixture
            .database
            .lock()
            .unwrap()
            .target_repository()
            .upsert_physical_target(&skillhub_storage::PhysicalTargetRegistration {
                id: &fixture.target.physical_target_id,
                agent_id: "deployment-conflict-test",
                project_id: None,
                scope: "global",
                path: &other_root.path().to_string_lossy(),
            })
            .expect("change registered target path");

        assert!(
            list_backups(&fixture.database, &fixture.library_runtime)
                .unwrap()
                .is_empty(),
            "backups for an unregistered target path must be hidden"
        );
        assert!(super::restore_backup(
            &fixture.database,
            &fixture.library_runtime,
            &backup.backup_id,
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(fixture.target_root.path().join("shared-runtime/SKILL.md"))
                .unwrap(),
            fixture.original_contents
        );
    }

    #[test]
    fn interrupted_backup_restore_hides_recovery_actions_after_target_path_drift() {
        let mut fixture = fixture();
        mark_fixture_occupant_unknown(&mut fixture);
        super::execute_unknown_conflict_action(
            &fixture.database,
            &fixture.library_runtime,
            OperationId::new(),
            &fixture.pair,
            &fixture.target,
        )
        .expect("replace unknown target");
        let original_backup = list_backups(&fixture.database, &fixture.library_runtime)
            .unwrap()
            .pop()
            .expect("original backup");
        super::restore_backup(
            &fixture.database,
            &fixture.library_runtime,
            &original_backup.backup_id,
        )
        .expect("restore unknown original");
        let managed_backup = list_backups(&fixture.database, &fixture.library_runtime)
            .unwrap()
            .pop()
            .expect("preserved managed replacement backup");
        restore_backup_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            &managed_backup.backup_id,
            |checkpoint| {
                if checkpoint == BackupRestoreCheckpoint::CurrentPreserved {
                    Err(injected_interruption())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("interrupt after preserving the current target");
        let record = fixture
            .database
            .lock()
            .unwrap()
            .operation_repository()
            .list_sync()
            .unwrap()
            .into_iter()
            .find(|record| {
                record.kind == super::BACKUP_RESTORE_KIND
                    && record.phase == skillhub_core::OperationPhase::NeedsRecovery
            })
            .expect("restore journal");
        assert!(!backup_restore_recovery_actions(
            &fixture.database,
            &fixture.library_runtime,
            &record,
        )
        .is_empty());
        let snapshot: super::BackupRestoreSnapshot =
            serde_json::from_value(record.recovery_data.clone()).expect("restore snapshot");
        let other_root = tempfile::tempdir().expect("different registered target path");
        fixture
            .database
            .lock()
            .unwrap()
            .target_repository()
            .upsert_physical_target(&skillhub_storage::PhysicalTargetRegistration {
                id: &fixture.target.physical_target_id,
                agent_id: "deployment-conflict-test",
                project_id: None,
                scope: "global",
                path: &other_root.path().to_string_lossy(),
            })
            .expect("change registered target path");

        assert!(backup_restore_recovery_actions(
            &fixture.database,
            &fixture.library_runtime,
            &record,
        )
        .is_empty());
        assert!(resolve_backup_restore_recovery(
            &fixture.database,
            &fixture.library_runtime,
            record.operation_id,
            RecoveryAction::CompleteOperation,
        )
        .is_err());
        assert!(snapshot.selected_backup.backup_path.exists());
        assert!(snapshot.current_backup.backup_path.exists());
        assert!(!snapshot.selected_backup.destination_path.exists());
    }

    #[test]
    fn interrupted_backup_restore_hides_actions_after_deployment_accounting_drifts() {
        let mut fixture = fixture();
        mark_fixture_occupant_unknown(&mut fixture);
        super::execute_unknown_conflict_action(
            &fixture.database,
            &fixture.library_runtime,
            OperationId::new(),
            &fixture.pair,
            &fixture.target,
        )
        .expect("replace unknown target");
        let original_backup = list_backups(&fixture.database, &fixture.library_runtime)
            .unwrap()
            .pop()
            .expect("original backup");
        super::restore_backup(
            &fixture.database,
            &fixture.library_runtime,
            &original_backup.backup_id,
        )
        .expect("restore unknown original");
        let managed_backup = list_backups(&fixture.database, &fixture.library_runtime)
            .unwrap()
            .pop()
            .expect("preserved managed replacement backup");
        restore_backup_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            &managed_backup.backup_id,
            |checkpoint| {
                if checkpoint == BackupRestoreCheckpoint::CurrentPreserved {
                    Err(injected_interruption())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("interrupt after preserving the current target");
        let record = fixture
            .database
            .lock()
            .unwrap()
            .operation_repository()
            .list_sync()
            .unwrap()
            .into_iter()
            .find(|record| record.kind == super::BACKUP_RESTORE_KIND)
            .expect("restore journal");
        fixture
            .database
            .lock()
            .unwrap()
            .deployment_repository()
            .insert_sync(&skillhub_core::deployment::DeploymentRecord {
                id: fixture.deployment_id,
                skill_id: fixture.new_skill.id(),
                version_id: fixture.new_version.clone(),
                target_id: fixture.target.physical_target_id.clone(),
                state: skillhub_core::deployment::DeploymentState::Deployed,
                mode: skillhub_core::deployment::DeploymentMode::ManagedCopy,
                managed: true,
                runtime_name: "shared-runtime".into(),
                expected_hash: "drifted-accounting".into(),
                observed_hash: Some("drifted-accounting".into()),
            })
            .expect("simulate deployment accounting drift");

        assert!(backup_restore_recovery_actions(
            &fixture.database,
            &fixture.library_runtime,
            &record,
        )
        .is_empty());
        assert!(resolve_backup_restore_recovery(
            &fixture.database,
            &fixture.library_runtime,
            record.operation_id,
            RecoveryAction::RollbackOperation,
        )
        .is_err());
    }

    #[test]
    fn recovery_rejects_content_without_a_committed_backup_record() {
        let mut fixture = fixture();
        mark_fixture_occupant_unknown(&mut fixture);
        execute_unknown_conflict_action_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            OperationId::new(),
            &fixture.pair,
            &fixture.target,
            |_| Ok(()),
        )
        .expect("replace unknown target");
        let backup = list_backups(&fixture.database, &fixture.library_runtime)
            .unwrap()
            .pop()
            .expect("original backup");
        let unjournaled_path = fixture.target_root.path().join(".unrelated-content");
        std::fs::write(&unjournaled_path, b"not a committed backup").expect("write unrelated file");
        restore_backup_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            &backup.backup_id,
            |checkpoint| {
                if checkpoint == BackupRestoreCheckpoint::CurrentPreserved {
                    Err(injected_interruption())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("stop after preserving the current target");

        let mut record = fixture
            .database
            .lock()
            .unwrap()
            .operation_repository()
            .list_sync()
            .unwrap()
            .into_iter()
            .find(|record| {
                record.kind == super::BACKUP_RESTORE_KIND
                    && record.phase == skillhub_core::OperationPhase::NeedsRecovery
            })
            .expect("interrupted restore record");
        let mut snapshot: super::BackupRestoreSnapshot =
            serde_json::from_value(record.recovery_data.clone()).expect("restore snapshot");
        snapshot.selected_backup.backup_path = unjournaled_path.clone();
        snapshot.selected_backup.entry = super::entry_snapshot(&unjournaled_path).unwrap();
        record.recovery_data = serde_json::to_value(snapshot).unwrap();
        fixture
            .database
            .lock()
            .unwrap()
            .operation_repository()
            .update_sync(&record)
            .expect("tamper restore journal");

        assert!(backup_restore_recovery_actions(
            &fixture.database,
            &fixture.library_runtime,
            &record,
        )
        .is_empty());
        assert!(resolve_backup_restore_recovery(
            &fixture.database,
            &fixture.library_runtime,
            record.operation_id,
            RecoveryAction::CompleteOperation,
        )
        .is_err());
        assert!(unjournaled_path.exists());
        assert!(!fixture.target_root.path().join("shared-runtime").exists());
    }

    #[test]
    fn completing_backup_restore_revalidates_the_preserved_current_entry() {
        let mut fixture = fixture();
        mark_fixture_occupant_unknown(&mut fixture);
        super::execute_unknown_conflict_action(
            &fixture.database,
            &fixture.library_runtime,
            OperationId::new(),
            &fixture.pair,
            &fixture.target,
        )
        .expect("replace unknown original");
        let backup = list_backups(&fixture.database, &fixture.library_runtime)
            .unwrap()
            .pop()
            .expect("original backup");
        restore_backup_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            &backup.backup_id,
            |checkpoint| {
                if checkpoint == BackupRestoreCheckpoint::CurrentPreserved {
                    Err(injected_interruption())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("interrupt after preserving the current target");
        let record = fixture
            .database
            .lock()
            .unwrap()
            .operation_repository()
            .list_sync()
            .unwrap()
            .into_iter()
            .find(|record| record.kind == super::BACKUP_RESTORE_KIND)
            .expect("restore journal");
        let snapshot: super::BackupRestoreSnapshot =
            serde_json::from_value(record.recovery_data.clone()).expect("restore snapshot");

        std::fs::remove_dir_all(&snapshot.current_backup.backup_path)
            .expect("simulate external removal of the preserved current target");
        let completed =
            super::complete_backup_restore(&fixture.database, record.operation_id, &snapshot);

        assert!(
            completed.is_err(),
            "missing current content must block completion"
        );
        assert!(snapshot.selected_backup.backup_path.exists());
        assert!(!snapshot.selected_backup.destination_path.exists());
        assert_ne!(
            fixture
                .database
                .lock()
                .unwrap()
                .operation_repository()
                .get_sync(record.operation_id)
                .unwrap()
                .unwrap()
                .phase,
            skillhub_core::OperationPhase::Committed
        );
    }

    #[test]
    fn recovery_rolls_back_when_interrupted_after_backing_up_original() {
        let fixture = fixture();
        let operation_id = OperationId::new();
        let error = execute_conflict_action_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            operation_id,
            &fixture.pair,
            &fixture.target,
            |checkpoint| {
                if checkpoint == ReplacementCheckpoint::OriginalBackedUp {
                    Err(injected_interruption())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("injected interruption");
        assert_eq!(error.code, ErrorCode::OperationConflict);
        let record = fixture
            .database
            .lock()
            .unwrap()
            .operation_repository()
            .get_sync(operation_id)
            .unwrap()
            .expect("operation journal");
        assert_eq!(record.phase, skillhub_core::OperationPhase::NeedsRecovery);
        validate_and_classify(&fixture.database, &fixture.library_runtime, &record)
            .unwrap_or_else(|error| panic!("recovery facts did not validate: {error:?}"));
        assert_eq!(
            recovery_actions(&fixture.database, &fixture.library_runtime, &record),
            vec![RecoveryAction::RollbackOperation]
        );

        resolve_recovery(
            &fixture.database,
            &fixture.library_runtime,
            operation_id,
            RecoveryAction::RollbackOperation,
        )
        .expect("restore backed up original");
        assert_eq!(
            std::fs::read_to_string(fixture.target_root.path().join("shared-runtime/SKILL.md"))
                .expect("restored original"),
            fixture.original_contents
        );
        let untracked_entries = std::fs::read_dir(fixture.target_root.path())
            .expect("read target root")
            .map(|entry| entry.expect("target entry").file_name())
            .filter(|name| name != "shared-runtime")
            .collect::<Vec<_>>();
        assert!(
            untracked_entries.is_empty(),
            "rollback removes its private staging copy: {untracked_entries:?}"
        );
        let database = fixture.database.lock().unwrap();
        let deployment = database
            .deployment_repository()
            .list_all()
            .unwrap()
            .into_iter()
            .find(|deployment| deployment.id == fixture.deployment_id)
            .expect("original deployment row");
        assert_eq!(deployment.skill_id, fixture.old_skill.id());
        assert_eq!(deployment.version_id, fixture.old_version);
        assert!(database
            .governance_history_repository()
            .list_for_relation(&format!("managed:{}", fixture.deployment_id))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn recovery_removes_a_copy_staging_entry_created_before_ownership_checkpoint() {
        let fixture = fixture();
        let operation_id = OperationId::new();
        execute_conflict_action_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            operation_id,
            &fixture.pair,
            &fixture.target,
            |checkpoint| {
                if checkpoint == ReplacementCheckpoint::CopyPrepared {
                    Err(injected_interruption())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("interrupted before copy ownership was checkpointed");

        let record = fixture
            .database
            .lock()
            .unwrap()
            .operation_repository()
            .get_sync(operation_id)
            .unwrap()
            .expect("operation journal");
        assert_eq!(record.phase, skillhub_core::OperationPhase::NeedsRecovery);
        assert_eq!(
            recovery_actions(&fixture.database, &fixture.library_runtime, &record),
            vec![RecoveryAction::RollbackOperation]
        );
        resolve_recovery(
            &fixture.database,
            &fixture.library_runtime,
            operation_id,
            RecoveryAction::RollbackOperation,
        )
        .expect("remove operation-owned private staging entry");

        let entries = std::fs::read_dir(fixture.target_root.path())
            .expect("read target root")
            .map(|entry| entry.expect("target entry").file_name())
            .filter(|name| name != "shared-runtime")
            .collect::<Vec<_>>();
        assert!(
            entries.is_empty(),
            "rollback removes the staging entry: {entries:?}"
        );
        assert_eq!(
            std::fs::read_to_string(fixture.target_root.path().join("shared-runtime/SKILL.md"))
                .expect("original target remains"),
            fixture.original_contents
        );
    }

    #[test]
    fn recovery_removes_an_applied_copy_before_replacement_proof_is_checkpointed() {
        let fixture = fixture();
        let operation_id = OperationId::new();
        execute_conflict_action_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            operation_id,
            &fixture.pair,
            &fixture.target,
            |checkpoint| {
                if checkpoint == ReplacementCheckpoint::ReplacementApplied {
                    Err(injected_interruption())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("interrupted after applying the copy and before saving its proof");

        let record = fixture
            .database
            .lock()
            .unwrap()
            .operation_repository()
            .get_sync(operation_id)
            .unwrap()
            .expect("operation journal");
        assert_eq!(
            recovery_actions(&fixture.database, &fixture.library_runtime, &record),
            vec![
                RecoveryAction::CompleteOperation,
                RecoveryAction::RollbackOperation
            ]
        );
        resolve_recovery(
            &fixture.database,
            &fixture.library_runtime,
            operation_id,
            RecoveryAction::RollbackOperation,
        )
        .expect("remove the derived replacement and restore the original");

        let entries = std::fs::read_dir(fixture.target_root.path())
            .expect("read target root")
            .map(|entry| entry.expect("target entry").file_name())
            .filter(|name| name != "shared-runtime")
            .collect::<Vec<_>>();
        assert!(
            entries.is_empty(),
            "rollback removes replacement staging: {entries:?}"
        );
        assert_eq!(
            std::fs::read_to_string(fixture.target_root.path().join("shared-runtime/SKILL.md"))
                .expect("original target restored"),
            fixture.original_contents
        );
    }

    #[test]
    fn recovery_removes_an_applied_link_before_replacement_proof_is_checkpointed() {
        let mut fixture = fixture();
        let capabilities = DeploymentFilesystem::new().available_capabilities();
        let mode = if capabilities.symlink {
            skillhub_core::DeploymentMode::SymbolicLink
        } else if capabilities.junction {
            skillhub_core::DeploymentMode::DirectoryJunction
        } else {
            return;
        };
        fixture.target.mode = mode;
        fixture.pair.preference = skillhub_core::deployment::DeploymentPreference::Link;
        fixture.pair.mode = Some(mode);

        let operation_id = OperationId::new();
        execute_conflict_action_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            operation_id,
            &fixture.pair,
            &fixture.target,
            |checkpoint| {
                if checkpoint == ReplacementCheckpoint::ReplacementApplied {
                    Err(injected_interruption())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("interrupted after applying the link and before saving its proof");

        let record = fixture
            .database
            .lock()
            .unwrap()
            .operation_repository()
            .get_sync(operation_id)
            .unwrap()
            .expect("operation journal");
        assert_eq!(
            recovery_actions(&fixture.database, &fixture.library_runtime, &record),
            vec![
                RecoveryAction::CompleteOperation,
                RecoveryAction::RollbackOperation
            ]
        );
        resolve_recovery(
            &fixture.database,
            &fixture.library_runtime,
            operation_id,
            RecoveryAction::RollbackOperation,
        )
        .expect("remove the derived replacement link and restore the original");

        let entries = std::fs::read_dir(fixture.target_root.path())
            .expect("read target root")
            .map(|entry| entry.expect("target entry").file_name())
            .filter(|name| name != "shared-runtime")
            .collect::<Vec<_>>();
        assert!(
            entries.is_empty(),
            "rollback removes replacement residue: {entries:?}"
        );
        assert_eq!(
            std::fs::read_to_string(fixture.target_root.path().join("shared-runtime/SKILL.md"))
                .expect("original target restored"),
            fixture.original_contents
        );
    }

    #[test]
    fn recovery_completes_when_interrupted_after_install_before_accounting() {
        let fixture = fixture();
        let operation_id = OperationId::new();
        execute_conflict_action_with_checkpoint(
            &fixture.database,
            &fixture.library_runtime,
            operation_id,
            &fixture.pair,
            &fixture.target,
            |checkpoint| {
                if checkpoint == ReplacementCheckpoint::ReplacementInstalled {
                    Err(injected_interruption())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("injected interruption");
        let record = fixture
            .database
            .lock()
            .unwrap()
            .operation_repository()
            .get_sync(operation_id)
            .unwrap()
            .expect("operation journal");
        assert_eq!(record.phase, skillhub_core::OperationPhase::NeedsRecovery);
        validate_and_classify(&fixture.database, &fixture.library_runtime, &record)
            .unwrap_or_else(|error| panic!("recovery facts did not validate: {error:?}"));
        assert_eq!(
            recovery_actions(&fixture.database, &fixture.library_runtime, &record),
            vec![
                RecoveryAction::CompleteOperation,
                RecoveryAction::RollbackOperation
            ]
        );

        resolve_recovery(
            &fixture.database,
            &fixture.library_runtime,
            operation_id,
            RecoveryAction::CompleteOperation,
        )
        .expect("finish installed replacement");
        assert_eq!(
            std::fs::read_to_string(fixture.target_root.path().join("shared-runtime/SKILL.md"))
                .expect("replacement contents"),
            fixture.replacement_contents
        );
        let database = fixture.database.lock().unwrap();
        let deployment = database
            .deployment_repository()
            .list_all()
            .unwrap()
            .into_iter()
            .find(|deployment| deployment.id == fixture.deployment_id)
            .expect("replacement deployment row");
        assert_eq!(deployment.skill_id, fixture.new_skill.id());
        assert_eq!(deployment.version_id, fixture.new_version);
        let history = database
            .governance_history_repository()
            .list_for_relation(&format!("managed:{}", fixture.deployment_id))
            .unwrap();
        assert_eq!(history.len(), 2);
        assert!(history.iter().any(|event| {
            event.operation_id.as_deref() == Some(operation_id.to_string().as_str())
                && event.result == "source_relation_ended"
        }));
        assert!(history.iter().any(|event| {
            event.operation_id.as_deref() == Some(operation_id.to_string().as_str())
                && event.result == "new_relation_established"
        }));
    }
}
