use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

use crate::{AppError, AppResult, ErrorCode, RecoveryAction, Severity, SkillId, VersionId};

/// The two security checks are intentionally independent facts.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CheckKind {
    Basic,
    Llm,
}

/// User-visible result states. Availability of an optional LLM is not a state.
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    Deserialize,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
    Serialize,
    specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum CheckState {
    #[default]
    NotChecked,
    Running,
    Passed,
    Failed,
}

/// Internal execution phase used to derive the four result states.
#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum CheckRunPhase {
    #[default]
    NotChecked,
    Running,
    Completed,
    Failed,
}

/// A stable rule or model finding code, never localized display text.
pub type FindingCode = String;

#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    Deserialize,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
    Serialize,
    specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum FindingDisposition {
    #[default]
    Actionable,
    Acknowledged,
    Dismissed,
}

impl FindingDisposition {
    pub const fn is_actionable(self) -> bool {
        matches!(self, Self::Actionable)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Finding {
    pub id: String,
    pub code: FindingCode,
    pub severity: Severity,
    pub file: Option<String>,
    pub line_start: Option<u32>,
    pub line_end: Option<u32>,
    pub evidence_hash: Option<String>,
    pub message_params: BTreeMap<String, Value>,
    pub disposition: FindingDisposition,
    #[serde(default = "default_allowed_dispositions")]
    pub allowed_dispositions: BTreeSet<FindingDisposition>,
}

impl Finding {
    pub fn new(id: impl Into<String>, code: impl Into<String>, severity: Severity) -> Self {
        Self {
            id: id.into(),
            code: code.into(),
            severity,
            file: None,
            line_start: None,
            line_end: None,
            evidence_hash: None,
            message_params: BTreeMap::new(),
            disposition: FindingDisposition::Actionable,
            allowed_dispositions: default_allowed_dispositions(),
        }
    }

    pub fn at(
        id: impl Into<String>,
        code: impl Into<String>,
        severity: Severity,
        file: impl Into<String>,
        line_start: u32,
        line_end: Option<u32>,
    ) -> Self {
        Self {
            file: Some(file.into()),
            line_start: Some(line_start),
            line_end: line_end.or(Some(line_start)),
            ..Self::new(id, code, severity)
        }
    }

    pub fn is_actionable(&self) -> bool {
        self.disposition.is_actionable()
    }

    pub fn is_high_risk(&self) -> bool {
        matches!(self.severity, Severity::Error | Severity::Critical)
    }
}

fn default_allowed_dispositions() -> BTreeSet<FindingDisposition> {
    [
        FindingDisposition::Acknowledged,
        FindingDisposition::Dismissed,
    ]
    .into_iter()
    .collect()
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CheckRun {
    pub id: String,
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub kind: CheckKind,
    #[serde(default)]
    pub generation: u64,
    pub phase: CheckRunPhase,
    pub ruleset_id: Option<String>,
    pub model_id: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub coverage_inputs: Value,
    pub failure_code: Option<String>,
    pub findings: Vec<Finding>,
}

impl CheckRun {
    pub fn not_checked(
        id: impl Into<String>,
        skill_id: SkillId,
        version_id: VersionId,
        kind: CheckKind,
    ) -> Self {
        Self {
            phase: CheckRunPhase::NotChecked,
            ..Self::running(id, skill_id, version_id, kind)
        }
    }

    pub fn running(
        id: impl Into<String>,
        skill_id: SkillId,
        version_id: VersionId,
        kind: CheckKind,
    ) -> Self {
        Self {
            id: id.into(),
            skill_id,
            version_id,
            kind,
            generation: 0,
            phase: CheckRunPhase::Running,
            ruleset_id: None,
            model_id: None,
            started_at: 0,
            ended_at: None,
            coverage_inputs: Value::Object(Default::default()),
            failure_code: None,
            findings: Vec::new(),
        }
    }

    pub fn completed(
        id: impl Into<String>,
        skill_id: SkillId,
        version_id: VersionId,
        kind: CheckKind,
        findings: Vec<Finding>,
    ) -> Self {
        Self {
            phase: CheckRunPhase::Completed,
            ended_at: Some(0),
            findings,
            ..Self::running(id, skill_id, version_id, kind)
        }
    }

    pub fn set_disposition(
        &self,
        finding_id: impl AsRef<str>,
        disposition: FindingDisposition,
    ) -> AppResult<Self> {
        let mut updated = self.clone();
        let Some(finding) = updated
            .findings
            .iter_mut()
            .find(|finding| finding.id == finding_id.as_ref())
        else {
            return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("finding_id", finding_id.as_ref().to_owned())
                .with_action(RecoveryAction::ReviewSecurityFindings));
        };
        if !finding.allowed_dispositions.contains(&disposition) {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("finding_id", finding_id.as_ref().to_owned())
                .with_param(
                    "disposition",
                    serde_json::to_value(disposition).unwrap_or_default(),
                )
                .with_action(RecoveryAction::ReviewSecurityFindings));
        }
        finding.disposition = disposition;
        Ok(updated)
    }

    pub fn state(&self) -> crate::check::CheckState {
        crate::check::derive_check_state(self)
    }
}

/// Persistence boundary for independent check runs.
#[async_trait(?Send)]
pub trait CheckRepository {
    async fn insert(&self, run: &CheckRun) -> AppResult<()>;
    async fn get(&self, id: &str) -> AppResult<Option<CheckRun>>;
    async fn update(&self, run: &CheckRun) -> AppResult<()>;
    async fn list_for_version(
        &self,
        skill_id: SkillId,
        version_id: &VersionId,
        kind: CheckKind,
    ) -> AppResult<Vec<CheckRun>>;
    async fn current_for_version(
        &self,
        skill_id: SkillId,
        version_id: &VersionId,
        kind: CheckKind,
    ) -> AppResult<Option<CheckRun>>;
}
