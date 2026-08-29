use skillhub_core::llm::{safety::build_safety_request as build_core_request, LlmTaskRequest};
use skillhub_core::AppResult;

/// Builds the fixed safety prompt. Skill text is always delimited as evidence,
/// never interpolated into runner instructions or tool definitions.
pub fn build_safety_request(evidence: &str) -> AppResult<LlmTaskRequest> {
    build_core_request(evidence)
}
