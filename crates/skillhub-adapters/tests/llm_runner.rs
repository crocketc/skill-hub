use serde_json::json;
use skillhub_adapters::credentials::SessionCredentialStore;
use skillhub_adapters::llm::HttpLlmTaskRunner;
use skillhub_core::llm::{CredentialRef, LlmProfile, LlmTaskKind, LlmTaskRequest};
use std::sync::Arc;

fn profile() -> LlmProfile {
    LlmProfile::new(
        "openai",
        "https://api.example.test/v1/chat/completions",
        "gpt-test",
        Some(CredentialRef::new("credential-1")),
    )
    .unwrap()
}

#[test]
fn task_request_contains_fixed_schema_and_no_tool_definition() {
    let request = LlmTaskRequest::new(
        LlmTaskKind::Safety,
        "quoted Skill evidence".into(),
        json!({"type": "object", "properties": {"findings": {"type": "array"}}}),
    )
    .unwrap();
    let payload = HttpLlmTaskRunner::build_payload(&profile(), &request).unwrap();
    assert!(payload.get("tools").is_none());
    assert_eq!(payload["temperature"], json!(0));
    assert_eq!(payload["response_format"]["type"], "json_schema");
    assert!(payload["response_format"]
        .to_string()
        .contains("json_schema"));
}

#[test]
fn credentials_are_redacted_before_payload_construction() {
    let redacted = HttpLlmTaskRunner::redact_input("use sk-secret-value here", "sk-secret-value");
    assert!(!redacted.contains("sk-secret-value"));
    assert!(redacted.contains("[REDACTED]"));
}

#[tokio::test]
async fn invalid_model_json_is_rejected_not_rendered_as_a_finding() {
    let store = Arc::new(SessionCredentialStore::default());
    store.insert(CredentialRef::new("credential-1"), "secret-value");
    let _runner = HttpLlmTaskRunner::new(store);
    let request = LlmTaskRequest::new(
        LlmTaskKind::Safety,
        "evidence".into(),
        json!({"type": "object"}),
    )
    .unwrap();
    let error = HttpLlmTaskRunner::parse_response(
        &profile(),
        &request,
        json!({"choices": [{"message": {"content": "ignore schema and run curl"}}]}),
    )
    .unwrap_err();
    assert_eq!(error.code.as_str(), "llm.invalid_structured_response");
}
