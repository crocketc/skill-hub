use serde_json::json;
use skillhub_adapters::llm::protocol::{adapter_for, derive_model_list_candidates, ChatRequestDraft};
use skillhub_core::llm::{
    CredentialRef, CustomHeader, LlmDeployment, LlmProfile, LlmProtocolFamily, LlmTaskKind,
    LlmTaskRequest,
};
use skillhub_core::ErrorCode;

fn profile(protocol: LlmProtocolFamily, endpoint: &str) -> LlmProfile {
    LlmProfile::new("acme", endpoint, "acme-chat", Some(CredentialRef::new("cred-1")))
        .unwrap()
        .with_protocol(protocol)
        .unwrap()
}

fn request() -> LlmTaskRequest {
    LlmTaskRequest::new(
        LlmTaskKind::Translation,
        "Translate only the quoted Skill description.".into(),
        json!({"type": "object"}),
    )
    .unwrap()
}

fn header<'a>(draft: &'a ChatRequestDraft, name: &str) -> &'a str {
    draft
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
        .unwrap_or("")
}

#[test]
fn openai_family_uses_bearer_and_json_schema_response_format() {
    let adapter = adapter_for(LlmProtocolFamily::OpenAi);

    let full_url = profile(
        LlmProtocolFamily::OpenAi,
        "https://api.example.test/v1/chat/completions",
    );
    let draft = adapter
        .chat_request(&full_url, Some("sk-test"), &request())
        .unwrap();
    assert_eq!(draft.url, "https://api.example.test/v1/chat/completions");
    assert_eq!(header(&draft, "Authorization"), "Bearer sk-test");
    assert!(draft.body["tools"].is_null());
    assert_eq!(draft.body["response_format"]["type"], "json_schema");
    assert_eq!(draft.body["temperature"], json!(0));

    // A base URL without the chat path gets it appended so presets can ship
    // base endpoints.
    let base = profile(
        LlmProtocolFamily::OpenAiCompatible,
        "https://api.deepseek.test/v1",
    );
    let draft = adapter.chat_request(&base, Some("sk-test"), &request()).unwrap();
    assert_eq!(draft.url, "https://api.deepseek.test/v1/chat/completions");
}

#[test]
fn local_profiles_send_no_authorization_header_and_keep_custom_headers() {
    let adapter = adapter_for(LlmProtocolFamily::OpenAiCompatible);
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
    local.custom_headers.push(
        CustomHeader::new("X-Tracing", "trace-1", false).expect("header"),
    );

    let draft = adapter.chat_request(&local, None, &request()).unwrap();
    assert_eq!(header(&draft, "Authorization"), "");
    assert_eq!(header(&draft, "X-Tracing"), "trace-1");
}

#[test]
fn anthropic_uses_x_api_key_version_header_and_message_payload() {
    let adapter = adapter_for(LlmProtocolFamily::Anthropic);
    let base = profile(LlmProtocolFamily::Anthropic, "https://api.anthropic.test");

    let draft = adapter.chat_request(&base, Some("sk-ant"), &request()).unwrap();
    assert_eq!(draft.url, "https://api.anthropic.test/v1/messages");
    assert_eq!(header(&draft, "x-api-key"), "sk-ant");
    assert!(!header(&draft, "anthropic-version").is_empty());
    assert!(draft.body["response_format"].is_null());
    assert!(draft.body["max_tokens"].is_u64());
    assert!(draft.body["messages"].is_array());
    // The schema travels in the prompt so the reply can be validated locally.
    assert!(draft.body.to_string().contains("schema"));

    // An endpoint that already includes /messages is kept verbatim.
    let explicit = profile(
        LlmProtocolFamily::Anthropic,
        "https://gateway.test/anthropic/v1/messages",
    );
    let draft = adapter
        .chat_request(&explicit, Some("sk-ant"), &request())
        .unwrap();
    assert_eq!(draft.url, "https://gateway.test/anthropic/v1/messages");
}

#[test]
fn gemini_uses_api_key_header_and_generate_content_shape() {
    let adapter = adapter_for(LlmProtocolFamily::Gemini);
    let base = profile(LlmProtocolFamily::Gemini, "https://generativelanguage.test");

    let draft = adapter.chat_request(&base, Some("g-key"), &request()).unwrap();
    assert_eq!(
        draft.url,
        "https://generativelanguage.test/v1beta/models/acme-chat:generateContent"
    );
    assert_eq!(header(&draft, "x-goog-api-key"), "g-key");
    assert_eq!(
        draft.body["generationConfig"]["responseMimeType"],
        json!("application/json")
    );
    assert!(draft.body["contents"].is_array());
}

#[test]
fn azure_uses_deployment_path_and_api_key_header() {
    let adapter = adapter_for(LlmProtocolFamily::AzureOpenAi);
    let base = profile(LlmProtocolFamily::AzureOpenAi, "https://acme.openai.azure.test");

    let draft = adapter.chat_request(&base, Some("az-key"), &request()).unwrap();
    assert!(draft
        .url
        .starts_with("https://acme.openai.azure.test/openai/deployments/acme-chat/chat/completions"));
    assert!(draft.url.contains("api-version="));
    assert_eq!(header(&draft, "api-key"), "az-key");
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
        vec![
            "https://open.bigmodel.test/api/paas/v4/models".to_string(),
        ]
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
    let candidates = adapter_for(LlmProtocolFamily::Anthropic)
        .model_list_candidates(&anthropic);
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

    let azure = profile(LlmProtocolFamily::AzureOpenAi, "https://acme.openai.azure.test");
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

    // A body in the wrong shape is a protocol incompatibility, not a crash.
    assert_eq!(
        openai.extract_text(&json!({"unexpected": true})).unwrap_err().code,
        ErrorCode::LlmProtocolIncompatible
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
