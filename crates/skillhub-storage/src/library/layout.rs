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

impl std::fmt::Debug for CentralLibrary {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CentralLibrary")
            .field("paths", &self.paths)
            .finish()
    }
}

impl CentralLibrary {
    pub fn initialize(root: impl AsRef<Path>) -> AppResult<Self> {
        Self::initialize_with_fault_handler(root, Arc::new(|_| false))
    }

    pub fn initialize_with_fault_handler(
        root: impl AsRef<Path>,
        fault_handler: ManifestFaultHandler,
    ) -> AppResult<Self> {
        let paths = LibraryPaths::from_root(root.as_ref());
        for directory in [
            &paths.skills_dir,
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
            store.write_atomic(&LibraryManifest::default())?;
        } else {
            // Existing files are never overwritten during initialization.
            store.load()?;
        }
        let library = Self { paths, store };
        library.materialize_missing_visible_skills()?;
        Ok(library)
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
        record.tags = skill.tags().iter().cloned().collect();
        record.author = skill.author().map(str::to_owned);
        record.license = skill.license().map(str::to_owned);
        record.call_policy = skill.call_policy();
        record.current_version = current.cloned();
        manifest.skills.retain(|existing| existing.id != skill.id());
        manifest.skills.push(record);
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

    /// Rebuilds the visible central-library tree for the supplied version.
    /// Immutable version objects remain the source of truth; this tree is the
    /// stable source used for human inspection and linked Agent deployments.
    pub fn materialize_current_skill(&self, skill: &Skill, version: &VersionId) -> AppResult<()> {
        self.materialize_visible_tree(skill.id(), skill.runtime_name(), version, true)
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
            let _ = fs::rename(&backup, &output);
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
