use super::SessionCredentialStore;

/// Windows Credential Manager adapter boundary. Until native vault access is
/// enabled, this intentionally exposes the process-only fallback.
pub type WindowsCredentialStore = SessionCredentialStore;
