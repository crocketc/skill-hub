//! Supplier / product-line compatibility profiles.
//!
//! The transport protocol ([`LlmProtocolFamily`]) describes only the HTTP wire
//! shape: URL suffix, authentication header and response envelope. Everything
//! that differs *between products speaking the same protocol* — structured
//! output mechanism, reasoning control, model catalogue and credential policy —
//! lives in a [`LlmCompatibilityProfile`].
//!
//! This module is the single source of truth for that behaviour. No request
//! path may branch on a provider display name, a user-editable id, a model
//! name or a URL host to pick a request strategy: callers ask
//! [`compatibility_policy`] instead.

use serde::{Deserialize, Serialize};

use crate::{AppError, AppResult, ErrorCode, Severity};

use super::model::LlmProfile;
use super::provider::LlmProtocolFamily;

/// A versioned behaviour identifier for a supplier product line.
///
/// It is deliberately *not* a user-entered provider name: the settings UI maps
/// a built-in preset to one of these values, and a hand-written configuration
/// falls back to [`LlmCompatibilityProfile::Generic`].
#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum LlmCompatibilityProfile {
    /// OpenAI's own service (`json_schema` strict structured outputs).
    OpenAi,
    /// Anthropic Claude (Messages API has no native structured-output field).
    Anthropic,
    /// Google Gemini (`responseMimeType` + native schema).
    Gemini,
    /// Azure OpenAI: deployment-scoped addressing.
    AzureOpenAi,
    /// OpenRouter: one platform-level policy, never the underlying vendor's.
    OpenRouter,
    /// DeepSeek official API (Chat / Responses / Anthropic surfaces).
    DeepSeek,
    /// Alibaba Cloud Model Studio (DashScope), OpenAI-compatible mode only.
    DashScope,
    /// Moonshot / Kimi open platform.
    Moonshot,
    /// Kimi Coding Plan (a separate product line from the open platform).
    KimiCoding,
    /// Zhipu GLM ordinary API.
    Glm,
    /// GLM Coding Plan (a separate product line from the ordinary API).
    GlmCoding,
    #[serde(rename = "minimax")]
    MiniMax,
    /// Volcengine Ark (Doubao).
    VolcengineArk,
    #[serde(rename = "xai")]
    Xai,
    Groq,
    Mistral,
    /// Baidu Qianfan model builder v2.
    BaiduQianfan,
    Ollama,
    LmStudio,
    /// Conservative default for user-supplied OpenAI-compatible endpoints.
    #[default]
    Generic,
}

/// How a structured task asks the provider for machine-readable output.
///
/// Whatever the strategy, the reply is always parsed and validated locally
/// against the task schema afterwards: a provider guarantee is never trusted.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum LlmStructuredOutputStrategy {
    /// Native strict JSON Schema (`response_format.json_schema.strict = true`).
    JsonSchemaStrict,
    /// Native JSON Schema without the strict flag.
    JsonSchema,
    /// Request a JSON object only; the schema travels in the system prompt.
    JsonObject,
    /// No provider-side structured field at all; prompt-only, validated locally.
    PromptedJson,
    /// Gemini's native `responseMimeType` + `responseSchema`.
    GeminiSchema,
}

/// Whether a structured task must suppress the provider's reasoning output.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum LlmReasoningPolicy {
    /// Leave the provider's own default alone.
    ProviderDefault,
    /// Structured tasks explicitly disable thinking.
    DisableForStructured,
    /// Structured tasks send `reasoning.effort = none`.
    EffortNoneForStructured,
}

/// How the provider's model catalogue is discovered.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum LlmModelListStrategy {
    /// OpenAI-family candidate derivation from the configured endpoint.
    OpenAiCompatible,
    /// Anthropic `/v1/models`.
    Anthropic,
    /// Gemini `/v1beta/models`.
    Gemini,
    /// No inference-plane catalogue exists; the model id must be entered by hand.
    Unsupported,
}

/// The authentication header a protocol requires. Declared here so the chosen
/// capability is inspectable, but header assembly itself stays in the protocol
/// adapter so it is never duplicated.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum LlmAuthStrategy {
    Bearer,
    XApiKey,
    GeminiKey,
    AzureApiKey,
    /// Local runtimes that need no credential at all.
    None,
}

/// How a base URL is turned into a generation endpoint.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum LlmEndpointStrategy {
    OpenAiChatPath,
    OpenAiResponsesPath,
    AnthropicMessages,
    GeminiGenerateContent,
    AzureDeployment,
}

/// The resolved capability of one (profile, protocol) pair.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LlmCompatibilityPolicy {
    pub profile: LlmCompatibilityProfile,
    pub protocol: LlmProtocolFamily,
    pub structured_output: LlmStructuredOutputStrategy,
    pub reasoning: LlmReasoningPolicy,
    pub model_list: LlmModelListStrategy,
    pub auth: LlmAuthStrategy,
    pub endpoint: LlmEndpointStrategy,
}

impl LlmCompatibilityProfile {
    /// Protocols a user may select for this profile. Anything outside this list
    /// is rejected before a request is built, so an impossible combination can
    /// never reach the network.
    pub const fn supported_protocols(self) -> &'static [LlmProtocolFamily] {
        use LlmProtocolFamily as P;
        match self {
            Self::OpenAi => &[P::OpenAi, P::OpenAiCompatible, P::OpenAiResponses],
            Self::Anthropic => &[P::Anthropic],
            Self::Gemini => &[P::Gemini],
            Self::AzureOpenAi => &[P::AzureOpenAi],
            Self::OpenRouter => &[P::OpenAiCompatible],
            Self::DeepSeek => &[P::OpenAiCompatible, P::OpenAiResponses, P::Anthropic],
            Self::DashScope => &[P::OpenAiCompatible],
            Self::Moonshot => &[P::OpenAiCompatible],
            Self::KimiCoding => &[P::OpenAiCompatible, P::Anthropic],
            Self::Glm => &[P::OpenAiCompatible],
            Self::GlmCoding => &[P::OpenAiCompatible, P::OpenAiResponses, P::Anthropic],
            Self::MiniMax => &[P::OpenAiCompatible],
            Self::VolcengineArk => &[P::OpenAiCompatible, P::OpenAiResponses],
            Self::Xai => &[P::OpenAiCompatible],
            Self::Groq => &[P::OpenAiCompatible],
            Self::Mistral => &[P::OpenAiCompatible],
            Self::BaiduQianfan => &[P::OpenAiCompatible, P::Anthropic],
            Self::Ollama => &[P::OpenAiCompatible],
            Self::LmStudio => &[P::OpenAiCompatible],
            // A hand-written configuration may pick any transport it can
            // actually speak; only the strategies below stay conservative.
            Self::Generic => &[
                P::OpenAi,
                P::OpenAiCompatible,
                P::OpenAiResponses,
                P::Anthropic,
                P::Gemini,
                P::AzureOpenAi,
            ],
        }
    }

    /// True when the profile is the conservative fallback used for
    /// user-supplied endpoints. Only this profile accepts an explicit
    /// structured-output override; built-in profiles own their strategy.
    pub const fn allows_structured_output_override(self) -> bool {
        matches!(self, Self::Generic)
    }

    const fn structured_output(self, protocol: LlmProtocolFamily) -> LlmStructuredOutputStrategy {
        use LlmProtocolFamily as P;
        use LlmStructuredOutputStrategy as S;
        match self {
            Self::OpenAi | Self::AzureOpenAi => S::JsonSchemaStrict,
            // OpenRouter normalises requests itself; its platform-level policy
            // is a strict schema, and unsupported upstreams degrade to plain
            // text that the local validator then rejects honestly.
            Self::OpenRouter | Self::Xai => S::JsonSchemaStrict,
            Self::Groq | Self::Mistral | Self::Ollama | Self::LmStudio => S::JsonSchema,
            Self::Anthropic => S::PromptedJson,
            Self::Gemini => S::GeminiSchema,
            Self::DeepSeek | Self::DashScope | Self::Moonshot | Self::Glm | Self::MiniMax => {
                match protocol {
                    P::Anthropic => S::PromptedJson,
                    _ => S::JsonObject,
                }
            }
            Self::KimiCoding | Self::BaiduQianfan => match protocol {
                P::Anthropic => S::PromptedJson,
                _ => S::JsonObject,
            },
            Self::GlmCoding | Self::VolcengineArk => match protocol {
                P::Anthropic => S::PromptedJson,
                _ => S::JsonObject,
            },
            Self::Generic => match protocol {
                P::Anthropic => S::PromptedJson,
                P::Gemini => S::GeminiSchema,
                // Azure keeps its native strict schema; the remaining
                // OpenAI-shaped transports stay conservative.
                P::AzureOpenAi => S::JsonSchemaStrict,
                _ => S::JsonObject,
            },
        }
    }

    const fn reasoning(self, protocol: LlmProtocolFamily) -> LlmReasoningPolicy {
        use LlmProtocolFamily as P;
        use LlmReasoningPolicy as R;
        match self {
            // Verified against the live service: DeepSeek Chat structured tasks
            // disable thinking, while the Responses surface uses effort=none.
            Self::DeepSeek => match protocol {
                P::OpenAiResponses => R::EffortNoneForStructured,
                P::Anthropic => R::ProviderDefault,
                _ => R::DisableForStructured,
            },
            // Ark documents `thinking: {type: "disabled"}` on the chat surface.
            // Its Responses surface uses a different effort enumeration whose
            // "off" value is not `none`, so nothing is injected there rather
            // than sending a value the gateway may reject.
            Self::VolcengineArk => match protocol {
                P::OpenAiResponses => R::ProviderDefault,
                _ => R::DisableForStructured,
            },
            _ => R::ProviderDefault,
        }
    }

    const fn model_list(self, protocol: LlmProtocolFamily) -> LlmModelListStrategy {
        use LlmModelListStrategy as M;
        use LlmProtocolFamily as P;
        match protocol {
            P::AzureOpenAi => M::Unsupported,
            P::Anthropic => M::Anthropic,
            P::Gemini => M::Gemini,
            _ => M::OpenAiCompatible,
        }
    }

    const fn auth(self, protocol: LlmProtocolFamily) -> LlmAuthStrategy {
        use LlmAuthStrategy as A;
        use LlmProtocolFamily as P;
        match self {
            // Local runtimes run without any credential.
            Self::Ollama | Self::LmStudio => A::None,
            _ => match protocol {
                P::Anthropic => A::XApiKey,
                P::Gemini => A::GeminiKey,
                P::AzureOpenAi => A::AzureApiKey,
                _ => A::Bearer,
            },
        }
    }
}

impl LlmProtocolFamily {
    const fn endpoint_strategy(self) -> LlmEndpointStrategy {
        match self {
            Self::OpenAi | Self::OpenAiCompatible => LlmEndpointStrategy::OpenAiChatPath,
            Self::OpenAiResponses => LlmEndpointStrategy::OpenAiResponsesPath,
            Self::Anthropic => LlmEndpointStrategy::AnthropicMessages,
            Self::Gemini => LlmEndpointStrategy::GeminiGenerateContent,
            Self::AzureOpenAi => LlmEndpointStrategy::AzureDeployment,
        }
    }
}

/// Validates a (profile, protocol) pair plus an optional override, without
/// needing a full runtime profile. Used by configuration validation so an
/// impossible combination is rejected at save time as well as at run time.
pub fn validate_compatibility_selection(
    profile: LlmCompatibilityProfile,
    protocol: LlmProtocolFamily,
    override_strategy: Option<LlmStructuredOutputStrategy>,
) -> AppResult<()> {
    if !profile.supported_protocols().contains(&protocol) {
        return Err(protocol_incompatible(format!(
            "compatibility profile '{profile:?}' does not support protocol '{protocol:?}'"
        )));
    }
    if override_strategy.is_some() && !profile.allows_structured_output_override() {
        return Err(protocol_incompatible(format!(
            "compatibility profile '{profile:?}' owns its structured-output strategy and cannot be overridden"
        )));
    }
    Ok(())
}

/// Resolves the capability policy for one runtime profile and protocol.
///
/// This is the only place that decides a provider's structured output,
/// reasoning, catalogue, auth and endpoint behaviour.
pub fn compatibility_policy(
    profile: &LlmProfile,
    protocol: LlmProtocolFamily,
) -> AppResult<LlmCompatibilityPolicy> {
    let selected = profile.compatibility_profile;
    let override_strategy = profile.structured_output_override;
    validate_compatibility_selection(selected, protocol, override_strategy)?;
    let structured_output = override_strategy
        .filter(|_| selected.allows_structured_output_override())
        .unwrap_or_else(|| selected.structured_output(protocol));
    Ok(LlmCompatibilityPolicy {
        profile: selected,
        protocol,
        structured_output,
        reasoning: selected.reasoning(protocol),
        model_list: selected.model_list(protocol),
        auth: selected.auth(protocol),
        endpoint: protocol.endpoint_strategy(),
    })
}

/// One-time normalisation used when reading records written before the
/// compatibility profile existed.
///
/// Only application-generated built-in preset ids are mapped. Everything else —
/// including a user's own id, a vendor display name or a URL — falls back to
/// `Generic`; the endpoint is never inspected.
pub fn legacy_profile_for_builtin_id(id: &str) -> LlmCompatibilityProfile {
    use LlmCompatibilityProfile as C;
    match id {
        "openai" => C::OpenAi,
        "anthropic" => C::Anthropic,
        "google-gemini" => C::Gemini,
        "azure-openai" => C::AzureOpenAi,
        "openrouter" => C::OpenRouter,
        "deepseek" | "deepseek-anthropic" => C::DeepSeek,
        "alibaba-dashscope" => C::DashScope,
        "moonshot-kimi" => C::Moonshot,
        "kimi-code-openai" | "kimi-code-anthropic" => C::KimiCoding,
        "zhipu-glm" => C::Glm,
        "zhipu-glm-coding-chat" | "zhipu-glm-coding-responses" | "zhipu-glm-coding-anthropic" => {
            C::GlmCoding
        }
        "minimax" => C::MiniMax,
        "volcengine-doubao" => C::VolcengineArk,
        "xai-grok" => C::Xai,
        "groq" => C::Groq,
        "mistral" => C::Mistral,
        "baidu-qianfan" | "baidu-qianfan-anthropic" => C::BaiduQianfan,
        "ollama" => C::Ollama,
        "lm-studio" => C::LmStudio,
        _ => C::Generic,
    }
}

pub(crate) fn protocol_incompatible(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::LlmProtocolIncompatible, Severity::Error)
        .with_param("detail", detail.into())
}
