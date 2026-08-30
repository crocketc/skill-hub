use serde::Serialize;
use serde_json::Value;

use crate::runtime::CliRuntimeError;

#[derive(Debug, Serialize)]
pub struct JsonEnvelope {
    pub schema_version: u32,
    pub command: String,
    pub result_code: String,
    pub operation_id: Option<String>,
    pub payload: Value,
}

impl JsonEnvelope {
    pub fn success(command: impl Into<String>, payload: Value) -> Self {
        Self {
            schema_version: 1,
            command: command.into(),
            result_code: "ok".into(),
            operation_id: None,
            payload,
        }
    }

    pub fn pending(command: impl Into<String>) -> Self {
        Self {
            schema_version: 1,
            command: command.into(),
            result_code: "cli.not_connected".into(),
            operation_id: None,
            payload: serde_json::json!({}),
        }
    }

    pub fn error(command: impl Into<String>, error: &CliRuntimeError) -> Self {
        Self {
            schema_version: 1,
            command: command.into(),
            result_code: error.code.clone(),
            operation_id: None,
            payload: serde_json::json!({
                "detail": error.detail,
                "params": error.params,
                "actions": error.actions,
            }),
        }
    }
}
