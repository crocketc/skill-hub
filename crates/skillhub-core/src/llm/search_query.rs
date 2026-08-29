use serde::Deserialize;
use serde_json::Value;

use super::model::{LlmTaskKind, LlmTaskRequest};
use crate::{AppError, AppResult, ErrorCode, Severity};

const SEARCH_QUERY_SCHEMA: &str = r#"{
  "type":"object",
  "additionalProperties":false,
  "required":["query","source_filters"],
  "properties":{
    "query":{"type":"string"},
    "source_filters":{"type":"array","items":{"type":"string"}}
  }
}"#;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, serde::Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SearchQuerySuggestion {
    pub query: String,
    pub source_filters: Vec<String>,
}

pub fn build_search_query_request(text: &str) -> AppResult<LlmTaskRequest> {
    let schema: Value = serde_json::from_str(SEARCH_QUERY_SCHEMA)
        .map_err(|_| AppError::new(ErrorCode::InternalError, Severity::Error))?;
    LlmTaskRequest::new(
        LlmTaskKind::SearchQuery,
        format!(
            "Generate a concise online Skill search query from the quoted user text. Return only a query and optional source filters; do not fetch anything.\n<USER_QUERY>\n{text}\n</USER_QUERY>"
        ),
        schema,
    )
}

pub fn parse_search_query_response(response: Value) -> AppResult<SearchQuerySuggestion> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Response {
        query: String,
        source_filters: Vec<String>,
    }
    let parsed: Response = serde_json::from_value(response)
        .map_err(|_| AppError::new(ErrorCode::LlmInvalidStructuredResponse, Severity::Error))?;
    if parsed.query.trim().is_empty() {
        return Err(AppError::new(
            ErrorCode::LlmInvalidStructuredResponse,
            Severity::Error,
        ));
    }
    Ok(SearchQuerySuggestion {
        query: parsed.query,
        source_filters: parsed.source_filters,
    })
}
