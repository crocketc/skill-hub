use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use skillhub_core::catalog::Skill;
use skillhub_core::{
    AppError, AppResult, ErrorCode, LibraryManifest, LibraryPaths, PortableSkillRecord,
    RecoveryAction, Severity, SkillId, VersionId,
};

use super::portable::{ManifestFaultHandler, PortableManifestStore};
use crate::version_store::VersionStore;

/// Filesystem-backed central library.
pub struct CentralLibrary {
    paths: LibraryPaths,
    store: PortableManifestStore,
}

/// A visible-tree replacement whose prior directory is retained until the
/// caller commits all other consumers of the selected version.
#[derive(Debug)]
pub struct VisibleTreeReplacement {
    skill_id: SkillId,
    output: std::path::PathBuf,
    backup: Option<std::path::PathBuf>,
    expected_tree_hash: String,
    expected_backup_tree_hash: Option<String>,
}

impl VisibleTreeReplacement {
    pub fn backup_path(&self) -> Option<&Path> {
        self.backup.as_deref()
    }
}

impl std::fmt::Debug for CentralLibrary {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CentralLibrary")
            .field("paths", &self.paths)
            .finish()
    }
}

impl CentralLibrary {
    /// Creates a new central library in a missing or empty directory.
    /// Existing user files are never overwritten or silently adopted.
    pub fn create(root: impl AsRef<Path>) -> AppResult<Self> {
        let root = root.as_ref();
        if root.exists() {
            if !root.is_dir() {
                return Err(library_conflict("library root is not a directory"));
            }
            let mut entries = fs::read_dir(root).map_err(io_error)?;
            if entries.next().transpose().map_err(io_error)?.is_some() {
                return Err(library_conflict(
                    "new library root must be missing or empty",
                ));
            }
        }
        Self::materialize(root, true)
    }

    /// Opens a previously initialized central library without creating its
    /// manifest or adopting an ordinary directory as a library.
    pub fn open_existing(root: impl AsRef<Path>) -> AppResult<Self> {
        let root = root.as_ref();
        let paths = LibraryPaths::from_root(root);
        if !paths.manifest_path.is_file() {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("reason", "existing_library_manifest_missing")
                .with_action(RecoveryAction::ChooseAnotherName));
        }
        Self::materialize(root, false)
    }

    pub fn initialize(root: impl AsRef<Path>) -> AppResult<Self> {
        Self::initialize_with_fault_handler(root, Arc::new(|_| false))
    }

    pub fn initialize_with_fault_handler(
        root: impl AsRef<Path>,
        fault_handler: ManifestFaultHandler,
    ) -> AppResult<Self> {
        Self::materialize_with_fault_handler(root.as_ref(), true, fault_handler)
    }

    fn materialize(root: &Path, allow_manifest_creation: bool) -> AppResult<Self> {
        Self::materialize_with_fault_handler(root, allow_manifest_creation, Arc::new(|_| false))
    }

    fn materialize_with_fault_handler(
        root: &Path,
        allow_manifest_creation: bool,
        fault_handler: ManifestFaultHandler,
    ) -> AppResult<Self> {
        let paths = LibraryPaths::from_root(root);
        for directory in [
            &paths.skills_dir,
            &paths.drafts_dir,
            &paths.management_dir,
            &paths.metadata_dir,
            &paths.versions_dir,
            &paths.objects_dir,
            &paths.backups_dir,
            &paths.tmp_dir,
        ] {
            fs::create_dir_all(directory).map_err(io_error)?;
        }
        let store = PortableManifestStore::new(paths.manifest_path.clone(), fault_handler);
        if !paths.manifest_path.exists() {
            if !allow_manifest_creation {
                return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                    .with_param("reason", "existing_library_manifest_missing")
                    .with_action(RecoveryAction::ChooseAnotherName));
            }
            store.write_atomic(&LibraryManifest::default())?;
        } else {
            // Existing files are never overwritten during initialization.
            store.load()?;
        }
        let library = Self { paths, store };
        library.probe_writable()?;
        library.materialize_missing_visible_skills()?;
        Ok(library)
    }

    fn probe_writable(&self) -> AppResult<()> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let probe = self
            .paths
            .management_dir
            .join(format!(".write-probe-{nonce}"));
        fs::write(&probe, b"skillhub write probe")
            .map_err(|error| library_not_writable(error.to_string()))?;
        fs::remove_file(probe).map_err(|error| library_not_writable(error.to_string()))
    }

    pub fn paths(&self) -> &LibraryPaths {
        &self.paths
    }

    pub fn load_manifest(&self) -> AppResult<LibraryManifest> {
        self.store.load()
    }

    pub fn write_manifest_atomic(&self, manifest: &LibraryManifest) -> AppResult<()> {
        self.store.write_atomic(manifest)
    }

    pub fn load_portable_skill(
        &self,
        id: SkillId,
    ) -> AppResult<Option<(PortableSkillRecord, Option<VersionId>)>> {
        Ok(self
            .load_manifest()?
            .skills
            .into_iter()
            .find(|record| record.id == id)
            .map(|record| (record.clone(), record.current_version.clone())))
    }

    pub fn save_portable_skill(&self, skill: &Skill, current: Option<&VersionId>) -> AppResult<()> {
        let mut manifest = self.load_manifest()?;
        let mut record = manifest
            .skills
            .iter()
            .find(|record| record.id == skill.id())
            .cloned()
            .unwrap_or_else(|| PortableSkillRecord::new(skill.id(), skill.display_name()));
        record.runtime_name = skill.runtime_name().to_owned();
        record.description = skill.original_description().to_owned();
        record.note = skill.note().map(str::to_owned);
        record.user_purpose = skill.user_purpose().map(str::to_owned);
        record.lifecycle = skill.lifecycle();
        record.tags = skill.tags().iter().cloned().collect();
        record.trial_due = skill
            .trial_due()
            .map(|(year, month, day)| format!("{year:04}-{month:02}-{day:02}"));
        record.author = skill.author().map(str::to_owned);
        record.license = skill.license().map(str::to_owned);
        record.call_policy = skill.call_policy();
        record.invocation_source = Some(
            match skill.invocation_source() {
                skillhub_core::catalog::InvocationPolicySource::Explicit => "explicit",
                skillhub_core::catalog::InvocationPolicySource::Default => "default",
                skillhub_core::catalog::InvocationPolicySource::Unknown => "unknown",
            }
            .to_owned(),
        );
        record.invocation_field = skill.invocation_field().map(str::to_owned);
        record.current_version = current.cloned();
        manifest.skills.retain(|existing| existing.id != skill.id());
        manifest.skills.push(record);
        self.write_manifest_atomic(&manifest)
    }

    /// Updates only the portable manifest's current-version field, preserving
    /// the user's other stored portable metadata exactly.
    pub fn set_portable_current_version(
        &self,
        id: SkillId,
        current: Option<&VersionId>,
    ) -> AppResult<()> {
        let mut manifest = self.load_manifest()?;
        let record = manifest
            .skills
            .iter_mut()
            .find(|record| record.id == id)
            .ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))?;
        record.current_version = current.cloned();
        self.write_manifest_atomic(&manifest)
    }

    /// Restores the exact prior portable record (or its absence) during
    /// compensation and recovery.
    pub fn restore_portable_skill_record(
        &self,
        id: SkillId,
        previous: Option<PortableSkillRecord>,
    ) -> AppResult<()> {
        if previous.as_ref().is_some_and(|record| record.id != id) {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "portable_skill_id")
                .with_action(RecoveryAction::Retry));
        }
        let mut manifest = self.load_manifest()?;
        manifest.skills.retain(|record| record.id != id);
        if let Some(previous) = previous {
            manifest.skills.push(previous);
        }
        self.write_manifest_atomic(&manifest)
    }

    pub fn remove_portable_skill(&self, id: SkillId) -> AppResult<()> {
        let mut manifest = self.load_manifest()?;
        let removed = manifest
            .skills
            .iter()
            .find(|record| record.id == id)
            .cloned();
        manifest.skills.retain(|record| record.id != id);
        self.write_manifest_atomic(&manifest)?;
        if let Some(record) = removed {
            let visible = self.visible_skill_path_for(id, &record.runtime_name);
            if visible.exists() {
                fs::remove_dir_all(visible).map_err(io_error)?;
            }
        }
        Ok(())
    }

    /// Returns the user-visible, managed copy of a Skill's current version.
    /// The directory name is stable for the Skill id and readable enough to
    /// inspect without exposing internal object-store paths.
    pub fn visible_skill_path(&self, skill: &Skill) -> std::path::PathBuf {
        self.visible_skill_path_for(skill.id(), skill.runtime_name())
    }

    pub fn visible_skill_path_for_runtime(
        &self,
        skill_id: SkillId,
        runtime_name: &str,
    ) -> std::path::PathBuf {
        self.visible_skill_path_for(skill_id, runtime_name)
    }

    /// Returns the fingerprint of a Skill's visible tree after verifying that
    /// the path is still the managed directory inside this library. Missing
    /// trees are represented as `None`; links, reparse points and unexpected
    /// filesystem entries are rejected rather than followed.
    pub fn visible_tree_fingerprint(&self, skill: &Skill) -> AppResult<Option<String>> {
        let output = self.visible_skill_path(skill);
        self.validate_visible_paths(skill.id(), &output)?;
        if !path_entry_exists(&output)? {
            return Ok(None);
        }
        if !is_real_directory(&output)? {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "visible_output_identity_changed")
                .with_param("path", output.to_string_lossy().into_owned())
                .with_action(RecoveryAction::InspectTarget));
        }
        VersionStore::from_library(self)
            .hash_tree_read_only(&output)
            .map(Some)
    }

    /// Rebuilds the visible central-library tree for the supplied version.
    /// Immutable version objects remain the source of truth; this tree is the
    /// stable source used for human inspection and linked Agent deployments.
    pub fn materialize_current_skill(&self, skill: &Skill, version: &VersionId) -> AppResult<()> {
        let replacement = self.prepare_visible_tree_replacement(skill, version)?;
        self.finalize_visible_tree_replacement(replacement)
    }

    /// Replaces the visible tree but keeps its previous directory available
    /// for an application-level multi-consumer transaction.
    pub fn prepare_visible_tree_replacement(
        &self,
        skill: &Skill,
        version: &VersionId,
    ) -> AppResult<VisibleTreeReplacement> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let backup = self
            .paths
            .tmp_dir
            .join(format!("visible-backup-{}-{nonce}", skill.id()));
        let expected_previous_tree_hash = self.visible_tree_fingerprint(skill)?;
        self.prepare_visible_tree_replacement_with_backup(
            skill,
            version,
            &backup,
            expected_previous_tree_hash.as_deref(),
        )
    }

    /// Variant used by a journaled adoption. The backup name and the hash of
    /// the old tree are persisted before this method can move the visible
    /// directory, so an interrupted process leaves durable recovery facts.
    pub fn prepare_visible_tree_replacement_with_backup(
        &self,
        skill: &Skill,
        version: &VersionId,
        backup: &Path,
        expected_previous_tree_hash: Option<&str>,
    ) -> AppResult<VisibleTreeReplacement> {
        let output = self.visible_skill_path_for(skill.id(), skill.runtime_name());
        self.validate_visible_paths(skill.id(), &output)?;
        self.validate_visible_backup_entry(skill.id(), backup)?;
        if path_entry_exists(backup)? {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "visible_backup_path_occupied")
                .with_param("path", backup.to_string_lossy().into_owned())
                .with_action(RecoveryAction::InspectTarget));
        }
        let had_output = path_entry_exists(&output)?;
        if had_output && !is_real_directory(&output)? {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("path", output.to_string_lossy().into_owned())
                .with_action(RecoveryAction::InspectTarget));
        }
        let expected_tree_hash = VersionStore::from_library(self)
            .load_manifest(version)?
            .tree_hash;
        let expected_backup_tree_hash = if had_output {
            Some(VersionStore::from_library(self).hash_tree_read_only(&output)?)
        } else {
            None
        };
        if expected_previous_tree_hash != expected_backup_tree_hash.as_deref() {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "visible_output_identity_changed")
                .with_action(RecoveryAction::InspectTarget));
        }
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let staging = self
            .paths
            .tmp_dir
            .join(format!("visible-{}-{nonce}", skill.id()));
        if let Err(error) = VersionStore::from_library(self).materialize(version, &staging) {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        if self.store.should_fail("before_visible_replace") {
            let _ = fs::remove_dir_all(&staging);
            return Err(injected_fault("before_visible_replace"));
        }
        if had_output {
            if let Err(error) = fs::rename(&output, backup) {
                let _ = fs::remove_dir_all(&staging);
                return Err(io_error(error));
            }
        }
        let install_result = if self.store.should_fail("before_visible_staging_rename") {
            Err(std::io::Error::other(
                "injected visible staging rename failure",
            ))
        } else {
            fs::rename(&staging, &output)
        };
        if let Err(error) = install_result {
            if had_output {
                let restore = if self.store.should_fail("before_visible_backup_restore") {
                    Err(std::io::Error::other(
                        "injected visible backup restore failure",
                    ))
                } else {
                    fs::rename(backup, &output)
                };
                if let Err(restore_error) = restore {
                    let _ = fs::remove_dir_all(&staging);
                    return Err(io_error(error)
                        .with_param("reason", "visible_backup_restore_failed")
                        .with_param(
                            "recovery_backup_path",
                            backup.to_string_lossy().into_owned(),
                        )
                        .with_param("recovery_restore_error", restore_error.to_string())
                        .with_action(RecoveryAction::InspectTarget));
                }
            }
            let _ = fs::remove_dir_all(&staging);
            return Err(io_error(error));
        }
        Ok(VisibleTreeReplacement {
            skill_id: skill.id(),
            output,
            backup: had_output.then_some(backup.to_path_buf()),
            expected_tree_hash,
            expected_backup_tree_hash,
        })
    }

    /// Restores the old visible directory. A failed restore leaves the
    /// retained backup in place for recovery.
    pub fn rollback_visible_tree_replacement(
        &self,
        replacement: &VisibleTreeReplacement,
    ) -> AppResult<()> {
        self.validate_visible_paths(replacement.skill_id, &replacement.output)?;
        if self.store.should_fail("before_visible_restore") {
            return Err(injected_fault("before_visible_restore").with_param(
                "recovery_backup_path",
                replacement
                    .backup
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            ));
        }
        if path_entry_exists(&replacement.output)?
            && (!is_real_directory(&replacement.output)?
                || VersionStore::from_library(self).hash_tree_read_only(&replacement.output)?
                    != replacement.expected_tree_hash)
        {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "visible_output_identity_changed")
                .with_param("path", replacement.output.to_string_lossy().into_owned())
                .with_param(
                    "recovery_backup_path",
                    replacement
                        .backup
                        .as_ref()
                        .map(|path| path.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                )
                .with_action(RecoveryAction::InspectTarget));
        }
        let Some(backup) = replacement.backup.as_ref() else {
            if path_entry_exists(&replacement.output)? {
                fs::remove_dir_all(&replacement.output).map_err(io_error)?;
            }
            return Ok(());
        };
        self.validate_visible_backup_path(replacement.skill_id, &replacement.output, backup)?;
        if !path_entry_exists(backup)? || !is_real_directory(backup)? {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "visible_backup_missing_or_invalid")
                .with_param(
                    "recovery_backup_path",
                    backup.to_string_lossy().into_owned(),
                )
                .with_action(RecoveryAction::InspectTarget));
        }
        let expected_backup_hash = replacement
            .expected_backup_tree_hash
            .as_deref()
            .ok_or_else(|| AppError::new(ErrorCode::OperationConflict, Severity::Error))?;
        if VersionStore::from_library(self).hash_tree_read_only(backup)? != expected_backup_hash {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "visible_backup_identity_changed")
                .with_param(
                    "recovery_backup_path",
                    backup.to_string_lossy().into_owned(),
                )
                .with_action(RecoveryAction::InspectTarget));
        }
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let displaced = self
            .paths
            .tmp_dir
            .join(format!("visible-failed-restore-{nonce}"));
        if path_entry_exists(&displaced)? {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "visible_displaced_path_occupied")
                .with_param(
                    "recovery_backup_path",
                    backup.to_string_lossy().into_owned(),
                )
                .with_action(RecoveryAction::InspectTarget));
        }
        let had_output = path_entry_exists(&replacement.output)?;
        if had_output {
            fs::rename(&replacement.output, &displaced).map_err(io_error)?;
        }
        let restore_result = if self.store.should_fail("before_visible_backup_restore") {
            Err(std::io::Error::other(
                "injected visible backup restore failure",
            ))
        } else {
            fs::rename(backup, &replacement.output)
        };
        if let Err(error) = restore_result {
            let mut compensation_error = None;
            if had_output {
                if let Err(restore_displaced_error) = fs::rename(&displaced, &replacement.output) {
                    compensation_error = Some(restore_displaced_error.to_string());
                }
            }
            let mut app_error = io_error(error)
                .with_param("reason", "visible_backup_restore_failed")
                .with_param(
                    "recovery_backup_path",
                    backup.to_string_lossy().into_owned(),
                )
                .with_action(RecoveryAction::InspectTarget);
            if path_entry_exists(&displaced).unwrap_or(false) {
                app_error = app_error.with_param(
                    "recovery_displaced_path",
                    displaced.to_string_lossy().into_owned(),
                );
            }
            if let Some(compensation_error) = compensation_error {
                app_error =
                    app_error.with_param("recovery_displaced_restore_error", compensation_error);
            }
            return Err(app_error);
        }
        if !is_real_directory(&replacement.output)?
            || VersionStore::from_library(self).hash_tree_read_only(&replacement.output)?
                != expected_backup_hash
        {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "visible_restored_tree_identity_changed")
                .with_param(
                    "recovery_backup_path",
                    backup.to_string_lossy().into_owned(),
                )
                .with_action(RecoveryAction::InspectTarget));
        }
        if had_output {
            fs::remove_dir_all(displaced).map_err(io_error)?;
        }
        Ok(())
    }

    /// Moves a Skill's visible tree into a retained tmp backup so a failed
    /// skill deletion can restore the only user-visible copy. Returns `true`
    /// when a tree was moved and `false` when the Skill had no visible tree.
    pub fn prepare_visible_tree_removal(&self, skill: &Skill, backup: &Path) -> AppResult<bool> {
        let output = self.visible_skill_path_for(skill.id(), skill.runtime_name());
        self.validate_visible_paths(skill.id(), &output)?;
        self.validate_visible_backup_entry(skill.id(), backup)?;
        if path_entry_exists(backup)? {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "visible_backup_path_occupied")
                .with_param("path", backup.to_string_lossy().into_owned())
                .with_action(RecoveryAction::InspectTarget));
        }
        if !path_entry_exists(&output)? {
            return Ok(false);
        }
        if !is_real_directory(&output)? {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "visible_output_identity_changed")
                .with_param("path", output.to_string_lossy().into_owned())
                .with_action(RecoveryAction::InspectTarget));
        }
        if self.store.should_fail("before_visible_removal_rename") {
            return Err(injected_fault("before_visible_removal_rename"));
        }
        fs::rename(&output, backup).map_err(io_error)?;
        Ok(true)
    }

    /// Restores a retained deletion backup to its original visible path while
    /// compensating a failed skill deletion.
    pub fn restore_visible_tree_removal(&self, skill: &Skill, backup: &Path) -> AppResult<()> {
        let output = self.visible_skill_path_for(skill.id(), skill.runtime_name());
        self.validate_visible_paths(skill.id(), &output)?;
        self.validate_visible_backup_entry(skill.id(), backup)?;
        if !path_entry_exists(backup)? || !is_real_directory(backup)? {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "visible_backup_missing_or_invalid")
                .with_param(
                    "recovery_backup_path",
                    backup.to_string_lossy().into_owned(),
                )
                .with_action(RecoveryAction::InspectTarget));
        }
        if path_entry_exists(&output)? {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "visible_output_path_occupied")
                .with_param("path", output.to_string_lossy().into_owned())
                .with_action(RecoveryAction::InspectTarget));
        }
        if self.store.should_fail("before_visible_removal_restore") {
            return Err(injected_fault("before_visible_removal_restore"));
        }
        fs::rename(backup, &output).map_err(io_error)?;
        Ok(())
    }

    /// Discards a consumed deletion backup after every consumer face confirmed
    /// the deletion. A leftover backup is harmless tmp residue, so callers may
    /// treat a failure here as best-effort cleanup.
    pub fn discard_visible_tree_removal(&self, backup: &Path) -> AppResult<()> {
        if path_entry_exists(backup)? {
            fs::remove_dir_all(backup).map_err(io_error)?;
        }
        Ok(())
    }

    /// W1-2：把 Skill 的草稿目录（`drafts/<skill_id>/`）移入保留的 tmp 备份，
    /// 使编辑草稿随主体删除一并清理、绝不残留孤儿。返回 `true` 表示发生了
    /// 移动，`false` 表示该主体没有草稿。失败时草稿原位保留。
    pub fn prepare_drafts_removal(&self, skill_id: SkillId, backup: &Path) -> AppResult<bool> {
        let drafts = self.paths.drafts_dir.join(skill_id.to_string());
        if path_entry_exists(backup)? {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "drafts_backup_path_occupied")
                .with_param("path", backup.to_string_lossy().into_owned())
                .with_action(RecoveryAction::InspectTarget));
        }
        if !path_entry_exists(&drafts)? {
            return Ok(false);
        }
        if self.store.should_fail("before_drafts_removal_rename") {
            return Err(injected_fault("before_drafts_removal_rename"));
        }
        fs::rename(&drafts, backup).map_err(io_error)?;
        Ok(true)
    }

    /// Restores a retained backup after restarting an interrupted adoption.
    /// The supplied path must be an internal backup produced for this Skill.
    pub fn recover_visible_tree_backup(
        &self,
        skill: &Skill,
        backup: &Path,
        expected_version: &VersionId,
        expected_backup_tree_hash: &str,
    ) -> AppResult<()> {
        let output = self.visible_skill_path_for(skill.id(), skill.runtime_name());
        self.validate_visible_paths(skill.id(), &output)?;
        self.validate_visible_backup_path(skill.id(), &output, backup)?;
        if !path_entry_exists(backup)?
            && path_entry_exists(&output)?
            && is_real_directory(&output)?
            && VersionStore::from_library(self).hash_tree_read_only(&output)?
                == expected_backup_tree_hash
        {
            return Ok(());
        }
        let expected_tree_hash = VersionStore::from_library(self)
            .load_manifest(expected_version)?
            .tree_hash;
        let replacement = VisibleTreeReplacement {
            skill_id: skill.id(),
            output,
            backup: Some(backup.to_path_buf()),
            expected_tree_hash,
            expected_backup_tree_hash: Some(expected_backup_tree_hash.to_owned()),
        };
        self.rollback_visible_tree_replacement(&replacement)
    }

    /// Idempotently restores the visible-tree part of an interrupted version
    /// adoption using only the durable backup path and the two tree hashes.
    pub fn recover_visible_tree_adoption(
        &self,
        skill: &Skill,
        expected_version: &VersionId,
        backup: Option<&Path>,
        expected_previous_tree_hash: Option<&str>,
    ) -> AppResult<()> {
        let output = self.visible_skill_path_for(skill.id(), skill.runtime_name());
        self.validate_visible_paths(skill.id(), &output)?;
        if let Some(backup) = backup {
            self.validate_visible_backup_path(skill.id(), &output, backup)?;
            if !path_entry_exists(backup)? {
                if let Some(expected) = expected_previous_tree_hash {
                    if path_entry_exists(&output)?
                        && is_real_directory(&output)?
                        && VersionStore::from_library(self).hash_tree_read_only(&output)?
                            == expected
                    {
                        return Ok(());
                    }
                }
                return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("reason", "visible_backup_missing_or_invalid")
                    .with_param(
                        "recovery_backup_path",
                        backup.to_string_lossy().into_owned(),
                    )
                    .with_action(RecoveryAction::InspectTarget));
            }
            let expected = expected_previous_tree_hash.ok_or_else(|| {
                AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("reason", "visible_backup_identity_missing")
                    .with_action(RecoveryAction::InspectTarget)
            })?;
            return self.recover_visible_tree_backup(skill, backup, expected_version, expected);
        }

        if !path_entry_exists(&output)? {
            if expected_previous_tree_hash.is_none() {
                return Ok(());
            }
        } else if let Some(expected) = expected_previous_tree_hash {
            if is_real_directory(&output)?
                && VersionStore::from_library(self).hash_tree_read_only(&output)? == expected
            {
                return Ok(());
            }
        }
        let expected_tree_hash = VersionStore::from_library(self)
            .load_manifest(expected_version)?
            .tree_hash;
        let replacement = VisibleTreeReplacement {
            skill_id: skill.id(),
            output,
            backup: None,
            expected_tree_hash,
            expected_backup_tree_hash: None,
        };
        self.rollback_visible_tree_replacement(&replacement)
    }

    /// Removes an internal retained backup after a recovery action completes
    /// the new version instead of rolling it back.
    pub fn discard_visible_tree_backup(&self, skill_id: SkillId, backup: &Path) -> AppResult<()> {
        self.validate_visible_backup_entry(skill_id, backup)?;
        if path_entry_exists(backup)? {
            if !is_real_directory(backup)? {
                return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                    .with_param("field", "visible_backup_path")
                    .with_action(RecoveryAction::InspectTarget));
            }
            fs::remove_dir_all(backup).map_err(io_error)?;
        }
        Ok(())
    }

    fn validate_visible_backup_path(
        &self,
        skill_id: SkillId,
        output: &Path,
        backup: &Path,
    ) -> AppResult<()> {
        self.validate_visible_paths(skill_id, output)?;
        self.validate_visible_backup_entry(skill_id, backup)
    }

    fn validate_visible_backup_entry(&self, skill_id: SkillId, backup: &Path) -> AppResult<()> {
        let filename = backup.file_name().and_then(|name| name.to_str());
        let expected_prefix = format!("visible-backup-{skill_id}-");
        let valid_name = filename.is_some_and(|name| {
            name.strip_prefix(&expected_prefix).is_some_and(|nonce| {
                !nonce.is_empty()
                    && nonce
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
        });
        if backup.parent() != Some(self.paths.tmp_dir.as_path()) || !valid_name {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "visible_backup_path")
                .with_action(RecoveryAction::InspectTarget));
        }
        if path_entry_exists(backup)? && !is_real_directory(backup)? {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "visible_backup_path")
                .with_action(RecoveryAction::InspectTarget));
        }
        Ok(())
    }

    fn validate_visible_paths(&self, skill_id: SkillId, output: &Path) -> AppResult<()> {
        let output_name = output.file_name();
        let expected_output_parent = self.paths.skills_dir.as_path();
        let valid_name = output_name
            .and_then(|name| name.to_str())
            .is_some_and(|name| !name.is_empty());
        if output.parent() != Some(expected_output_parent) || !valid_name {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "visible_output_path")
                .with_param("skill_id", skill_id.to_string())
                .with_action(RecoveryAction::InspectTarget));
        }
        for directory in [
            self.paths.management_dir.as_path(),
            self.paths.skills_dir.as_path(),
            self.paths.tmp_dir.as_path(),
        ] {
            if !is_real_directory(directory)? {
                return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("reason", "library_internal_directory_changed")
                    .with_param("path", directory.to_string_lossy().into_owned())
                    .with_action(RecoveryAction::InspectTarget));
            }
        }
        let root = self.paths.root.canonicalize().map_err(io_error)?;
        for (directory, relative) in [
            (self.paths.management_dir.as_path(), Path::new(".skillhub")),
            (self.paths.skills_dir.as_path(), Path::new("skills")),
            (self.paths.tmp_dir.as_path(), Path::new(".skillhub/tmp")),
        ] {
            let expected = root.join(relative);
            if directory.canonicalize().map_err(io_error)? != expected {
                return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("reason", "library_internal_directory_identity_changed")
                    .with_param("path", directory.to_string_lossy().into_owned())
                    .with_action(RecoveryAction::InspectTarget));
            }
        }
        Ok(())
    }

    /// Deletes the retained old directory only after all version consumers
    /// have committed successfully.
    pub fn finalize_visible_tree_replacement(
        &self,
        replacement: VisibleTreeReplacement,
    ) -> AppResult<()> {
        if let Some(backup) = replacement.backup {
            self.validate_visible_backup_path(replacement.skill_id, &replacement.output, &backup)?;
            if !path_entry_exists(&replacement.output)?
                || !is_real_directory(&replacement.output)?
                || VersionStore::from_library(self).hash_tree_read_only(&replacement.output)?
                    != replacement.expected_tree_hash
            {
                return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("reason", "visible_output_identity_changed")
                    .with_param(
                        "recovery_backup_path",
                        backup.to_string_lossy().into_owned(),
                    )
                    .with_action(RecoveryAction::InspectTarget));
            }
            if path_entry_exists(&backup)? {
                if !is_real_directory(&backup)?
                    || VersionStore::from_library(self).hash_tree_read_only(&backup)?
                        != replacement
                            .expected_backup_tree_hash
                            .as_deref()
                            .unwrap_or_default()
                {
                    return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                        .with_param("reason", "visible_backup_identity_changed")
                        .with_param(
                            "recovery_backup_path",
                            backup.to_string_lossy().into_owned(),
                        )
                        .with_action(RecoveryAction::InspectTarget));
                }
                fs::remove_dir_all(backup).map_err(io_error)?;
            }
        }
        Ok(())
    }

    fn materialize_missing_visible_skills(&self) -> AppResult<()> {
        for record in self.load_manifest()?.skills {
            let Some(version) = record.current_version else {
                continue;
            };
            let output = self.visible_skill_path_for(record.id, &record.runtime_name);
            if !output.exists() {
                self.materialize_visible_tree(record.id, &record.runtime_name, &version, false)?;
            }
        }
        Ok(())
    }

    fn materialize_visible_tree(
        &self,
        skill_id: SkillId,
        runtime_name: &str,
        version: &VersionId,
        replace_existing: bool,
    ) -> AppResult<()> {
        let output = self.visible_skill_path_for(skill_id, runtime_name);
        if output.exists() && !replace_existing {
            return Ok(());
        }
        if output.exists()
            && (!output.is_dir()
                || fs::symlink_metadata(&output)
                    .map_err(io_error)?
                    .file_type()
                    .is_symlink())
        {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("path", output.to_string_lossy().into_owned())
                .with_action(RecoveryAction::InspectTarget));
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let staging = self
            .paths
            .tmp_dir
            .join(format!("visible-{skill_id}-{nonce}"));
        let backup = self
            .paths
            .tmp_dir
            .join(format!("visible-backup-{skill_id}-{nonce}"));
        if let Err(error) = VersionStore::from_library(self).materialize(version, &staging) {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }

        if !output.exists() {
            return fs::rename(&staging, &output).map_err(io_error);
        }
        fs::rename(&output, &backup).map_err(io_error)?;
        if let Err(error) = fs::rename(&staging, &output) {
            let _ = fs::rename(backup, &output);
            return Err(io_error(error));
        }
        // The replacement is already complete; a leftover backup can be
        // recovered during housekeeping and must not turn a successful import
        // into a failed one.
        let _ = fs::remove_dir_all(&backup);
        Ok(())
    }

    fn visible_skill_path_for(&self, skill_id: SkillId, runtime_name: &str) -> std::path::PathBuf {
        let readable_name = runtime_name
            .chars()
            .map(|character| {
                if character.is_alphanumeric() || matches!(character, '-' | '_' | '.') {
                    character
                } else {
                    '-'
                }
            })
            .collect::<String>()
            .trim_matches(['.', '-'])
            .to_owned();
        let readable_name = if readable_name.is_empty() {
            "skill".to_owned()
        } else {
            readable_name
        };
        self.paths
            .skills_dir
            .join(format!("{readable_name}--{skill_id}"))
    }
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}

fn injected_fault(point: &'static str) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("fault", point)
        .with_action(RecoveryAction::Retry)
}

fn library_conflict(detail: &str) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("reason", "library_root_not_empty")
        .with_param("detail", detail)
        .with_action(RecoveryAction::ChooseAnotherName)
}

fn library_not_writable(detail: String) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("reason", "library_not_writable")
        .with_param("detail", detail)
        .with_action(RecoveryAction::Retry)
}

fn path_entry_exists(path: &Path) -> AppResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

fn is_real_directory(path: &Path) -> AppResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_dir() && !is_link_or_reparse(&metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}
