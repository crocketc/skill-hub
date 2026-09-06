use serde::{Deserialize, Serialize};

use crate::{AppResult, SkillId, VersionId};

/// Deterministic state returned by an upstream check. It describes observed
/// facts only; it does not imply that an update should be applied.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SourceState {
    UpToDate,
    UpdateAvailable,
    UpdateAvailableWithLocalChanges,
    SourceUnavailable,
    AuthenticationRequired,
    /// 该 Skill 没有可检查更新的上游来源（本地创建或仅有本地目录来源）。
    /// 这是观察事实而非错误；本地文件变化由外部变化与健康检查追踪。
    NoUpstream,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UpdateDecision {
    KeepLocal,
    TakeUpstream,
    CreateIndependentBranch,
    Cancel,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UpstreamCheckResult {
    pub skill_id: SkillId,
    pub state: SourceState,
    pub local_version: Option<VersionId>,
    pub upstream_version: Option<VersionId>,
}

impl UpstreamCheckResult {
    pub fn new(skill_id: SkillId, state: SourceState) -> Self {
        Self {
            skill_id,
            state,
            local_version: None,
            upstream_version: None,
        }
    }

    pub fn with_versions(
        mut self,
        local_version: Option<VersionId>,
        upstream_version: Option<VersionId>,
    ) -> Self {
        self.local_version = local_version;
        self.upstream_version = upstream_version;
        self
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AppliedSourceUpdate {
    pub skill_id: SkillId,
    pub decision: UpdateDecision,
    pub new_version: Option<VersionId>,
    pub deployments_need_reconciliation: bool,
}

impl AppliedSourceUpdate {
    pub fn new(skill_id: SkillId, decision: UpdateDecision) -> Self {
        Self {
            skill_id,
            decision,
            new_version: None,
            deployments_need_reconciliation: false,
        }
    }
}

/// Port owned by the native/storage layer. The service enforces decision
/// safety and leaves acquisition, version capture and deployment reconciliation
/// to the adapter implementation.
#[async_trait::async_trait]
pub trait SourceUpdateBackend: Send + Sync {
    async fn relink_source(&self, skill_id: SkillId, source: SourceDescriptor) -> AppResult<()>;
    async fn check_source_update(&self, skill_id: SkillId) -> AppResult<UpstreamCheckResult>;
    async fn apply_source_update(
        &self,
        skill_id: SkillId,
        decision: UpdateDecision,
    ) -> AppResult<AppliedSourceUpdate>;
}

use super::SourceDescriptor;
