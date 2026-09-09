//! Credential storage. Secrets live in the operating system vault
//! (macOS Keychain, Windows Credential Manager) through `OsCredentialStore`;
//! the application database only ever holds `CredentialRef` identifiers.

mod keyring_backend;
mod memory;

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use skillhub_core::llm::{CredentialRef, CredentialStore};
use skillhub_core::{AppError, AppResult};

pub use memory::InMemoryCredentialBackend;

/// Read-only overlay serving one inline secret under a fixed reference id and
/// falling back to the base store for everything else. Used by administration
/// calls on unsaved drafts whose credential material is not persisted yet.
pub struct OverlayCredentialStore {
    base: Arc<dyn CredentialStore>,
    overlay_id: String,
    overlay_value: String,
}

impl OverlayCredentialStore {
    pub fn new(base: Arc<dyn CredentialStore>, overlay_id: String, overlay_value: String) -> Self {
        Self {
            base,
            overlay_id,
            overlay_value,
        }
    }
}

#[async_trait::async_trait(?Send)]
impl CredentialStore for OverlayCredentialStore {
    async fn get(&self, reference: &CredentialRef) -> AppResult<Option<String>> {
        if reference.id == self.overlay_id {
            return Ok(Some(self.overlay_value.clone()));
        }
        self.base.get(reference).await
    }

    async fn set(&self, reference: &CredentialRef, secret: &str) -> AppResult<()> {
        self.base.set(reference, secret).await
    }

    async fn delete(&self, reference: &CredentialRef) -> AppResult<()> {
        self.base.delete(reference).await
    }
}

/// Platform seam behind [`OsCredentialStore`]. Production builds use the
/// keyring-backed implementation; tests inject in-memory backends so no test
/// ever touches a real OS vault or real credential.
pub trait CredentialBackend: Send + Sync {
    fn set(&self, account: &str, secret: &str) -> AppResult<()>;
    fn get(&self, account: &str) -> AppResult<Option<String>>;
    fn delete(&self, account: &str) -> AppResult<()>;
}

/// A process-only credential store used when an OS vault is unavailable
/// (CLI runs, tests). The value is never serialised or written to the
/// application database.
#[derive(Clone, Default)]
pub struct SessionCredentialStore {
    values: Arc<Mutex<HashMap<String, String>>>,
}

impl SessionCredentialStore {
    pub fn insert(&self, reference: CredentialRef, secret: impl Into<String>) {
        self.values
            .lock()
            .expect("credential mutex poisoned")
            .insert(reference.id, secret.into());
    }

    pub fn remove(&self, reference: &CredentialRef) {
        self.values
            .lock()
            .expect("credential mutex poisoned")
            .remove(&reference.id);
    }
}

#[async_trait(?Send)]
impl CredentialStore for SessionCredentialStore {
    async fn get(&self, reference: &CredentialRef) -> AppResult<Option<String>> {
        Ok(self
            .values
            .lock()
            .expect("credential mutex poisoned")
            .get(&reference.id)
            .cloned())
    }

    async fn set(&self, reference: &CredentialRef, secret: &str) -> AppResult<()> {
        self.values
            .lock()
            .expect("credential mutex poisoned")
            .insert(reference.id.clone(), secret.to_owned());
        Ok(())
    }

    async fn delete(&self, reference: &CredentialRef) -> AppResult<()> {
        self.values
            .lock()
            .expect("credential mutex poisoned")
            .remove(&reference.id);
        Ok(())
    }
}

/// The production credential store. On macOS and Windows the native OS vault
/// is used; other platforms fall back to the process-only store, which the
/// user documentation states honestly.
pub struct OsCredentialStore {
    backend: Arc<dyn CredentialBackend>,
}

impl OsCredentialStore {
    /// OS-vault-backed store for the current platform.
    pub fn native() -> Self {
        Self {
            backend: Arc::new(keyring_backend::KeyringCredentialBackend::native()),
        }
    }

    /// Test seam: run the same contract against an injected backend.
    pub fn with_backend(backend: Arc<dyn CredentialBackend>) -> Self {
        Self { backend }
    }
}

#[async_trait(?Send)]
impl CredentialStore for OsCredentialStore {
    async fn get(&self, reference: &CredentialRef) -> AppResult<Option<String>> {
        self.backend.get(&reference.id)
    }

    async fn set(&self, reference: &CredentialRef, secret: &str) -> AppResult<()> {
        self.backend.set(&reference.id, secret)
    }

    async fn delete(&self, reference: &CredentialRef) -> AppResult<()> {
        self.backend.delete(&reference.id)
    }
}

/// Shared error mapping for vault access failures. The message never carries
/// secret material; the recovery action points at the credential settings.
pub(crate) fn vault_failure() -> AppError {
    AppError::llm_credential_read_failed()
}
