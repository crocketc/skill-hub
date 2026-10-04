//! Opens user-visible library paths with platform applications.
//!
//! Contract: [`skillhub_core::local_open`].
//!
//! The webview never receives filesystem paths from SkillHub: local
//! resources are opened through these commands instead. The facade validates
//! that the requested path lives inside the owning Skill's materialized
//! library tree before the platform opener runs, and the opener itself is
//! injected by the desktop shell — a facade without one refuses instead of
//! silently succeeding.

use std::sync::{Arc, Mutex};

use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

/// Hands one validated local path to the platform.
pub trait LocalPathOpener: Send + Sync {
    /// Opens the path with the platform default application.
    fn open_default(&self, path: &str) -> AppResult<()>;
    /// Reveals the path in the platform file manager.
    fn open_folder(&self, path: &str) -> AppResult<()>;
    /// Offers the platform application chooser. Not every platform exposes
    /// one; implementations refuse with [`ErrorCode::LocalPathOpenUnsupported`]
    /// instead of silently falling back to the default application.
    fn choose_application(&self, path: &str) -> AppResult<()>;
}

/// Production opener. Everything is launched detached so a slow or long-lived
/// application never blocks the command pipeline.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemLocalPathOpener;

impl LocalPathOpener for SystemLocalPathOpener {
    fn open_default(&self, path: &str) -> AppResult<()> {
        // `open` supports every platform SkillHub ships on; the Windows
        // shell resolves the default handler for the file type.
        open::that_detached(path).map_err(|error| refused(error.to_string()))
    }

    fn open_folder(&self, path: &str) -> AppResult<()> {
        #[cfg(windows)]
        {
            std::process::Command::new("explorer.exe")
                .arg(path)
                .spawn()
                .map(|_| ())
                .map_err(|error| refused(error.to_string()))
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            open::that_detached(path).map_err(|error| refused(error.to_string()))
        }
    }

    fn choose_application(&self, path: &str) -> AppResult<()> {
        #[cfg(windows)]
        {
            // shell32's legacy "Open With" dialog; it takes the file as the
            // trailing argument and never blocks the caller.
            std::process::Command::new("rundll32.exe")
                .arg("shell32.dll,OpenAs_RunDLLW")
                .arg(path)
                .spawn()
                .map(|_| ())
                .map_err(|error| refused(error.to_string()))
        }
        #[cfg(not(windows))]
        {
            #[cfg(target_os = "macos")]
            {
                let _ = path;
                Err(
                    AppError::new(ErrorCode::LocalPathOpenUnsupported, Severity::Warning)
                        .with_param("platform", "macos")
                        .with_action(RecoveryAction::Acknowledge),
                )
            }
            #[cfg(not(target_os = "macos"))]
            {
                open::that_detached(path).map_err(|error| refused(error.to_string()))
            }
        }
    }
}

fn refused(detail: String) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Warning)
        .with_param("detail", detail)
        .with_action(RecoveryAction::Retry)
}

/// Holds the platform opener supplied by the desktop shell.
#[derive(Default)]
pub struct LocalOpenService {
    opener: Mutex<Option<Arc<dyn LocalPathOpener>>>,
}

impl LocalOpenService {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replaces the platform opener. Production injects the desktop shell's
    /// opener; without one, opening stays blocked.
    pub fn set_opener(&self, opener: Arc<dyn LocalPathOpener>) {
        if let Ok(mut slot) = self.opener.lock() {
            *slot = Some(opener);
        }
    }

    pub fn open_default(&self, path: &str) -> AppResult<()> {
        self.opener()?.open_default(path)
    }

    pub fn open_folder(&self, path: &str) -> AppResult<()> {
        self.opener()?.open_folder(path)
    }

    pub fn choose_application(&self, path: &str) -> AppResult<()> {
        self.opener()?.choose_application(path)
    }

    fn opener(&self) -> AppResult<Arc<dyn LocalPathOpener>> {
        self.opener
            .lock()
            .map_err(|_| internal_mutex("local_open.opener.locked"))?
            .clone()
            .ok_or_else(|| {
                AppError::new(ErrorCode::LocalPathOpenerUnavailable, Severity::Warning)
                    .with_param("reason", "local path opener is not available")
                    .with_action(RecoveryAction::Acknowledge)
            })
    }
}

fn internal_mutex(operation: &'static str) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("operation", operation)
}
