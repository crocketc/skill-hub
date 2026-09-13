//! Contract tests for the protocol layer and the request planner.
//!
//! Everything asserted here is offline: a "plan" is the URL, headers and body
//! that *would* be sent, so supplier differences are proven without a live
//! service and without a credential.

use serde_json::{json, Value};
use skillhub_adapters::llm::protocol::{adapter_for, derive_model_list_candidates};
use skillhub_adapters::llm::{
    parse_structured_content, plan_request, LlmRequestPlan, ResponseExpectation,
};
use skillhub_core::llm::{
    CredentialRef, CustomHeader, LlmCompatibilityProfile, LlmDeployment, LlmProfile,
    LlmProtocolFamily, LlmStructuredOutputStrategy, LlmTaskKind, LlmTaskRequest,
};
use skillhub_core::ErrorCode;

fn profile(protocol: LlmProtocolFamily, endpoint: &str) -> LlmProfile {
    LlmProfile::new(
        "acme",
        endpoint,
        "acme-chat",
        Some(CredentialRef::new("cred-1")),
    )
    .unwrap()
    .with_protocol(protocol)
    .unwrap()
}

fn supplier(compatibility: LlmCompatibilityProfile, endpoint: &str) -> LlmProfile {
    let mut profile = profile(LlmProtocolFamily::OpenAiCompatible, endpoint);
    profile.compatibility_profile = compatibility;
    profile
}

fn request() -> LlmTaskRequest {
    LlmTaskRequest::new(
        LlmTaskKind::Translation,
        "Translate only the quoted Skill description.".into(),
        json!({"type": "object", "properties": {"translation": {"type": "string"}}}),
    )
    .unwrap()
}

fn structured_plan(profile: &LlmProfile, credential: Option<&str>) -> LlmRequestPlan {
    let request = request();
    plan_request(
        profile,
        credential,
        &request,
        ResponseExpectation::Structured {
            schema: request.response_schema.clone(),
        },
    )
    .unwrap()
}

fn text_plan(profile: &LlmProfile, credential: Option<&str>) -> LlmRequestPlan {
    let request = request();
    plan_request(profile, credential, &request, ResponseExpectation::Text).unwrap()
}

fn header<'a>(plan: &'a LlmRequestPlan, name: &str) -> &'a str {
    plan.headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
        .unwrap_or("")
}

// ---------------------------------------------------------------------------
// Transport shape: URL, authentication and envelope per protocol.
// ---------------------------------------------------------------------------

#[test]
fn openai_family_uses_bearer_and_json_schema_response_format() {
    let mut full_url = profile(
        LlmProtocolFamily::OpenAi,
        "https://api.example.test/v1/chat/completions",
    );
    full_url.compatibility_profile = LlmCompatibilityProfile::OpenAi;
    let plan = structured_plan(&full_url, Some("sk-test"));
    assert_eq!(plan.url, "https://api.example.test/v1/chat/completions");
    assert_eq!(header(&plan, "Authorization"), "Bearer sk-test");
    assert!(plan.body["tools"].is_null());
    assert_eq!(plan.body["response_format"]["type"], "json_schema");
    assert_eq!(
        plan.body["response_format"]["json_schema"]["strict"],
        json!(true)
    );
    assert_eq!(plan.body["temperature"], json!(0));

    // A base URL without the chat path gets it appended so presets can ship
    // base endpoints.
    let base = profile(
        LlmProtocolFamily::OpenAiCompatible,
        "https://api.deepseek.test/v1",
    );
    let plan = structured_plan(&base, Some("sk-test"));
    assert_eq!(plan.url, "https://api.deepseek.test/v1/chat/completions");
}

#[test]
fn local_profiles_send_no_authorization_header_and_keep_custom_headers() {
    // Build with an https loopback endpoint first, then switch the deployment
    // to local, which unlocks plain http on loopback addresses.
    let mut local = profile(
        LlmProtocolFamily::OpenAiCompatible,
        "https://127.0.0.1:11434/v1",
    );
    local.deployment = LlmDeployment::Local;
    local.endpoint = "http://127.0.0.1:11434/v1".into();
    local.credential_ref = None;
    local.validate().unwrap();
    local
        .custom_headers
        .push(CustomHeader::new("X-Tracing", "trace-1", false).expect("header"));

    let plan = structured_plan(&local, None);
    assert_eq!(header(&plan, "Authorization"), "");
    assert_eq!(header(&plan, "X-Tracing"), "trace-1");
}

#[test]
fn local_openai_compatible_base_url_without_version_uses_v1_chat_path() {
    let mut local = profile(LlmProtocolFamily::OpenAiCompatible, "http://127.0.0.1:1234");
    local.deployment = LlmDeployment::Local;

    let plan = structured_plan(&local, None);

    assert_eq!(plan.url, "http://127.0.0.1:1234/v1/chat/completions");
}

#[test]
fn openai_responses_uses_the_responses_suffix_and_text_format_schema() {
    let mut base = profile(
        LlmProtocolFamily::OpenAiResponses,
        "https://gateway.test/v1",
    );
    base.compatibility_profile = LlmCompatibilityProfile::OpenAi;

    let plan = structured_plan(&base, Some("sk-test"));

    assert_eq!(plan.url, "https://gateway.test/v1/responses");
    assert_eq!(header(&plan, "Authorization"), "Bearer sk-test");
    assert_eq!(plan.body["text"]["format"]["type"], json!("json_schema"));
    assert!(plan.body["input"].is_array());
}

#[test]
fn anthropic_uses_x_api_key_version_header_and_message_payload() {
    let mut base = profile(LlmProtocolFamily::Anthropic, "https://api.anthropic.test");
    base.compatibility_profile = LlmCompatibilityProfile::Anthropic;

    let plan = structured_plan(&base, Some("sk-ant"));
    assert_eq!(plan.url, "https://api.anthropic.test/v1/messages");
    assert_eq!(header(&plan, "x-api-key"), "sk-ant");
    assert!(!header(&plan, "anthropic-version").is_empty());
    assert!(plan.body["response_format"].is_null());
    assert!(plan.body["max_tokens"].is_u64());
    assert!(plan.body["messages"].is_array());
    // The schema travels in the prompt so the reply can be validated locally.
    assert!(plan.body.to_string().contains("schema"));

    // An endpoint that already includes /messages is kept verbatim.
    let mut explicit = profile(
        LlmProtocolFamily::Anthropic,
        "https://gateway.test/anthropic/v1/messages",
    );
    explicit.compatibility_profile = LlmCompatibilityProfile::Anthropic;
    let plan = structured_plan(&explicit, Some("sk-ant"));
    assert_eq!(plan.url, "https://gateway.test/anthropic/v1/messages");
}

#[test]
fn gemini_uses_api_key_header_and_generate_content_shape() {
    let mut base = profile(LlmProtocolFamily::Gemini, "https://generativelanguage.test");
    base.compatibility_profile = LlmCompatibilityProfile::Gemini;

    let plan = structured_plan(&base, Some("g-key"));
    assert_eq!(
        plan.url,
        "https://generativelanguage.test/v1beta/models/acme-chat:generateContent"
    );
    assert_eq!(header(&plan, "x-goog-api-key"), "g-key");
    assert_eq!(
        plan.body["generationConfig"]["responseMimeType"],
        json!("application/json")
    );
    assert!(plan.body["contents"].is_array());
}

#[test]
fn azure_uses_deployment_path_and_api_key_header() {
    let mut base = profile(
        LlmProtocolFamily::AzureOpenAi,
        "https://acme.openai.azure.test",
    );
    base.compatibility_profile = LlmCompatibilityProfile::AzureOpenAi;

    let plan = structured_plan(&base, Some("az-key"));
    assert!(plan.url.starts_with(
        "https://acme.openai.azure.test/openai/deployments/acme-chat/chat/completions"
    ));
    assert!(plan.url.contains("api-version="));
    assert_eq!(header(&plan, "api-key"), "az-key");
    // Azure addresses its deployment through the URL; a body model is invalid.
    assert!(plan.body["model"].is_null());
}

// ---------------------------------------------------------------------------
// The planner: same protocol, different supplier, different request.
// ---------------------------------------------------------------------------

#[test]
fn same_protocol_different_suppliers_get_different_request_parameters() {
    // OpenAI and DeepSeek both speak OpenAI Chat, yet their structured output
    // and reasoning parameters must not be forced to be identical.
    let openai = structured_plan(
        &supplier(
            LlmCompatibilityProfile::OpenAi,
            "https://api.openai.test/v1",
        ),
        Some("sk-test"),
    );
    let deepseek = structured_plan(
        &supplier(
            LlmCompatibilityProfile::DeepSeek,
            "https://api.deepseek.test/v1",
        ),
        Some("sk-test"),
    );

    assert_eq!(openai.body["response_format"]["type"], "json_schema");
    assert_eq!(
        openai.body["response_format"]["json_schema"]["strict"],
        json!(true)
    );
    assert!(openai.body["thinking"].is_null());
    assert!(openai.body["reasoning"].is_null());

    assert_eq!(deepseek.body["response_format"]["type"], "json_object");
    assert!(
        deepseek.body["response_format"]["json_schema"].is_null(),
        "DeepSeek Chat must never receive a strict JSON Schema"
    );
    assert_eq!(deepseek.body["thinking"], json!({"type": "disabled"}));

    // The Responses surface of the same supplier uses the effort dial instead.
    let mut responses = supplier(
        LlmCompatibilityProfile::DeepSeek,
        "https://api.deepseek.test/v1",
    );
    responses = responses
        .with_protocol(LlmProtocolFamily::OpenAiResponses)
        .unwrap();
    let plan = structured_plan(&responses, Some("sk-test"));
    assert_eq!(plan.body["text"]["format"]["type"], "json_object");
    assert_eq!(plan.body["reasoning"], json!({"effort": "none"}));
    assert!(plan.body["thinking"].is_null());
}

#[test]
fn a_text_plan_carries_no_structured_output_and_no_schema() {
    let plan = text_plan(
        &supplier(
            LlmCompatibilityProfile::OpenAi,
            "https://api.openai.test/v1",
        ),
        Some("sk-test"),
    );
    assert!(plan.body["response_format"].is_null());
    assert!(plan.body["text"].is_null());
    assert!(plan.body["thinking"].is_null());
    let serialized = plan.body.to_string();
    assert!(!serialized.contains("json_schema"));
    assert!(
        !serialized.contains("\"schema\""),
        "a text probe must not carry a structured instruction: {serialized}"
    );
    assert_eq!(expectation_is_text(&plan), true);

    // A prompt-only transport likewise sends nothing structured for text.
    let mut anthropic = profile(LlmProtocolFamily::Anthropic, "https://api.anthropic.test");
    anthropic.compatibility_profile = LlmCompatibilityProfile::Anthropic;
    let plan = text_plan(&anthropic, Some("sk-ant"));
    assert!(plan.body["system"].is_null());
}

fn expectation_is_text(plan: &LlmRequestPlan) -> bool {
    matches!(plan.expectation, ResponseExpectation::Text)
}

#[test]
fn structured_plan_follows_the_capability_strategy_not_the_protocol() {
    // A conservative default for user-supplied endpoints: JSON object, never a
    // strict schema the endpoint may reject.
    let generic = structured_plan(
        &supplier(LlmCompatibilityProfile::Generic, "https://unknown.test/v1"),
        Some("sk-test"),
    );
    assert_eq!(
        generic.policy.structured_output,
        LlmStructuredOutputStrategy::JsonObject
    );
    assert_eq!(generic.body["response_format"]["type"], "json_object");

    // Anthropic has no native structured field: prompt + local validation.
    let mut anthropic = profile(LlmProtocolFamily::Anthropic, "https://api.anthropic.test");
    anthropic.compatibility_profile = LlmCompatibilityProfile::Anthropic;
    let plan = structured_plan(&anthropic, Some("sk-ant"));
    assert_eq!(
        plan.policy.structured_output,
        LlmStructuredOutputStrategy::PromptedJson
    );
    assert!(plan.body["response_format"].is_null());
    assert!(plan.body["system"].as_str().unwrap().contains("Schema"));

    // Gemini uses its native mime type + schema.
    let mut gemini = profile(LlmProtocolFamily::Gemini, "https://generativelanguage.test");
    gemini.compatibility_profile = LlmCompatibilityProfile::Gemini;
    let plan = structured_plan(&gemini, Some("g-key"));
    assert_eq!(
        plan.policy.structured_output,
        LlmStructuredOutputStrategy::GeminiSchema
    );
    assert_eq!(
        plan.body["generationConfig"]["responseSchema"]["type"],
        "object"
    );
    assert!(plan.body["response_format"].is_null());
}

#[test]
fn a_plan_never_carries_credential_material_in_its_body() {
    let plan = structured_plan(
        &supplier(
            LlmCompatibilityProfile::DeepSeek,
            "https://api.deepseek.test/v1",
        ),
        Some("sk-secret-value"),
    );
    assert!(
        !plan.body.to_string().contains("sk-secret-value"),
        "credential material belongs in headers, never in the body"
    );
    assert_eq!(header(&plan, "Authorization"), "Bearer sk-secret-value");
}

#[test]
fn an_impossible_capability_combination_fails_before_any_request() {
    // Anthropic cannot express OpenAI's native strict schema transport.
    let mut wrong = profile(LlmProtocolFamily::Gemini, "https://api.anthropic.test");
    wrong.compatibility_profile = LlmCompatibilityProfile::Anthropic;
    let request = request();
    let error = plan_request(
        &wrong,
        None,
        &request,
        ResponseExpectation::Structured {
            schema: request.response_schema.clone(),
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::LlmProtocolIncompatible);
}

// ---------------------------------------------------------------------------
// Response handling: extraction and parsing are separate failures.
// ---------------------------------------------------------------------------

#[test]
fn an_incompatible_envelope_and_unparseable_text_are_distinct_failures() {
    let openai = adapter_for(LlmProtocolFamily::OpenAi);
    assert_eq!(
        openai
            .extract_text(&json!({"unexpected": true}))
            .unwrap_err()
            .code,
        ErrorCode::LlmProtocolIncompatible
    );

    assert_eq!(
        parse_structured_content("I cannot help with that.", LlmTaskKind::Translation)
            .unwrap_err()
            .code,
        ErrorCode::LlmInvalidStructuredResponse
    );
    // A complete fenced block is a valid structured reply.
    assert_eq!(
        parse_structured_content("```json\n{\"ok\": true}\n```", LlmTaskKind::Translation)
            .unwrap()
            .get("ok"),
        Some(&Value::Bool(true))
    );
    // Empty text is an interrupted response, not invalid JSON.
    assert_eq!(
        parse_structured_content("   ", LlmTaskKind::Translation)
            .unwrap_err()
            .code,
        ErrorCode::LlmResponseInterrupted
    );
}

#[test]
fn model_list_candidates_cover_version_segments_and_protocols() {
    // Full OpenAI chat URL derives /v1/models.
    assert_eq!(
        derive_model_list_candidates("https://api.deepseek.test/v1/chat/completions", None),
        vec!["https://api.deepseek.test/v1/models".to_string()]
    );
    // Base URL with a version segment tries its own /models first.
    assert_eq!(
        derive_model_list_candidates("https://open.bigmodel.test/api/paas/v4", None),
        vec!["https://open.bigmodel.test/api/paas/v4/models".to_string(),]
    );
    // Base URL without version segment tries /v1/models then /models.
    let candidates = derive_model_list_candidates("https://gateway.test/api/anthropic", None);
    assert!(candidates.contains(&"https://gateway.test/v1/models".to_string()));
    assert!(candidates.contains(&"https://gateway.test/models".to_string()));
    // Explicit override wins and suppresses guessing.
    assert_eq!(
        derive_model_list_candidates(
            "https://api.deepseek.test/v1/chat/completions",
            Some("https://api.deepseek.test/models")
        ),
        vec!["https://api.deepseek.test/models".to_string()]
    );

    // Protocol-specific candidates.
    let anthropic = profile(LlmProtocolFamily::Anthropic, "https://api.anthropic.test");
    let candidates = adapter_for(LlmProtocolFamily::Anthropic).model_list_candidates(&anthropic);
    assert_eq!(
        candidates,
        vec!["https://api.anthropic.test/v1/models".to_string()]
    );

    let gemini = profile(LlmProtocolFamily::Gemini, "https://generativelanguage.test");
    let candidates = adapter_for(LlmProtocolFamily::Gemini).model_list_candidates(&gemini);
    assert_eq!(
        candidates,
        vec!["https://generativelanguage.test/v1beta/models".to_string()]
    );

    let azure = profile(
        LlmProtocolFamily::AzureOpenAi,
        "https://acme.openai.azure.test",
    );
    let candidates = adapter_for(LlmProtocolFamily::AzureOpenAi).model_list_candidates(&azure);
    assert!(
        candidates.is_empty(),
        "Azure has no public inference-plane model list; manual input is required"
    );
}

#[test]
fn text_and_model_extraction_understands_each_protocol_shape() {
    let openai = adapter_for(LlmProtocolFamily::OpenAi);
    let body = json!({"choices": [{"message": {"content": "{\"ok\": true}"}}]});
    assert_eq!(openai.extract_text(&body).unwrap(), "{\"ok\": true}");
    let models = json!({"data": [{"id": "m-b"}, {"id": "m-a"}]});
    assert_eq!(openai.extract_models(&models).unwrap(), vec!["m-a", "m-b"]);

    let responses = adapter_for(LlmProtocolFamily::OpenAiResponses);
    assert_eq!(
        responses
            .extract_text(&json!({"output_text": "{\"ok\": true}"}))
            .unwrap(),
        "{\"ok\": true}"
    );
    // A reasoning item precedes the message item in the output array; only the
    // message text is the answer.
    assert_eq!(
        responses
            .extract_text(&json!({"output": [
                {"type": "reasoning", "summary": []},
                {"type": "message", "content": [{"type": "output_text", "text": "{\"ok\": 1}"}]}
            ]}))
            .unwrap(),
        "{\"ok\": 1}"
    );

    let anthropic = adapter_for(LlmProtocolFamily::Anthropic);
    let body = json!({"content": [{"type": "text", "text": "{\"ok\": 1}"}]});
    assert_eq!(anthropic.extract_text(&body).unwrap(), "{\"ok\": 1}");
    assert_eq!(
        anthropic
            .extract_models(&json!({"data": [{"id": "claude-x"}]}))
            .unwrap(),
        vec!["claude-x"]
    );

    let gemini = adapter_for(LlmProtocolFamily::Gemini);
    let body = json!({"candidates": [{"content": {"parts": [{"text": "{\"ok\": 1}"}]}}]});
    assert_eq!(gemini.extract_text(&body).unwrap(), "{\"ok\": 1}");
    assert_eq!(
        gemini
            .extract_models(&json!({"models": [{"name": "models/gemini-x"}]}))
            .unwrap(),
        vec!["gemini-x"]
    );
}

#[test]
fn http_status_mapping_covers_the_error_taxonomy() {
    let adapter = adapter_for(LlmProtocolFamily::OpenAi);
    assert_eq!(
        adapter.map_status(401, "unauthorized").code,
        ErrorCode::LlmAuthFailed
    );
    assert_eq!(
        adapter.map_status(403, "forbidden").code,
        ErrorCode::LlmAuthFailed
    );
    assert_eq!(
        adapter.map_status(404, "missing").code,
        ErrorCode::LlmModelNotFound
    );
    assert_eq!(
        adapter.map_status(429, "slow down").code,
        ErrorCode::LlmRateLimited
    );
    assert_eq!(
        adapter.map_status(503, "down").code,
        ErrorCode::LlmServerError
    );
    assert_eq!(
        adapter.map_status(400, "bad request").code,
        ErrorCode::LlmProtocolIncompatible
    );
}
