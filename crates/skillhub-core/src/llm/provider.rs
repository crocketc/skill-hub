use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use url::Url;

use crate::{AppError, AppResult, ErrorCode, Severity};

use super::compatibility::{
    validate_compatibility_selection, LlmCompatibilityProfile, LlmStructuredOutputStrategy,
};
use super::model::{CredentialRef, LlmProfile};

/// Wire protocol spoken by a provider. Vendor differences are confined here.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum LlmProtocolFamily {
    /// OpenAI's own service (`https://api.openai.com/v1`).
    OpenAi,
    /// OpenAI chat-completions shaped services: aggregators, DeepSeek, Qwen,
    /// Moonshot, GLM, MiniMax, Doubao, Grok, LM Studio and custom gateways.
    #[default]
    OpenAiCompatible,
    /// OpenAI Responses API (`/responses`), also used by compatible routers.
    OpenAiResponses,
    /// Anthropic Messages protocol (`/v1/messages`, `x-api-key`).
    Anthropic,
    /// Google Generative Language protocol (`:generateContent`).
    Gemini,
    /// Azure OpenAI deployment-scoped addressing (`api-key` header).
    AzureOpenAi,
}

/// Whether a provider runs in the cloud (network switch and cost hints apply)
/// or on this machine (offline inference, no credential normally required).
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum LlmDeployment {
    #[default]
    Online,
    Local,
}

const MAX_CUSTOM_HEADERS: usize = 16;
const MAX_HEADER_NAME_BYTES: usize = 128;
const MAX_HEADER_VALUE_BYTES: usize = 8 * 1024;

/// A single user-configured request header. Sensitive values are never stored
/// in the configuration: they live in the OS credential store behind
/// `credential_ref`, keeping the database free of secret material.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CustomHeader {
    pub name: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub credential_ref: Option<CredentialRef>,
    pub sensitive: bool,
}

impl CustomHeader {
    pub fn new(
        name: impl Into<String>,
        value: impl Into<String>,
        sensitive: bool,
    ) -> AppResult<Self> {
        let name = name.into();
        Self::validate_name(&name)?;
        let value = value.into();
        if value.len() > MAX_HEADER_VALUE_BYTES {
            return Err(invalid_input("header_value_too_large"));
        }
        if sensitive {
            return Err(invalid_input("sensitive_value_requires_credential_ref"));
        }
        Ok(Self {
            name,
            value: Some(value),
            credential_ref: None,
            sensitive,
        })
    }

    /// A sensitive header keeps only a credential reference.
    pub fn sensitive(name: impl Into<String>, credential_ref: CredentialRef) -> AppResult<Self> {
        let name = name.into();
        Self::validate_name(&name)?;
        Ok(Self {
            name,
            value: None,
            credential_ref: Some(credential_ref),
            sensitive: true,
        })
    }

    fn validate_name(name: &str) -> AppResult<()> {
        if name.is_empty() || name.len() > MAX_HEADER_NAME_BYTES {
            return Err(invalid_input("header_name"));
        }
        let valid = name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
        if !valid {
            return Err(invalid_input("header_name"));
        }
        Ok(())
    }
}

/// A user-managed provider configuration. This is the persistence-facing
/// counterpart of [`super::model::LlmProfile`]: stable identity across model
/// changes, explicit protocol/deployment and an enable flag, while the runtime
/// profile stays the narrow per-task view.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct LlmProviderConfig {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    pub protocol: LlmProtocolFamily,
    pub deployment: LlmDeployment,
    pub endpoint: String,
    pub model: String,
    #[serde(default)]
    pub credential_ref: Option<CredentialRef>,
    #[serde(default)]
    pub custom_headers: Vec<CustomHeader>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    // u32 keeps the generated TypeScript contract free of BigInt-only types.
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u32,
    #[serde(default = "default_max_input_bytes")]
    pub max_input_bytes: u32,
    /// Supplier behaviour selector. Older records deserialise to `Generic`;
    /// the storage layer normalises known built-in ids once on read.
    #[serde(default)]
    pub compatibility_profile: LlmCompatibilityProfile,
    /// Present only for the Generic profile, where the user may choose the
    /// structured-output mechanism explicitly.
    #[serde(default)]
    pub structured_output_override: Option<LlmStructuredOutputStrategy>,
}

fn default_true() -> bool {
    true
}
fn default_timeout_ms() -> u32 {
    30_000
}
fn default_max_input_bytes() -> u32 {
    256 * 1024
}

impl LlmProviderConfig {
    pub fn new(
        id: impl Into<String>,
        label: impl Into<String>,
        protocol: LlmProtocolFamily,
        deployment: LlmDeployment,
        endpoint: impl Into<String>,
        model: impl Into<String>,
        credential_ref: Option<CredentialRef>,
    ) -> AppResult<Self> {
        let id = id.into();
        let label = label.into();
        let endpoint = endpoint.into();
        let model = model.into();
        if id.trim().is_empty() || model.trim().is_empty() {
            return Err(invalid_input("provider_or_model"));
        }
        if id.bytes().any(|b| b.is_ascii_control() || b == b':') {
            return Err(invalid_input("provider_id"));
        }
        let config = Self {
            id,
            label: if label.trim().is_empty() {
                None
            } else {
                Some(label)
            },
            protocol,
            deployment,
            endpoint,
            model,
            credential_ref,
            custom_headers: Vec::new(),
            enabled: true,
            timeout_ms: default_timeout_ms(),
            max_input_bytes: default_max_input_bytes(),
            compatibility_profile: LlmCompatibilityProfile::default(),
            structured_output_override: None,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn with_header(mut self, header: CustomHeader) -> AppResult<Self> {
        if self.custom_headers.len() >= MAX_CUSTOM_HEADERS {
            return Err(invalid_input("too_many_custom_headers"));
        }
        if self
            .custom_headers
            .iter()
            .any(|existing| existing.name.eq_ignore_ascii_case(&header.name))
        {
            return Err(invalid_input("duplicate_header_name"));
        }
        self.custom_headers.push(header);
        Ok(self)
    }

    pub fn with_limits(mut self, timeout_ms: u32, max_input_bytes: u32) -> AppResult<Self> {
        if timeout_ms == 0 || max_input_bytes == 0 {
            return Err(invalid_input("limits"));
        }
        self.timeout_ms = timeout_ms;
        self.max_input_bytes = max_input_bytes;
        Ok(self)
    }

    /// Endpoint rules: online providers must use https; local models may use
    /// plain http only on loopback, private-network, or link-local addresses.
    /// This keeps local services such as Ollama and LM Studio usable over a
    /// user's LAN without allowing arbitrary public plaintext endpoints.
    pub fn validate(&self) -> AppResult<()> {
        let parsed =
            Url::parse(&self.endpoint).map_err(|_| endpoint_not_allowed("endpoint_unparsable"))?;
        let host = parsed
            .host_str()
            .ok_or_else(|| endpoint_not_allowed("endpoint_host"))?;
        match self.deployment {
            LlmDeployment::Online => {
                if parsed.scheme() != "https" {
                    return Err(endpoint_not_allowed("online_requires_https"));
                }
            }
            LlmDeployment::Local => {
                if parsed.scheme() == "http" && !local_http_host_allowed(host) {
                    return Err(endpoint_not_allowed("local_http_requires_trusted_network"));
                }
                if parsed.scheme() != "http" && parsed.scheme() != "https" {
                    return Err(endpoint_not_allowed("endpoint_scheme"));
                }
            }
        }
        if self.model.trim().is_empty() || self.id.trim().is_empty() {
            return Err(invalid_input("provider_or_model"));
        }
        if self.timeout_ms == 0 || self.max_input_bytes == 0 {
            return Err(invalid_input("limits"));
        }
        // Persisted configurations carry the same capability contract as the
        // runtime profile: an impossible (profile, protocol) pair, or an
        // override on a built-in profile, is refused at save time too.
        validate_compatibility_selection(
            self.compatibility_profile,
            self.protocol,
            self.structured_output_override,
        )?;
        Ok(())
    }
}

/// Plain HTTP is allowed for local deployments only when the destination is
/// unambiguously local to the machine or its private/link-local network.
/// Public DNS names, public IP addresses, and unspecified addresses remain
/// disallowed so a Local flag cannot silently turn into an arbitrary HTTP
/// client.
pub(crate) fn local_http_host_allowed(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return true;
    }

    // `url::Url::host_str()` is normally bracket-free for IPv6, but accepting
    // the bracketed form here keeps the helper correct for callers that pass
    // the URL host representation directly.
    let normalized_host = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);

    match normalized_host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            address.is_loopback() || is_private_ipv4(address) || address.is_link_local()
        }
        Ok(IpAddr::V6(address)) => {
            address.is_loopback() || is_unique_local_ipv6(address) || is_link_local_ipv6(address)
        }
        Err(_) => false,
    }
}

fn is_private_ipv4(address: std::net::Ipv4Addr) -> bool {
    let [first, second, ..] = address.octets();
    first == 10 || (first == 172 && (16..=31).contains(&second)) || (first == 192 && second == 168)
}

fn is_unique_local_ipv6(address: std::net::Ipv6Addr) -> bool {
    address.octets()[0] & 0xfe == 0xfc
}

fn is_link_local_ipv6(address: std::net::Ipv6Addr) -> bool {
    let [first, second, ..] = address.octets();
    first == 0xfe && (0x80..=0xbf).contains(&second)
}

impl LlmProviderConfig {
    /// Derives the runtime task profile from this configuration. The
    /// protocol, deployment and custom headers ride along so the HTTP runner
    /// can dispatch to the right adapter.
    pub fn to_profile(&self) -> AppResult<LlmProfile> {
        let mut profile = LlmProfile::new(
            self.id.clone(),
            self.endpoint.clone(),
            self.model.clone(),
            self.credential_ref.clone(),
        )?;
        profile.protocol = self.protocol;
        profile.deployment = self.deployment;
        profile.compatibility_profile = self.compatibility_profile;
        profile.structured_output_override = self.structured_output_override;
        profile.timeout_ms = u64::from(self.timeout_ms);
        profile.max_input_bytes = self.max_input_bytes as usize;
        profile.custom_headers = self.custom_headers.clone();
        profile.validate()?;
        Ok(profile)
    }

    /// Builds the narrower profile used to fetch available models. Unlike a
    /// task profile, this permits an empty `model` because that is the field
    /// the model-list request is intended to populate.
    pub fn to_model_listing_profile(&self) -> AppResult<LlmProfile> {
        let profile = LlmProfile {
            id: format!("{}:model-list", self.id),
            provider: self.id.clone(),
            endpoint: self.endpoint.clone(),
            model: self.model.clone(),
            credential_ref: self.credential_ref.clone(),
            timeout_ms: self.timeout_ms.into(),
            max_input_bytes: self.max_input_bytes as usize,
            protocol: self.protocol,
            deployment: self.deployment,
            custom_headers: self.custom_headers.clone(),
            compatibility_profile: self.compatibility_profile,
            structured_output_override: self.structured_output_override,
        };
        profile.validate_model_listing()?;
        Ok(profile)
    }
}

/// A listed provider configuration with UI-facing status fields. The secret
/// value itself never leaves the OS credential store.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct LlmProviderView {
    pub config: LlmProviderConfig,
    #[serde(default)]
    pub credential_configured: bool,
    pub is_default: bool,
}

fn endpoint_not_allowed(reason: &'static str) -> AppError {
    AppError::new(ErrorCode::LlmEndpointNotAllowed, Severity::Error).with_param("reason", reason)
}

fn invalid_input(field: &'static str) -> AppError {
    AppError::new(ErrorCode::InvalidInput, Severity::Error).with_param("field", field)
}

/// A built-in provider suggestion. Presets describe the protocol, deployment
/// and default endpoint only: they never ship a model catalogue, because the
/// model identifier must come from the provider's model-list endpoint or from
/// manual input (requirement 5.42, US-047).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct LlmProviderPreset {
    pub id: String,
    pub label: String,
    pub protocol: LlmProtocolFamily,
    pub deployment: LlmDeployment,
    pub endpoint: String,
    pub requires_credential: bool,
    #[serde(default)]
    pub models_hint: Option<String>,
    #[serde(default)]
    pub api_docs_url: Option<String>,
    /// The product line's capability profile. Two presets that bill, ship a
    /// different key or serve a different endpoint must never share one.
    #[serde(default)]
    pub compatibility_profile: LlmCompatibilityProfile,
    /// Interface formats the settings page may offer for this preset. The
    /// default protocol is always a member; switching format never rewrites
    /// the user's endpoint, model or credential.
    #[serde(default)]
    pub supported_protocols: Vec<LlmProtocolFamily>,
}

const API_DOCS_TOS: &str = "https://platform.openai.com/docs/api-reference";
const ANTHROPIC_DOCS: &str = "https://docs.anthropic.com/en/api/messages";
const GEMINI_DOCS: &str = "https://ai.google.dev/api/generate-content";
const AZURE_DOCS: &str = "https://learn.microsoft.com/azure/ai-services/openai/reference";
const OPENROUTER_DOCS: &str = "https://openrouter.ai/docs/api-reference/overview";
const DEEPSEEK_DOCS: &str = "https://api-docs.deepseek.com/";
const DASHSCOPE_DOCS: &str =
    "https://www.alibabacloud.com/help/en/model-studio/getting-started/models";
const MOONSHOT_DOCS: &str = "https://platform.moonshot.cn/docs/api/chat";
const GLM_DOCS: &str = "https://docs.bigmodel.cn/cn/guide/start/model-overview";
const MINIMAX_DOCS: &str = "https://platform.minimaxi.com/en/document/Announcement";
const ARK_DOCS: &str = "https://www.volcengine.com/docs/82379/1330621";
const XAI_DOCS: &str = "https://docs.x.ai/docs/api-reference";
const GROQ_DOCS: &str = "https://console.groq.com/docs/openai";
const MISTRAL_DOCS: &str = "https://docs.mistral.ai/api";
const QIANFAN_DOCS: &str = "https://cloud.baidu.com/doc/qianfan";
const OLLAMA_DOCS: &str = "https://github.com/ollama/ollama/blob/main/docs/openai.md";
const LMSTUDIO_DOCS: &str = "https://lmstudio.ai/docs/app/api/endpoints/openai";

/// The confirmed provider baseline. Order is presentation-neutral: the
/// settings UI groups by deployment and protocol without any commercial
/// promotion (no sponsor ordering is reproduced from reference projects).
pub fn builtin_provider_presets() -> Vec<LlmProviderPreset> {
    use LlmDeployment::{Local, Online};
    use LlmProtocolFamily::{
        Anthropic, AzureOpenAi, Gemini, OpenAi, OpenAiCompatible, OpenAiResponses,
    };
    vec![
        LlmProviderPreset {
            id: "openai".into(),
            label: "OpenAI".into(),
            // The visible settings format follows cc-switch's OpenAI Chat
            // format; keep the legacy OpenAi variant only for old stored data.
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: "https://api.openai.com/v1".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::OpenAi,
            supported_protocols: vec![OpenAi, OpenAiCompatible, OpenAiResponses],
            api_docs_url: Some(API_DOCS_TOS.into()),
        },
        LlmProviderPreset {
            id: "anthropic".into(),
            label: "Anthropic Claude".into(),
            protocol: Anthropic,
            deployment: Online,
            endpoint: "https://api.anthropic.com".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::Anthropic,
            supported_protocols: vec![Anthropic],
            api_docs_url: Some(ANTHROPIC_DOCS.into()),
        },
        LlmProviderPreset {
            id: "google-gemini".into(),
            label: "Google Gemini".into(),
            protocol: Gemini,
            deployment: Online,
            endpoint: "https://generativelanguage.googleapis.com".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::Gemini,
            supported_protocols: vec![Gemini],
            api_docs_url: Some(GEMINI_DOCS.into()),
        },
        LlmProviderPreset {
            id: "azure-openai".into(),
            label: "Azure OpenAI".into(),
            protocol: AzureOpenAi,
            deployment: Online,
            // Resource-scoped: the user replaces the placeholder host.
            endpoint: "https://YOUR-RESOURCE-NAME.openai.azure.com".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::AzureOpenAi,
            supported_protocols: vec![AzureOpenAi],
            api_docs_url: Some(AZURE_DOCS.into()),
        },
        LlmProviderPreset {
            id: "openrouter".into(),
            label: "OpenRouter".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: "https://openrouter.ai/api/v1".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::OpenRouter,
            supported_protocols: vec![OpenAiCompatible],
            api_docs_url: Some(OPENROUTER_DOCS.into()),
        },
        LlmProviderPreset {
            id: "deepseek".into(),
            label: "DeepSeek API (OpenAI)".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            // cc-switch uses the provider root: chat is /chat/completions and
            // the model catalogue is the separate /models endpoint.
            endpoint: "https://api.deepseek.com".into(),
            requires_credential: true,
            models_hint: Some("deepseek-flash, deepseek-v4-pro".into()),
            compatibility_profile: LlmCompatibilityProfile::DeepSeek,
            supported_protocols: vec![OpenAiCompatible, OpenAiResponses],
            api_docs_url: Some(DEEPSEEK_DOCS.into()),
        },
        LlmProviderPreset {
            id: "deepseek-anthropic".into(),
            label: "DeepSeek API (Anthropic)".into(),
            protocol: Anthropic,
            deployment: Online,
            endpoint: "https://api.deepseek.com/anthropic".into(),
            requires_credential: true,
            models_hint: Some("deepseek-flash, deepseek-v4-pro".into()),
            compatibility_profile: LlmCompatibilityProfile::DeepSeek,
            supported_protocols: vec![Anthropic],
            api_docs_url: Some(DEEPSEEK_DOCS.into()),
        },
        LlmProviderPreset {
            id: "alibaba-dashscope".into(),
            label: "Alibaba Cloud Model Studio (Qwen)".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::DashScope,
            supported_protocols: vec![OpenAiCompatible],
            api_docs_url: Some(DASHSCOPE_DOCS.into()),
        },
        LlmProviderPreset {
            id: "moonshot-kimi".into(),
            label: "Kimi Open Platform".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: "https://api.moonshot.cn/v1".into(),
            requires_credential: true,
            models_hint: Some("kimi-k3".into()),
            compatibility_profile: LlmCompatibilityProfile::Moonshot,
            supported_protocols: vec![OpenAiCompatible],
            api_docs_url: Some(MOONSHOT_DOCS.into()),
        },
        LlmProviderPreset {
            id: "kimi-code-openai".into(),
            label: "Kimi Code (OpenAI)".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: "https://api.kimi.com/coding/v1".into(),
            requires_credential: true,
            models_hint: Some("kimi-for-coding, k3, k2.8-preview".into()),
            compatibility_profile: LlmCompatibilityProfile::KimiCoding,
            supported_protocols: vec![OpenAiCompatible],
            api_docs_url: Some(MOONSHOT_DOCS.into()),
        },
        LlmProviderPreset {
            id: "kimi-code-anthropic".into(),
            label: "Kimi Code (Anthropic)".into(),
            protocol: Anthropic,
            deployment: Online,
            endpoint: "https://api.kimi.com/coding".into(),
            requires_credential: true,
            models_hint: Some("kimi-for-coding, k3, k2.8-preview".into()),
            compatibility_profile: LlmCompatibilityProfile::KimiCoding,
            supported_protocols: vec![Anthropic],
            api_docs_url: Some(MOONSHOT_DOCS.into()),
        },
        LlmProviderPreset {
            id: "zhipu-glm".into(),
            label: "Zhipu GLM API (OpenAI)".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: "https://open.bigmodel.cn/api/paas/v4".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::Glm,
            supported_protocols: vec![OpenAiCompatible],
            api_docs_url: Some(GLM_DOCS.into()),
        },
        LlmProviderPreset {
            id: "zhipu-glm-coding-chat".into(),
            label: "GLM Coding Plan (OpenAI Chat)".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: "https://open.bigmodel.cn/api/coding/paas/v4".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::GlmCoding,
            // The Coding Plan separates its three surfaces onto three base
            // URLs. The chat base must never receive a `/responses` suffix:
            // that path is a strict legacy gateway. Responses and Anthropic
            // have their own presets below.
            supported_protocols: vec![OpenAiCompatible],
            api_docs_url: Some(GLM_DOCS.into()),
        },
        LlmProviderPreset {
            id: "zhipu-glm-coding-responses".into(),
            label: "GLM Coding Plan (OpenAI Responses)".into(),
            protocol: OpenAiResponses,
            deployment: Online,
            endpoint: "https://open.bigmodel.cn/api/v1".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::GlmCoding,
            supported_protocols: vec![OpenAiResponses],
            api_docs_url: Some(GLM_DOCS.into()),
        },
        LlmProviderPreset {
            id: "zhipu-glm-coding-anthropic".into(),
            label: "GLM Coding Plan (Anthropic)".into(),
            protocol: Anthropic,
            deployment: Online,
            endpoint: "https://open.bigmodel.cn/api/anthropic".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::GlmCoding,
            supported_protocols: vec![Anthropic],
            api_docs_url: Some(GLM_DOCS.into()),
        },
        LlmProviderPreset {
            id: "minimax".into(),
            label: "MiniMax".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            // Official API hosts are api.minimax.io (international) and
            // api.minimax.cn (China); minimaxi.com is the docs domain only.
            endpoint: "https://api.minimax.io/v1".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::MiniMax,
            supported_protocols: vec![OpenAiCompatible],
            api_docs_url: Some(MINIMAX_DOCS.into()),
        },
        LlmProviderPreset {
            id: "volcengine-doubao".into(),
            label: "Volcengine Ark (Doubao)".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: "https://ark.cn-beijing.volces.com/api/v3".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::VolcengineArk,
            supported_protocols: vec![OpenAiCompatible, OpenAiResponses],
            api_docs_url: Some(ARK_DOCS.into()),
        },
        LlmProviderPreset {
            id: "xai-grok".into(),
            label: "xAI Grok".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: "https://api.x.ai/v1".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::Xai,
            supported_protocols: vec![OpenAiCompatible],
            api_docs_url: Some(XAI_DOCS.into()),
        },
        LlmProviderPreset {
            id: "groq".into(),
            label: "Groq".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: "https://api.groq.com/openai/v1".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::Groq,
            supported_protocols: vec![OpenAiCompatible],
            api_docs_url: Some(GROQ_DOCS.into()),
        },
        LlmProviderPreset {
            id: "mistral".into(),
            label: "Mistral AI".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: "https://api.mistral.ai/v1".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::Mistral,
            supported_protocols: vec![OpenAiCompatible],
            api_docs_url: Some(MISTRAL_DOCS.into()),
        },
        LlmProviderPreset {
            id: "baidu-qianfan".into(),
            label: "Baidu Qianfan (OpenAI)".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: "https://qianfan.baidubce.com/v2".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::BaiduQianfan,
            supported_protocols: vec![OpenAiCompatible],
            api_docs_url: Some(QIANFAN_DOCS.into()),
        },
        LlmProviderPreset {
            id: "baidu-qianfan-anthropic".into(),
            label: "Baidu Qianfan (Anthropic)".into(),
            protocol: Anthropic,
            deployment: Online,
            endpoint: "https://qianfan.baidubce.com/anthropic".into(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::BaiduQianfan,
            supported_protocols: vec![Anthropic],
            api_docs_url: Some(QIANFAN_DOCS.into()),
        },
        LlmProviderPreset {
            id: "ollama".into(),
            label: "Ollama (local)".into(),
            protocol: OpenAiCompatible,
            deployment: Local,
            endpoint: "http://127.0.0.1:11434/v1".into(),
            requires_credential: false,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::Ollama,
            supported_protocols: vec![OpenAiCompatible],
            api_docs_url: Some(OLLAMA_DOCS.into()),
        },
        LlmProviderPreset {
            id: "lm-studio".into(),
            label: "LM Studio (local)".into(),
            protocol: OpenAiCompatible,
            deployment: Local,
            endpoint: "http://127.0.0.1:1234/v1".into(),
            requires_credential: false,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::LmStudio,
            supported_protocols: vec![OpenAiCompatible],
            api_docs_url: Some(LMSTUDIO_DOCS.into()),
        },
        LlmProviderPreset {
            id: "custom-openai-compatible".into(),
            label: "Custom OpenAI-compatible service".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: String::new(),
            requires_credential: true,
            models_hint: None,
            compatibility_profile: LlmCompatibilityProfile::Generic,
            supported_protocols: vec![
                OpenAi,
                OpenAiCompatible,
                OpenAiResponses,
                Anthropic,
                Gemini,
                AzureOpenAi,
            ],
            api_docs_url: None,
        },
    ]
}
