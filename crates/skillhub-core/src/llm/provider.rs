use serde::{Deserialize, Serialize};
use url::Url;

use crate::{AppError, AppResult, ErrorCode, Severity};

use super::model::CredentialRef;

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
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_max_input_bytes")]
    pub max_input_bytes: usize,
}

fn default_true() -> bool {
    true
}
fn default_timeout_ms() -> u64 {
    30_000
}
fn default_max_input_bytes() -> usize {
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

    pub fn with_limits(mut self, timeout_ms: u64, max_input_bytes: usize) -> AppResult<Self> {
        if timeout_ms == 0 || max_input_bytes == 0 {
            return Err(invalid_input("limits"));
        }
        self.timeout_ms = timeout_ms;
        self.max_input_bytes = max_input_bytes;
        Ok(self)
    }

    /// Endpoint rules: online providers must use https; local models may use
    /// plain http only on loopback addresses so LAN plaintext is rejected.
    pub fn validate(&self) -> AppResult<()> {
        let parsed = Url::parse(&self.endpoint)
            .map_err(|_| endpoint_not_allowed("endpoint_unparsable"))?;
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
                let loopback = host.eq_ignore_ascii_case("localhost")
                    || host.ends_with(".localhost")
                    || host == "[::1]"
                    || host.starts_with("127.");
                if parsed.scheme() == "http" && !loopback {
                    return Err(endpoint_not_allowed("local_http_requires_loopback"));
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
        Ok(())
    }
}

fn endpoint_not_allowed(reason: &'static str) -> AppError {
    AppError::new(ErrorCode::LlmEndpointNotAllowed, Severity::Error)
        .with_param("reason", reason)
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
}

const API_DOCS_TOS: &str = "https://platform.openai.com/docs/api-reference";
const ANTHROPIC_DOCS: &str = "https://docs.anthropic.com/en/api/messages";
const GEMINI_DOCS: &str = "https://ai.google.dev/api/generate-content";
const AZURE_DOCS: &str =
    "https://learn.microsoft.com/azure/ai-services/openai/reference";
const OPENROUTER_DOCS: &str = "https://openrouter.ai/docs/api-reference/overview";
const DEEPSEEK_DOCS: &str = "https://api-docs.deepseek.com/";
const DASHSCOPE_DOCS: &str =
    "https://www.alibabacloud.com/help/en/model-studio/getting-started/models";
const MOONSHOT_DOCS: &str = "https://platform.moonshot.cn/docs/api/chat";
const GLM_DOCS: &str = "https://docs.bigmodel.cn/cn/guide/start/model-overview";
const MINIMAX_DOCS: &str = "https://platform.minimaxi.com/en/document/Announcement";
const ARK_DOCS: &str =
    "https://www.volcengine.com/docs/82379/1330621";
const XAI_DOCS: &str = "https://docs.x.ai/docs/api-reference";
const OLLAMA_DOCS: &str = "https://github.com/ollama/ollama/blob/main/docs/openai.md";
const LMSTUDIO_DOCS: &str = "https://lmstudio.ai/docs/app/api/endpoints/openai";

/// The confirmed provider baseline. Order is presentation-neutral: the
/// settings UI groups by deployment and protocol without any commercial
/// promotion (no sponsor ordering is reproduced from reference projects).
pub fn builtin_provider_presets() -> Vec<LlmProviderPreset> {
    use LlmDeployment::{Local, Online};
    use LlmProtocolFamily::{Anthropic, AzureOpenAi, Gemini, OpenAi, OpenAiCompatible};
    vec![
        LlmProviderPreset {
            id: "openai".into(),
            label: "OpenAI".into(),
            protocol: OpenAi,
            deployment: Online,
            endpoint: "https://api.openai.com/v1".into(),
            requires_credential: true,
            models_hint: None,
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
            api_docs_url: Some(OPENROUTER_DOCS.into()),
        },
        LlmProviderPreset {
            id: "deepseek".into(),
            label: "DeepSeek".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: "https://api.deepseek.com/v1".into(),
            requires_credential: true,
            models_hint: None,
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
            api_docs_url: Some(DASHSCOPE_DOCS.into()),
        },
        LlmProviderPreset {
            id: "moonshot-kimi".into(),
            label: "Moonshot Kimi".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: "https://api.moonshot.cn/v1".into(),
            requires_credential: true,
            models_hint: None,
            api_docs_url: Some(MOONSHOT_DOCS.into()),
        },
        LlmProviderPreset {
            id: "zhipu-glm".into(),
            label: "Zhipu GLM".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: "https://open.bigmodel.cn/api/paas/v4".into(),
            requires_credential: true,
            models_hint: None,
            api_docs_url: Some(GLM_DOCS.into()),
        },
        LlmProviderPreset {
            id: "minimax".into(),
            label: "MiniMax".into(),
            protocol: OpenAiCompatible,
            deployment: Online,
            endpoint: "https://api.minimaxi.com/v1".into(),
            requires_credential: true,
            models_hint: None,
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
            api_docs_url: Some(XAI_DOCS.into()),
        },
        LlmProviderPreset {
            id: "ollama".into(),
            label: "Ollama (local)".into(),
            protocol: OpenAiCompatible,
            deployment: Local,
            endpoint: "http://127.0.0.1:11434/v1".into(),
            requires_credential: false,
            models_hint: None,
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
            api_docs_url: None,
        },
    ]
}
