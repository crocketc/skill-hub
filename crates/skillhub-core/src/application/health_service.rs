use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;

use crate::health::{HealthFinding, HealthReport, RepairPlan};
use crate::{AppError, AppResult, ErrorCode, OperationId, RecoveryAction, Severity};

#[async_trait]
pub trait HealthBackend: Send + Sync {
    async fn check(&self) -> AppResult<Vec<HealthFinding>>;
    async fn repair(&self, finding: &HealthFinding) -> AppResult<()>;
}

pub struct HealthService<B> {
    backend: Arc<B>,
    reports: tokio::sync::Mutex<HashMap<OperationId, HealthReport>>,
    prepared: tokio::sync::Mutex<HashMap<OperationId, RepairPlan>>,
}

impl<B> HealthService<B>
where
    B: HealthBackend + 'static,
{
    pub fn new(backend: Arc<B>) -> Self {
        Self {
            backend,
            reports: tokio::sync::Mutex::new(HashMap::new()),
            prepared: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    pub async fn run(&self) -> AppResult<HealthReport> {
        let report = HealthReport {
            id: OperationId::new(),
            findings: self.backend.check().await?,
        };
        self.reports.lock().await.insert(report.id, report.clone());
        Ok(report)
    }

    pub async fn repair(&self, report_id: OperationId, index: usize) -> AppResult<()> {
        let plan = self
            .prepare_repair(
                report_id,
                u32::try_from(index).map_err(|_| not_found("health_finding"))?,
            )
            .await?;
        self.commit_repair(plan.id).await
    }

    pub async fn prepare_repair(
        &self,
        report_id: OperationId,
        finding_index: u32,
    ) -> AppResult<RepairPlan> {
        let finding = self
            .reports
            .lock()
            .await
            .get(&report_id)
            .and_then(|report| report.findings.get(finding_index as usize))
            .cloned()
            .ok_or_else(|| not_found("health_finding"))?;
        let plan = RepairPlan {
            id: OperationId::new(),
            report_id,
            finding_index,
            finding,
        };
        self.prepared.lock().await.insert(plan.id, plan.clone());
        Ok(plan)
    }

    pub async fn commit_repair(&self, repair_id: OperationId) -> AppResult<()> {
        let plan = self
            .prepared
            .lock()
            .await
            .get(&repair_id)
            .cloned()
            .ok_or_else(|| not_found("repair_plan"))?;
        self.backend.repair(&plan.finding).await?;
        self.prepared.lock().await.remove(&repair_id);
        Ok(())
    }
}

fn not_found(field: &str) -> AppError {
    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
        .with_param("field", field)
        .with_action(RecoveryAction::Retry)
}
