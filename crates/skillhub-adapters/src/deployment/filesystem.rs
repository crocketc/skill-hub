use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use skillhub_core::{
    physical_id_for_path, AppError, AppResult, DeploymentMode, ErrorCode, RecoveryAction, Severity,
    SkillId, TargetPlan, VersionId,
};

use super::{junction_windows, managed_copy, symlink};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedTarget {
    pub mode: DeploymentMode,
    pub source_path: PathBuf,
    pub destination_path: PathBuf,
    pub staging_path: Option<PathBuf>,
    pub expected_tree_hash: String,
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub runtime_name: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppliedTarget {
    pub destination_path: PathBuf,
    pub observed_tree_hash: String,
    pub ownership: OwnershipProof,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnershipProof {
    pub mode: DeploymentMode,
    pub destination_path: PathBuf,
    pub source_path: PathBuf,
    pub expected_hash: String,
    pub target_identity: String,
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub runtime_name: String,
}

#[derive(Clone, Debug, Default)]
pub struct DeploymentFilesystem;

impl DeploymentFilesystem {
    pub fn new() -> Self {
        Self
    }

    pub fn hash_tree(root: impl AsRef<Path>) -> AppResult<String> {
        tree_hash(root.as_ref())
    }

    pub fn prepare(&self, target: &TargetPlan) -> AppResult<PreparedTarget> {
        let source_path = PathBuf::from(&target.source_path);
        let destination_path = PathBuf::from(&target.destination_path);
        if !source_path.is_dir() {
            return Err(operation_conflict("source deployment tree is unavailable"));
        }
        if destination_path.exists() {
            return Err(target_exists(&destination_path));
        }
        let parent = destination_path.parent().ok_or_else(|| {
            AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("detail", "destination must have a parent")
                .with_action(RecoveryAction::Acknowledge)
        })?;
        if !parent.is_dir() {
            return Err(operation_conflict("target parent is unavailable"));
        }

        let expected_tree_hash = tree_hash(&source_path)?;
        let staging_path = if target.mode == DeploymentMode::ManagedCopy {
            let staging = unique_staging_path(parent, &target.runtime_name);
            managed_copy::copy_tree(&source_path, &staging).map_err(io_error)?;
            Some(staging)
        } else {
            None
        };

        Ok(PreparedTarget {
            mode: target.mode,
            source_path,
            destination_path,
            staging_path,
            expected_tree_hash,
            skill_id: target.skill_id,
            version_id: target.version_id.clone(),
            runtime_name: target.runtime_name.clone(),
        })
    }

    pub fn apply(&self, prepared: PreparedTarget) -> AppResult<AppliedTarget> {
        if prepared.destination_path.exists() {
            return Err(target_exists(&prepared.destination_path));
        }
        match prepared.mode {
            DeploymentMode::ManagedCopy => {
                let staging = prepared
                    .staging_path
                    .as_ref()
                    .ok_or_else(|| operation_conflict("managed copy was not prepared"))?;
                fs::rename(staging, &prepared.destination_path).map_err(io_error)?;
            }
            DeploymentMode::SymbolicLink => {
                symlink::create_dir_link(&prepared.source_path, &prepared.destination_path)
                    .map_err(|_| unsupported_symlink())?;
            }
            DeploymentMode::DirectoryJunction => {
                junction_windows::create_junction(
                    &prepared.source_path,
                    &prepared.destination_path,
                )
                .map_err(|_| unsupported_junction())?;
            }
        }
        let observed_tree_hash = tree_hash(&prepared.destination_path)?;
        if observed_tree_hash != prepared.expected_tree_hash {
            return Err(target_changed(&prepared.destination_path));
        }
        let target_identity = physical_id_for_path(&prepared.destination_path)
            .ok_or_else(|| operation_conflict("target filesystem identity is unavailable"))?;
        let ownership = OwnershipProof {
            mode: prepared.mode,
            destination_path: prepared.destination_path,
            source_path: prepared.source_path,
            expected_hash: prepared.expected_tree_hash,
            target_identity,
            skill_id: prepared.skill_id,
            version_id: prepared.version_id,
            runtime_name: prepared.runtime_name,
        };
        Ok(AppliedTarget {
            destination_path: ownership.destination_path.clone(),
            observed_tree_hash,
            ownership,
        })
    }

    pub fn verify(&self, applied: &AppliedTarget) -> AppResult<()> {
        verify_owned(&applied.ownership)?;
        let observed = tree_hash(&applied.destination_path)?;
        if observed != applied.observed_tree_hash {
            return Err(target_changed(&applied.destination_path));
        }
        Ok(())
    }

    pub fn remove_owned(&self, proof: &OwnershipProof) -> AppResult<()> {
        verify_owned(proof)?;
        match proof.mode {
            DeploymentMode::ManagedCopy => {
                fs::remove_dir_all(&proof.destination_path).map_err(io_error)?;
            }
            DeploymentMode::SymbolicLink => {
                symlink::remove_dir_link(&proof.destination_path).map_err(io_error)?;
            }
            DeploymentMode::DirectoryJunction => {
                fs::remove_dir(&proof.destination_path).map_err(io_error)?;
            }
        }
        Ok(())
    }
}

fn verify_owned(proof: &OwnershipProof) -> AppResult<()> {
    let destination = &proof.destination_path;
    if !destination.exists() {
        return Err(ownership_mismatch(destination));
    }
    let current_identity = physical_id_for_path(destination)
        .ok_or_else(|| operation_conflict("target filesystem identity is unavailable"))?;
    if current_identity != proof.target_identity {
        return Err(ownership_mismatch(destination));
    }
    let current_hash = tree_hash(destination)?;
    if current_hash != proof.expected_hash {
        return Err(ownership_mismatch(destination));
    }
    Ok(())
}

fn tree_hash(root: &Path) -> AppResult<String> {
    let mut entries = Vec::new();
    collect_entries(root, root, &mut entries)?;
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hasher = Sha256::new();
    for (relative_path, digest) in entries {
        hasher.update(relative_path.as_bytes());
        hasher.update([0]);
        hasher.update(digest.as_bytes());
        hasher.update([0]);
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn collect_entries(
    root: &Path,
    current: &Path,
    entries: &mut Vec<(String, String)>,
) -> AppResult<()> {
    let metadata = fs::symlink_metadata(current).map_err(io_error)?;
    if metadata.file_type().is_symlink() && current != root {
        return Err(operation_conflict(
            "deployment trees must not contain nested symlinks",
        ));
    }
    let relative = current
        .strip_prefix(root)
        .map_err(|_| operation_conflict("deployment path escaped its root"))?
        .to_string_lossy()
        .replace('\\', "/");
    if metadata.is_dir() || (metadata.file_type().is_symlink() && current == root) {
        entries.push((format!("dir:{relative}"), String::new()));
        for entry in fs::read_dir(current).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            collect_entries(root, &entry.path(), entries)?;
        }
        return Ok(());
    }
    let bytes = fs::read(current).map_err(io_error)?;
    let digest = Sha256::digest(bytes);
    entries.push((format!("file:{relative}"), format!("{digest:x}")));
    Ok(())
}

fn unique_staging_path(parent: &Path, runtime_name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    parent.join(format!(".skillhub.tmp.{runtime_name}.{nanos}"))
}

fn target_exists(path: impl AsRef<Path>) -> AppError {
    AppError::new(ErrorCode::TargetExists, Severity::Error)
        .with_param("path", path.as_ref().to_string_lossy().into_owned())
        .with_action(RecoveryAction::ChooseAnotherName)
        .with_action(RecoveryAction::InspectTarget)
}

fn target_changed(path: impl AsRef<Path>) -> AppError {
    AppError::new(ErrorCode::TargetChanged, Severity::Error)
        .with_param("path", path.as_ref().to_string_lossy().into_owned())
        .with_action(RecoveryAction::InspectTarget)
}

fn ownership_mismatch(path: impl AsRef<Path>) -> AppError {
    AppError::new(ErrorCode::OwnershipMismatch, Severity::Error)
        .with_param("path", path.as_ref().to_string_lossy().into_owned())
        .with_action(RecoveryAction::InspectTarget)
}

fn unsupported_symlink() -> AppError {
    AppError::new(ErrorCode::SymlinkNotSupported, Severity::Warning)
        .with_action(RecoveryAction::OpenReadOnly)
}

fn unsupported_junction() -> AppError {
    AppError::new(ErrorCode::JunctionNotSupported, Severity::Warning)
        .with_action(RecoveryAction::OpenReadOnly)
}

fn operation_conflict(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("detail", detail.into())
        .with_action(RecoveryAction::InspectTarget)
}

fn io_error(error: io::Error) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("io_kind", format!("{:?}", error.kind()))
        .with_param("detail", error.to_string())
        .with_action(RecoveryAction::Retry)
}
