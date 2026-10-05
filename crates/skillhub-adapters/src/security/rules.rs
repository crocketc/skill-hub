use serde::{Deserialize, Serialize};
use skillhub_core::check::ProductLevel;
use skillhub_core::{AppError, AppResult, ErrorCode, Severity};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

/// A versioned, deterministic set of rules. Display text is deliberately not
/// part of the ruleset so localization cannot change scan output.
///
/// W3-1（FB-003 §23）：每条规则显式标注产品级 `product_level`（危险级
/// danger／警告级 warning；放行级是无发现，不是规则属性）。逐条定级与
/// 依据见 `rules/basic-v1-levels.md`；`severity` 字段保留（兼容既有存储
/// 与查询），产品级不回写 severity。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BasicRule {
    pub code: String,
    pub severity: Severity,
    pub category: String,
    pub product_level: ProductLevel,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BasicRuleset {
    pub id: String,
    pub rules: Vec<BasicRule>,
}

impl BasicRuleset {
    pub const ID: &'static str = "basic-v1";

    pub fn v1() -> Self {
        Self::from_str(BUILTIN_RULES_JSON).expect("embedded basic-v1 rules must be valid")
    }

    pub fn from_json(path: impl AsRef<Path>) -> AppResult<Self> {
        let bytes = fs::read(path).map_err(|error| {
            AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("reason", error.to_string())
        })?;
        let ruleset: Self = serde_json::from_slice(&bytes).map_err(|error| {
            AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("reason", error.to_string())
        })?;
        ruleset.validate()?;
        Ok(ruleset)
    }

    fn from_str(source: &str) -> AppResult<Self> {
        let ruleset: Self = serde_json::from_str(source).map_err(|error| {
            AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("reason", error.to_string())
        })?;
        ruleset.validate()?;
        Ok(ruleset)
    }

    fn validate(&self) -> AppResult<()> {
        let mut codes = BTreeSet::new();
        if self.id != Self::ID || self.rules.is_empty() {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("reason", "basic-v1 ruleset identity or rules are invalid"));
        }
        if self
            .rules
            .iter()
            .any(|rule| rule.code.trim().is_empty() || !codes.insert(&rule.code))
        {
            return Err(
                AppError::new(ErrorCode::InvalidInput, Severity::Error).with_param(
                    "reason",
                    "basic-v1 contains an empty or duplicate rule code",
                ),
            );
        }
        Ok(())
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

const BUILTIN_RULES_JSON: &str = include_str!("../../rules/basic-v1.json");
