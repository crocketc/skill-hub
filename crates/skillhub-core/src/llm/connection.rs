use serde::{Deserialize, Serialize};

/// Two-level connection test report (requirement 5.42 / goal E): the endpoint
/// level proves reachability, the model level proves credentials, model
/// availability and a minimal structured round-trip. Only a passing model
/// level allows the UI to say "model connection available".
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ConnectionTestResult {
    pub endpoint: EndpointCheckResult,
    #[serde(default)]
    pub model: Option<ModelCheckResult>,
    #[serde(default)]
    pub model_failure_code: Option<String>,
}

impl ConnectionTestResult {
    /// The verdict the UI may advertise: only the model level counts.
    pub fn model_ok(&self) -> bool {
        self.model.as_ref().is_some_and(|model| model.ok)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct EndpointCheckResult {
    pub reachable: bool,
    // u32 keeps the generated TypeScript contract free of BigInt-only types.
    pub latency_ms: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ModelCheckResult {
    pub ok: bool,
    pub latency_ms: Option<u32>,
}
