use std::fs;
use std::path::Path;
use std::sync::Arc;

use skillhub_core::{
    AppError, AppResult, ErrorCode, LibraryManifest, LibraryPaths, RecoveryAction, Severity,
};

use super::portable::{ManifestFaultHandler, PortableManifestStore};

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
        Ok(Self { paths, store })
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
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
