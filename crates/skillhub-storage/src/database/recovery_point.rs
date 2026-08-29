use skillhub_core::{AppError, AppResult, ErrorCode, Severity};
use std::fs;
use std::path::{Path, PathBuf};

/// Same-volume copy retained until a database migration opens successfully.
#[derive(Debug)]
pub struct RecoveryPoint {
    source: PathBuf,
    backup: PathBuf,
}

impl RecoveryPoint {
    pub fn create(source: impl AsRef<Path>) -> AppResult<Option<Self>> {
        let source = source.as_ref().to_path_buf();
        if !source.exists() {
            return Ok(None);
        }
        let backup = source.with_extension(format!("pre-migration-{}", timestamp()));
        fs::copy(&source, &backup).map_err(io_error)?;
        Ok(Some(Self { source, backup }))
    }

    pub fn restore(&self) -> AppResult<()> {
        fs::copy(&self.backup, &self.source).map_err(io_error)?;
        Ok(())
    }

    pub fn backup_path(&self) -> &Path {
        &self.backup
    }

    pub fn discard(self) -> AppResult<()> {
        if self.backup.exists() {
            fs::remove_file(&self.backup).map_err(io_error)?;
        }
        Ok(())
    }
}

fn timestamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("source", error.to_string())
}
