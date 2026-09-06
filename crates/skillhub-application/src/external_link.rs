//! Opens validated https links in the platform default browser.
//!
//! The packaged webview does not respond to ordinary `<a target="_blank">`
//! clicks, so README links and the official release page have to go through a
//! native command. Opening anything the user did not explicitly ask for is a
//! hostile-input surface, so the URL is validated by
//! [`skillhub_core::validate_external_url`] before it ever reaches this port,
//! and the platform opener itself is injected by the desktop shell — a facade
//! without one refuses instead of silently succeeding.

use std::sync::{Arc, Mutex};

use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

/// Hands a validated https URL to the platform default browser.
pub trait ExternalUrlOpener: Send + Sync {
    fn open(&self, url: &str) -> AppResult<()>;
}

/// Production opener. It detaches from the launched application so a slow or
/// long-lived browser never blocks the command pipeline.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemExternalUrlOpener;

impl ExternalUrlOpener for SystemExternalUrlOpener {
    fn open(&self, url: &str) -> AppResult<()> {
        open::that_detached(url).map_err(|error| {
            AppError::new(ErrorCode::InternalError, Severity::Warning)
                .with_param("detail", error.to_string())
                .with_action(RecoveryAction::Retry)
        })
    }
}

/// Holds the platform opener supplied by the desktop shell.
#[derive(Default)]
pub struct ExternalLinkService {
    opener: Mutex<Option<Arc<dyn ExternalUrlOpener>>>,
}

impl ExternalLinkService {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replaces the platform opener. Production injects the desktop shell's
    /// opener; without one, opening stays blocked.
    pub fn set_opener(&self, opener: Arc<dyn ExternalUrlOpener>) {
        if let Ok(mut slot) = self.opener.lock() {
            *slot = Some(opener);
        }
    }

    pub fn open(&self, url: &str) -> AppResult<()> {
        let opener = self
            .opener
            .lock()
            .map_err(|_| internal_mutex("external_link.opener.locked"))?
            .clone()
            .ok_or_else(|| {
                AppError::new(ErrorCode::ExternalLinkOpenerUnavailable, Severity::Warning)
                    .with_param("reason", "external url opener is not available")
                    .with_action(RecoveryAction::Acknowledge)
            })?;
        opener.open(url)
    }
}

fn internal_mutex(operation: &'static str) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("operation", operation)
}
