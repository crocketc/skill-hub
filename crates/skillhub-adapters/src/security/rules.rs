use serde::{Deserialize, Serialize};
use skillhub_core::{AppError, AppResult, ErrorCode, Severity};
use std::fs;
use std::path::Path;

/// A versioned, deterministic set of rules. Display text is deliberately not
/// part of the ruleset so localization cannot change scan output.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BasicRule {
    pub code: String,
    pub severity: Severity,
    pub category: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BasicRuleset {
    pub id: String,
    pub rules: Vec<BasicRule>,
}

impl BasicRuleset {
    pub const ID: &'static str = "basic-v1";

    pub fn v1() -> Self {
        let rules = [
            (
                "security.destructive_command",
                Severity::Critical,
                "destructive",
            ),
            ("security.elevation", Severity::Error, "privilege"),
            ("security.permission_change", Severity::Error, "privilege"),
            ("security.persistence", Severity::Error, "persistence"),
            (
                "security.download_and_execute",
                Severity::Critical,
                "execution",
            ),
            ("security.data_upload", Severity::Error, "exfiltration"),
            (
                "security.command_interpolation",
                Severity::Warning,
                "execution",
            ),
            ("security.obfuscation", Severity::Warning, "obfuscation"),
            ("security.path_traversal", Severity::Error, "filesystem"),
            (
                "security.possible_plaintext_credential",
                Severity::Warning,
                "credential",
            ),
            (
                "security.prompt_injection",
                Severity::Warning,
                "prompt_injection",
            ),
            (
                "security.suspicious_external_resource",
                Severity::Warning,
                "external_resource",
            ),
        ]
        .into_iter()
        .map(|(code, severity, category)| BasicRule {
            code: code.to_owned(),
            severity,
            category: category.to_owned(),
        })
        .collect();
        Self {
            id: Self::ID.to_owned(),
            rules,
        }
    }

    pub fn from_json(path: impl AsRef<Path>) -> AppResult<Self> {
        let bytes = fs::read(path).map_err(|error| {
            AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("reason", error.to_string())
        })?;
        serde_json::from_slice(&bytes).map_err(|error| {
            AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("reason", error.to_string())
        })
    }

    pub fn rule(&self, code: &str) -> Option<&BasicRule> {
        self.rules.iter().find(|rule| rule.code == code)
    }
}

impl Default for BasicRuleset {
    fn default() -> Self {
        Self::v1()
    }
}
