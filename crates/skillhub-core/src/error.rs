use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Stable machine-readable failures returned by the application boundary.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub enum ErrorCode {
    #[serde(rename = "input.invalid")]
    InvalidInput,
    #[serde(rename = "path.outside_allowed_root")]
    PathOutsideAllowedRoots,
    #[serde(rename = "object.not_found")]
    ObjectNotFound,
    #[serde(rename = "deployment.target_exists")]
    TargetExists,
    #[serde(rename = "deployment.target_changed")]
    TargetChanged,
    #[serde(rename = "deployment.symlink_not_supported")]
    SymlinkNotSupported,
    #[serde(rename = "deployment.junction_not_supported")]
    JunctionNotSupported,
    #[serde(rename = "target.ownership_unknown")]
    OwnershipUnknown,
    #[serde(rename = "deployment.ownership_mismatch")]
    OwnershipMismatch,
    #[serde(rename = "deployment.security_check_blocked")]
    CheckBlocked,
    #[serde(rename = "operation.conflict")]
    OperationConflict,
    #[serde(rename = "operation.id_reused_with_different_request")]
    OperationIdReusedWithDifferentRequest,
    #[serde(rename = "credential.unavailable")]
    CredentialUnavailable,
    #[serde(rename = "migration.required")]
    MigrationRequired,
    #[serde(rename = "database.newer_schema")]
    DatabaseNewerSchema,
    #[serde(rename = "internal.error")]
    InternalError,
    #[serde(rename = "combination.nesting_not_allowed")]
    CombinationNestingNotAllowed,
    #[serde(rename = "catalog.invalid_metadata")]
    CatalogInvalidMetadata,
    #[serde(rename = "requirements.invalid_declaration")]
    RequirementsInvalidDeclaration,
    #[serde(rename = "agent_profile.invalid_capability")]
    AgentProfileInvalidCapability,
    #[serde(rename = "source.search_rate_limited")]
    SourceSearchRateLimited,
    #[serde(rename = "source.provider_authentication_unavailable")]
    SourceProviderAuthenticationUnavailable,
    #[serde(rename = "source.search_unavailable")]
    SourceSearchUnavailable,
    #[serde(rename = "network.disabled")]
    NetworkDisabled,
    #[serde(rename = "call_policy.not_supported")]
    CallPolicyNotSupported,
}

#[allow(non_upper_case_globals)]
impl ErrorCode {
    pub const PathOutsideAllowedRoot: Self = Self::PathOutsideAllowedRoots;
    pub const SecurityCheckBlocked: Self = Self::CheckBlocked;

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidInput => "input.invalid",
            Self::PathOutsideAllowedRoots => "path.outside_allowed_root",
            Self::ObjectNotFound => "object.not_found",
            Self::TargetExists => "deployment.target_exists",
            Self::TargetChanged => "deployment.target_changed",
            Self::SymlinkNotSupported => "deployment.symlink_not_supported",
            Self::JunctionNotSupported => "deployment.junction_not_supported",
            Self::OwnershipUnknown => "target.ownership_unknown",
            Self::OwnershipMismatch => "deployment.ownership_mismatch",
            Self::CheckBlocked => "deployment.security_check_blocked",
            Self::OperationConflict => "operation.conflict",
            Self::OperationIdReusedWithDifferentRequest => {
                "operation.id_reused_with_different_request"
            }
            Self::CredentialUnavailable => "credential.unavailable",
            Self::MigrationRequired => "migration.required",
            Self::DatabaseNewerSchema => "database.newer_schema",
            Self::InternalError => "internal.error",
            Self::CombinationNestingNotAllowed => "combination.nesting_not_allowed",
            Self::CatalogInvalidMetadata => "catalog.invalid_metadata",
            Self::RequirementsInvalidDeclaration => "requirements.invalid_declaration",
            Self::AgentProfileInvalidCapability => "agent_profile.invalid_capability",
            Self::SourceSearchRateLimited => "source.search_rate_limited",
            Self::SourceProviderAuthenticationUnavailable => {
                "source.provider_authentication_unavailable"
            }
            Self::SourceSearchUnavailable => "source.search_unavailable",
            Self::NetworkDisabled => "network.disabled",
            Self::CallPolicyNotSupported => "call_policy.not_supported",
        }
    }
}

/// How prominently an error should be presented to the user.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    Warning,
    Error,
    Critical,
}

/// Structured actions a client may offer to recover from an error.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryAction {
    ChooseAnotherName,
    OverwriteUnknown,
    CompleteOperation,
    RollbackOperation,
    Retry,
    Reauthenticate,
    ConfigureCredential,
    ReviewSecurityFindings,
    MigrateData,
    InspectTarget,
    Acknowledge,
    OpenReadOnly,
}

impl RecoveryAction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ChooseAnotherName => "choose_another_name",
            Self::OverwriteUnknown => "overwrite_unknown",
            Self::CompleteOperation => "complete_operation",
            Self::RollbackOperation => "rollback_operation",
            Self::Retry => "retry",
            Self::Reauthenticate => "reauthenticate",
            Self::ConfigureCredential => "configure_credential",
            Self::ReviewSecurityFindings => "review_security_findings",
            Self::MigrateData => "migrate_data",
            Self::InspectTarget => "inspect_target",
            Self::Acknowledge => "acknowledge",
            Self::OpenReadOnly => "open_read_only",
        }
    }
}

/// An application error contains no localized user-facing sentence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AppError {
    pub code: ErrorCode,
    pub severity: Severity,
    pub params: BTreeMap<String, Value>,
    pub actions: Vec<RecoveryAction>,
}

impl AppError {
    pub fn new(code: ErrorCode, severity: Severity) -> Self {
        Self {
            code,
            severity,
            params: BTreeMap::new(),
            actions: Vec::new(),
        }
    }

    pub fn with_param<K, V>(mut self, key: K, value: V) -> Self
    where
        K: Into<String>,
        V: Into<Value>,
    {
        self.params.insert(key.into(), value.into());
        self
    }

    pub fn with_action(mut self, action: RecoveryAction) -> Self {
        self.actions.push(action);
        self
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.code.as_str())
    }
}

impl std::error::Error for AppError {}

pub type AppResult<T> = Result<T, AppError>;
