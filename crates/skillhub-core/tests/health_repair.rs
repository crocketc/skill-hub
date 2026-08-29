use async_trait::async_trait;
use skillhub_core::application::{HealthBackend, HealthService};
use skillhub_core::{HealthFinding, RepairAction, Severity};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct FakeHealthBackend {
    findings: Vec<HealthFinding>,
    repaired: Arc<Mutex<Vec<RepairAction>>>,
}

#[async_trait]
impl HealthBackend for FakeHealthBackend {
    async fn check(&self) -> skillhub_core::AppResult<Vec<HealthFinding>> {
        Ok(self.findings.clone())
    }

    async fn repair(&self, finding: &HealthFinding) -> skillhub_core::AppResult<()> {
        self.repaired.lock().unwrap().push(finding.repair);
        Ok(())
    }
}

#[test]
fn health_check_reports_orphan_manifest_and_repairs_only_that_finding() {
    block_on(async {
        let backend = FakeHealthBackend {
            findings: vec![HealthFinding {
                code: "health.orphan_manifest".into(),
                severity: Severity::Warning,
                repair: RepairAction::RemoveOrphanMetadata,
            }],
            repaired: Arc::new(Mutex::new(Vec::new())),
        };
        let service = HealthService::new(Arc::new(backend.clone()));
        let report = service.run().await.unwrap();
        assert_eq!(report.findings[0].code, "health.orphan_manifest");
        assert_eq!(
            report.findings[0].repair,
            RepairAction::RemoveOrphanMetadata
        );
        let repair_plan = service.prepare_repair(report.id, 0).await.unwrap();
        assert_eq!(repair_plan.finding.code, "health.orphan_manifest");
        service.commit_repair(repair_plan.id).await.unwrap();
        assert_eq!(
            backend.repaired.lock().unwrap().as_slice(),
            &[RepairAction::RemoveOrphanMetadata]
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
