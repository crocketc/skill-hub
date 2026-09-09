use std::sync::Arc;

use skillhub_adapters::credentials::{
    CredentialBackend, InMemoryCredentialBackend, OsCredentialStore, SessionCredentialStore,
};
use skillhub_core::llm::{CredentialRef, CredentialStore};

fn reference() -> CredentialRef {
    CredentialRef::new("llm-provider:deepseek")
}

#[tokio::test]
async fn session_store_supports_set_replace_and_delete() {
    let store = SessionCredentialStore::default();
    let reference = reference();

    store.set(&reference, "sk-first-value").await.expect("set");
    let read = store.get(&reference).await.expect("get");
    assert_eq!(read.as_deref(), Some("sk-first-value"));

    // Replacing a credential overwrites the old value instead of stacking.
    store
        .set(&reference, "sk-second-value")
        .await
        .expect("replace");
    let replaced = store.get(&reference).await.expect("get after replace");
    assert_eq!(replaced.as_deref(), Some("sk-second-value"));

    store.delete(&reference).await.expect("delete");
    let gone = store.get(&reference).await.expect("get after delete");
    assert_eq!(gone, None, "deleted credentials must not resolve");
}

#[tokio::test]
async fn os_credential_store_round_trips_through_its_backend() {
    let backend = Arc::new(InMemoryCredentialBackend::default());
    let store = OsCredentialStore::with_backend(backend.clone());
    let reference = reference();

    store
        .set(&reference, "sk-test-fixture-value")
        .await
        .expect("set stores into the backend");
    assert_eq!(
        backend.read_raw("llm-provider:deepseek").as_deref(),
        Some("sk-test-fixture-value")
    );

    let read = store.get(&reference).await.expect("get");
    assert_eq!(read.as_deref(), Some("sk-test-fixture-value"));

    store
        .set(&reference, "sk-rotated-value")
        .await
        .expect("rotate");
    assert_eq!(
        backend.read_raw("llm-provider:deepseek").as_deref(),
        Some("sk-rotated-value"),
        "rotation must leave exactly one stored value"
    );

    store.delete(&reference).await.expect("delete");
    assert_eq!(backend.read_raw("llm-provider:deepseek"), None);
    let gone = store.get(&reference).await.expect("get after delete");
    assert_eq!(gone, None);
}

#[tokio::test]
async fn deleting_an_absent_credential_is_not_an_error() {
    let store = OsCredentialStore::with_backend(Arc::new(InMemoryCredentialBackend::default()));
    store
        .delete(&reference())
        .await
        .expect("delete of absent credential stays idempotent");
}

#[test]
fn backend_failures_surface_as_actionable_credential_errors() {
    let backend = Arc::new(FailingBackend);
    let store = OsCredentialStore::with_backend(backend);

    let write = futures_block_on(store.set(&reference(), "sk-x"));
    assert_eq!(
        write.expect_err("backend failure must surface").code,
        skillhub_core::ErrorCode::LlmCredentialReadFailed
    );

    let read = futures_block_on(store.get(&reference()));
    assert_eq!(
        read.expect_err("backend failure must surface").code,
        skillhub_core::ErrorCode::LlmCredentialReadFailed
    );
}

fn futures_block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(future)
}

struct FailingBackend;

impl CredentialBackend for FailingBackend {
    fn set(&self, _account: &str, _secret: &str) -> skillhub_core::AppResult<()> {
        Err(skillhub_core::AppError::llm_credential_read_failed())
    }
    fn get(&self, _account: &str) -> skillhub_core::AppResult<Option<String>> {
        Err(skillhub_core::AppError::llm_credential_read_failed())
    }
    fn delete(&self, _account: &str) -> skillhub_core::AppResult<()> {
        Err(skillhub_core::AppError::llm_credential_read_failed())
    }
}
