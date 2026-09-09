use std::collections::HashMap;
use std::sync::Mutex;

use super::CredentialBackend;

/// In-memory backend used by tests and any platform without an OS vault.
/// Nothing is ever written to disk or to the application database.
#[derive(Default)]
pub struct InMemoryCredentialBackend {
    values: Mutex<HashMap<String, String>>,
}

impl InMemoryCredentialBackend {
    pub fn read_raw(&self, account: &str) -> Option<String> {
        self.values
            .lock()
            .expect("credential mutex poisoned")
            .get(account)
            .cloned()
    }
}

impl CredentialBackend for InMemoryCredentialBackend {
    fn set(&self, account: &str, secret: &str) -> skillhub_core::AppResult<()> {
        self.values
            .lock()
            .expect("credential mutex poisoned")
            .insert(account.to_owned(), secret.to_owned());
        Ok(())
    }

    fn get(&self, account: &str) -> skillhub_core::AppResult<Option<String>> {
        Ok(self
            .values
            .lock()
            .expect("credential mutex poisoned")
            .get(account)
            .cloned())
    }

    fn delete(&self, account: &str) -> skillhub_core::AppResult<()> {
        self.values
            .lock()
            .expect("credential mutex poisoned")
            .remove(account);
        Ok(())
    }
}
