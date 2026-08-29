use async_trait::async_trait;
use skillhub_core::application::{DeploymentBackend, DeploymentService};
use skillhub_core::deployment::{
    DeploymentMode, DeploymentPlan, DeploymentRecord, DeploymentState, TargetChange, TargetPlan,
};
use skillhub_core::{AppError, AppResult, DeploymentId, ErrorCode, Severity, SkillId, VersionId};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct RecordingDeploymentBackend {
    applied: Mutex<Vec<String>>,
    fail_target: Option<String>,
}

#[async_trait]
impl DeploymentBackend for RecordingDeploymentBackend {
    async fn revalidate(&self, plan: &DeploymentPlan) -> AppResult<DeploymentPlan> {
        Ok(plan.clone())
    }

    async fn apply_target(&self, target: &TargetPlan) -> AppResult<DeploymentRecord> {
        if self.fail_target.as_deref() == Some(target.physical_target_id.as_str()) {
            return Err(AppError::new(ErrorCode::InternalError, Severity::Error));
        }
        self.applied
            .lock()
            .unwrap()
            .push(target.physical_target_id.clone());
        Ok(DeploymentRecord {
            id: DeploymentId::new(),
            skill_id: target.skill_id,
            version_id: target.version_id.clone(),
            target_id: target.physical_target_id.clone(),
            state: DeploymentState::Deployed,
            mode: target.mode,
            managed: true,
            runtime_name: target.runtime_name.clone(),
            expected_hash: "sha256:tree".into(),
            observed_hash: Some("sha256:tree".into()),
        })
    }
}

fn plan() -> DeploymentPlan {
    let skill_id = SkillId::new();
    let version_id =
        VersionId::parse("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .unwrap();
    let target = |id: &str| TargetPlan {
        physical_target_id: id.into(),
        logical_target_ids: vec![id.into()],
        target_path: format!("C:/agents/{id}"),
        destination_path: format!("C:/agents/{id}/notes"),
        source_path: "C:/skillhub/notes".into(),
        runtime_name: "notes".into(),
        skill_id,
        version_id: version_id.clone(),
        mode: DeploymentMode::ManagedCopy,
        change: TargetChange::Create,
        warnings: vec![],
        conflicts: vec![],
    };
    DeploymentPlan {
        skill_id,
        version_id: version_id.clone(),
        runtime_name: "notes".into(),
        mode: DeploymentMode::ManagedCopy,
        targets: vec![target("codex"), target("claude")],
        warnings: vec![],
        conflicts: vec![],
    }
}

#[test]
fn committed_deployment_links_selected_version_and_records_relation() {
    block_on(async {
        let backend = Arc::new(RecordingDeploymentBackend::default());
        let service = DeploymentService::new(backend.clone());
        let prepared = service.prepare(plan()).await.unwrap();
        let result = service.commit(prepared.id).await.unwrap();
        assert_eq!(
            result.targets[0].status,
            skillhub_core::TargetOperationStatus::Succeeded
        );
        assert_eq!(result.targets[0].version_id, result.version_id);
        assert_eq!(backend.applied.lock().unwrap().len(), 2);
    });
}

#[test]
fn batch_keeps_success_and_reports_failed_target_separately() {
    block_on(async {
        let backend = Arc::new(RecordingDeploymentBackend {
            fail_target: Some("claude".into()),
            ..Default::default()
        });
        let service = DeploymentService::new(backend.clone());
        let prepared = service.prepare(plan()).await.unwrap();
        let result = service.commit(prepared.id).await.unwrap();
        assert_eq!(
            result.targets[0].status,
            skillhub_core::TargetOperationStatus::Succeeded
        );
        assert_eq!(
            result.targets[1].status,
            skillhub_core::TargetOperationStatus::Failed
        );
        assert_eq!(backend.applied.lock().unwrap().as_slice(), &["codex"]);
    });
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}
