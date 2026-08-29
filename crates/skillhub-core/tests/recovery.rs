use async_trait::async_trait;
use skillhub_core::application::{RecoveryBackend, RecoveryService};
use skillhub_core::{OperationId, RecoveryAction, RecoveryCandidate};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct FakeRecoveryBackend {
    candidate: RecoveryCandidate,
    resolved: Arc<Mutex<Vec<(OperationId, RecoveryAction)>>>,
}

#[async_trait]
impl RecoveryBackend for FakeRecoveryBackend {
    async fn list_candidates(&self) -> skillhub_core::AppResult<Vec<RecoveryCandidate>> {
        Ok(vec![self.candidate.clone()])
    }

    async fn resolve(
        &self,
        operation_id: OperationId,
        action: RecoveryAction,
    ) -> skillhub_core::AppResult<()> {
        self.resolved.lock().unwrap().push((operation_id, action));
        Ok(())
    }
}

#[test]
fn restart_exposes_complete_and_rollback_for_an_interrupted_operation() {
    block_on(async {
        let candidate = RecoveryCandidate {
            operation_id: OperationId::new(),
            actions: vec![
                RecoveryAction::CompleteOperation,
                RecoveryAction::RollbackOperation,
            ],
        };
        let backend = FakeRecoveryBackend {
            candidate: candidate.clone(),
            resolved: Arc::new(Mutex::new(Vec::new())),
        };
        let service = RecoveryService::new(Arc::new(backend.clone()));
        let candidates = service.list().await.unwrap();
        assert_eq!(candidates, vec![candidate.clone()]);
        service
            .resolve(candidate.operation_id, RecoveryAction::RollbackOperation)
            .await
            .unwrap();
        assert_eq!(
            backend.resolved.lock().unwrap().as_slice(),
            &[(candidate.operation_id, RecoveryAction::RollbackOperation)]
        );
    });
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}
