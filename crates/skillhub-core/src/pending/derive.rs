use crate::catalog::{Skill, TrialState};
use crate::SkillId;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

/// A stable category for work the user may need to handle.
#[derive(
    Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum PendingKind {
    TrialDue,
    SecurityFinding,
    Recovery,
}

/// N9：待处理事项的风险档位（由检查发现的严重级别映射）。
#[derive(
    Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum PendingRisk {
    High,
    Medium,
    Low,
}

/// A check finding projected into pending work. The projection intentionally
/// keeps codes and identifiers rather than localized display text.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct FindingRecord {
    pub subject: SkillId,
    pub code: String,
    pub unresolved: bool,
}

impl FindingRecord {
    pub fn unresolved(subject: SkillId, code: impl Into<String>) -> Self {
        Self {
            subject,
            code: code.into(),
            unresolved: true,
        }
    }
}

/// Derived pending work. `message_code` is an i18n key, never a localized
/// sentence persisted in the database or cache.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct PendingItem {
    pub subject: SkillId,
    pub kind: PendingKind,
    pub code: String,
    pub message_code: Option<String>,
    /// N9：到期日（YYYY-MM-DD）。试用到期项填试用截止日；其余 None。
    #[serde(default)]
    pub due_date: Option<String>,
    /// N9：风险档位。检查发现按严重级别映射（critical/error→high、
    /// warning→medium、info→low）；无级别数据时诚实缺省 None。
    #[serde(default)]
    pub risk: Option<PendingRisk>,
    /// N9：影响面——该 Skill 当前生效的部署关系数量；无法计算时 None。
    #[serde(default)]
    pub affected_deployments: Option<u32>,
}

impl Ord for PendingItem {
    fn cmp(&self, other: &Self) -> Ordering {
        self.kind
            .cmp(&other.kind)
            .then_with(|| self.subject.to_string().cmp(&other.subject.to_string()))
            .then_with(|| self.code.cmp(&other.code))
    }
}

impl PartialOrd for PendingItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Derives pending work from current facts. No status label is read from a
/// Skill; trial and finding state are evaluated from typed facts at query time.
pub fn derive_pending(
    skills: &[Skill],
    findings: &[FindingRecord],
    today: (i32, u8, u8),
) -> Vec<PendingItem> {
    let mut result = Vec::new();
    for skill in skills {
        if skill.trial_state(today) == TrialState::Due {
            let due_date = skill
                .trial_due()
                .map(|(year, month, day)| format!("{year:04}-{month:02}-{day:02}"));
            result.push(PendingItem {
                subject: skill.id(),
                kind: PendingKind::TrialDue,
                code: "trial.due".to_owned(),
                message_code: Some("pending.trial_due".to_owned()),
                due_date,
                risk: None,
                affected_deployments: None,
            });
        }
    }
    for finding in findings.iter().filter(|finding| finding.unresolved) {
        result.push(PendingItem {
            subject: finding.subject,
            kind: PendingKind::SecurityFinding,
            code: finding.code.clone(),
            message_code: Some("pending.security_finding".to_owned()),
            due_date: None,
            risk: None,
            affected_deployments: None,
        });
    }
    result.sort();
    result.dedup();
    result
}
