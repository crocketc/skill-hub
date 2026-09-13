pub mod compatibility;
pub mod connection;
mod errors;
mod model;
pub mod network_gate;
pub mod provider;
pub mod safety;
pub mod search_query;
mod task;
pub mod translation;
pub use translation::{TranslationOrigin, TranslationRecord, TranslationResult, TranslationView};

pub use compatibility::{
    compatibility_policy, legacy_profile_for_builtin_id, validate_compatibility_selection,
    LlmAuthStrategy, LlmCompatibilityPolicy, LlmCompatibilityProfile, LlmEndpointStrategy,
    LlmModelListStrategy, LlmReasoningPolicy, LlmStructuredOutputStrategy,
};
pub use connection::{
    ConnectionTestResult, EndpointCheckResult, ModelCheckResult, StructuredCheckResult,
};
pub use model::{CredentialRef, LlmProfile, LlmTaskKind, LlmTaskRequest, LlmTaskResponse};
pub use network_gate::NetworkGate;
pub use provider::{
    builtin_provider_presets, CustomHeader, LlmDeployment, LlmProtocolFamily, LlmProviderConfig,
    LlmProviderPreset, LlmProviderView,
};
pub use task::{CredentialStore, LlmAdmin, LlmTaskRunner};
