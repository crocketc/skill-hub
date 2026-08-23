use std::fs;
use std::path::Path;

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
    let tmp = root.join(format!(".tmp-{}", std::process::id()));
    fs::write(&tmp, bytes).map_err(io_error)?;
    let result = fs::rename(&tmp, &path);
    if result.is_err() && path.exists() {
        let _ = fs::remove_file(&tmp);
        return Ok(id);
    }
    result.map_err(io_error)?;
    Ok(id)
}

pub fn get(root: &Path, id: &str) -> AppResult<Vec<u8>> {
    let digest = id
        .strip_prefix("sha256:")
        .ok_or_else(|| invalid("object id"))?;
    if digest.is_empty() || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid("object id"));
    }
    fs::read(root.join(digest))
        .map_err(|_| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))
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
