use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};
use std::sync::Arc;

use skillhub_core::llm::{
    CredentialStore, LlmProfile, LlmTaskRequest, LlmTaskResponse, LlmTaskRunner,
};
use skillhub_core::{AppError, AppResult, ErrorCode, OperationId, RecoveryAction, Severity};

pub struct HttpLlmTaskRunner {
    credentials: Arc<dyn CredentialStore>,
}

impl HttpLlmTaskRunner {
    pub fn new<S>(credentials: Arc<S>) -> Self
    where
        S: CredentialStore + 'static,
    {
        Self {
            credentials: credentials as Arc<dyn CredentialStore>,
        }
    }

    pub fn build_payload(profile: &LlmProfile, request: &LlmTaskRequest) -> AppResult<Value> {
        profile.validate()?;
        validate_input_size(profile, request)?;
        Ok(json!({
            "model": profile.model,
            "messages": [
                {"role": "system", "content": "Return only JSON matching the supplied schema."},
                {"role": "user", "content": request.input},
            ],
            "temperature": 0,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": request.kind.schema_name(),
                    "strict": true,
                    "schema": request.response_schema,
                }
            }
        }))
    }

    pub fn parse_response(
        _profile: &LlmProfile,
        request: &LlmTaskRequest,
        response: Value,
    ) -> AppResult<LlmTaskResponse> {
        let content = response
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .ok_or_else(invalid_response)?;
        let output: Value = serde_json::from_str(content).map_err(|_| invalid_response())?;
        if !output.is_object() {
            return Err(invalid_response());
        }
        Ok(LlmTaskResponse {
            request_id: OperationId::new().to_string(),
            kind: request.kind,
            output,
        })
    }

    pub fn redact_input(input: &str, secret: &str) -> String {
        if secret.is_empty() {
            return input.to_owned();
        }
        input.replace(secret, "[REDACTED]")
    }
}

#[async_trait(?Send)]
impl LlmTaskRunner for HttpLlmTaskRunner {
    async fn run(
        &self,
        profile: &LlmProfile,
        request: LlmTaskRequest,
    ) -> AppResult<LlmTaskResponse> {
        profile.validate()?;
        let secret = profile
            .credential_ref
            .as_ref()
            .ok_or_else(credential_unavailable)?;
        let token = self
            .credentials
            .get(secret)
            .await?
            .ok_or_else(credential_unavailable)?;
        let mut request = request;
        request.input = Self::redact_input(&request.input, &token);
        let payload = Self::build_payload(profile, &request)?;
        let client = Client::builder()
            .timeout(std::time::Duration::from_millis(profile.timeout_ms))
            .no_proxy()
            .build()
            .map_err(|error| transport_error(error.to_string()))?;
        let response = client
            .post(&profile.endpoint)
            .bearer_auth(token)
            .json(&payload)
            .send()
            .await
            .map_err(|error| transport_error(error.to_string()))?;
        if !response.status().is_success() {
            return Err(transport_error(format!(
                "HTTP status {}",
                response.status()
            )));
        }
        let body = response
            .json::<Value>()
            .await
            .map_err(|error| invalid_response_with_source(error.to_string()))?;
        Self::parse_response(profile, &request, body)
    }
}

fn validate_input_size(profile: &LlmProfile, request: &LlmTaskRequest) -> AppResult<()> {
    if request.input.len() > profile.max_input_bytes {
        return Err(AppError::new(ErrorCode::LlmInputTooLarge, Severity::Error)
            .with_param("max_input_bytes", profile.max_input_bytes));
    }
    Ok(())
}

fn credential_unavailable() -> AppError {
    AppError::new(ErrorCode::CredentialUnavailable, Severity::Error)
        .with_action(RecoveryAction::ConfigureCredential)
}

fn invalid_response() -> AppError {
    AppError::new(ErrorCode::LlmInvalidStructuredResponse, Severity::Error)
        .with_action(RecoveryAction::Retry)
}

fn invalid_response_with_source(source: String) -> AppError {
    invalid_response().with_param("source", source)
}

fn transport_error(source: String) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", source)
        .with_action(RecoveryAction::Retry)
}
