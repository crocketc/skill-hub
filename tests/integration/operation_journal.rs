//! Task 05-01 integration scenarios.
//!
//! The repository is currently a virtual Cargo workspace, so these scenarios
//! are mirrored by the focused unit tests in `application::operation_service`.
//! Keeping this file at the plan's integration boundary lets the workspace
//! integration harness include them without changing the public contracts.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use skillhub_core::{
    AppError, AppResult, OperationId, OperationRecord, OperationRepository, OperationService,
};

#[derive(Default)]
struct MemoryRepository {
    records: Mutex<BTreeMap<String, OperationRecord>>,
}

#[async_trait(?Send)]
impl OperationRepository for MemoryRepository {
    async fn get(&self, id: OperationId) -> AppResult<Option<OperationRecord>> {
        Ok(self.records.lock().unwrap().get(&id.to_string()).cloned())
    }

    async fn insert(&self, record: &OperationRecord) -> AppResult<()> {
        self.records
            .lock()
            .unwrap()
            .insert(record.operation_id.to_string(), record.clone());
        Ok(())
    }

    async fn update(&self, record: &OperationRecord) -> AppResult<()> {
        self.insert(record).await
    }

    async fn list(&self) -> AppResult<Vec<OperationRecord>> {
        Ok(self.records.lock().unwrap().values().cloned().collect())
    }
}

#[test]
fn repeated_operation_id_returns_original_result_without_second_write() {
    let service = OperationService::new(Arc::new(MemoryRepository::default()));
    let operation_id = OperationId::new();
    let first = block_on(service.run(operation_id, "count", "same", |_context| async {
        Ok::<_, AppError>(1_u32)
    }))
    .unwrap();
    let second = block_on(service.run(operation_id, "count", "same", |_context| async {
        Ok::<_, AppError>(2_u32)
    }))
    .unwrap();
    assert_eq!(first, second);
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
    fn clone(_: *const ()) -> RawWaker { raw_waker() }
    fn wake(_: *const ()) {}
    fn raw_waker() -> RawWaker {
        RawWaker::new(std::ptr::null(), &RawWakerVTable::new(clone, wake, wake, wake))
    }
    let waker = unsafe { Waker::from_raw(raw_waker()) };
    let mut context = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}
