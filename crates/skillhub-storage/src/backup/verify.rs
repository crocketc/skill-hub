use sha2::{Digest, Sha256};
use skillhub_core::backup::{BackupManifest, BackupPackage};
use skillhub_core::{AppError, AppResult, ErrorCode, Severity};
use std::path::Component;

#[derive(Debug)]
pub struct BackupVerification {
    pub manifest: BackupManifest,
    pub bytes: Vec<u8>,
}

impl super::BackupService {
    pub fn verify(&self, package: &BackupPackage) -> AppResult<BackupVerification> {
        let manifest_bytes = std::fs::read(package.root.join("backup.json")).map_err(io_error)?;
        let manifest: BackupManifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|_| AppError::new(ErrorCode::BackupChecksumMismatch, Severity::Error))?;
        let mut bytes = Vec::new();
        for entry in &manifest.entries {
            if !is_safe_relative_path(&entry.path) {
                return Err(AppError::new(
                    ErrorCode::BackupChecksumMismatch,
                    Severity::Error,
                ));
            }
            let path = package.root.join(&entry.path);
            let content = std::fs::read(&path)
                .map_err(|_| AppError::new(ErrorCode::BackupChecksumMismatch, Severity::Error))?;
            let mut hasher = Sha256::new();
            hasher.update(&content);
            if format!("{:x}", hasher.finalize()) != entry.sha256 {
                return Err(AppError::new(
                    ErrorCode::BackupChecksumMismatch,
                    Severity::Error,
                ));
            }
            bytes.extend_from_slice(&content);
        }
        Ok(BackupVerification { manifest, bytes })
    }
}

fn is_safe_relative_path(path: &str) -> bool {
    let candidate = std::path::Path::new(path);
    !candidate.is_absolute()
        && candidate
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("source", error.to_string())
}
