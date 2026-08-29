use async_trait::async_trait;
use skillhub_core::application::{ReconcileBackend, ReconcileService};
use skillhub_core::deployment::{DeploymentMode, DeploymentRecord, DeploymentState};
use skillhub_core::{
    AppError, AppResult, DeploymentId, ErrorCode, ExternalChangeState, SkillId, VersionId,
};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct FakeReconcileBackend {
    record: DeploymentRecord,
    state: ExternalChangeState,
    observed_hash: Option<String>,
    collected: Arc<Mutex<Vec<DeploymentId>>>,
    restored: Arc<Mutex<Vec<DeploymentId>>>,
    detached: Arc<Mutex<Vec<DeploymentId>>>,
    ignored: Arc<Mutex<Vec<DeploymentId>>>,
}

#[async_trait]
impl ReconcileBackend for FakeReconcileBackend {
    async fn get_deployment(&self, id: DeploymentId) -> AppResult<DeploymentRecord> {
        if self.record.id == id {
            Ok(self.record.clone())
        } else {
            Err(AppError::new(
                ErrorCode::ObjectNotFound,
                skillhub_core::Severity::Error,
            ))
        }
    }

    async fn inspect_target(
        &self,
        _deployment: &DeploymentRecord,
    ) -> AppResult<skillhub_core::ExternalChangeObservation> {
        Ok(skillhub_core::ExternalChangeObservation {
            state: self.state,
            observed_hash: self.observed_hash.clone(),
        })
    }

    async fn collect_target_changes(&self, deployment: &DeploymentRecord) -> AppResult<VersionId> {
        self.collected.lock().unwrap().push(deployment.id);
        VersionId::parse("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
            .map_err(|_| AppError::new(ErrorCode::InternalError, skillhub_core::Severity::Error))
    }

    async fn restore_target(&self, deployment: &DeploymentRecord) -> AppResult<()> {
        self.restored.lock().unwrap().push(deployment.id);
        Ok(())
    }

    async fn keep_independent(&self, deployment: &DeploymentRecord) -> AppResult<()> {
        self.detached.lock().unwrap().push(deployment.id);
        Ok(())
    }

    async fn ignore_external_change(&self, deployment: &DeploymentRecord) -> AppResult<()> {
        self.ignored.lock().unwrap().push(deployment.id);
        Ok(())
    }
}

fn deployed_record() -> DeploymentRecord {
    DeploymentRecord {
        id: DeploymentId::new(),
        skill_id: SkillId::new(),
        version_id: VersionId::parse(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap(),
        target_id: "target".into(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "notes".into(),
        expected_hash: "sha256:tree".into(),
        observed_hash: Some("sha256:tree".into()),
    }
}

fn service(
    state: ExternalChangeState,
) -> (ReconcileService<FakeReconcileBackend>, FakeReconcileBackend) {
    let backend = FakeReconcileBackend {
        record: deployed_record(),
        state,
        observed_hash: Some("sha256:changed".into()),
        collected: Arc::new(Mutex::new(Vec::new())),
        restored: Arc::new(Mutex::new(Vec::new())),
        detached: Arc::new(Mutex::new(Vec::new())),
        ignored: Arc::new(Mutex::new(Vec::new())),
    };
    (ReconcileService::new(Arc::new(backend.clone())), backend)
}

#[test]
fn changed_managed_copy_becomes_modified_and_collect_creates_new_version() {
    block_on(async {
        let (service, backend) = service(ExternalChangeState::Modified);
        let plan = service.plan(backend.record.id).await.unwrap();
        assert_eq!(plan.state, ExternalChangeState::Modified);
        assert!(plan
            .allowed_actions
            .contains(&skillhub_core::ReconcileAction::CollectChanges));

        let result = service.collect_changes(backend.record.id).await.unwrap();
        assert_eq!(result.state_before, ExternalChangeState::Modified);
        assert_eq!(
            result.version_id.unwrap().as_str(),
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );
        assert_eq!(
            backend.collected.lock().unwrap().as_slice(),
            &[backend.record.id]
        );
    });
}

#[test]
fn broken_link_is_reported_missing_and_not_silently_recreated() {
    block_on(async {
        let (service, backend) = service(ExternalChangeState::Missing);
        let plan = service.plan(backend.record.id).await.unwrap();
        assert_eq!(plan.state, ExternalChangeState::Missing);
        assert!(!plan
            .allowed_actions
            .contains(&skillhub_core::ReconcileAction::CollectChanges));
        assert!(backend.restored.lock().unwrap().is_empty());
    });
}

#[test]
fn keep_independent_and_ignore_are_explicit_actions() {
    block_on(async {
        let (service, backend) = service(ExternalChangeState::Modified);
        let detached = service.keep_independent(backend.record.id).await.unwrap();
        assert!(!detached.management_retained);
        assert_eq!(backend.detached.lock().unwrap().len(), 1);

        let ignored = service
            .ignore_external_change(backend.record.id)
            .await
            .unwrap();
        assert!(ignored.management_retained);
        assert_eq!(backend.ignored.lock().unwrap().len(), 1);
    });
}

#[test]
fn collecting_unchanged_or_missing_target_is_rejected() {
    block_on(async {
        for state in [ExternalChangeState::Unchanged, ExternalChangeState::Missing] {
            let (service, backend) = service(state);
            let error = service
                .collect_changes(backend.record.id)
                .await
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::OperationConflict);
        }
    });
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}
