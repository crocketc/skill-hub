use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use skillhub_core::{AppError, AppResult, ErrorCode, LibraryManifest, RecoveryAction, Severity};

pub type ManifestFaultHandler = Arc<dyn Fn(&str) -> bool + Send + Sync>;

pub struct PortableManifestStore {
    path: PathBuf,
    fault_handler: ManifestFaultHandler,
}

impl PortableManifestStore {
    pub fn new(path: PathBuf, fault_handler: ManifestFaultHandler) -> Self {
        Self {
            path,
            fault_handler,
        }
    }

    pub fn load(&self) -> AppResult<LibraryManifest> {
        let bytes = fs::read(&self.path).map_err(io_error)?;
        let manifest: LibraryManifest = serde_json::from_slice(&bytes).map_err(json_error)?;
        validate_manifest_version(&manifest)?;
        Ok(manifest)
    }

    pub fn write_atomic(&self, manifest: &LibraryManifest) -> AppResult<()> {
        validate_manifest_version(manifest)?;
        // Serialize and parse before touching the filesystem. This prevents a
        // malformed in-memory value from ever replacing a valid manifest.
        let bytes = serde_json::to_vec_pretty(manifest).map_err(json_error)?;
        let parsed: LibraryManifest = serde_json::from_slice(&bytes).map_err(json_error)?;
        validate_manifest_version(&parsed)?;
        let parent = self.path.parent().ok_or_else(|| {
            AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_action(RecoveryAction::Retry)
        })?;
        fs::create_dir_all(parent).map_err(io_error)?;
        let temporary = temporary_path(parent, &self.path);
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(io_error)?;
            file.write_all(&bytes).map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
            drop(file);
            if (self.fault_handler)("before_manifest_replace") {
                return Err(AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("fault", "before_manifest_replace")
                    .with_action(RecoveryAction::Retry));
            }
            replace_file(&temporary, &self.path).map_err(io_error)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

fn validate_manifest_version(manifest: &LibraryManifest) -> AppResult<()> {
    if manifest.format_version == 1 {
        return Ok(());
    }
    Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
        .with_param("format_version", manifest.format_version)
        .with_param("supported_format_version", 1_u32)
        .with_action(RecoveryAction::Retry))
}

fn temporary_path(parent: &Path, destination: &Path) -> PathBuf {
    let name = destination
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("library.json");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    parent.join(format!(".{name}.{timestamp}.tmp"))
}

fn replace_file(temporary: &Path, destination: &Path) -> io::Result<()> {
    // Rename is an atomic replacement on Unix. Windows requires the native
    // replace-existing move; deleting the destination first would create a
    // recovery window in which an interrupted write loses the old manifest.
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let moved = unsafe {
            MoveFileExW(
                source.as_ptr(),
                target.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    fs::rename(temporary, destination)
}

fn io_error(error: io::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}

fn json_error(error: serde_json::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
