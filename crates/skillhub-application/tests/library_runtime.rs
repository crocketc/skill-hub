use std::sync::Arc;
use std::thread;

use skillhub_application::library_runtime::{LibraryContext, LibraryRuntime};
use skillhub_core::ErrorCode;
use skillhub_storage::CentralLibrary;

fn context() -> Arc<LibraryContext> {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().to_path_buf();
    std::mem::forget(root);
    Arc::new(LibraryContext::from_library(
        CentralLibrary::create(root_path).unwrap(),
    ))
}

#[test]
fn pending_runtime_returns_a_stable_library_not_ready_error() {
    let runtime = LibraryRuntime::new();

    let error = match runtime.snapshot() {
        Ok(_) => panic!("pending runtime unexpectedly had a snapshot"),
        Err(error) => error,
    };

    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        error.params.get("reason").and_then(|value| value.as_str()),
        Some("library_not_ready")
    );
}

#[test]
fn publishing_a_context_makes_snapshot_and_store_use_the_same_context() {
    let runtime = LibraryRuntime::new();
    let candidate = context();
    let expected_root = candidate.root.clone();

    runtime.publish(candidate.clone()).unwrap();
    let snapshot = runtime.snapshot().unwrap();

    assert!(Arc::ptr_eq(&snapshot, &candidate));
    assert_eq!(snapshot.root, expected_root);
    assert_eq!(
        snapshot
            .store
            .objects_path_for_test()
            .parent()
            .unwrap()
            .parent()
            .unwrap(),
        snapshot.root
    );
}

#[test]
fn active_runtime_can_only_publish_once() {
    let runtime = LibraryRuntime::new();
    runtime.publish(context()).unwrap();

    let error = runtime.publish(context()).unwrap_err();

    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        error.params.get("reason").and_then(|value| value.as_str()),
        Some("library_root_locked")
    );
}

#[test]
fn concurrent_publishers_are_serialized_and_only_one_succeeds() {
    let runtime = Arc::new(LibraryRuntime::new());
    let first = context();
    let second = context();
    let left = Arc::clone(&runtime);
    let right = Arc::clone(&runtime);
    let left_handle = thread::spawn(move || left.publish(first));
    let right_handle = thread::spawn(move || right.publish(second));

    let outcomes = [left_handle.join().unwrap(), right_handle.join().unwrap()];
    assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(outcomes.iter().filter(|result| result.is_err()).count(), 1);
}
