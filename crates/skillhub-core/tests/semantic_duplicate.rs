use async_trait::async_trait;
use serde_json::json;
use skillhub_core::application::{DuplicateCandidateProvider, DuplicateService};
use skillhub_core::duplicate::{CoverageRelation, DuplicateCandidate, RetentionRecommendation};
use skillhub_core::llm::{CredentialRef, LlmProfile, LlmTaskResponse, LlmTaskRunner};
use skillhub_core::{AppResult, SkillId};
use std::str::FromStr;
use std::sync::{Arc, Mutex};

struct Candidates {
    items: Vec<DuplicateCandidate>,
}

#[async_trait(?Send)]
impl DuplicateCandidateProvider for Candidates {
    async fn candidates(&self, _skill_id: SkillId) -> AppResult<Vec<DuplicateCandidate>> {
        Ok(self.items.clone())
    }
}

struct RecordingRunner {
    candidate_count: Arc<Mutex<usize>>,
}

#[async_trait(?Send)]
impl LlmTaskRunner for RecordingRunner {
    async fn run(
        &self,
        _profile: &LlmProfile,
        request: skillhub_core::llm::LlmTaskRequest,
    ) -> AppResult<LlmTaskResponse> {
        self.candidate_count
            .lock()
            .unwrap()
            .clone_from(&request.input.matches("skill_id").count());
        Ok(LlmTaskResponse {
            request_id: "request-duplicate".into(),
            kind: request.kind,
            output: json!({"relations": [{"skill_a": "00000000-0000-0000-0000-00000000000a", "skill_b": "00000000-0000-0000-0000-00000000000b", "coverage": "a_contains_b", "shared_abilities": ["pdf extraction"], "unique_a": ["batch mode"], "unique_b": [], "evidence": ["same trigger and output"], "recommendation": "keep_a"}]}),
        })
    }
}

#[test]
fn only_top_eight_candidates_are_sent_and_no_recommendation_is_applied() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let skill_a = SkillId::from_str("00000000-0000-0000-0000-00000000000a").unwrap();
            let skill_b = SkillId::from_str("00000000-0000-0000-0000-00000000000b").unwrap();
            let items = (0..10)
                .map(|index| DuplicateCandidate {
                    skill_id: if index == 0 { skill_a } else { skill_b },
                    name: format!("candidate-{index}"),
                    description: "extract PDF text".into(),
                    trigger: "when a PDF is provided".into(),
                    permissions: vec!["read files".into()],
                    source: "local".into(),
                    basic_check_state: "passed".into(),
                    locally_modified: false,
                })
                .collect();
            let count = Arc::new(Mutex::new(0));
            let service = DuplicateService::new(
                Candidates { items },
                RecordingRunner {
                    candidate_count: count.clone(),
                },
            );
            let profile = LlmProfile::new(
                "provider",
                "https://api.example.test/v1/chat/completions",
                "model",
                Some(CredentialRef::new("credential")),
            )
            .unwrap();
            let result = service.analyze(skill_a, &profile).await.unwrap();
            assert!(*count.lock().unwrap() <= 8);
            assert_eq!(result.relations[0].coverage, CoverageRelation::AContainsB);
            assert_eq!(
                result.relations[0].recommendation,
                RetentionRecommendation::KeepA
            );
            assert!(!result.applied_automatically);
        });
}

struct FailingRunner;

#[async_trait(?Send)]
impl LlmTaskRunner for FailingRunner {
    async fn run(
        &self,
        _profile: &LlmProfile,
        _request: skillhub_core::llm::LlmTaskRequest,
    ) -> AppResult<LlmTaskResponse> {
        Err(skillhub_core::AppError::llm_request_timeout(1_000))
    }
}

fn profile() -> LlmProfile {
    LlmProfile::new(
        "provider",
        "https://api.example.test/v1/chat/completions",
        "model",
        Some(CredentialRef::new("credential")),
    )
    .unwrap()
}

fn candidate(id: &str) -> DuplicateCandidate {
    DuplicateCandidate {
        skill_id: SkillId::from_str(id).unwrap(),
        name: "candidate".into(),
        description: "extract PDF text".into(),
        trigger: "when a PDF is provided".into(),
        permissions: vec![],
        source: "local".into(),
        basic_check_state: "unknown".into(),
        locally_modified: false,
    }
}

#[test]
fn llm_failure_keeps_the_deterministic_candidates_visible() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let anchor = SkillId::from_str("00000000-0000-0000-0000-00000000000a").unwrap();
            let service = DuplicateService::new(
                Candidates {
                    items: vec![
                        candidate("00000000-0000-0000-0000-00000000000a"),
                        candidate("00000000-0000-0000-0000-00000000000b"),
                    ],
                },
                FailingRunner,
            );
            let analysis = service
                .analyze(anchor, &profile())
                .await
                .expect("a failing LLM must not lose the deterministic layer");
            assert_eq!(analysis.candidate_count, 2);
            assert!(analysis.relations.is_empty());
            assert_eq!(
                analysis.source,
                skillhub_core::duplicate::DuplicateAnalysisSource::DeterministicOnly
            );
            assert_eq!(
                analysis.failure_code.as_deref(),
                Some("llm.request_timeout")
            );
            assert!(!analysis.applied_automatically);
            assert_eq!(analysis.candidates.len(), 2);
        });
}

#[test]
fn a_successful_analysis_carries_the_deterministic_candidates_too() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let anchor = SkillId::from_str("00000000-0000-0000-0000-00000000000a").unwrap();
            let service = DuplicateService::new(
                Candidates {
                    items: vec![
                        candidate("00000000-0000-0000-0000-00000000000a"),
                        candidate("00000000-0000-0000-0000-00000000000b"),
                    ],
                },
                RecordingRunner {
                    candidate_count: Arc::new(Mutex::new(0)),
                },
            );
            let analysis = service.analyze(anchor, &profile()).await.expect("analysis");
            assert_eq!(
                analysis.source,
                skillhub_core::duplicate::DuplicateAnalysisSource::Llm
            );
            assert_eq!(analysis.failure_code, None);
            assert_eq!(analysis.relations.len(), 1);
            assert_eq!(analysis.candidates.len(), 2);
        });
}

#[test]
fn without_candidates_no_llm_call_is_made() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let anchor = SkillId::from_str("00000000-0000-0000-0000-00000000000a").unwrap();
            let counter = Arc::new(Mutex::new(0));
            let service = DuplicateService::new(
                Candidates { items: vec![] },
                RecordingRunner {
                    candidate_count: counter.clone(),
                },
            );
            let analysis = service
                .analyze(anchor, &profile())
                .await
                .expect("empty analysis");
            assert_eq!(analysis.candidate_count, 0);
            assert_eq!(
                analysis.source,
                skillhub_core::duplicate::DuplicateAnalysisSource::DeterministicOnly
            );
            assert_eq!(analysis.failure_code, None);
            assert_eq!(*counter.lock().unwrap(), 0, "no candidates, no LLM call");
        });
}
