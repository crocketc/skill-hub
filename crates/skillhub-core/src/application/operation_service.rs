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
    pub async fn run<T, F, Fut>(
        &self,
        operation_id: OperationId,
        kind: impl Into<String>,
        request_fingerprint: impl Into<String>,
        operation: F,
    ) -> AppResult<T>
    where
        T: Serialize + DeserializeOwned + Clone,
        F: FnOnce(OperationContext<R>) -> Fut,
        Fut: Future<Output = AppResult<T>>,
    {
        let kind = kind.into();
        let request_fingerprint = request_fingerprint.into();
        let _writer = self.journal.acquire_writer().await;

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
            let mut existing = existing;
            for _ in 0..64 {
                if existing.phase == OperationPhase::Committed {
                    return decode_result(&existing);
                }
                if existing.is_terminal() {
                    return Err(conflict("operation_in_progress"));
                }
                tokio::task::yield_now().await;
                existing = self
                    .journal
                    .repository()
                    .get(operation_id)
                    .await?
                    .ok_or_else(|| conflict("operation_disappeared"))?;
            }
            return Err(conflict("operation_in_progress"));
        }

        let mut record = OperationRecord::planned(operation_id, kind, request_fingerprint);
        if let Err(insert_error) = self.journal.repository().insert(&record).await {
            // A second service instance may use a separate process-local
            // writer while pointing at the same SQLite file. The primary key
            // insert is the atomic claim; resolve its loser path by reading
            // the row that won the claim.
            if let Some(existing) = self.journal.repository().get(operation_id).await? {
                if existing.request_fingerprint != record.request_fingerprint {
                    return Err(mismatch_error());
                }
                let mut existing = existing;
                for _ in 0..64 {
                    if existing.phase == OperationPhase::Committed {
                        return decode_result(&existing);
                    }
                    if existing.is_terminal() {
                        return Err(conflict("operation_claimed_by_another_writer"));
                    }
                    tokio::task::yield_now().await;
                    existing = self
                        .journal
                        .repository()
                        .get(operation_id)
                        .await?
                        .ok_or_else(|| conflict("operation_claim_lost"))?;
                }
                return Err(conflict("operation_claimed_by_another_writer"));
            }
            return Err(insert_error);
        }

        record.phase = OperationPhase::Applying;
        record.progress.phase = OperationPhase::Applying;
        record.progress.message_code = "operation.applying".to_owned();
        self.journal.repository().update(&record).await?;

        let context = OperationContext::new(
            record.clone(),
            self.journal.repository().clone(),
            self.journal.cancellation_state(),
        );
        let outcome = operation(context.clone()).await;
        let checkpoint_error = context.checkpoint_error();
        let cancelled = context.is_cancelled();
        let mut context_record = context.into_record();
        if let Some(error) = checkpoint_error {
            context_record.phase = OperationPhase::NeedsRecovery;
            context_record.progress.phase = OperationPhase::NeedsRecovery;
            context_record.progress.message_code = "operation.needs_recovery".to_owned();
            context_record.error_code = Some(error.code);
            self.journal.repository().update(&context_record).await?;
            return Err(error);
        }
        if cancelled {
            context_record.phase = OperationPhase::RolledBack;
            context_record.progress.phase = OperationPhase::RolledBack;
            context_record.progress.message_code = "operation.cancelled".to_owned();
            self.journal.repository().update(&context_record).await?;
            return Err(conflict("operation_cancelled"));
        }
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

    pub async fn cancel(&self, operation_id: OperationId) -> AppResult<OperationSummary> {
        self.journal.request_cancel(operation_id);
        let _writer = self.journal.acquire_writer().await;
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
        self.journal.clear_cancel(operation_id);
        Ok(summary(&record))
    }

    /// Prepare an inverse only when freshly observed facts match the
    /// preconditions recorded by the original operation.
    pub async fn prepare_undo_checked(
        &self,
        operation_id: OperationId,
        current_facts: Value,
    ) -> AppResult<UndoPlan> {
        self.prepare_undo_internal(operation_id, current_facts)
            .await
    }

    async fn prepare_undo_internal(
        &self,
        operation_id: OperationId,
        current_facts: Value,
    ) -> AppResult<UndoPlan> {
        let _writer = self.journal.acquire_writer().await;
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
        if current_facts != inverse.preconditions {
            return Err(conflict("undo_precondition_mismatch"));
        }
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

    /// Apply and verify an inverse while holding the same writer permit. The
    /// callback is the domain-specific inverse (for example, restoring a
    /// previous name); the journal supplies recorded facts, refuses stale
    /// observations before any inverse write begins, and verifies the facts
    /// observed after applying the inverse before committing.
    pub async fn commit_undo_checked<T, F, Fut, RF, RFut>(
        &self,
        plan_id: OperationId,
        current_facts: Value,
        apply_inverse: F,
        read_facts_after_apply: RF,
    ) -> AppResult<T>
    where
        T: Serialize,
        F: FnOnce(Value) -> Fut,
        Fut: Future<Output = AppResult<T>>,
        RF: FnOnce() -> RFut,
        RFut: Future<Output = AppResult<Value>>,
    {
        let _writer = self.journal.acquire_writer().await;
        let mut plan = self
            .journal
            .repository()
            .get(plan_id)
            .await?
            .ok_or_else(|| object_not_found(plan_id))?;
        let inverse = plan
            .inverse
            .clone()
            .ok_or_else(|| conflict("undo_plan_has_no_inverse"))?;
        if plan.phase != OperationPhase::Prepared {
            return Err(conflict("undo_plan_is_not_prepared"));
        }
        if current_facts != inverse.preconditions {
            return Err(conflict("undo_precondition_mismatch"));
        }
        plan.phase = OperationPhase::Applying;
        plan.progress.phase = OperationPhase::Applying;
        plan.progress.message_code = "operation.undo_applying".to_owned();
        self.journal.repository().update(&plan).await?;

        let expected_post_apply_facts = inverse.facts.clone();
        match apply_inverse(inverse.facts).await {
            Ok(result) => {
                let post_apply_facts = match read_facts_after_apply().await {
                    Ok(facts) => facts,
                    Err(error) => {
                        plan.phase = OperationPhase::NeedsRecovery;
                        plan.progress.phase = OperationPhase::NeedsRecovery;
                        plan.error_code = Some(error.code);
                        plan.progress.message_code = "operation.undo_needs_recovery".to_owned();
                        self.journal.repository().update(&plan).await?;
                        return Err(error);
                    }
                };
                if post_apply_facts != expected_post_apply_facts {
                    let error = conflict("undo_postcondition_mismatch");
                    plan.phase = OperationPhase::NeedsRecovery;
                    plan.progress.phase = OperationPhase::NeedsRecovery;
                    plan.error_code = Some(error.code);
                    plan.progress.message_code = "operation.undo_needs_recovery".to_owned();
                    self.journal.repository().update(&plan).await?;
                    return Err(error);
                }
                plan.result = Some(serde_json::to_value(&result).map_err(|_| {
                    AppError::new(ErrorCode::InternalError, Severity::Error)
                        .with_param("reason", "undo_result_not_serializable")
                })?);
                plan.phase = OperationPhase::Verifying;
                plan.progress.phase = OperationPhase::Verifying;
                self.journal.repository().update(&plan).await?;
                plan.phase = OperationPhase::Committed;
                plan.progress.phase = OperationPhase::Committed;
                plan.progress.message_code = "operation.undo_committed".to_owned();
                self.journal.repository().update(&plan).await?;
                Ok(result)
            }
            Err(error) => {
                plan.phase = OperationPhase::NeedsRecovery;
                plan.progress.phase = OperationPhase::NeedsRecovery;
                plan.error_code = Some(error.code);
                plan.progress.message_code = "operation.undo_needs_recovery".to_owned();
                self.journal.repository().update(&plan).await?;
                Err(error)
            }
        }
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

        let plan =
            block_on(service.prepare_undo_checked(id, serde_json::json!({"current_name":"after"})))
                .unwrap();
        assert_eq!(plan.inverse_kind, "rename_skill");
        assert_eq!(plan.facts["previous_name"], "before");
        block_on(service.commit_undo_checked(
            plan.id,
            serde_json::json!({"current_name":"after"}),
            |_facts| async { Ok::<_, AppError>(()) },
            || async { Ok::<_, AppError>(serde_json::json!({"previous_name":"before"})) },
        ))
        .unwrap();
    }

    #[test]
    fn shared_repository_writer_never_allows_two_applying_mutations() {
        let repository = Arc::new(MemoryRepository::default());
        let service = OperationService::new(repository);
        let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let maximum = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let first_active = active.clone();
        let first_maximum = maximum.clone();
        let second_active = active.clone();
        let second_maximum = maximum.clone();
        let result = block_on(async move {
            join2(
                service.run(OperationId::new(), "first", "a", move |_context| {
                    applying_window(first_active, first_maximum)
                }),
                service.run(OperationId::new(), "second", "b", move |_context| {
                    applying_window(second_active, second_maximum)
                }),
            )
            .await
        });
        assert!(result.0.is_ok() && result.1.is_ok());
        assert_eq!(maximum.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn cancellation_is_observable_and_persisted_as_rolled_back() {
        let repository = Arc::new(MemoryRepository::default());
        let service = OperationService::new(repository.clone());
        let operation_id = OperationId::new();
        let result = block_on(async {
            join2(
                service.run(operation_id, "cancel-me", "cancel", |context| async move {
                    while !context.is_cancelled() {
                        tokio::task::yield_now().await;
                    }
                    Err::<(), _>(conflict("cooperative_cancel"))
                }),
                async {
                    tokio::task::yield_now().await;
                    service.cancel(operation_id).await
                },
            )
            .await
        });
        assert!(result.0.is_err());
        assert_eq!(result.1.unwrap().phase, OperationPhase::RolledBack);
        let stored = block_on(repository.get(operation_id)).unwrap().unwrap();
        assert_eq!(stored.phase, OperationPhase::RolledBack);
    }

    #[test]
    fn checked_undo_rejects_external_change_and_applies_matching_inverse() {
        let repository = Arc::new(MemoryRepository::default());
        let service = OperationService::new(repository);
        let id = OperationId::new();
        block_on(
            service.run(id, "rename_skill", "rename-checked", |context| async move {
                context.set_inverse(
                    "rename_skill",
                    serde_json::json!({"name":"after"}),
                    serde_json::json!({"name":"before"}),
                );
                Ok::<_, AppError>(())
            }),
        )
        .unwrap();
        let plan = block_on(service.prepare_undo_checked(id, serde_json::json!({"name":"after"})))
            .unwrap();
        let stale = block_on(service.commit_undo_checked(
            plan.id,
            serde_json::json!({"name":"changed-externally"}),
            |_facts| async { Ok::<_, AppError>(()) },
            || async { Ok::<_, AppError>(serde_json::json!({"name":"before"})) },
        ));
        assert_eq!(
            stale.unwrap_err().params["reason"],
            "undo_precondition_mismatch"
        );
        let plan = block_on(service.prepare_undo_checked(id, serde_json::json!({"name":"after"})))
            .unwrap();
        let applied = block_on(service.commit_undo_checked(
            plan.id,
            serde_json::json!({"name":"after"}),
            |facts| async move { Ok::<_, AppError>(facts["name"].clone()) },
            || async { Ok::<_, AppError>(serde_json::json!({"name":"before"})) },
        ))
        .unwrap();
        assert_eq!(applied, "before");

        let id_again = OperationId::new();
        block_on(service.run(
            id_again,
            "rename_skill_again",
            "rename-again",
            |context| async move {
                context.set_inverse(
                    "rename_skill",
                    serde_json::json!({"name":"after"}),
                    serde_json::json!({"name":"before"}),
                );
                Ok::<_, AppError>(())
            },
        ))
        .unwrap();
        let plan =
            block_on(service.prepare_undo_checked(id_again, serde_json::json!({"name":"after"})))
                .unwrap();
        let post_mismatch = block_on(service.commit_undo_checked(
            plan.id,
            serde_json::json!({"name":"after"}),
            |_facts| async { Ok::<_, AppError>(()) },
            || async { Ok::<_, AppError>(serde_json::json!({"name":"wrong"})) },
        ));
        assert_eq!(
            post_mismatch.unwrap_err().params["reason"],
            "undo_postcondition_mismatch"
        );
    }

    async fn applying_window(
        active: Arc<std::sync::atomic::AtomicUsize>,
        maximum: Arc<std::sync::atomic::AtomicUsize>,
    ) -> AppResult<u32> {
        let current = active.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        maximum.fetch_max(current, std::sync::atomic::Ordering::SeqCst);
        tokio::task::yield_now().await;
        active.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        Ok(1)
    }

    async fn join2<A, B>(first: A, second: B) -> (A::Output, B::Output)
    where
        A: Future,
        B: Future,
    {
        use std::task::Poll;
        let mut first = std::pin::pin!(first);
        let mut second = std::pin::pin!(second);
        let mut first_result = None;
        let mut second_result = None;
        std::future::poll_fn(|cx| {
            if first_result.is_none() {
                if let Poll::Ready(value) = first.as_mut().poll(cx) {
                    first_result = Some(value);
                }
            }
            if second_result.is_none() {
                if let Poll::Ready(value) = second.as_mut().poll(cx) {
                    second_result = Some(value);
                }
            }
            if first_result.is_some() && second_result.is_some() {
                Poll::Ready((first_result.take().unwrap(), second_result.take().unwrap()))
            } else {
                Poll::Pending
            }
        })
        .await
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(future)
    }
}
