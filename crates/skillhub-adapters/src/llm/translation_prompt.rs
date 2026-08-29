use skillhub_core::llm::translation::build_translation_request as build_core_request;
use skillhub_core::llm::LlmTaskRequest;
use skillhub_core::AppResult;

/// Builds the fixed translation prompt with Skill text delimited as data.
pub fn build_translation_request(description: &str, language: &str) -> AppResult<LlmTaskRequest> {
    build_core_request(description, language)
}
