mod macos;
mod windows;

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use skillhub_core::llm::{CredentialRef, CredentialStore};
use skillhub_core::AppResult;

/// A process-only credential store used when an OS vault is unavailable.
/// The value is never serialised or written to the application database.
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
}

pub use macos::MacosCredentialStore;
pub use windows::WindowsCredentialStore;
