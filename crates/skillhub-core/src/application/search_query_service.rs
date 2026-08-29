use crate::llm::search_query::{
    build_search_query_request, parse_search_query_response, SearchQuerySuggestion,
};
use crate::llm::{LlmProfile, LlmTaskRunner};
use crate::{AppError, AppResult, ErrorCode, Severity};

pub struct SearchQueryService<T> {
    runner: T,
}

impl<T> SearchQueryService<T>
where
    T: LlmTaskRunner,
{
    pub fn new(runner: T) -> Self {
        Self { runner }
    }

    pub async fn generate(
        &self,
        text: &str,
        profile: Option<&LlmProfile>,
    ) -> AppResult<SearchQuerySuggestion> {
        let profile =
            profile.ok_or_else(|| AppError::new(ErrorCode::LlmNotConfigured, Severity::Info))?;
        let response = self
            .runner
            .run(profile, build_search_query_request(text)?)
            .await?;
        parse_search_query_response(response.output)
    }
}
