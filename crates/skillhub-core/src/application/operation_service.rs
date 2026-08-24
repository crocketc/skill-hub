use std::future::Future;
use std::sync::Arc;

use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

use crate::operation::journal::{
    conflict, decode_result, mismatch_error, OperationContext, OperationJournal, OperationRecord,
};
use crate::{
    AppError, AppResult, ErrorCode, OperationId, OperationPhase, OperationProgress,
    OperationRepository, OperationSummary, RecoveryAction, Severity, UndoPlan,
};

/// Application-facing coordinator for all durable library mutations.
pub struct OperationService<R> {
    journal: OperationJournal<R>,
}

impl<R> Clone for OperationService<R> {
    fn clone(&self) -> Self {
        Self {
            journal: self.journal.clone(),
        }
    }
}

impl<R> OperationService<R>
where
    R: OperationRepository,
{
    pub fn new(repository: Arc<R>) -> Self {
        Self {
            journal: OperationJournal::new(repository),
        }
    }

    pub fn from_journal(journal: OperationJournal<R>) -> Self {
        Self { journal }
    }

    pub fn journal(&self) -> &OperationJournal<R> {
        &self.journal
    }

    /// Run an idempotent mutation. A completed operation with the same id and
    /// fingerprint is decoded and returned without invoking `operation`.
    #[allow(clippy::await_holding_lock)]
    pub async fn run<T, F, Fut>(
        &self,
        operation_id: OperationId,
        kind: impl Into<String>,
        request_fingerprint: impl Into<String>,
        operation: F,
    ) -> AppResult<T>
    where
        T: Serialize + DeserializeOwned + Clone,
        F: FnOnce(OperationContext) -> Fut,
        Fut: Future<Output = AppResult<T>>,
    {
        let kind = kind.into();
        let request_fingerprint = request_fingerprint.into();
        let _writer = self.journal.acquire_writer()?;

        if let Some(existing) = self.journal.repository().get(operation_id).await? {
            if existing.request_fingerprint != request_fingerprint {
                return Err(mismatch_error());
            }
            if existing.phase == OperationPhase::Committed {
                return decode_result(&existing);
            }
            if existing.phase == OperationPhase::RolledBack {
                return Err(conflict("operation_was_rolled_back"));
            }
            if existing.phase == OperationPhase::NeedsRecovery {
                return Err(
                    AppError::new(ErrorCode::OperationConflict, Severity::Critical)
                        .with_action(RecoveryAction::CompleteOperation)
                        .with_action(RecoveryAction::RollbackOperation),
                );
            }
            return Err(conflict("operation_in_progress"));
        }

        let mut record = OperationRecord::planned(operation_id, kind, request_fingerprint);
        self.journal.repository().insert(&record).await?;

        record.phase = OperationPhase::Applying;
        record.progress.phase = OperationPhase::Applying;
        record.progress.message_code = "operation.applying".to_owned();
        self.journal.repository().update(&record).await?;

        let context = OperationContext::new(record.clone());
        let outcome = operation(context.clone()).await;
        let mut context_record = context.into_record();
        match outcome {
            Ok(result) => {
                context_record.phase = OperationPhase::Verifying;
                context_record.progress.phase = OperationPhase::Verifying;
                context_record.progress.message_code = "operation.verifying".to_owned();
                self.journal.repository().update(&context_record).await?;

                context_record.result = Some(serde_json::to_value(&result).map_err(|_| {
                    AppError::new(ErrorCode::InternalError, Severity::Error)
                        .with_param("reason", "operation_result_not_serializable")
                })?);
                context_record.phase = OperationPhase::Committed;
                context_record.progress.phase = OperationPhase::Committed;
                context_record.progress.completed = context_record.progress.total;
                context_record.progress.message_code = "operation.committed".to_owned();
                self.journal.repository().update(&context_record).await?;
                Ok(result)
            }
            Err(error) => {
                let mut failed = context_record;
                failed.phase = OperationPhase::NeedsRecovery;
                failed.progress.phase = OperationPhase::NeedsRecovery;
                failed.progress.message_code = "operation.needs_recovery".to_owned();
                failed.error_code = Some(error.code);
                self.journal.repository().update(&failed).await?;
                Err(error)
            }
        }
    }

    #[allow(clippy::await_holding_lock)]
    pub async fn cancel(&self, operation_id: OperationId) -> AppResult<OperationSummary> {
        let _writer = self.journal.acquire_writer()?;
        let mut record = self
            .journal
            .repository()
            .get(operation_id)
            .await?
            .ok_or_else(|| object_not_found(operation_id))?;
        if !record.is_terminal() {
            record.phase = OperationPhase::RolledBack;
            record.progress.phase = OperationPhase::RolledBack;
            record.progress.message_code = "operation.rolled_back".to_owned();
            self.journal.repository().update(&record).await?;
        }
        Ok(summary(&record))
    }

    /// Prepare a whole-operation inverse. This method never exposes a global
    /// history rewind; only facts recorded by the selected operation are put in
    /// the plan. The caller must re-check the returned preconditions before
    /// applying the inverse to domain state.
    #[allow(clippy::await_holding_lock)]
    pub async fn prepare_undo(&self, operation_id: OperationId) -> AppResult<UndoPlan> {
        let _writer = self.journal.acquire_writer()?;
        let source = self
            .journal
            .repository()
            .get(operation_id)
            .await?
            .ok_or_else(|| object_not_found(operation_id))?;
        if source.phase != OperationPhase::Committed {
            return Err(conflict("only_committed_operations_can_be_undone"));
        }
        let inverse = source
            .inverse
            .clone()
            .ok_or_else(|| conflict("operation_has_no_inverse"))?;
        let plan_id = OperationId::new();
        let mut plan_record = OperationRecord::planned(
            plan_id,
            format!("undo.{}", inverse.kind),
            format!("undo:{}", operation_id),
        );
        plan_record.phase = OperationPhase::Prepared;
        plan_record.progress.phase = OperationPhase::Prepared;
        plan_record.progress.message_code = "operation.undo_prepared".to_owned();
        plan_record.inverse = Some(inverse.clone());
        plan_record.recovery_data = serde_json::json!({"source_operation_id": operation_id});
        self.journal.repository().insert(&plan_record).await?;
        Ok(UndoPlan {
            id: plan_id,
            operation_id,
            inverse_kind: inverse.kind,
            preconditions: inverse.preconditions,
            facts: inverse.facts,
        })
    }

    /// Commit the prepared inverse marker after the caller has applied and
    /// verified the inverse against `UndoPlan::preconditions`.
    #[allow(clippy::await_holding_lock)]
    pub async fn commit_undo(&self, plan_id: OperationId) -> AppResult<OperationSummary> {
        let _writer = self.journal.acquire_writer()?;
        let mut plan = self
            .journal
            .repository()
            .get(plan_id)
            .await?
            .ok_or_else(|| object_not_found(plan_id))?;
        if plan.phase != OperationPhase::Prepared {
            return Err(conflict("undo_plan_is_not_prepared"));
        }
        if plan.inverse.is_none() {
            return Err(conflict("undo_plan_has_no_inverse"));
        }
        plan.phase = OperationPhase::Applying;
        plan.progress.phase = OperationPhase::Applying;
        plan.progress.message_code = "operation.undo_applying".to_owned();
        self.journal.repository().update(&plan).await?;
        plan.phase = OperationPhase::Committed;
        plan.progress.phase = OperationPhase::Committed;
        plan.progress.message_code = "operation.undo_committed".to_owned();
        self.journal.repository().update(&plan).await?;
        Ok(summary(&plan))
    }

    pub async fn list_operations(&self) -> AppResult<Vec<OperationRecord>> {
        self.journal.list().await
    }
}

fn summary(record: &OperationRecord) -> OperationSummary {
    OperationSummary {
        operation_id: record.operation_id,
        phase: record.phase,
        message_code: record.progress.message_code.clone(),
        error_code: record.error_code,
    }
}

fn object_not_found(operation_id: OperationId) -> AppError {
    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
        .with_param("operation_id", operation_id.to_string())
}

#[allow(dead_code)]
fn _keep_public_types(_: Value, _: OperationProgress) {}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

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
            self.records
                .lock()
                .unwrap()
                .insert(record.operation_id.to_string(), record.clone());
            Ok(())
        }

        async fn list(&self) -> AppResult<Vec<OperationRecord>> {
            Ok(self.records.lock().unwrap().values().cloned().collect())
        }
    }

    #[test]
    fn repeated_id_returns_persisted_result_without_invoking_second_mutation() {
        let repository = Arc::new(MemoryRepository::default());
        let service = OperationService::new(repository);
        let id = OperationId::new();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let first_calls = calls.clone();
        let first = block_on(service.run(id, "count", "same", move |_context| {
            first_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { Ok::<_, AppError>(7_u32) }
        }))
        .unwrap();
        let second_calls = calls.clone();
        let second = block_on(service.run(id, "count", "same", move |_context| {
            second_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { Ok::<_, AppError>(99_u32) }
        }))
        .unwrap();

        assert_eq!(first, 7);
        assert_eq!(second, 7);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn reusing_id_with_another_fingerprint_is_rejected() {
        let repository = Arc::new(MemoryRepository::default());
        let service = OperationService::new(repository);
        let id = OperationId::new();
        block_on(service.run(id, "rename", "request-a", |_context| async {
            Ok::<_, AppError>(())
        }))
        .unwrap();

        let error = block_on(service.run(id, "rename", "request-b", |_context| async {
            Ok::<_, AppError>(())
        }))
        .unwrap_err();
        assert_eq!(
            error.code.as_str(),
            "operation.id_reused_with_different_request"
        );
    }

    #[test]
    fn undo_is_prepared_from_recorded_inverse_facts() {
        let repository = Arc::new(MemoryRepository::default());
        let service = OperationService::new(repository);
        let id = OperationId::new();
        block_on(
            service.run(id, "rename_skill", "rename-a", |context| async move {
                context.set_inverse(
                    "rename_skill",
                    serde_json::json!({"current_name":"after"}),
                    serde_json::json!({"previous_name":"before"}),
                );
                Ok::<_, AppError>(())
            }),
        )
        .unwrap();

        let plan = block_on(service.prepare_undo(id)).unwrap();
        assert_eq!(plan.inverse_kind, "rename_skill");
        assert_eq!(plan.facts["previous_name"], "before");
        let summary = block_on(service.commit_undo(plan.id)).unwrap();
        assert_eq!(summary.phase, OperationPhase::Committed);
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
        fn clone(_: *const ()) -> RawWaker {
            raw_waker()
        }
        fn wake(_: *const ()) {}
        fn raw_waker() -> RawWaker {
            RawWaker::new(
                std::ptr::null(),
                &RawWakerVTable::new(clone, wake, wake, wake),
            )
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
}
