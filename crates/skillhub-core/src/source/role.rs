use serde::{Deserialize, Serialize};

use super::{SearchHitOrigin, SourceDescriptor};
use crate::SkillId;

/// P1-05 来源角色：可验证上游 / 仅本地 / 搜索候选。
///
/// `SourceKind` 只描述传输形态（local/https/git）；本枚举补上"可信状态"维度。
/// 证据口径：`verified_upstream` 只能来自用户显式确认动作（导入向导提交带坐标
/// 的仓库来源，或手动 relink 到远端 URL），绝不来自联网搜索。
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SourceRole {
    /// 用户显式确认的可验证上游（含 branch/directory 坐标时支持更新检测）。
    VerifiedUpstream,
    /// 本地目录来源或本地创建；没有（或尚未确认）远端上游。
    LocalOnly,
    /// 联网搜索产生的待确认候选；只存在于 `search_candidates` 表，
    /// 绝不写入 sources/skill_sources，也绝不参与更新检测。
    SearchCandidate,
}

/// 搜索候选的三态：待确认 / 已确认（仅登记导入意向）/ 已拒绝。
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SearchCandidateStatus {
    Pending,
    Confirmed,
    Dismissed,
}

/// 一个 Skill 的来源投影：来源描述符 + 角色 + 可选上游坐标。
/// 无来源记录的 Skill 不返回本结构（调用方按 `local_only` 展示）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SourceRecord {
    pub skill_id: SkillId,
    pub source: SourceDescriptor,
    pub role: SourceRole,
    /// 仅 `verified_upstream` 且 branch/directory 坐标完整时才读出。
    pub upstream: Option<super::UpstreamOrigin>,
    /// 来源行创建时间（Unix 秒的十进制字符串；Specta 不放行 64 位整数）。
    pub created_at: String,
}

/// 一条联网搜索候选。候选是"待确认"实体：确认只是登记导入意向，
/// 成为来源只有导入向导提交这一条路（P1-05 底线：绝不自动绑定）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SearchCandidateRecord {
    pub id: String,
    /// 产生该候选的搜索提供方（如 `skills_sh`）。
    pub provider: String,
    /// 提供方内的唯一标识（如 `owner/name`）。
    pub provider_source_id: String,
    pub name: String,
    pub source: SourceDescriptor,
    pub page_url: String,
    pub installs: u32,
    /// 命中来自原始查询还是 AI 扩展查询（扩展只做标记，不改变数据来源）。
    pub via: SearchHitOrigin,
    /// 首次发现时间（Unix 秒的十进制字符串）。
    pub first_seen_at: String,
    pub status: SearchCandidateStatus,
}
