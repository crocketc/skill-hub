use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::{AppError, AppResult, ErrorCode, Severity};

use super::provider::local_http_host_allowed;

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
    /// Supplier behaviour selector. Defaults to the conservative Generic
    /// profile so a profile deserialised from older data never invents vendor
    /// behaviour from its endpoint.
    #[serde(default)]
    pub compatibility_profile: crate::llm::compatibility::LlmCompatibilityProfile,
    /// Only the Generic profile accepts an explicit override; built-in
    /// profiles own their strategy.
    #[serde(default)]
    pub structured_output_override: Option<crate::llm::compatibility::LlmStructuredOutputStrategy>,
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
            compatibility_profile: Default::default(),
            structured_output_override: None,
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
        self.validate_model_listing()?;
        if self.model.trim().is_empty() {
            return Err(invalid_profile("provider_or_model"));
        }
        Ok(())
    }

    /// Validates the information needed to contact a provider's model-list
    /// endpoint. This deliberately does not require `model`: the list is what
    /// lets a user choose that value in the first place.
    pub fn validate_model_listing(&self) -> AppResult<()> {
        let parsed = Url::parse(&self.endpoint).map_err(|_| invalid_profile("endpoint"))?;
        let host = parsed.host_str().unwrap_or_default();
        // Plain http is only acceptable for local/private/link-local model
        // services. The user-facing LlmProviderConfig additionally requires
        // the explicit Local deployment for non-HTTPS endpoints.
        let scheme_ok = match parsed.scheme() {
            "https" => parsed.host_str().is_some(),
            "http" => local_http_host_allowed(host),
            _ => false,
        };
        if !scheme_ok {
            return Err(AppError::new(
                ErrorCode::LlmEndpointNotAllowed,
                Severity::Error,
            ));
        }
        if self.provider.trim().is_empty() {
            return Err(invalid_profile("provider_or_model"));
        }
        if self.timeout_ms == 0 || self.max_input_bytes == 0 {
            return Err(invalid_profile("limits"));
        }
        // A profile whose compatibility profile cannot speak its protocol is
        // rejected here, so no incompatible pair can ever reach a request.
        super::compatibility::validate_compatibility_selection(
            self.compatibility_profile,
            self.protocol,
            self.structured_output_override,
        )?;
        Ok(())
    }

    /// Resolved capability policy for this profile's own protocol.
    pub fn compatibility_policy(&self) -> AppResult<super::compatibility::LlmCompatibilityPolicy> {
        super::compatibility::compatibility_policy(self, self.protocol)
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
