use crate::{AppError, ErrorCode, RecoveryAction, Severity};

use super::model::LlmTaskKind;

/// Canonical constructors for the LLM failure taxonomy. Protocol adapters and
/// the HTTP runner must raise failures through these helpers so error codes,
/// severities and recovery actions stay consistent across providers.
impl AppError {
    pub fn llm_auth_failed() -> Self {
        AppError::new(ErrorCode::LlmAuthFailed, Severity::Error)
            .with_action(RecoveryAction::Reauthenticate)
            .with_action(RecoveryAction::Retry)
    }

    pub fn llm_model_not_found(model: impl Into<String>) -> Self {
        AppError::new(ErrorCode::LlmModelNotFound, Severity::Error)
            .with_param("model", model.into())
            .with_action(RecoveryAction::Retry)
    }

    pub fn llm_rate_limited(retry_after_ms: Option<u64>) -> Self {
        let error = AppError::new(ErrorCode::LlmRateLimited, Severity::Warning)
            .with_action(RecoveryAction::Retry);
        match retry_after_ms {
            Some(ms) => error.with_param("retry_after_ms", ms),
            None => error,
        }
    }

    pub fn llm_request_timeout(timeout_ms: u64) -> Self {
        AppError::new(ErrorCode::LlmRequestTimeout, Severity::Error)
            .with_param("timeout_ms", timeout_ms)
            .with_action(RecoveryAction::Retry)
    }

    pub fn llm_cancelled() -> Self {
        AppError::new(ErrorCode::LlmCancelled, Severity::Info)
            .with_action(RecoveryAction::Acknowledge)
    }

    pub fn llm_endpoint_unreachable(reason: impl Into<String>) -> Self {
        AppError::new(ErrorCode::LlmEndpointUnreachable, Severity::Error)
            .with_param("reason", reason.into())
            .with_action(RecoveryAction::Retry)
    }

    pub fn llm_server_error(status: u16) -> Self {
        AppError::new(ErrorCode::LlmServerError, Severity::Error)
            .with_param("status", status)
            .with_action(RecoveryAction::Retry)
    }

    pub fn llm_invalid_json() -> Self {
        AppError::new(ErrorCode::LlmInvalidJson, Severity::Error).with_action(RecoveryAction::Retry)
    }

    pub fn llm_response_interrupted() -> Self {
        AppError::new(ErrorCode::LlmResponseInterrupted, Severity::Error)
            .with_action(RecoveryAction::Retry)
    }

    pub fn llm_protocol_incompatible(detail: impl Into<String>) -> Self {
        AppError::new(ErrorCode::LlmProtocolIncompatible, Severity::Error)
            .with_param("detail", detail.into())
            .with_action(RecoveryAction::Retry)
    }

    pub fn llm_credential_read_failed() -> Self {
        AppError::new(ErrorCode::LlmCredentialReadFailed, Severity::Error)
            .with_action(RecoveryAction::ConfigureCredential)
    }

    pub fn llm_capability_disabled(kind: LlmTaskKind) -> Self {
        AppError::new(ErrorCode::LlmCapabilityDisabled, Severity::Info)
            .with_param("task_kind", kind.schema_name())
            .with_action(RecoveryAction::Acknowledge)
    }
}
