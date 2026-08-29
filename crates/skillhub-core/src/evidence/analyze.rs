use async_trait::async_trait;
use std::collections::{BTreeMap, BTreeSet};

use super::model::{
    EvidenceCoverage, GlobalSkillRecommendation, GlobalSkillSuggestion, UsageEvidence,
    UsageEvidenceAnalysis,
};
use crate::{AppResult, SkillId};

#[async_trait(?Send)]
pub trait EvidenceProvider: Send + Sync {
    async fn collect(&self, window_days: u32) -> AppResult<Vec<UsageEvidence>>;
}

pub struct UsageEvidenceAnalyzer<P> {
    provider: P,
}

impl<P> UsageEvidenceAnalyzer<P>
where
    P: EvidenceProvider,
{
    pub fn new(provider: P) -> Self {
        Self { provider }
    }

    pub async fn analyze(
        &self,
        window_days: u32,
        threshold_calls: u32,
    ) -> AppResult<UsageEvidenceAnalysis> {
        let records = self.provider.collect(window_days).await?;
        let mut calls: BTreeMap<String, (SkillId, u32)> = BTreeMap::new();
        let mut sources = BTreeSet::new();
        let mut complete = true;
        for record in records {
            calls
                .entry(record.skill_id.to_string())
                .and_modify(|(_, total)| *total = total.saturating_add(record.calls))
                .or_insert((record.skill_id, record.calls));
            sources.insert(record.source);
            complete &= record.complete;
        }
        let suggestions = calls
            .into_iter()
            .map(|(_, (skill_id, total))| {
                let recommendation = if total < threshold_calls {
                    GlobalSkillRecommendation::ConsiderMoving
                } else {
                    GlobalSkillRecommendation::KeepInGlobal
                };
                let reason = match recommendation {
                    GlobalSkillRecommendation::ConsiderMoving => {
                        "Observed calls are below the configured threshold in the available evidence window."
                    }
                    GlobalSkillRecommendation::KeepInGlobal => {
                        "Observed calls meet the configured threshold in the available evidence window."
                    }
                };
                GlobalSkillSuggestion {
                    skill_id,
                    calls: total,
                    recommendation,
                    reason: reason.to_owned(),
                    applied_automatically: false,
                }
            })
            .collect();
        Ok(UsageEvidenceAnalysis {
            experimental: true,
            window_days,
            threshold_calls,
            coverage: EvidenceCoverage {
                sources: sources.into_iter().collect(),
                complete,
            },
            suggestions,
        })
    }
}
