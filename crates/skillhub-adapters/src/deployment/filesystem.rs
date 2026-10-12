use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use skillhub_core::{
    physical_id_for_path, reparse_physical_id_for_path, symlink_physical_id_for_path, AppError,
    AppResult, DeploymentCapability, DeploymentMode, ErrorCode, RecoveryAction, Severity, SkillId,
    TargetPlan, VersionId,
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
    /// Managed locations a deployed link may resolve to.  A link's own file
    /// identity is minted fresh with every replacement and was never
    /// persisted, so link ownership is anchored to where the link points:
    /// a proof for a link deployment lists every source location the apply
    /// flow could have chosen; the adapters refuse a link that resolves
    /// anywhere else.  Empty for non-link modes.
    pub link_anchor_paths: Vec<PathBuf>,
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub runtime_name: String,
}

#[derive(Clone, Debug, Default)]
pub struct DeploymentFilesystem;

/// Stable cause for unavailable directory links, decided at probe time so
/// user-facing reasons never parse OS messages after the fact.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LinkUnavailableCause {
    /// The account may not create directory links (e.g. missing Windows
    /// symlink privilege or developer mode).
    Permission,
    /// The filesystem or platform cannot host directory links.
    Filesystem,
}

impl DeploymentFilesystem {
    pub fn new() -> Self {
        Self
    }

    /// Probes why directory links are unavailable on this host, mirroring
    /// [`Self::available_capabilities`].  `None` when a link can be created.
    pub fn link_unavailability_cause(&self) -> Option<LinkUnavailableCause> {
        let workspace = tempfile::tempdir().ok()?;
        let source = workspace.path().join("source");
        let destination = workspace.path().join("destination");
        if fs::create_dir(&source).is_err() {
            return Some(LinkUnavailableCause::Filesystem);
        }
        match symlink::create_dir_link(&source, &destination) {
            Ok(()) => {
                let materialized = fs::symlink_metadata(&destination)
                    .map(|metadata| metadata.file_type().is_symlink())
                    .unwrap_or(false);
                if fs::symlink_metadata(&destination).is_ok() {
                    let _ = symlink::remove_dir_link(&destination);
                }
                if materialized {
                    None
                } else {
                    // A creation that reports success without materializing
                    // (filtered or virtualized volumes) is "unsupported".
                    Some(LinkUnavailableCause::Filesystem)
                }
            }
            Err(error) => Some(classify_link_error(&error)),
        }
    }

    /// Checks the running account's ability to create directory links without
    /// touching an Agent or project directory. Copy deployments remain
    /// available even if the platform rejects links. A creation that reports
    /// success without actually materializing a link (observed on filtered or
    /// virtualized volumes) is treated as "unsupported".
    ///
    /// Both link kinds are probed: a Windows account that cannot create a
    /// symbolic link can still create a junction, and reporting that honestly
    /// is what lets target modes and the deployment planner stay accurate.
    pub fn available_capabilities(&self) -> DeploymentCapability {
        let (symlink, junction) = tempfile::tempdir()
            .ok()
            .map(|workspace| {
                let source = workspace.path().join("source");
                let destination = workspace.path().join("destination");
                if fs::create_dir(&source).is_err() {
                    return (false, false);
                }
                let symlink = self.probe_symlink(&source, &destination);
                let junction = self.probe_junction(&source, &destination);
                (symlink, junction)
            })
            .unwrap_or((false, false));
        DeploymentCapability::new(symlink, junction, true)
    }

    pub fn hash_tree(root: impl AsRef<Path>) -> AppResult<String> {
        tree_hash(root.as_ref())
    }

    /// Checks the final path component without resolving it. The result is
    /// true for directory symlinks on Unix and for any reparse point on
    /// Windows, so callers can reject an unexpected link before copying or
    /// removing an entry.
    pub fn is_directory_link_entry(path: impl AsRef<Path>) -> bool {
        is_directory_link_entry(path.as_ref())
    }

    /// Probes directory-link creation at the exact location where a relation
    /// conversion would create the replacement entry.  The global
    /// [`Self::available_capabilities`] probe cannot answer per-volume
    /// questions: a filtered, read-only, or cross-privilege volume must make
    /// the conversion fail instead of silently degrading to a copy.
    ///
    /// The probe creates a uniquely named directory link inside `parent`
    /// pointing at `target`, verifies it materialized, and removes it again.
    /// Copy stays reported as available: refusing the copy fallback is a
    /// conversion policy, not a filesystem capability fact.
    pub fn probe_link_capabilities(&self, parent: &Path, target: &Path) -> DeploymentCapability {
        let probe_destination = parent.join(format!(
            ".skillhub-link-probe-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default(),
        ));
        // An existing probe entry cannot be verified as ours; refuse instead
        // of replacing or deleting a foreign path.
        if fs::symlink_metadata(&probe_destination).is_ok() {
            return DeploymentCapability::new(false, false, true);
        }
        let symlink = self.probe_symlink(target, &probe_destination);
        let junction = self.probe_junction(target, &probe_destination);
        DeploymentCapability::new(symlink, junction, true)
    }

    fn probe_symlink(&self, target: &Path, destination: &Path) -> bool {
        let created = symlink::create_dir_link(target, destination).is_ok()
            && fs::symlink_metadata(destination)
                .map(|metadata| metadata.file_type().is_symlink())
                .unwrap_or(false);
        // The probe entry must never survive, even when it did not
        // materialize as a link.
        if fs::symlink_metadata(destination).is_ok()
            && symlink::remove_dir_link(destination).is_err()
        {
            return false;
        }
        created
    }

    #[cfg(windows)]
    fn probe_junction(&self, target: &Path, destination: &Path) -> bool {
        // A junction needs no privilege, so this is the probe that keeps a
        // relation conversion available to an account that cannot create
        // symbolic links.  It must clean up after itself: a surviving probe
        // entry would sit in the user's own directory.
        let materialized = junction_windows::create_junction(target, destination).is_ok()
            && junction_windows::is_reparse_point(destination);
        if fs::symlink_metadata(destination).is_ok()
            && junction_windows::remove_junction(destination).is_err()
        {
            return false;
        }
        materialized
    }

    #[cfg(not(windows))]
    fn probe_junction(&self, _: &Path, _: &Path) -> bool {
        false
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
                // Some Windows configurations report success for symlink_dir
                // without actually materializing the link. Verify before
                // treating the deployment as applied so failures stay honest.
                let materialized = fs::symlink_metadata(&prepared.destination_path)
                    .map(|meta| meta.file_type().is_symlink())
                    .unwrap_or(false);
                if !materialized {
                    return Err(unsupported_symlink());
                }
            }
            DeploymentMode::DirectoryJunction => {
                junction_windows::create_junction(
                    &prepared.source_path,
                    &prepared.destination_path,
                )
                .map_err(|_| unsupported_junction())?;
                // Both link kinds can report success without materializing.
                // Verify before treating the deployment as applied so the
                // failure stays honest instead of leaving an empty directory.
                if !junction_windows::is_reparse_point(&prepared.destination_path) {
                    return Err(unsupported_junction());
                }
            }
        }
        let observed_tree_hash = tree_hash(&prepared.destination_path)?;
        if observed_tree_hash != prepared.expected_tree_hash {
            return Err(target_changed(&prepared.destination_path));
        }
        let target_identity = ownership_identity(prepared.mode, &prepared.destination_path)?;
        let ownership = OwnershipProof {
            mode: prepared.mode,
            destination_path: prepared.destination_path,
            link_anchor_paths: vec![prepared.source_path.clone()],
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

    /// K5：按所有权证明核对条目仍归属记录（物理身份 + 内容哈希；链接
    /// 模式只核对链接本身）。替换继承在交接前用它逐项验证。
    pub fn verify_ownership(&self, proof: &OwnershipProof) -> AppResult<()> {
        verify_owned(proof)
    }

    pub fn remove_owned(&self, proof: &OwnershipProof) -> AppResult<()> {
        verify_owned(proof)?;
        remove_target(proof)
    }

    /// Removes a target that this machine recorded as written by an
    /// interrupted operation.  The caller supplies the path from its own
    /// durable `recovery_data`, so the content-hash ownership proof is
    /// deliberately skipped: residue is by definition a half-written tree
    /// whose hash cannot match anything.  The physical identity is not
    /// re-checked either, for the same reason — the entry may not exist yet.
    /// A missing path is a no-op, which keeps the call idempotent.
    pub fn remove_residue(&self, path: &Path, mode: DeploymentMode) -> AppResult<()> {
        if fs::symlink_metadata(path).is_err() {
            return Ok(());
        }
        remove_residue_path(path, mode)
    }

    /// Checks that a deployment recovery entry is still at its recorded
    /// registered root and has the physical identity captured when the
    /// application attempted to undo the write. A missing entry is safe to
    /// treat as already removed.
    pub fn validate_residue_identity(
        &self,
        root: &Path,
        path: &Path,
        runtime_name: &str,
        mode: DeploymentMode,
        expected_target_id: &str,
        expected_entry_identity: &str,
    ) -> AppResult<bool> {
        skillhub_core::deployment::validate_runtime_name(runtime_name)?;
        if !root.is_dir()
            || physical_id_for_path(root).as_deref() != Some(expected_target_id)
            || path.parent() != Some(root)
            || path.file_name() != Some(std::ffi::OsStr::new(runtime_name))
        {
            return Err(ownership_mismatch(path));
        }
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(io_error(error)),
        };
        let mode_matches_entry_type = residue_entry_type_matches(
            mode,
            metadata.is_dir(),
            metadata.file_type().is_symlink(),
            Self::is_directory_link_entry(path),
        );
        let identity = match mode {
            DeploymentMode::ManagedCopy => physical_id_for_path(path),
            DeploymentMode::SymbolicLink => symlink_physical_id_for_path(path),
            DeploymentMode::DirectoryJunction => reparse_physical_id_for_path(path),
        };
        if !mode_matches_entry_type || identity.as_deref() != Some(expected_entry_identity) {
            return Err(ownership_mismatch(path));
        }
        Ok(true)
    }

    /// Removes deployment residue only after rechecking its root and entry
    /// identity immediately before the filesystem operation.
    pub fn remove_residue_if_identity(
        &self,
        root: &Path,
        path: &Path,
        runtime_name: &str,
        mode: DeploymentMode,
        expected_target_id: &str,
        expected_entry_identity: &str,
    ) -> AppResult<()> {
        if self.validate_residue_identity(
            root,
            path,
            runtime_name,
            mode,
            expected_target_id,
            expected_entry_identity,
        )? {
            remove_residue_path(path, mode)?;
        }
        Ok(())
    }

    /// Removes a target after the caller has explicitly confirmed a restore.
    /// The physical identity is still checked, but the content hash is allowed
    /// to differ because this operation intentionally replaces external edits.
    pub fn replace_owned(&self, proof: &OwnershipProof) -> AppResult<()> {
        verify_identity(proof)?;
        remove_target(proof)
    }
}

fn remove_residue_path(path: &Path, mode: DeploymentMode) -> AppResult<()> {
    match mode {
        DeploymentMode::ManagedCopy => fs::remove_dir_all(path).map_err(io_error),
        DeploymentMode::SymbolicLink => symlink::remove_dir_link(path).map_err(io_error),
        DeploymentMode::DirectoryJunction => {
            junction_windows::remove_junction(path).map_err(io_error)
        }
    }
}

fn residue_entry_type_matches(
    mode: DeploymentMode,
    is_directory: bool,
    is_symlink: bool,
    is_directory_link: bool,
) -> bool {
    match mode {
        DeploymentMode::ManagedCopy => is_directory && !is_symlink && !is_directory_link,
        DeploymentMode::SymbolicLink => is_symlink,
        DeploymentMode::DirectoryJunction => is_directory_link,
    }
}

#[cfg(test)]
mod tests {
    use super::residue_entry_type_matches;
    use skillhub_core::DeploymentMode;

    #[cfg(windows)]
    use super::DeploymentFilesystem;
    #[cfg(windows)]
    use skillhub_core::physical_id_for_path;

    #[test]
    fn managed_copy_recovery_rejects_any_directory_link() {
        assert!(!residue_entry_type_matches(
            DeploymentMode::ManagedCopy,
            true,
            false,
            true,
        ));
    }

    #[cfg(windows)]
    #[test]
    fn managed_copy_recovery_rejects_a_replaced_directory_junction() {
        use super::junction_windows;

        let workspace = tempfile::tempdir().expect("workspace");
        let root = workspace.path().join("target-root");
        let source = workspace.path().join("source");
        let residue = root.join("skill");
        std::fs::create_dir(&root).expect("target root");
        std::fs::create_dir(&source).expect("junction source");
        std::fs::write(source.join("SKILL.md"), "# preserve\n").expect("source content");
        junction_windows::create_junction(&source, &residue).expect("replacement junction");

        let filesystem = DeploymentFilesystem::new();
        let result = filesystem.validate_residue_identity(
            &root,
            &residue,
            "skill",
            DeploymentMode::ManagedCopy,
            &physical_id_for_path(&root).expect("root identity"),
            &physical_id_for_path(&residue).expect("resolved replacement identity"),
        );

        assert!(result.is_err(), "a junction is not a managed copy residue");
        assert!(
            source.join("SKILL.md").is_file(),
            "junction target survives"
        );
    }
}

/// Physical identity used in ownership proofs. Link deployments pin the link
/// itself (a trailing reparse point is never followed) so removing the link
/// keeps working after the central library replaces the source directory;
/// every other mode keeps following to the real directory.
fn ownership_identity(mode: DeploymentMode, path: &Path) -> AppResult<String> {
    let lookup = match mode {
        DeploymentMode::SymbolicLink => symlink_physical_id_for_path(path),
        DeploymentMode::DirectoryJunction => reparse_physical_id_for_path(path),
        DeploymentMode::ManagedCopy => physical_id_for_path(path),
    };
    lookup.ok_or_else(|| operation_conflict("target filesystem identity is unavailable"))
}

fn remove_target(proof: &OwnershipProof) -> AppResult<()> {
    match proof.mode {
        DeploymentMode::ManagedCopy => {
            fs::remove_dir_all(&proof.destination_path).map_err(io_error)?;
        }
        DeploymentMode::SymbolicLink => {
            symlink::remove_dir_link(&proof.destination_path).map_err(io_error)?;
        }
        DeploymentMode::DirectoryJunction => {
            junction_windows::remove_junction(&proof.destination_path).map_err(io_error)?;
        }
    }
    Ok(())
}

fn verify_owned(proof: &OwnershipProof) -> AppResult<()> {
    let destination = &proof.destination_path;
    if !destination.exists() {
        return Err(ownership_mismatch(destination));
    }
    verify_identity(proof)?;
    if proof.mode.is_directory_link() {
        // The deployment owns the link, not the content it resolves to: source
        // updates legitimately replace that directory wholesale, so a stale
        // content hash must not block removing the link we created.
        return Ok(());
    }
    let current_hash = tree_hash(destination)?;
    if current_hash != proof.expected_hash {
        return Err(ownership_mismatch(destination));
    }
    Ok(())
}

fn verify_identity(proof: &OwnershipProof) -> AppResult<()> {
    let destination = &proof.destination_path;
    if !destination.exists() {
        return Err(ownership_mismatch(destination));
    }
    if proof.mode.is_directory_link() {
        return verify_link_identity(proof);
    }
    let current_identity = ownership_identity(proof.mode, destination)?;
    if current_identity != proof.target_identity {
        return Err(ownership_mismatch(destination));
    }
    Ok(())
}

/// Link deployments are owned as links, but a link's own file identity is a
/// fresh file record for every creation (a replacement link never reuses the
/// old one) and was never persisted.  Recomputing that identity at removal
/// time and comparing it with the same recomputation would bless any
/// replacement entry, so the durable anchor is where the link resolves: the
/// entry must still be a link and must resolve to one of the managed source
/// locations recorded in the proof.
fn verify_link_identity(proof: &OwnershipProof) -> AppResult<()> {
    let destination = &proof.destination_path;
    if !is_directory_link_entry(destination) {
        return Err(ownership_mismatch(destination));
    }
    let Ok(resolved) = fs::canonicalize(destination) else {
        return Err(ownership_mismatch(destination));
    };
    let anchored = proof.link_anchor_paths.iter().any(|anchor| {
        fs::canonicalize(anchor).is_ok_and(|canonical_anchor| canonical_anchor == resolved)
    });
    if !anchored {
        return Err(ownership_mismatch(destination));
    }
    Ok(())
}

/// Whether the entry itself is a directory link (reparse point, or a symlink
/// where reparse points do not exist), without following it.
fn is_directory_link_entry(path: &Path) -> bool {
    junction_windows::is_reparse_point(path)
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

fn classify_link_error(error: &io::Error) -> LinkUnavailableCause {
    match error.kind() {
        io::ErrorKind::PermissionDenied => LinkUnavailableCause::Permission,
        _ => LinkUnavailableCause::Filesystem,
    }
}
