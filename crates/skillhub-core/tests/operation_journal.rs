use async_trait::async_trait;
use skillhub_core::{
    AppError, AppResult, OperationId, OperationRecord, OperationRepository, OperationService,
};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

struct MemoryRepository {
    records: Mutex<BTreeMap<String, OperationRecord>>,
    writer: Arc<tokio::sync::Mutex<()>>,
}

impl Default for MemoryRepository {
    fn default() -> Self {
        Self {
            records: Mutex::new(BTreeMap::new()),
            writer: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
}

#[async_trait(?Send)]
impl OperationRepository for MemoryRepository {
    fn writer(&self) -> Arc<tokio::sync::Mutex<()>> {
        self.writer.clone()
    }

    fn checkpoint(&self, record: &OperationRecord) -> AppResult<()> {
        self.records
            .lock()
            .unwrap()
            .insert(record.operation_id.to_string(), record.clone());
        Ok(())
    }

    async fn get(&self, id: OperationId) -> AppResult<Option<OperationRecord>> {
        Ok(self.records.lock().unwrap().get(&id.to_string()).cloned())
    }

    async fn insert(&self, record: &OperationRecord) -> AppResult<()> {
        self.checkpoint(record)
    }

    async fn update(&self, record: &OperationRecord) -> AppResult<()> {
        self.checkpoint(record)
    }

    async fn list(&self) -> AppResult<Vec<OperationRecord>> {
        Ok(self.records.lock().unwrap().values().cloned().collect())
    }
}

#[test]
fn operation_idempotency_is_executable_in_the_integration_target() {
    let repository = Arc::new(MemoryRepository::default());
    let service = OperationService::new(repository);
    let id = OperationId::new();
    let first = block_on(service.run(id, "count", "same", |_context| async {
        Ok::<_, AppError>(7_u32)
    }))
    .unwrap();
    let second = block_on(service.run(id, "count", "same", |_context| async {
        Ok::<_, AppError>(99_u32)
    }))
    .unwrap();
    assert_eq!(first, second);
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
        .block_on(future)
}
