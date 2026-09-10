use std::ops::Deref;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};
use skillhub_storage::{CentralLibrary, VersionStore};

/// The immutable library state used by one application operation.
pub struct LibraryContext {
    pub root: PathBuf,
    pub store: VersionStore,
    pub central: Arc<CentralLibrary>,
}

impl LibraryContext {
    pub fn from_library(library: CentralLibrary) -> Self {
        let root = library.paths().root.clone();
        let store = VersionStore::from_library(&library);
        Self {
            root,
            store,
            central: Arc::new(library),
        }
    }
}

impl Deref for LibraryContext {
    type Target = VersionStore;

    fn deref(&self) -> &Self::Target {
        &self.store
    }
}

/// Owns the one-way Pending -> Active library lifecycle.
pub struct LibraryRuntime {
    active: RwLock<Option<Arc<LibraryContext>>>,
    activation_lock: Mutex<()>,
}

impl LibraryRuntime {
    pub fn new() -> Self {
        Self {
            active: RwLock::new(None),
            activation_lock: Mutex::new(()),
        }
    }

    pub fn from_active(context: Arc<LibraryContext>) -> Self {
        Self {
            active: RwLock::new(Some(context)),
            activation_lock: Mutex::new(()),
        }
    }

    pub fn snapshot(&self) -> AppResult<Arc<LibraryContext>> {
        self.active
            .read()
            .map_err(|_| runtime_internal("library_runtime.snapshot"))?
            .clone()
            .ok_or_else(library_not_ready)
    }

    pub fn publish(&self, context: Arc<LibraryContext>) -> AppResult<()> {
        let _guard = self
            .activation_lock
            .lock()
            .map_err(|_| runtime_internal("library_runtime.publish.lock"))?;
        let mut active = self
            .active
            .write()
            .map_err(|_| runtime_internal("library_runtime.publish"))?;
        if active.is_some() {
            return Err(library_root_locked());
        }
        *active = Some(context);
        Ok(())
    }
}

impl Default for LibraryRuntime {
    fn default() -> Self {
        Self::new()
    }
}

fn library_not_ready() -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("reason", "library_not_ready")
        .with_action(RecoveryAction::Retry)
}

fn library_root_locked() -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("reason", "library_root_locked")
        .with_action(RecoveryAction::MigrateData)
}

fn runtime_internal(operation: &str) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("operation", operation)
        .with_action(RecoveryAction::Retry)
}
