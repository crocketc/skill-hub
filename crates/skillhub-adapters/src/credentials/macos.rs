use super::SessionCredentialStore;

/// macOS Keychain adapter boundary. Until native Keychain access is enabled,
/// this intentionally exposes the process-only fallback.
pub type MacosCredentialStore = SessionCredentialStore;
