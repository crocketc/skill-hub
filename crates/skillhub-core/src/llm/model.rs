use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::{AppError, AppResult, ErrorCode, Severity};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CredentialRef {
    pub id: String,
}

impl CredentialRef {
    pub fn new(id: impl Into<String>) -> Self {
        Self { id: id.into() }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct LlmProfile {
    pub id: String,
    pub provider: String,
    pub endpoint: String,
    pub model: String,
    pub credential_ref: Option<CredentialRef>,
    pub timeout_ms: u64,
    pub max_input_bytes: usize,
    #[serde(default)]
    pub protocol: crate::llm::provider::LlmProtocolFamily,
    #[serde(default)]
    pub deployment: crate::llm::provider::LlmDeployment,
    #[serde(default)]
    pub custom_headers: Vec<crate::llm::provider::CustomHeader>,
}

impl LlmProfile {
    pub fn new(
        provider: impl Into<String>,
        endpoint: impl Into<String>,
        model: impl Into<String>,
        credential_ref: Option<CredentialRef>,
    ) -> AppResult<Self> {
        let provider = provider.into();
        let endpoint = endpoint.into();
        let model = model.into();
        if provider.trim().is_empty() || model.trim().is_empty() {
            return Err(invalid_profile("provider_or_model"));
        }
        let profile = Self {
            id: format!("{provider}:{model}"),
            provider,
            endpoint,
            model,
            credential_ref,
            timeout_ms: 30_000,
            max_input_bytes: 256 * 1024,
            protocol: Default::default(),
            deployment: Default::default(),
            custom_headers: Vec::new(),
        };
        profile.validate()?;
        Ok(profile)
    }

    pub fn with_protocol(
        mut self,
        protocol: crate::llm::provider::LlmProtocolFamily,
    ) -> AppResult<Self> {
        self.protocol = protocol;
        self.validate()?;
        Ok(self)
    }

    pub fn with_deployment(
        mut self,
        deployment: crate::llm::provider::LlmDeployment,
    ) -> AppResult<Self> {
        self.deployment = deployment;
        self.validate()?;
        Ok(self)
    }

    pub fn validate(&self) -> AppResult<()> {
        let parsed = Url::parse(&self.endpoint).map_err(|_| invalid_profile("endpoint"))?;
        let host = parsed.host_str().unwrap_or_default();
        let loopback = host.eq_ignore_ascii_case("localhost")
            || host.ends_with(".localhost")
            || host == "[::1]"
            || host.starts_with("127.");
        // Plain http is only ever acceptable on loopback: those addresses are
        // local model services no matter how the deployment flag is set. The
        // user-facing LlmProviderConfig keeps the stricter rule that requires
        // the explicit Local deployment.
        let scheme_ok = match parsed.scheme() {
            "https" => parsed.host_str().is_some(),
            "http" => loopback,
            _ => false,
        };
        if !scheme_ok {
            return Err(AppError::new(
                ErrorCode::LlmEndpointNotAllowed,
                Severity::Error,
            ));
        }
        if self.provider.trim().is_empty() || self.model.trim().is_empty() {
            return Err(invalid_profile("provider_or_model"));
        }
        if self.timeout_ms == 0 || self.max_input_bytes == 0 {
            return Err(invalid_profile("limits"));
        }
        Ok(())
    }

    pub fn with_limits(mut self, timeout_ms: u64, max_input_bytes: usize) -> AppResult<Self> {
        if timeout_ms == 0 || max_input_bytes == 0 {
            return Err(invalid_profile("limits"));
        }
        self.timeout_ms = timeout_ms;
        self.max_input_bytes = max_input_bytes;
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum LlmTaskKind {
    Safety,
    DuplicateAnalysis,
    Translation,
    SearchQuery,
    UsageEvidence,
}

impl LlmTaskKind {
    pub const fn schema_name(self) -> &'static str {
        match self {
            Self::Safety => "skill_safety_v1",
            Self::DuplicateAnalysis => "skill_duplicate_analysis_v1",
            Self::Translation => "skill_translation_v1",
            Self::SearchQuery => "skill_search_query_v1",
            Self::UsageEvidence => "skill_usage_evidence_v1",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LlmTaskRequest {
    pub kind: LlmTaskKind,
    pub input: String,
    pub response_schema: Value,
}

impl LlmTaskRequest {
    pub fn new(kind: LlmTaskKind, input: String, response_schema: Value) -> AppResult<Self> {
        if input.is_empty() || !response_schema.is_object() {
            return Err(invalid_profile("task_request"));
        }
        Ok(Self {
            kind,
            input,
            response_schema,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LlmTaskResponse {
    pub request_id: String,
    pub kind: LlmTaskKind,
    pub output: Value,
}

fn invalid_profile(field: &'static str) -> AppError {
    AppError::new(ErrorCode::InvalidInput, Severity::Error).with_param("field", field)
}
