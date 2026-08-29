use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
pub struct JsonEnvelope {
    pub schema_version: u32,
    pub command: String,
    pub result_code: String,
    pub operation_id: Option<String>,
    pub payload: Value,
}

impl JsonEnvelope {
    pub fn pending(command: impl Into<String>) -> Self {
        Self {
            schema_version: 1,
            command: command.into(),
            result_code: "cli.not_connected".into(),
            operation_id: None,
            payload: serde_json::json!({}),
        }
    }
}
