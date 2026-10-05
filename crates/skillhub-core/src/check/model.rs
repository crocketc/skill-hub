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

/// W3-1（FB-003 §23）：确定性规则的产品级分级。`Danger` 是危险级（导入时
/// 必须由用户显式决策"仍要导入／不导入"），`Warning` 是警告级（直接导入
/// 并写入预警）。"放行级"是"无发现"的状态，不是规则属性，因此不在枚举
/// 内。分级只基于确定性规则集标注，AI 不参与任何分级或放行判定。
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
pub enum ProductLevel {
    Danger,
    #[default]
    Warning,
}

impl ProductLevel {
    /// 裁决定稿映射（§23）：critical/error 类确定性规则为危险级，warning
    /// 类为警告级。规则文件对每条规则显式标注 `product_level`；本函数只
    /// 作为规则缺级时的确定性兜底与测试对照，不替代逐条标注。
    pub const fn from_severity(severity: Severity) -> Self {
        match severity {
            Severity::Critical | Severity::Error => Self::Danger,
            Severity::Warning | Severity::Info => Self::Warning,
        }
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
    /// W3-1：规则的产品级，由规则集在扫描时透传。历史存储行读出时为
    /// None（分级是扫描/预警时刻的即时结论，不回填旧行）；serde default
    /// 保持旧载荷可解析。
    #[serde(default)]
    pub product_level: Option<ProductLevel>,
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
            product_level: None,
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

/// W1-3（FB-006）：检查记录的触发来源。`manual` 兼容导入标注之前的全部
/// 既有行为；`import` 标注由导入边界扫描登记的首次基础检查记录。
#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum CheckTrigger {
    #[default]
    Manual,
    Import,
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
    /// W1-3：触发来源；缺省 manual 保持旧记录与旧路径的语义。
    #[serde(default)]
    pub trigger: CheckTrigger,
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
            trigger: CheckTrigger::Manual,
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
