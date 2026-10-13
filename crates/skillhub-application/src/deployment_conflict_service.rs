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

pub(crate) fn execute_conflict_action(
    database: &Arc<Mutex<Database>>,
    library_runtime: &Arc<LibraryRuntime>,
    operation_id: OperationId,
    pair: &DeploymentPairPreview,
    target: &TargetPlan,
) -> AppResult<ReplacementReceipt> {
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
        execute_conflict_action_with_checkpoint, recovery_actions, resolve_recovery,
        validate_and_classify, ReplacementCheckpoint,
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
