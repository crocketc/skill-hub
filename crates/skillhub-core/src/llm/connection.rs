use serde::{Deserialize, Serialize};

/// Three-level connection report.
///
/// The levels answer three different questions and are deliberately kept
/// apart, because a model that answers plain text is *callable* even when the
/// profile's structured-output strategy is not usable:
///
/// 1. `endpoint` — the address answered at all (any HTTP status counts).
/// 2. `model` — authentication, model existence and a parseable envelope,
///    proven by one low-token plain-text request.
/// 3. `structured` — the configured compatibility profile can complete the
///    structured request the real tasks will use.
///
/// Only [`ConnectionTestResult::model_ok`] may be reported as "the model can be
/// called"; [`ConnectionTestResult::task_ready`] is the stricter verdict that
/// also needs structured output.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ConnectionTestResult {
    pub endpoint: EndpointCheckResult,
    #[serde(default)]
    pub model: Option<ModelCheckResult>,
    #[serde(default)]
    pub model_failure_code: Option<String>,
    #[serde(default)]
    pub structured: Option<StructuredCheckResult>,
    #[serde(default)]
    pub structured_failure_code: Option<String>,
}

impl ConnectionTestResult {
    /// Authentication and model availability are proven; the model answers.
    /// A failing structured level never clears this.
    pub fn model_ok(&self) -> bool {
        self.model.as_ref().is_some_and(|model| model.ok)
    }

    /// The profile's own structured-output strategy completed a structured
    /// round-trip. Only reached when the model level passed.
    pub fn structured_ok(&self) -> bool {
        self.structured
            .as_ref()
            .is_some_and(|structured| structured.ok)
    }

    /// The model is reachable *and* structured output works: the provider is
    /// ready for the application's real tasks.
    pub fn task_ready(&self) -> bool {
        self.model_ok() && self.structured_ok()
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

/// Structured-output compatibility of the configured compatibility profile.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct StructuredCheckResult {
    pub ok: bool,
    pub latency_ms: Option<u32>,
}
