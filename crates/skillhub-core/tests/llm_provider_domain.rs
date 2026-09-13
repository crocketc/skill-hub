use skillhub_core::llm::{
    builtin_provider_presets, compatibility_policy, legacy_profile_for_builtin_id, CustomHeader,
    LlmCompatibilityProfile, LlmDeployment, LlmProtocolFamily, LlmProviderConfig,
    LlmReasoningPolicy, LlmStructuredOutputStrategy,
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
    assert!(credential
        .actions
        .contains(&RecoveryAction::ConfigureCredential));
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
fn online_configs_require_https_and_local_configs_allow_trusted_local_http() {
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
    assert!(endpoint_error(
        ErrorCode::LlmEndpointNotAllowed,
        &http_online
    ));

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
    assert!(endpoint_error(
        ErrorCode::LlmEndpointNotAllowed,
        &plain_online
    ));

    let lan_local = LlmProviderConfig::new(
        "ollama-lan",
        "Ollama on the LAN",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Local,
        "http://192.168.1.5:11434/v1",
        "qwen3:8b",
        None,
    )
    .expect("private LAN http is valid for local models");
    assert_eq!(lan_local.deployment, LlmDeployment::Local);
    lan_local
        .to_profile()
        .expect("private LAN http also passes runtime profile validation");

    let link_local = LlmProviderConfig::new(
        "lm-studio-lan",
        "LM Studio on the LAN",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Local,
        "http://169.254.83.107:1234",
        "qwen3.5-4b",
        None,
    )
    .expect("IPv4 link-local http is valid for local models");
    assert_eq!(link_local.deployment, LlmDeployment::Local);

    let ipv6_link_local = LlmProviderConfig::new(
        "ollama-ipv6",
        "Ollama over IPv6",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Local,
        "http://[fe80::1]:11434/v1",
        "qwen3:8b",
        None,
    )
    .expect("IPv6 link-local http is valid for local models");
    ipv6_link_local
        .to_profile()
        .expect("IPv6 link-local http also passes runtime profile validation");

    let public_local = LlmProviderConfig::new(
        "public-http",
        "Public HTTP",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Local,
        "http://203.0.113.10:1234/v1",
        "qwen3:8b",
        None,
    )
    .expect_err("public http must be rejected even for local models");
    assert!(endpoint_error(
        ErrorCode::LlmEndpointNotAllowed,
        &public_local
    ));

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
    assert!(endpoint_error(
        skillhub_core::ErrorCode::InvalidInput,
        &missing_model
    ));

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

    let secret_without_ref = CustomHeader::new("X-Api-Key", "sk-nope", true)
        .expect_err("sensitive values need a credential reference");
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
    assert!(
        CustomHeader::new("", "v", false).is_err(),
        "empty names rejected"
    );

    let mut overflowing = config;
    for i in 0..16 {
        overflowing = overflowing
            .with_header(CustomHeader::new(format!("X-H{i}"), "v", false).expect("header"))
            .expect("header accepted");
    }
    let overflow =
        overflowing.with_header(CustomHeader::new("X-One-Too-Many", "v", false).expect("header"));
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
        "deepseek-anthropic",
        "alibaba-dashscope",
        "moonshot-kimi",
        "kimi-code-openai",
        "kimi-code-anthropic",
        "zhipu-glm",
        "zhipu-glm-coding-chat",
        "zhipu-glm-coding-anthropic",
        "minimax",
        "volcengine-doubao",
        "xai-grok",
        "groq",
        "mistral",
        "baidu-qianfan",
        "baidu-qianfan-anthropic",
        "ollama",
        "lm-studio",
        "custom-openai-compatible",
    ] {
        assert!(ids.contains(&expected), "missing preset {expected}");
    }

    let glm_coding = presets
        .iter()
        .find(|preset| preset.id == "zhipu-glm-coding-chat")
        .expect("GLM Coding Plan must be a distinct product-line preset");
    assert_eq!(
        glm_coding.endpoint,
        "https://open.bigmodel.cn/api/coding/paas/v4"
    );
    assert_eq!(glm_coding.protocol, LlmProtocolFamily::OpenAiCompatible);

    let kimi_code = presets
        .iter()
        .find(|preset| preset.id == "kimi-code-openai")
        .expect("Kimi Code must not reuse the open-platform endpoint");
    assert_eq!(kimi_code.endpoint, "https://api.kimi.com/coding/v1");

    let openai = presets.iter().find(|p| p.id == "openai").unwrap();
    assert_eq!(openai.protocol, LlmProtocolFamily::OpenAiCompatible);
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

    // Hints are optional guidance only; users still fetch or manually enter
    // the actual model identifier.
    assert!(
        presets
            .iter()
            .find(|p| p.id == "deepseek")
            .unwrap()
            .models_hint
            .is_some(),
        "official product lines may provide a non-binding current model hint"
    );
    // Every online preset documents its official API reference for the
    // compatibility matrix and the settings page.
    assert!(presets
        .iter()
        .all(|p| p.api_docs_url.is_some() || p.id == "custom-openai-compatible"));
}

// ---------------------------------------------------------------------------
// 兼容配置档（Task 2）
// ---------------------------------------------------------------------------

const ALL_PROFILES: [LlmCompatibilityProfile; 20] = [
    LlmCompatibilityProfile::OpenAi,
    LlmCompatibilityProfile::Anthropic,
    LlmCompatibilityProfile::Gemini,
    LlmCompatibilityProfile::AzureOpenAi,
    LlmCompatibilityProfile::OpenRouter,
    LlmCompatibilityProfile::DeepSeek,
    LlmCompatibilityProfile::DashScope,
    LlmCompatibilityProfile::Moonshot,
    LlmCompatibilityProfile::KimiCoding,
    LlmCompatibilityProfile::Glm,
    LlmCompatibilityProfile::GlmCoding,
    LlmCompatibilityProfile::MiniMax,
    LlmCompatibilityProfile::VolcengineArk,
    LlmCompatibilityProfile::Xai,
    LlmCompatibilityProfile::Groq,
    LlmCompatibilityProfile::Mistral,
    LlmCompatibilityProfile::BaiduQianfan,
    LlmCompatibilityProfile::Ollama,
    LlmCompatibilityProfile::LmStudio,
    LlmCompatibilityProfile::Generic,
];

#[test]
fn compatibility_profiles_round_trip_through_serde() {
    for profile in ALL_PROFILES {
        let json = serde_json::to_string(&profile).expect("serialize profile");
        let decoded: LlmCompatibilityProfile =
            serde_json::from_str(&json).expect("deserialize profile");
        assert_eq!(decoded, profile, "profile {json} must round-trip");
    }
    assert_eq!(
        serde_json::to_string(&LlmCompatibilityProfile::Generic).unwrap(),
        "\"generic\""
    );
    assert_eq!(
        serde_json::to_string(&LlmCompatibilityProfile::GlmCoding).unwrap(),
        "\"glm_coding\""
    );
    // A provider display name is never accepted as a profile identifier.
    assert!(serde_json::from_str::<LlmCompatibilityProfile>("\"Zhipu GLM API\"").is_err());
}

#[test]
fn structured_output_and_reasoning_enums_cover_the_designed_vocabulary() {
    for strategy in [
        LlmStructuredOutputStrategy::JsonSchemaStrict,
        LlmStructuredOutputStrategy::JsonSchema,
        LlmStructuredOutputStrategy::JsonObject,
        LlmStructuredOutputStrategy::PromptedJson,
        LlmStructuredOutputStrategy::GeminiSchema,
    ] {
        let json = serde_json::to_string(&strategy).unwrap();
        let decoded: LlmStructuredOutputStrategy = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, strategy);
    }
    assert_eq!(
        serde_json::to_string(&LlmStructuredOutputStrategy::JsonSchemaStrict).unwrap(),
        "\"json_schema_strict\""
    );
    assert_eq!(
        serde_json::to_string(&LlmStructuredOutputStrategy::PromptedJson).unwrap(),
        "\"prompted_json\""
    );
    assert_eq!(
        serde_json::to_string(&LlmStructuredOutputStrategy::GeminiSchema).unwrap(),
        "\"gemini_schema\""
    );

    for policy in [
        LlmReasoningPolicy::ProviderDefault,
        LlmReasoningPolicy::DisableForStructured,
        LlmReasoningPolicy::EffortNoneForStructured,
    ] {
        let json = serde_json::to_string(&policy).unwrap();
        let decoded: LlmReasoningPolicy = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, policy);
    }
    assert_eq!(
        serde_json::to_string(&LlmReasoningPolicy::EffortNoneForStructured).unwrap(),
        "\"effort_none_for_structured\""
    );
}

/// 旧配置缺失新字段时默认到 Generic，且绝不根据 endpoint 猜测供应商。
#[test]
fn provider_config_and_profile_default_to_generic_without_guessing_from_the_endpoint() {
    let legacy = serde_json::json!({
        "id": "legacy",
        "label": "Legacy",
        "protocol": "open_ai_compatible",
        "deployment": "online",
        "endpoint": "https://api.deepseek.com",
        "model": "deepseek-v4-pro",
    });
    let config: LlmProviderConfig = serde_json::from_value(legacy).expect("legacy json decodes");
    assert_eq!(
        config.compatibility_profile,
        LlmCompatibilityProfile::Generic
    );
    assert!(config.structured_output_override.is_none());

    let profile = config.to_profile().expect("profile");
    assert_eq!(
        profile.compatibility_profile,
        LlmCompatibilityProfile::Generic
    );
    assert!(profile.structured_output_override.is_none());

    let listing = config.to_model_listing_profile().expect("listing profile");
    assert_eq!(
        listing.compatibility_profile,
        LlmCompatibilityProfile::Generic
    );

    // An explicitly configured profile survives both conversions.
    let mut explicit = config.clone();
    explicit.compatibility_profile = LlmCompatibilityProfile::DeepSeek;
    assert_eq!(
        explicit.to_profile().unwrap().compatibility_profile,
        LlmCompatibilityProfile::DeepSeek
    );
    assert_eq!(
        explicit
            .to_model_listing_profile()
            .unwrap()
            .compatibility_profile,
        LlmCompatibilityProfile::DeepSeek
    );
}

/// 每个内置档都必须能在 profile 构造阶段拒绝非法协议组合，且不产生网络调用。
#[test]
fn incompatible_profile_and_protocol_combinations_fail_before_any_request() {
    // Gemini profile does not speak Anthropic Messages.
    let mut gemini = LlmProviderConfig::new(
        "gemini",
        "Gemini",
        LlmProtocolFamily::Anthropic,
        LlmDeployment::Online,
        "https://generativelanguage.googleapis.com",
        "gemini-3",
        None,
    )
    .expect("transport-shaped config still constructs");
    gemini.compatibility_profile = LlmCompatibilityProfile::Gemini;
    let error = gemini
        .to_profile()
        .expect_err("Gemini + Anthropic must be rejected");
    assert_eq!(error.code, ErrorCode::LlmProtocolIncompatible);

    // Azure profile only speaks the Azure deployment protocol.
    let mut azure = LlmProviderConfig::new(
        "azure",
        "Azure",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Online,
        "https://acme.openai.azure.com",
        "acme-chat",
        None,
    )
    .expect("config");
    azure.compatibility_profile = LlmCompatibilityProfile::AzureOpenAi;
    assert_eq!(
        azure.to_profile().unwrap_err().code,
        ErrorCode::LlmProtocolIncompatible
    );

    // A compatible combination is accepted.
    let mut deepseek = LlmProviderConfig::new(
        "deepseek",
        "DeepSeek",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Online,
        "https://api.deepseek.com",
        "deepseek-v4-pro",
        None,
    )
    .expect("config");
    deepseek.compatibility_profile = LlmCompatibilityProfile::DeepSeek;
    assert!(deepseek.to_profile().is_ok());
}

/// Generic 允许用户显式覆盖结构化策略；内置档拒绝任意覆盖。
#[test]
fn only_the_generic_profile_accepts_an_explicit_structured_output_override() {
    let mut generic = LlmProviderConfig::new(
        "custom",
        "Custom",
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Online,
        "https://gateway.example/v1",
        "model-a",
        None,
    )
    .expect("config");
    assert_eq!(
        generic.compatibility_profile,
        LlmCompatibilityProfile::Generic
    );
    generic.structured_output_override = Some(LlmStructuredOutputStrategy::JsonSchemaStrict);
    let profile = generic.to_profile().expect("generic override accepted");
    assert_eq!(
        profile.structured_output_override,
        Some(LlmStructuredOutputStrategy::JsonSchemaStrict)
    );
    let policy = compatibility_policy(&profile, LlmProtocolFamily::OpenAiCompatible).unwrap();
    assert_eq!(
        policy.structured_output,
        LlmStructuredOutputStrategy::JsonSchemaStrict
    );

    // Built-in profiles must not silently accept an arbitrary override.
    let mut builtin = generic.clone();
    builtin.compatibility_profile = LlmCompatibilityProfile::KimiCoding;
    assert_eq!(
        builtin.to_profile().unwrap_err().code,
        ErrorCode::LlmProtocolIncompatible
    );
}

/// 同一传输协议下不同供应商产生不同的结构化策略与推理控制。
#[test]
fn compatibility_policy_is_the_single_source_of_provider_behaviour() {
    let openai =
        compatibility_policy_for(LlmCompatibilityProfile::OpenAi, "https://api.openai.com/v1");
    assert_eq!(
        openai.structured_output,
        LlmStructuredOutputStrategy::JsonSchemaStrict
    );
    assert_eq!(openai.reasoning, LlmReasoningPolicy::ProviderDefault);

    let deepseek_chat = compatibility_policy_for(
        LlmCompatibilityProfile::DeepSeek,
        "https://api.deepseek.com",
    );
    assert_eq!(
        deepseek_chat.structured_output,
        LlmStructuredOutputStrategy::JsonObject,
        "DeepSeek Chat must not send strict JSON Schema"
    );
    assert_eq!(
        deepseek_chat.reasoning,
        LlmReasoningPolicy::DisableForStructured
    );

    let mut deepseek_responses_profile = profile_for(
        LlmCompatibilityProfile::DeepSeek,
        "https://api.deepseek.com",
    );
    deepseek_responses_profile.protocol = LlmProtocolFamily::OpenAiResponses;
    let deepseek_responses = compatibility_policy(
        &deepseek_responses_profile,
        LlmProtocolFamily::OpenAiResponses,
    )
    .unwrap();
    assert_eq!(
        deepseek_responses.structured_output,
        LlmStructuredOutputStrategy::JsonObject
    );
    assert_eq!(
        deepseek_responses.reasoning,
        LlmReasoningPolicy::EffortNoneForStructured
    );

    // GLM 普通 API 与 GLM Coding Plan 是不同产品档。
    let glm = compatibility_policy_for(
        LlmCompatibilityProfile::Glm,
        "https://open.bigmodel.cn/api/paas/v4",
    );
    let glm_coding = compatibility_policy_for(
        LlmCompatibilityProfile::GlmCoding,
        "https://open.bigmodel.cn/api/coding/paas/v4",
    );
    assert_eq!(
        glm.structured_output,
        LlmStructuredOutputStrategy::JsonObject
    );
    assert_eq!(
        glm_coding.structured_output,
        LlmStructuredOutputStrategy::JsonObject
    );
    assert_ne!(
        glm.profile, glm_coding.profile,
        "ordinary GLM API and GLM Coding Plan must stay distinct product lines"
    );

    // Anthropic / Gemini / Azure must not inherit the OpenAI strategy.
    let anthropic = compatibility_policy_for(
        LlmCompatibilityProfile::Anthropic,
        "https://api.anthropic.com",
    );
    assert_eq!(
        anthropic.structured_output,
        LlmStructuredOutputStrategy::PromptedJson
    );
    let gemini = compatibility_policy_for(
        LlmCompatibilityProfile::Gemini,
        "https://generativelanguage.googleapis.com",
    );
    assert_eq!(
        gemini.structured_output,
        LlmStructuredOutputStrategy::GeminiSchema
    );
    let azure = compatibility_policy_for(
        LlmCompatibilityProfile::AzureOpenAi,
        "https://acme.openai.azure.com",
    );
    assert_eq!(
        azure.structured_output,
        LlmStructuredOutputStrategy::JsonSchemaStrict
    );

    // 本地服务不需要凭据；云端 OpenAI-compatible 需要 Bearer。
    let ollama =
        compatibility_policy_for(LlmCompatibilityProfile::Ollama, "http://127.0.0.1:11434/v1");
    assert_eq!(ollama.auth, skillhub_core::llm::LlmAuthStrategy::None);
    assert_eq!(
        ollama.model_list,
        skillhub_core::llm::LlmModelListStrategy::OpenAiCompatible
    );
    let lm_studio = compatibility_policy_for(
        LlmCompatibilityProfile::LmStudio,
        "http://127.0.0.1:1234/v1",
    );
    assert_eq!(lm_studio.auth, skillhub_core::llm::LlmAuthStrategy::None);

    // 每个内置档都声明了非空的受支持协议集合。
    for profile in ALL_PROFILES {
        assert!(
            !profile.supported_protocols().is_empty(),
            "profile {profile:?} must declare supported protocols"
        );
    }
}

fn profile_for(
    compatibility: LlmCompatibilityProfile,
    endpoint: &str,
) -> skillhub_core::llm::LlmProfile {
    let mut profile = skillhub_core::llm::LlmProfile::new(
        "acme",
        endpoint,
        "acme-model",
        Some(skillhub_core::llm::CredentialRef::new("cred-1")),
    )
    .expect("profile");
    profile.compatibility_profile = compatibility;
    // Use the profile's own default protocol so the pair stays legal.
    profile.protocol = compatibility.supported_protocols()[0];
    profile
}

fn compatibility_policy_for(
    compatibility: LlmCompatibilityProfile,
    endpoint: &str,
) -> skillhub_core::llm::LlmCompatibilityPolicy {
    let profile = profile_for(compatibility, endpoint);
    let protocol = profile.protocol;
    compatibility_policy(&profile, protocol).expect("policy")
}

/// 每个内置预设都必须声明能力档、默认协议和非空受支持协议集合，且默认协议
/// 属于该集合；不同产品线不得共用一个能力档。
#[test]
fn builtin_presets_declare_their_capability_profile_and_protocol_set() {
    let presets = builtin_provider_presets();
    for preset in &presets {
        assert!(
            !preset.supported_protocols.is_empty(),
            "preset {} must declare supported protocols",
            preset.id
        );
        assert!(
            preset.supported_protocols.contains(&preset.protocol),
            "preset {} default protocol must be part of its supported set",
            preset.id
        );
        assert!(
            !preset
                .compatibility_profile
                .supported_protocols()
                .is_empty(),
            "preset {} must resolve to a profile with protocols",
            preset.id
        );
        for protocol in &preset.supported_protocols {
            assert!(
                preset
                    .compatibility_profile
                    .supported_protocols()
                    .contains(protocol),
                "preset {} offers a protocol its profile cannot speak",
                preset.id
            );
        }
    }

    let by_id = |id: &str| {
        presets
            .iter()
            .find(|preset| preset.id == id)
            .unwrap_or_else(|| panic!("missing preset {id}"))
    };

    // GLM 普通 API 与 GLM Coding Plan 必须是两个不同产品线，且普通 API
    // 不允许被拼上 `/responses`。
    let glm = by_id("zhipu-glm");
    let glm_coding_chat = by_id("zhipu-glm-coding-chat");
    let glm_coding_anthropic = by_id("zhipu-glm-coding-anthropic");
    assert_eq!(glm.compatibility_profile, LlmCompatibilityProfile::Glm);
    assert_eq!(
        glm_coding_chat.compatibility_profile,
        LlmCompatibilityProfile::GlmCoding
    );
    assert_eq!(
        glm_coding_anthropic.compatibility_profile,
        LlmCompatibilityProfile::GlmCoding
    );
    assert_eq!(
        glm.supported_protocols,
        vec![LlmProtocolFamily::OpenAiCompatible]
    );
    assert_eq!(
        glm_coding_chat.supported_protocols,
        vec![
            LlmProtocolFamily::OpenAiCompatible,
            LlmProtocolFamily::OpenAiResponses
        ]
    );
    assert_eq!(
        glm_coding_anthropic.supported_protocols,
        vec![LlmProtocolFamily::Anthropic]
    );
    assert_ne!(
        glm.endpoint, glm_coding_chat.endpoint,
        "ordinary GLM API and GLM Coding Plan must not share an endpoint"
    );

    // Kimi 开放平台与 Kimi Coding Plan 必须分开。
    let kimi = by_id("moonshot-kimi");
    let kimi_open = by_id("kimi-code-openai");
    let kimi_open_anthropic = by_id("kimi-code-anthropic");
    assert_eq!(
        kimi.compatibility_profile,
        LlmCompatibilityProfile::Moonshot
    );
    assert_eq!(
        kimi_open.compatibility_profile,
        LlmCompatibilityProfile::KimiCoding
    );
    assert_eq!(
        kimi_open_anthropic.compatibility_profile,
        LlmCompatibilityProfile::KimiCoding
    );
    assert_ne!(kimi.endpoint, kimi_open.endpoint);
    assert_eq!(
        kimi_open.supported_protocols,
        vec![LlmProtocolFamily::OpenAiCompatible]
    );
    assert_eq!(
        kimi_open_anthropic.supported_protocols,
        vec![LlmProtocolFamily::Anthropic]
    );

    // DeepSeek 的协议集合来自官方契约：Chat + Responses，Anthropic 独立预设。
    let deepseek = by_id("deepseek");
    assert_eq!(
        deepseek.compatibility_profile,
        LlmCompatibilityProfile::DeepSeek
    );
    assert_eq!(
        deepseek.supported_protocols,
        vec![
            LlmProtocolFamily::OpenAiCompatible,
            LlmProtocolFamily::OpenAiResponses
        ]
    );

    // 本地服务与自定义配置。
    assert_eq!(
        by_id("lm-studio").compatibility_profile,
        LlmCompatibilityProfile::LmStudio
    );
    assert_eq!(
        by_id("ollama").compatibility_profile,
        LlmCompatibilityProfile::Ollama
    );
    assert_eq!(
        by_id("custom-openai-compatible").compatibility_profile,
        LlmCompatibilityProfile::Generic
    );
}

/// 未知旧配置一律回退 Generic，不根据 URL、label 或 model 猜测。
#[test]
fn legacy_builtin_ids_map_once_and_unknown_ids_fall_back_to_generic() {
    assert_eq!(
        legacy_profile_for_builtin_id("zhipu-glm"),
        LlmCompatibilityProfile::Glm
    );
    assert_eq!(
        legacy_profile_for_builtin_id("zhipu-glm-coding-chat"),
        LlmCompatibilityProfile::GlmCoding
    );
    assert_eq!(
        legacy_profile_for_builtin_id("kimi-code-openai"),
        LlmCompatibilityProfile::KimiCoding
    );
    assert_eq!(
        legacy_profile_for_builtin_id("moonshot-kimi"),
        LlmCompatibilityProfile::Moonshot
    );
    assert_eq!(
        legacy_profile_for_builtin_id("deepseek"),
        LlmCompatibilityProfile::DeepSeek
    );
    assert_eq!(
        legacy_profile_for_builtin_id("lm-studio"),
        LlmCompatibilityProfile::LmStudio
    );
    assert_eq!(
        legacy_profile_for_builtin_id("some-user-id"),
        LlmCompatibilityProfile::Generic
    );
    // 一个语义上像供应商的 URL 绝不会被当作 ID 识别。
    assert_eq!(
        legacy_profile_for_builtin_id("https://api.deepseek.com"),
        LlmCompatibilityProfile::Generic
    );
}
