use skillhub_core::llm::{
    builtin_provider_presets, CustomHeader, LlmDeployment, LlmProtocolFamily, LlmProviderConfig,
};
use skillhub_core::{AppError, ErrorCode, RecoveryAction};

fn endpoint_error(code: ErrorCode, error: &AppError) -> bool {
    error.code == code
}

#[test]
fn llm_failure_codes_map_to_stable_strings_and_recovery_actions() {
    assert_eq!(ErrorCode::LlmAuthFailed.as_str(), "llm.auth_failed");
    assert_eq!(ErrorCode::LlmModelNotFound.as_str(), "llm.model_not_found");
    assert_eq!(ErrorCode::LlmRateLimited.as_str(), "llm.rate_limited");
    assert_eq!(ErrorCode::LlmRequestTimeout.as_str(), "llm.request_timeout");
    assert_eq!(ErrorCode::LlmCancelled.as_str(), "llm.cancelled");
    assert_eq!(
        ErrorCode::LlmEndpointUnreachable.as_str(),
        "llm.endpoint_unreachable"
    );
    assert_eq!(ErrorCode::LlmServerError.as_str(), "llm.server_error");
    assert_eq!(ErrorCode::LlmInvalidJson.as_str(), "llm.invalid_json");
    assert_eq!(
        ErrorCode::LlmResponseInterrupted.as_str(),
        "llm.response_interrupted"
    );
    assert_eq!(
        ErrorCode::LlmProtocolIncompatible.as_str(),
        "llm.protocol_incompatible"
    );
    assert_eq!(
        ErrorCode::LlmCredentialReadFailed.as_str(),
        "llm.credential_read_failed"
    );
    assert_eq!(
        ErrorCode::LlmCapabilityDisabled.as_str(),
        "llm.capability_disabled"
    );

    let auth = AppError::llm_auth_failed();
    assert!(auth.actions.contains(&RecoveryAction::Reauthenticate));
    let credential = AppError::llm_credential_read_failed();
    assert!(credential.actions.contains(&RecoveryAction::ConfigureCredential));
    let rate_limited = AppError::llm_rate_limited(Some(2_000));
    assert_eq!(
        rate_limited.params.get("retry_after_ms"),
        Some(&serde_json::json!(2_000))
    );
    let cancelled = AppError::llm_cancelled();
    assert_eq!(cancelled.code, ErrorCode::LlmCancelled);
}

#[test]
fn protocol_family_and_deployment_are_explicit() {
    let online = LlmProviderConfig::new(
        "deepseek",
        "DeepSeek",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Online,
        "https://api.deepseek.com/v1",
        "deepseek-chat",
        None,
    )
    .expect("online https config is valid");
    assert_eq!(online.protocol, LlmProtocolFamily::OpenAiCompatible);
    assert_eq!(online.deployment, LlmDeployment::Online);
    assert!(online.enabled, "new configs start enabled");

    let local = LlmProviderConfig::new(
        "ollama",
        "Ollama (local)",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Local,
        "http://127.0.0.1:11434/v1",
        "qwen3:8b",
        None,
    )
    .expect("loopback http is valid for local models");
    assert_eq!(local.deployment, LlmDeployment::Local);
}

#[test]
fn online_configs_require_https_and_local_configs_allow_only_loopback_http() {
    let http_online = LlmProviderConfig::new(
        "acme",
        "Acme",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Online,
        "http://api.acme.example/v1",
        "acme-chat",
        None,
    )
    .expect_err("online http must be rejected");
    assert!(endpoint_error(ErrorCode::LlmEndpointNotAllowed, &http_online));

    let plain_online = LlmProviderConfig::new(
        "acme",
        "Acme",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Online,
        "api.acme.example/v1",
        "acme-chat",
        None,
    )
    .expect_err("endpoints must parse as URLs");
    assert!(endpoint_error(ErrorCode::LlmEndpointNotAllowed, &plain_online));

    let lan_local = LlmProviderConfig::new(
        "ollama-lan",
        "Ollama on the LAN",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Local,
        "http://192.168.1.5:11434/v1",
        "qwen3:8b",
        None,
    )
    .expect_err("non-loopback http must be rejected even for local models");
    assert!(endpoint_error(ErrorCode::LlmEndpointNotAllowed, &lan_local));

    let localhost_alias = LlmProviderConfig::new(
        "lm-studio",
        "LM Studio (local)",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Local,
        "http://localhost:1234/v1",
        "qwen3-8b",
        None,
    )
    .expect("localhost alias counts as loopback");
    assert_eq!(localhost_alias.deployment, LlmDeployment::Local);
}

#[test]
fn provider_configs_require_provider_and_model_and_stable_id() {
    let missing_model = LlmProviderConfig::new(
        "deepseek",
        "DeepSeek",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Online,
        "https://api.deepseek.com/v1",
        "   ",
        None,
    )
    .expect_err("blank model must be rejected");
    assert!(endpoint_error(skillhub_core::ErrorCode::InvalidInput, &missing_model));

    let configured = LlmProviderConfig::new(
        "deepseek",
        "DeepSeek",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Online,
        "https://api.deepseek.com/v1",
        "deepseek-chat",
        None,
    )
    .expect("valid config");
    assert_eq!(configured.id, "deepseek");
    assert!(
        configured.timeout_ms > 0 && configured.max_input_bytes > 0,
        "bounded limits default to positive values"
    );
}

#[test]
fn custom_headers_are_bounded_and_sensitive_values_require_the_credential_store() {
    let config = LlmProviderConfig::new(
        "gateway",
        "Gateway",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Online,
        "https://gateway.example/v1",
        "model-a",
        None,
    )
    .expect("valid config");

    let plain = CustomHeader::new("X-Trace-Id", "trace-123", false).expect("plain header");
    let config = config.with_header(plain).expect("plain header accepted");

    let secret_without_ref =
        CustomHeader::new("X-Api-Key", "sk-nope", true).expect_err("sensitive values need a credential reference");
    let _ = secret_without_ref;

    let _ = config;
}

#[test]
fn custom_headers_reject_invalid_names_and_overflow() {
    let config = LlmProviderConfig::new(
        "gateway",
        "Gateway",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Online,
        "https://gateway.example/v1",
        "model-a",
        None,
    )
    .expect("valid config");

    assert!(
        CustomHeader::new("bad header\n", "v", false).is_err(),
        "header names must be valid tokens"
    );
    assert!(CustomHeader::new("", "v", false).is_err(), "empty names rejected");

    let mut overflowing = config;
    for i in 0..16 {
        overflowing = overflowing
            .with_header(CustomHeader::new(format!("X-H{i}"), "v", false).expect("header"))
            .expect("header accepted");
    }
    let overflow = overflowing.with_header(
        CustomHeader::new("X-One-Too-Many", "v", false).expect("header"),
    );
    assert!(overflow.is_err(), "custom headers must stay bounded");
}

#[test]
fn builtin_presets_cover_the_confirmed_provider_baseline() {
    let presets = builtin_provider_presets();
    let ids: Vec<&str> = presets.iter().map(|p| p.id.as_str()).collect();
    for expected in [
        "openai",
        "anthropic",
        "google-gemini",
        "azure-openai",
        "openrouter",
        "deepseek",
        "alibaba-dashscope",
        "moonshot-kimi",
        "zhipu-glm",
        "minimax",
        "volcengine-doubao",
        "xai-grok",
        "ollama",
        "lm-studio",
        "custom-openai-compatible",
    ] {
        assert!(ids.contains(&expected), "missing preset {expected}");
    }

    let openai = presets.iter().find(|p| p.id == "openai").unwrap();
    assert_eq!(openai.protocol, LlmProtocolFamily::OpenAi);
    assert_eq!(openai.deployment, LlmDeployment::Online);
    assert!(openai.requires_credential);
    assert!(openai.endpoint.starts_with("https://"));

    let ollama = presets.iter().find(|p| p.id == "ollama").unwrap();
    assert_eq!(ollama.deployment, LlmDeployment::Local);
    assert!(
        !ollama.requires_credential,
        "local model services run without API credentials"
    );
    let lm_studio = presets.iter().find(|p| p.id == "lm-studio").unwrap();
    assert_eq!(lm_studio.deployment, LlmDeployment::Local);

    let custom = presets
        .iter()
        .find(|p| p.id == "custom-openai-compatible")
        .unwrap();
    assert_eq!(custom.protocol, LlmProtocolFamily::OpenAiCompatible);

    // Presets never hardcode model ids as the only choice: the model comes
    // from the model-list fetch or manual input, so the catalog carries none.
    assert!(
        presets.iter().all(|p| p.models_hint.is_none()),
        "presets must not ship model catalogues"
    );
    // Every online preset documents its official API reference for the
    // compatibility matrix and the settings page.
    assert!(presets.iter().all(|p| p.api_docs_url.is_some() || p.id == "custom-openai-compatible"));
}
