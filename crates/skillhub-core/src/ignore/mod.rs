use crate::{OperationId, SkillId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case", tag = "type", content = "value")]
pub enum IgnoreSubject {
    ExactPath(String),
    ExactSkill(SkillId),
    ExactPending(String),
}

impl IgnoreSubject {
    pub fn exact_path(value: impl Into<String>) -> Result<Self, crate::AppError> {
        let value = value.into();
        validate_exact(&value)?;
        Ok(Self::ExactPath(value))
    }

    pub fn exact_skill(skill_id: SkillId) -> Self {
        Self::ExactSkill(skill_id)
    }

    pub fn exact_pending(value: impl Into<String>) -> Self {
        Self::ExactPending(value.into())
    }

    pub fn from_raw(value: impl Into<String>) -> Result<Self, crate::AppError> {
        Self::exact_path(value)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct IgnoreRule {
    pub id: String,
    pub subject: IgnoreSubject,
    pub reason: String,
    pub created_at: String,
    pub defer_until: Option<String>,
}

fn validate_exact(value: &str) -> Result<(), crate::AppError> {
    let invalid = value.is_empty()
        || value
            .chars()
            .any(|ch| matches!(ch, '*' | '?' | '^' | '$' | '|' | ';' | '\n' | '\r'))
        || value.starts_with("regex:")
        || value.contains("../")
        || value.contains("..\\")
        || value.starts_with("if ");
    if invalid {
        return Err(crate::AppError::new(
            crate::ErrorCode::IgnoreOnlyExactSubjectsSupported,
            crate::Severity::Error,
        ));
    }
    Ok(())
}

pub fn new_rule(subject: IgnoreSubject, reason: String, defer_until: Option<String>) -> IgnoreRule {
    IgnoreRule {
        id: OperationId::new().to_string(),
        subject,
        reason,
        created_at: String::new(),
        defer_until,
    }
}
