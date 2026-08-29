use async_trait::async_trait;
use skillhub_core::evidence::{EvidenceProvider, UsageEvidence};
use skillhub_core::AppResult;
use std::sync::{Arc, Mutex};

/// Local, explicit evidence rows supplied by integrations. It intentionally
/// does not scrape Agent conversations or claim complete runtime coverage.
#[derive(Clone, Default)]
pub struct UsageEvidenceRepository {
    records: Arc<Mutex<Vec<UsageEvidence>>>,
}

impl UsageEvidenceRepository {
    pub fn new(records: Vec<UsageEvidence>) -> Self {
        Self {
            records: Arc::new(Mutex::new(records)),
        }
    }

    pub fn replace(&self, records: Vec<UsageEvidence>) {
        *self.records.lock().expect("evidence repository lock") = records;
    }
}

#[async_trait(?Send)]
impl EvidenceProvider for UsageEvidenceRepository {
    async fn collect(&self, _window_days: u32) -> AppResult<Vec<UsageEvidence>> {
        Ok(self
            .records
            .lock()
            .expect("evidence repository lock")
            .clone())
    }
}
