use async_trait::async_trait;
use skillhub_core::evidence::{EvidenceProvider, UsageEvidence};
use skillhub_core::AppResult;

/// Adapter for explicit local records supplied by a future Agent runtime hook.
/// No raw conversation parsing or implicit runtime claims are made here.
pub struct ExplicitLocalEvidenceProvider {
    records: Vec<UsageEvidence>,
}

impl ExplicitLocalEvidenceProvider {
    pub fn new(records: Vec<UsageEvidence>) -> Self {
        Self { records }
    }
}

#[async_trait(?Send)]
impl EvidenceProvider for ExplicitLocalEvidenceProvider {
    async fn collect(&self, _window_days: u32) -> AppResult<Vec<UsageEvidence>> {
        Ok(self.records.clone())
    }
}
