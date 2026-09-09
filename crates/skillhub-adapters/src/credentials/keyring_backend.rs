//! OS vault backend on macOS (Keychain) and Windows (Credential Manager),
//! built on the `keyring` crate. Other platforms fall back to the process
//! memory backend, which the user documentation states honestly.

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod native_impl {
    use super::super::{vault_failure, CredentialBackend};

    const SERVICE: &str = "SkillHub";

    /// Calls the OS vault through the `keyring` crate.
    pub struct KeyringCredentialBackend;

    impl KeyringCredentialBackend {
        pub fn native() -> Self {
            Self
        }
    }

    impl CredentialBackend for KeyringCredentialBackend {
        fn set(&self, account: &str, secret: &str) -> skillhub_core::AppResult<()> {
            let entry = keyring::Entry::new(SERVICE, account).map_err(|_| vault_failure())?;
            entry.set_password(secret).map_err(|_| vault_failure())?;
            Ok(())
        }

        fn get(&self, account: &str) -> skillhub_core::AppResult<Option<String>> {
            let entry = keyring::Entry::new(SERVICE, account).map_err(|_| vault_failure())?;
            match entry.get_password() {
                Ok(secret) => Ok(Some(secret)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(vault_failure()),
            }
        }

        fn delete(&self, account: &str) -> skillhub_core::AppResult<()> {
            let entry = keyring::Entry::new(SERVICE, account).map_err(|_| vault_failure())?;
            match entry.delete_credential() {
                Ok(()) => Ok(()),
                Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(vault_failure()),
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod native_impl {
    use std::sync::Arc;

    use super::super::memory::InMemoryCredentialBackend;
    use super::super::CredentialBackend;

    /// On platforms without a supported OS vault the native store degrades to
    /// process memory. This is a documented limitation, not a silent promise.
    pub struct KeyringCredentialBackend {
        fallback: Arc<InMemoryCredentialBackend>,
    }

    impl KeyringCredentialBackend {
        pub fn native() -> Self {
            Self {
                fallback: Arc::new(InMemoryCredentialBackend::default()),
            }
        }
    }

    impl CredentialBackend for KeyringCredentialBackend {
        fn set(&self, account: &str, secret: &str) -> skillhub_core::AppResult<()> {
            self.fallback.set(account, secret)
        }

        fn get(&self, account: &str) -> skillhub_core::AppResult<Option<String>> {
            self.fallback.get(account)
        }

        fn delete(&self, account: &str) -> skillhub_core::AppResult<()> {
            self.fallback.delete(account)
        }
    }
}

pub use native_impl::KeyringCredentialBackend;
