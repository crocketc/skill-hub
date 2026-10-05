use serde::{Deserialize, Serialize};

use crate::{AppResult, OperationId, SkillId, VersionId};

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
    /// AR-021 来源版本：上游最新 release/tag 名（如 v1.2.3）。
    /// 抓取失败或上游无 release 时诚实缺省 None。
    #[serde(default)]
    pub upstream_label: Option<String>,
    /// K6：候选身份——预览/检查时远端候选内容的确定性标识。当前下载
    /// 管线以候选树哈希为身份（tag 会重指、归档不带提交号，树哈希才是
    /// 能稳定判别"是不是同一个候选"的事实）；不可得时为 None。
    #[serde(default)]
    pub candidate_identity: Option<String>,
}

impl UpstreamCheckResult {
    pub fn new(skill_id: SkillId, state: SourceState) -> Self {
        Self {
            skill_id,
            state,
            local_version: None,
            upstream_version: None,
            upstream_label: None,
            candidate_identity: None,
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

    pub fn with_upstream_label(mut self, label: Option<String>) -> Self {
        self.upstream_label = label;
        self
    }

    pub fn with_candidate_identity(mut self, identity: Option<String>) -> Self {
        self.candidate_identity = identity;
        self
    }
}

/// K6：候选预览的文件级变更种类。来自当前版本清单与候选树的确定性对比。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SourceUpdateFileChangeKind {
    Added,
    Removed,
    Modified,
}

/// K6：候选预览的文件级变更摘要项（路径 + 变更种类）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SourceUpdateFileChange {
    pub path: String,
    pub change: SourceUpdateFileChangeKind,
}

/// K6：来源更新候选预览——统一预览绑定三件套（preview_id + expires_at
/// RFC3339 UTC + confirmation_fingerprint）加候选身份与文件级变更摘要。
/// 提交端（CommitSourceUpdate）重核当前版本与上游候选未漂移后消耗。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SourceUpdatePreview {
    pub skill_id: SkillId,
    pub preview_id: OperationId,
    /// RFC3339 UTC；过期后必须重新预览。
    pub expires_at: String,
    pub confirmation_fingerprint: String,
    pub current_version_id: Option<VersionId>,
    /// 上游候选身份（当前管线 = 候选树哈希）。
    pub candidate_identity: String,
    /// 展示用上游标签（release/tag 名）；无 release 回退分支时为 None。
    pub upstream_label: Option<String>,
    pub files: Vec<SourceUpdateFileChange>,
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

/// K6/D3：一条被忽略的候选（skill 维度持久化于 settings KV）。来源身份
/// 变更或候选被采纳后整体清除；「关闭窗口」不产生本记录。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct IgnoredSourceUpdate {
    pub candidate_identity: String,
    pub upstream_url: String,
    pub ignored_at_epoch: i64,
}

/// Port owned by the native/storage layer. The service enforces decision
/// safety and leaves acquisition, version capture and deployment reconciliation
/// to the adapter implementation. K6 起"采用上游"只有一条预览绑定路径：
/// prepare 产出候选预览，commit 重核后消耗；直接采纳端口已移除。
#[async_trait::async_trait]
pub trait SourceUpdateBackend: Send + Sync {
    async fn relink_source(&self, skill_id: SkillId, source: SourceDescriptor) -> AppResult<()>;
    async fn check_source_update(&self, skill_id: SkillId) -> AppResult<UpstreamCheckResult>;
    async fn prepare_source_update(&self, skill_id: SkillId) -> AppResult<SourceUpdatePreview>;
    async fn commit_source_update(
        &self,
        skill_id: SkillId,
        preview_id: OperationId,
        decision: UpdateDecision,
    ) -> AppResult<AppliedSourceUpdate>;
}

use super::SourceDescriptor;
