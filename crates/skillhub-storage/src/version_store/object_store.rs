use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

use super::manifest::digest_bytes;

pub fn put(root: &Path, bytes: &[u8]) -> AppResult<String> {
    let id = digest_bytes(bytes);
    let path = root.join(id.strip_prefix("sha256:").unwrap());
    if path.exists() {
        let existing = fs::read(&path).map_err(io_error)?;
        if existing != bytes {
            return Err(AppError::new(ErrorCode::InternalError, Severity::Critical));
        }
        return Ok(id);
    }
    fs::create_dir_all(root).map_err(io_error)?;
    let tmp = unique_temp(root, ".object")?;
    fs::write(&tmp, bytes).map_err(io_error)?;
    let result = fs::rename(&tmp, &path);
    if result.is_err() && path.exists() {
        let _ = fs::remove_file(&tmp);
        return Ok(id);
    }
    result.map_err(io_error)?;
    Ok(id)
}

pub fn get(root: &Path, id: &str, expected_size: u64) -> AppResult<Vec<u8>> {
    let digest = id
        .strip_prefix("sha256:")
        .ok_or_else(|| invalid("object id"))?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid("object id"));
    }
    let bytes = fs::read(root.join(digest))
        .map_err(|_| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))?;
    if bytes.len() as u64 != expected_size || digest_bytes(&bytes) != id {
        return Err(AppError::new(ErrorCode::InternalError, Severity::Critical)
            .with_param("reason", "object_integrity_mismatch"));
    }
    Ok(bytes)
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn unique_temp(root: &Path, prefix: &str) -> AppResult<std::path::PathBuf> {
    fs::create_dir_all(root).map_err(io_error)?;
    for _ in 0..32 {
        let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let candidate = root.join(format!("{prefix}-{}-{sequence}.tmp", std::process::id()));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(error)),
        }
    }
    Err(AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("reason", "temporary_name_exhausted"))
}

fn invalid(field: &str) -> AppError {
    AppError::new(ErrorCode::InvalidInput, Severity::Error)
        .with_param("field", field)
        .with_action(RecoveryAction::ChooseAnotherName)
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
