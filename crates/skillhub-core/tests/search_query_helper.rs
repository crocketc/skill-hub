use async_trait::async_trait;
use serde_json::json;
use skillhub_core::application::SearchQueryService;
use skillhub_core::llm::{CredentialRef, LlmProfile, LlmTaskResponse, LlmTaskRunner};
use skillhub_core::{AppResult, ErrorCode};

struct Runner;

#[async_trait(?Send)]
impl LlmTaskRunner for Runner {
    async fn run(
        &self,
        _profile: &LlmProfile,
        request: skillhub_core::llm::LlmTaskRequest,
    ) -> AppResult<LlmTaskResponse> {
        Ok(LlmTaskResponse {
            request_id: "query-request".into(),
            kind: request.kind,
            output: json!({"query": "PDF extraction", "source_filters": ["github"]}),
        })
    }
}

#[test]
fn missing_llm_disables_online_query_helper() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let service = SearchQueryService::new(Runner);
            let error = service.generate("PDF", None).await.unwrap_err();
            assert_eq!(error.code, ErrorCode::LlmNotConfigured);
        });
}

#[test]
fn query_helper_returns_text_and_filters_without_fetching_sources() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let profile = LlmProfile::new(
                "provider",
                "https://api.example.test/v1/chat/completions",
                "model",
                Some(CredentialRef::new("credential")),
            )
            .unwrap();
            let result = SearchQueryService::new(Runner)
                .generate("PDF", Some(&profile))
                .await
                .unwrap();
            assert_eq!(result.query, "PDF extraction");
            assert_eq!(result.source_filters, vec!["github"]);
        });
}
