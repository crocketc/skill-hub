use skillhub_core::duplicate::{build_duplicate_request as build_core_request, DuplicateCandidate};
use skillhub_core::llm::LlmTaskRequest;
use skillhub_core::AppResult;

/// Builds the fixed, read-only semantic duplicate comparison request.
pub fn build_duplicate_request(candidates: &[DuplicateCandidate]) -> AppResult<LlmTaskRequest> {
    build_core_request(candidates)
}
