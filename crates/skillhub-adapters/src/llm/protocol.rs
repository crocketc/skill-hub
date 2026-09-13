//! Vendor protocol adapters. A transport protocol owns exactly three things:
//! the generation URL derived from the base endpoint, the authentication
//! header, and the shape of the request/response envelope.
//!
//! It deliberately owns *nothing* about supplier behaviour. Which structured
//! output field to send (`response_format` vs `text.format` vs
//! `generationConfig`), whether strict mode is available, and whether
//! reasoning must be suppressed are resolved by
//! [`super::request_plan`] from the profile's capability policy and then
//! placed by the transport-specific functions at the bottom of this module.
//! That split is what stops one protocol from forcing every supplier onto the
//! same request parameters.

use serde_json::{json, Value};
use url::Url;

use skillhub_core::llm::{
    LlmDeployment, LlmProfile, LlmProtocolFamily, LlmReasoningPolicy, LlmStructuredOutputStrategy,
};
use skillhub_core::{AppError, AppResult};

pub trait ProtocolAdapter: Send + Sync {
    /// Builds the transport envelope: model identity, the user content and an
    /// optional system instruction. No structured-output, reasoning or
    /// credential field is added here.
    fn request_envelope(
        &self,
        profile: &LlmProfile,
        system: Option<&str>,
        user: &str,
    ) -> AppResult<Value>;

    /// The generation endpoint derived from the configured base URL.
    fn request_url(&self, profile: &LlmProfile) -> AppResult<String>;

    /// Auth + custom headers shared by chat and model-list requests.
    fn request_headers(
        &self,
        profile: &LlmProfile,
        credential: Option<&str>,
    ) -> AppResult<Vec<(String, String)>>;

    /// Candidate model-list URLs, best first. The runner tries them in order
    /// and treats 404/405 as "try the next candidate".
    fn model_list_candidates(&self, profile: &LlmProfile) -> Vec<String> {
        derive_model_list_candidates(&profile.endpoint, None)
    }

    /// Extracts the assistant text from a protocol-specific response body.
    fn extract_text(&self, body: &Value) -> AppResult<String>;

    /// Extracts model identifiers, sorted for stable display.
    fn extract_models(&self, body: &Value) -> AppResult<Vec<String>>;

    /// Maps a non-2xx status onto the unified failure taxonomy.
    fn map_status(&self, status: u16, body: &str) -> AppError {
        map_status(status, body)
    }
}

pub fn adapter_for(protocol: LlmProtocolFamily) -> Box<dyn ProtocolAdapter> {
    match protocol {
        LlmProtocolFamily::OpenAi => Box::new(OpenAiAdapter),
        LlmProtocolFamily::OpenAiCompatible => Box::new(OpenAiCompatibleAdapter),
        LlmProtocolFamily::OpenAiResponses => Box::new(OpenAiResponsesAdapter),
        LlmProtocolFamily::Anthropic => Box::new(AnthropicAdapter),
        LlmProtocolFamily::Gemini => Box::new(GeminiAdapter),
        LlmProtocolFamily::AzureOpenAi => Box::new(AzureOpenAiAdapter),
    }
}

pub struct OpenAiAdapter;
pub struct OpenAiCompatibleAdapter;
pub struct OpenAiResponsesAdapter;
pub struct AnthropicAdapter;
pub struct GeminiAdapter;
pub struct AzureOpenAiAdapter;

type Headers = Vec<(String, String)>;

fn bearer_headers(profile: &LlmProfile, credential: Option<&str>) -> Headers {
    let mut headers: Headers = Vec::new();
    if let Some(secret) = credential {
        headers.push(("Authorization".into(), format!("Bearer {secret}")));
    }
    headers.extend(assembled_custom_headers(profile));
    headers
}

/// Chat-completions URL for the OpenAI family. A base URL without the path
/// gets `/chat/completions` appended; a local deployment whose base carries no
/// version segment gets `/v1` first.
fn openai_chat_url(profile: &LlmProfile) -> String {
    if profile.endpoint.contains("/chat/completions") {
        return profile.endpoint.clone();
    }
    let endpoint = profile.endpoint.trim_end_matches('/');
    let endpoint = if matches!(profile.deployment, LlmDeployment::Local)
        && version_suffix(endpoint).is_none()
    {
        format!("{endpoint}/v1")
    } else {
        endpoint.to_owned()
    };
    format!("{endpoint}/chat/completions")
}

fn openai_responses_url(profile: &LlmProfile) -> String {
    let endpoint = profile.endpoint.trim_end_matches('/');
    let endpoint = if matches!(profile.deployment, LlmDeployment::Local)
        && version_suffix(endpoint).is_none()
    {
        format!("{endpoint}/v1")
    } else {
        endpoint.to_owned()
    };
    if endpoint.ends_with("/responses") {
        endpoint
    } else {
        format!("{endpoint}/responses")
    }
}

fn supports_model_field(profile: &LlmProfile) -> bool {
    // Azure addresses a deployment through the URL and rejects a body model.
    !matches!(profile.protocol, LlmProtocolFamily::AzureOpenAi)
}

fn chat_envelope(profile: &LlmProfile, system: Option<&str>, user: &str) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if let Some(system) = system {
        messages.push(json!({"role": "system", "content": system}));
    }
    messages.push(json!({"role": "user", "content": user}));
    let mut body = json!({"messages": messages, "temperature": 0});
    if supports_model_field(profile) {
        body["model"] = json!(profile.model);
    }
    body
}

impl ProtocolAdapter for OpenAiAdapter {
    fn request_envelope(
        &self,
        profile: &LlmProfile,
        system: Option<&str>,
        user: &str,
    ) -> AppResult<Value> {
        Ok(chat_envelope(profile, system, user))
    }

    fn request_url(&self, profile: &LlmProfile) -> AppResult<String> {
        Ok(openai_chat_url(profile))
    }

    fn request_headers(
        &self,
        profile: &LlmProfile,
        credential: Option<&str>,
    ) -> AppResult<Headers> {
        Ok(bearer_headers(profile, credential))
    }

    fn extract_text(&self, body: &Value) -> AppResult<String> {
        extract_openai_text(body)
    }

    fn extract_models(&self, body: &Value) -> AppResult<Vec<String>> {
        extract_data_models(body)
    }
}

impl ProtocolAdapter for OpenAiCompatibleAdapter {
    fn request_envelope(
        &self,
        profile: &LlmProfile,
        system: Option<&str>,
        user: &str,
    ) -> AppResult<Value> {
        Ok(chat_envelope(profile, system, user))
    }

    fn request_url(&self, profile: &LlmProfile) -> AppResult<String> {
        Ok(openai_chat_url(profile))
    }

    fn request_headers(
        &self,
        profile: &LlmProfile,
        credential: Option<&str>,
    ) -> AppResult<Headers> {
        Ok(bearer_headers(profile, credential))
    }

    fn extract_text(&self, body: &Value) -> AppResult<String> {
        extract_openai_text(body)
    }

    fn extract_models(&self, body: &Value) -> AppResult<Vec<String>> {
        extract_data_models(body)
    }
}

impl ProtocolAdapter for OpenAiResponsesAdapter {
    fn request_envelope(
        &self,
        profile: &LlmProfile,
        system: Option<&str>,
        user: &str,
    ) -> AppResult<Value> {
        let mut body = json!({
            "model": profile.model,
            "input": [{
                "role": "user",
                "content": [{"type": "input_text", "text": user}],
            }],
            "temperature": 0,
        });
        if let Some(system) = system {
            body["instructions"] = json!(system);
        }
        Ok(body)
    }

    fn request_url(&self, profile: &LlmProfile) -> AppResult<String> {
        Ok(openai_responses_url(profile))
    }

    fn request_headers(
        &self,
        profile: &LlmProfile,
        credential: Option<&str>,
    ) -> AppResult<Headers> {
        Ok(bearer_headers(profile, credential))
    }

    fn extract_text(&self, body: &Value) -> AppResult<String> {
        if let Some(text) = body.get("output_text").and_then(Value::as_str) {
            return Ok(text.to_owned());
        }
        // The Responses API returns an `output` array mixing reasoning and
        // message items; only the message item carries the final text.
        body.get("output")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().rev().find_map(|item| {
                    item.get("content")
                        .and_then(Value::as_array)
                        .and_then(|content| {
                            content
                                .iter()
                                .find_map(|part| part.get("text").and_then(Value::as_str))
                        })
                })
            })
            .map(str::to_owned)
            .ok_or_else(protocol_mismatch)
    }

    fn extract_models(&self, body: &Value) -> AppResult<Vec<String>> {
        extract_data_models(body)
    }
}

impl ProtocolAdapter for AnthropicAdapter {
    fn request_envelope(
        &self,
        profile: &LlmProfile,
        system: Option<&str>,
        user: &str,
    ) -> AppResult<Value> {
        let mut body = json!({
            "model": profile.model,
            "max_tokens": 4096,
            "temperature": 0,
            "messages": [{"role": "user", "content": user}],
        });
        if let Some(system) = system {
            body["system"] = json!(system);
        }
        Ok(body)
    }

    fn request_url(&self, profile: &LlmProfile) -> AppResult<String> {
        if profile.endpoint.ends_with("/messages") {
            Ok(profile.endpoint.clone())
        } else {
            Ok(format!(
                "{}/v1/messages",
                profile.endpoint.trim_end_matches('/')
            ))
        }
    }

    fn request_headers(
        &self,
        profile: &LlmProfile,
        credential: Option<&str>,
    ) -> AppResult<Headers> {
        let mut headers: Headers = Vec::new();
        if let Some(secret) = credential {
            headers.push(("x-api-key".into(), secret.to_owned()));
        }
        headers.push(("anthropic-version".into(), "2023-06-01".into()));
        headers.extend(assembled_custom_headers(profile));
        Ok(headers)
    }

    fn model_list_candidates(&self, profile: &LlmProfile) -> Vec<String> {
        vec![format!(
            "{}/v1/models",
            profile.endpoint.trim_end_matches('/')
        )]
    }

    fn extract_text(&self, body: &Value) -> AppResult<String> {
        body.get("content")
            .and_then(Value::as_array)
            .and_then(|blocks| {
                blocks
                    .iter()
                    .find(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .or_else(|| blocks.first())
            })
            .and_then(|block| block.get("text"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(protocol_mismatch)
    }

    fn extract_models(&self, body: &Value) -> AppResult<Vec<String>> {
        extract_data_models(body)
    }
}

impl ProtocolAdapter for GeminiAdapter {
    fn request_envelope(
        &self,
        _profile: &LlmProfile,
        system: Option<&str>,
        user: &str,
    ) -> AppResult<Value> {
        // Gemini carries the model in the URL, not the body.
        let mut body = json!({
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {"temperature": 0},
        });
        if let Some(system) = system {
            body["systemInstruction"] = json!({"parts": [{"text": system}]});
        }
        Ok(body)
    }

    fn request_url(&self, profile: &LlmProfile) -> AppResult<String> {
        let endpoint = profile.endpoint.trim_end_matches('/');
        Ok(format!(
            "{endpoint}/v1beta/models/{}:generateContent",
            profile.model
        ))
    }

    fn request_headers(
        &self,
        profile: &LlmProfile,
        credential: Option<&str>,
    ) -> AppResult<Headers> {
        let mut headers: Headers = Vec::new();
        if let Some(secret) = credential {
            headers.push(("x-goog-api-key".into(), secret.to_owned()));
        }
        headers.extend(assembled_custom_headers(profile));
        Ok(headers)
    }

    fn model_list_candidates(&self, profile: &LlmProfile) -> Vec<String> {
        vec![format!(
            "{}/v1beta/models",
            profile.endpoint.trim_end_matches('/')
        )]
    }

    fn extract_text(&self, body: &Value) -> AppResult<String> {
        body.get("candidates")
            .and_then(Value::as_array)
            .and_then(|candidates| candidates.first())
            .and_then(|candidate| candidate.get("content"))
            .and_then(|content| content.get("parts"))
            .and_then(Value::as_array)
            .and_then(|parts| parts.first())
            .and_then(|part| part.get("text"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(protocol_mismatch)
    }

    fn extract_models(&self, body: &Value) -> AppResult<Vec<String>> {
        let mut models: Vec<String> = body
            .get("models")
            .and_then(Value::as_array)
            .ok_or_else(protocol_mismatch)?
            .iter()
            .filter_map(|model| model.get("name").and_then(Value::as_str))
            .map(|name| name.trim_start_matches("models/").to_owned())
            .collect();
        models.sort();
        Ok(models)
    }
}

impl ProtocolAdapter for AzureOpenAiAdapter {
    fn request_envelope(
        &self,
        profile: &LlmProfile,
        system: Option<&str>,
        user: &str,
    ) -> AppResult<Value> {
        Ok(chat_envelope(profile, system, user))
    }

    fn request_url(&self, profile: &LlmProfile) -> AppResult<String> {
        let endpoint = profile.endpoint.trim_end_matches('/');
        // Azure addresses a deployment, not a model: the configured model
        // field doubles as the deployment name (documented in the settings
        // UI and the compatibility matrix).
        Ok(format!(
            "{endpoint}/openai/deployments/{}/chat/completions?api-version=2024-10-21",
            profile.model
        ))
    }

    fn request_headers(
        &self,
        profile: &LlmProfile,
        credential: Option<&str>,
    ) -> AppResult<Headers> {
        let mut headers: Headers = Vec::new();
        if let Some(secret) = credential {
            headers.push(("api-key".into(), secret.to_owned()));
        }
        headers.extend(assembled_custom_headers(profile));
        Ok(headers)
    }

    // Azure has no public inference-plane model list (the management plane
    // needs different credentials), so the runner reports "manual input"
    // instead of issuing a doomed request.
    fn model_list_candidates(&self, _profile: &LlmProfile) -> Vec<String> {
        Vec::new()
    }

    fn extract_text(&self, body: &Value) -> AppResult<String> {
        extract_openai_text(body)
    }

    fn extract_models(&self, body: &Value) -> AppResult<Vec<String>> {
        extract_data_models(body)
    }
}

/// Places the structured-output field for one transport.
///
/// The *choice* of strategy comes from the capability policy; this function
/// only knows how each transport spells it. A strategy the transport cannot
/// express is an explicit incompatibility rather than a silent downgrade.
pub fn apply_structured_output(
    protocol: LlmProtocolFamily,
    body: &mut Value,
    strategy: LlmStructuredOutputStrategy,
    schema_name: &str,
    schema: &Value,
) -> AppResult<()> {
    use LlmProtocolFamily as P;
    use LlmStructuredOutputStrategy as S;
    match protocol {
        P::OpenAi | P::OpenAiCompatible | P::AzureOpenAi => match strategy {
            S::JsonSchemaStrict => {
                body["response_format"] = json!({
                    "type": "json_schema",
                    "json_schema": {
                        "name": schema_name,
                        "strict": true,
                        "schema": schema,
                    }
                });
            }
            S::JsonSchema => {
                body["response_format"] = json!({
                    "type": "json_schema",
                    "json_schema": {
                        "name": schema_name,
                        "schema": schema,
                    }
                });
            }
            S::JsonObject => {
                body["response_format"] = json!({"type": "json_object"});
            }
            // The schema already travelled in the system instruction.
            S::PromptedJson => {}
            S::GeminiSchema => return Err(unsupported_strategy(protocol, strategy)),
        },
        P::OpenAiResponses => match strategy {
            S::JsonSchemaStrict => {
                body["text"] = json!({
                    "format": {
                        "type": "json_schema",
                        "name": schema_name,
                        "strict": true,
                        "schema": schema,
                    }
                });
            }
            S::JsonSchema => {
                body["text"] = json!({
                    "format": {
                        "type": "json_schema",
                        "name": schema_name,
                        "schema": schema,
                    }
                });
            }
            S::JsonObject => {
                body["text"] = json!({"format": {"type": "json_object"}});
            }
            S::PromptedJson => {}
            S::GeminiSchema => return Err(unsupported_strategy(protocol, strategy)),
        },
        // Anthropic Messages has no native structured-output field; the schema
        // travels in the system instruction and is validated locally.
        P::Anthropic => match strategy {
            S::PromptedJson => {}
            _ => return Err(unsupported_strategy(protocol, strategy)),
        },
        P::Gemini => match strategy {
            S::GeminiSchema => {
                body["generationConfig"]["responseMimeType"] = json!("application/json");
                body["generationConfig"]["responseSchema"] = schema.clone();
            }
            S::PromptedJson => {
                body["generationConfig"]["responseMimeType"] = json!("application/json");
            }
            _ => return Err(unsupported_strategy(protocol, strategy)),
        },
    }
    Ok(())
}

/// Places the reasoning-control field for one transport.
pub fn apply_reasoning(protocol: LlmProtocolFamily, body: &mut Value, policy: LlmReasoningPolicy) {
    use LlmProtocolFamily as P;
    use LlmReasoningPolicy as R;
    match policy {
        R::ProviderDefault => {}
        // The Responses surface exposes a normalised effort dial.
        R::EffortNoneForStructured => {
            body["reasoning"] = json!({"effort": "none"});
        }
        R::DisableForStructured => match protocol {
            P::OpenAiResponses => {
                body["reasoning"] = json!({"effort": "none"});
            }
            _ => {
                body["thinking"] = json!({"type": "disabled"});
            }
        },
    }
}

fn unsupported_strategy(
    protocol: LlmProtocolFamily,
    strategy: LlmStructuredOutputStrategy,
) -> AppError {
    AppError::llm_protocol_incompatible(format!(
        "structured-output strategy '{strategy:?}' is not expressible over '{protocol:?}'"
    ))
}

/// Inline header values for the wire. Sensitive headers arrive with their
/// values already resolved: the runner reads them from the credential store
/// and clones the profile with in-memory values before assembling the
/// request, so no resolution logic lives in the adapters.
fn assembled_custom_headers(profile: &LlmProfile) -> Headers {
    profile
        .custom_headers
        .iter()
        .filter_map(|header| {
            header
                .value
                .as_ref()
                .map(|value| (header.name.clone(), value.clone()))
        })
        .collect()
}

fn extract_openai_text(body: &Value) -> AppResult<String> {
    body.get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(protocol_mismatch)
}

fn extract_data_models(body: &Value) -> AppResult<Vec<String>> {
    let mut models: Vec<String> = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(protocol_mismatch)?
        .iter()
        .filter_map(|model| model.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    models.sort();
    Ok(models)
}

/// Known gateway path suffixes whose roots expose their own /v1/models
/// endpoint (borrowed from cc-switch, MIT). Longest first so the most
/// specific suffix wins.
const KNOWN_COMPAT_SUFFIXES: &[&str] = &[
    "/api/claudecode",
    "/api/anthropic",
    "/apps/anthropic",
    "/api/coding",
    "/claudecode",
    "/anthropic",
    "/step_plan",
    "/coding",
    "/claude",
];

/// Candidate model-list URLs derived from an OpenAI-family endpoint,
/// best candidate first (design borrowed from cc-switch, MIT).
pub fn derive_model_list_candidates(endpoint: &str, override_url: Option<&str>) -> Vec<String> {
    if let Some(override_url) = override_url.map(str::trim).filter(|s| !s.is_empty()) {
        return vec![override_url.to_owned()];
    }
    let base = endpoint.trim_end_matches('/');
    let without_chat = base.strip_suffix("/chat/completions").unwrap_or(base);
    // A base that already carries a version segment serves /models directly.
    if version_suffix(without_chat).is_some() {
        return vec![format!("{without_chat}/models")];
    }
    let trimmed = without_chat.trim_end_matches('/');
    // Most OpenAI-compatible gateways expose /v1/models. Preserve this
    // priority: a lexical sort made /models win for compatible routes.
    let mut candidates = vec![format!("{trimmed}/v1/models"), format!("{trimmed}/models")];
    for suffix in KNOWN_COMPAT_SUFFIXES {
        if let Some(root) = trimmed.strip_suffix(suffix) {
            let root = root.trim_end_matches('/');
            candidates.push(format!("{root}/v1/models"));
            candidates.push(format!("{root}/models"));
            break;
        }
    }
    let mut unique = Vec::new();
    for candidate in candidates {
        if !unique.contains(&candidate) {
            unique.push(candidate);
        }
    }
    unique
}

fn version_suffix(url: &str) -> Option<&str> {
    let last = url.rsplit('/').next()?;
    let version = last.strip_prefix('v')?;
    if !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit()) {
        Some(last)
    } else {
        None
    }
}

pub fn map_status(status: u16, body: &str) -> AppError {
    let detail = truncate_for_error(body);
    match status {
        401 | 403 => AppError::llm_auth_failed().with_param("detail", detail),
        404 => AppError::llm_model_not_found("").with_param("detail", detail),
        429 => AppError::llm_rate_limited(None).with_param("detail", detail),
        500..=599 => AppError::llm_server_error(status).with_param("detail", detail),
        _ => AppError::llm_protocol_incompatible(format!("HTTP {status}: {detail}")),
    }
}

/// Error details are truncated so no full response body can leak into logs.
pub fn truncate_for_error(body: &str) -> String {
    const MAX: usize = 200;
    if body.len() <= MAX {
        body.to_owned()
    } else {
        let mut end = MAX;
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &body[..end])
    }
}

fn protocol_mismatch() -> AppError {
    AppError::llm_protocol_incompatible("unexpected response shape")
}

/// Transport-level failure classification shared by the runner: DNS, TLS,
/// connect, proxy and timeout failures are distinguished by reqwest's error
/// chain.
pub fn classify_transport_error(error: &reqwest::Error, timeout_ms: u64) -> AppError {
    if error.is_timeout() {
        return AppError::llm_request_timeout(timeout_ms);
    }
    if error.is_connect() {
        return AppError::llm_endpoint_unreachable("connect_failed");
    }
    let reason = if error.is_builder() {
        "client_builder"
    } else if error.is_body() {
        "body"
    } else if error.is_decode() {
        "decode"
    } else {
        "network"
    };
    AppError::llm_endpoint_unreachable(reason)
}

/// URL used in logs and error params: scheme/host/port/path only, without
/// userinfo, query or fragment (borrowed from cc-switch's redaction design).
pub fn url_for_log(url: &str) -> String {
    Url::parse(url)
        .map(|mut sanitized| {
            sanitized.set_username("").ok();
            sanitized.set_password(None).ok();
            sanitized.set_query(None);
            sanitized.set_fragment(None);
            sanitized.to_string()
        })
        .unwrap_or_else(|_| "<unparsable-url>".to_owned())
}
