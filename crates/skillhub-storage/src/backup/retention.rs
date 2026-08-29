use skillhub_core::backup::{BackupPackage, BackupRetentionPolicy, BackupRetentionResult};
use skillhub_core::{AppError, AppResult, ErrorCode, Severity};
use std::fs;
use std::path::PathBuf;

use super::BackupService;

pub struct RetentionService {
    root: PathBuf,
}

impl RetentionService {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn apply(&self, policy: BackupRetentionPolicy) -> AppResult<BackupRetentionResult> {
        let mut valid = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(io_error)? {
            let path = entry.map_err(io_error)?.path();
            let is_owned = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("skillhub-backup-"));
            if !is_owned || !path.is_dir() {
                continue;
            }
            let package = BackupPackage { root: path.clone() };
            if BackupService::new(self.root.clone())
                .verify(&package)
                .is_ok()
            {
                let modified = fs::metadata(&path)
                    .and_then(|metadata| metadata.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                valid.push((modified, path));
            }
        }
        valid.sort_by_key(|item| std::cmp::Reverse(item.0));
        let keep = usize::max(policy.max_backups as usize, 1).min(valid.len());
        let mut removed = 0;
        for (_, path) in valid.iter().skip(keep) {
            fs::remove_dir_all(path).map_err(io_error)?;
            removed += 1;
        }
        Ok(BackupRetentionResult {
            retained: keep as u32,
            removed,
        })
    }
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("source", error.to_string())
}
