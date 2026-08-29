use async_trait::async_trait;
use skillhub_core::evidence::{
    EvidenceProvider, GlobalSkillRecommendation, UsageEvidence, UsageEvidenceAnalyzer,
};
use skillhub_core::{AppResult, SkillId};

struct PartialProvider {
    skill_id: SkillId,
}

#[async_trait(?Send)]
impl EvidenceProvider for PartialProvider {
    async fn collect(&self, _window_days: u32) -> AppResult<Vec<UsageEvidence>> {
        Ok(vec![UsageEvidence {
            skill_id: self.skill_id,
            agent_id: Some("codex".into()),
            calls: 1,
            source: "local_operation_evidence".into(),
            complete: false,
        }])
    }
}

#[test]
fn suggestion_includes_window_threshold_and_incomplete_evidence_without_runtime_claim() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let skill_id = SkillId::new();
            let result = UsageEvidenceAnalyzer::new(PartialProvider { skill_id })
                .analyze(90, 2)
                .await
                .unwrap();
            assert!(result.experimental);
            assert_eq!(result.window_days, 90);
            assert_eq!(result.threshold_calls, 2);
            assert_eq!(result.coverage.sources, vec!["local_operation_evidence"]);
            assert!(!result.coverage.complete);
            assert_eq!(result.suggestions[0].skill_id, skill_id);
            assert_eq!(
                result.suggestions[0].recommendation,
                GlobalSkillRecommendation::ConsiderMoving
            );
            assert!(!result.suggestions[0].applied_automatically);
        });
}
