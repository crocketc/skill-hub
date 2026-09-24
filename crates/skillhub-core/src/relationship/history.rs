//! Governance-history read model (plan Task 7.10).
//!
//! History is a separate query surface, not a ledger filter: rows are the
//! display snapshots fixed at write time, so they render without re-resolving
//! Agents, projects or Skills that may have been deleted since. Technical
//! identifiers (relation id, operation id) are carried for reconciliation but
//! are not display labels.

use serde::{Deserialize, Serialize};

use crate::SkillId;

/// Paged governance-history query. All filters are optional and combine.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ListGovernanceHistory {
    #[serde(default)]
    pub page: u32,
    #[serde(default)]
    pub page_size: u32,
    #[serde(default)]
    pub relation_id: Option<String>,
    #[serde(default)]
    pub skill_id: Option<SkillId>,
    #[serde(default)]
    pub agent_client_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    /// 写入时固化的 result 词表（如 `archived`）。
    #[serde(default)]
    pub result: Option<String>,
}

/// Agent 呈现快照：品牌 `client_id` 加用户可理解的展示类型，由前端统一
/// presenter 渲染，不在历史里回查可能已删除的 Agent。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GovernanceHistoryAgent {
    #[serde(default)]
    pub client_id: Option<String>,
}

/// One history entry rendered entirely from the snapshot fixed at write time.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GovernanceHistoryEntry {
    pub relation_id: String,
    pub skill_id: Option<SkillId>,
    pub skill_display_name: String,
    pub agent: GovernanceHistoryAgent,
    pub path: String,
    pub scope: String,
    pub project_id: Option<String>,
    pub action: String,
    pub result: String,
    pub reason: Option<String>,
    /// 技术对账字段；不作为展示标签。
    pub operation_id: Option<String>,
    #[serde(with = "crate::i64_string")]
    #[specta(type = String)]
    pub occurred_at: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GovernanceHistoryPage {
    pub items: Vec<GovernanceHistoryEntry>,
    pub total: u32,
    pub page: u32,
    pub page_size: u32,
}
