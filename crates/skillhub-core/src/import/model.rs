use serde::{Deserialize, Serialize};

use crate::source::SourceDescriptor;

/// Long-lived provenance classification; acquisition cache paths are excluded.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ImportSourceClass {
    AgentLocal,
    UserLocal,
    RegisteredProject,
    Online,
    CentralLibrary,
    LegacyUnclassified,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AcquisitionWorkspaceKind {
    DirectSource,
    TemporaryCache,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportAcquisitionContext {
    pub workspace_kind: AcquisitionWorkspaceKind,
    pub workspace_path: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ImportOutcomeStatus {
    Succeeded,
    Failed,
    Cancelled,
}

/// Resolve the committed Skill identity before recording import facts.
pub fn final_skill_for_import(
    decision: super::ImportDecision,
    status: ImportOutcomeStatus,
    existing_skill_id: Option<crate::SkillId>,
    created_skill_id: Option<crate::SkillId>,
) -> Option<crate::SkillId> {
    if status != ImportOutcomeStatus::Succeeded {
        return None;
    }
    match decision {
        super::ImportDecision::Skip | super::ImportDecision::EstablishManagedRelation => None,
        super::ImportDecision::ReuseExisting => existing_skill_id,
        _ => created_skill_id,
    }
}

/// Legacy direct relation action is refused by the new import fact flow.
pub fn legacy_managed_relation_rejected(decision: super::ImportDecision) -> bool {
    decision == super::ImportDecision::EstablishManagedRelation
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CandidateOwnership {
    Unclassified,
    CentralLibrary,
    KnownAgentTarget,
    RegisteredProject,
    ReadOnlyBuiltinOrPlugin,
    ArbitraryLocalDirectory,
    DownloadedSource,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ImportAction {
    Review,
    UseExistingManagedSkill,
    EstablishManagedRelation,
    CopyIntoLibrary,
    CopyAsIndependentManagedSkill,
    Skip,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportCandidate {
    pub source: SourceDescriptor,
    pub absolute_root: String,
    pub relative_root: String,
    pub marker: String,
    pub runtime_name: String,
    pub ownership: CandidateOwnership,
    pub default_action: ImportAction,
    pub ownership_detail: Option<String>,
    /// 仓库发现导入盖章的长期上游坐标；本地导入为 None。
    #[serde(default)]
    pub upstream: Option<crate::source::UpstreamOrigin>,
    /// DEV-3：SKILL.md frontmatter 的 `name`（读取失败或缺省为 None）。
    /// 与 `runtime_name`（= 文件夹名）不一致时界面给出非阻塞警告；
    /// 生成逻辑不受该字段影响（runtime_name 不变量）。
    #[serde(default)]
    pub frontmatter_name: Option<String>,
}

impl ImportCandidate {
    pub fn detected(
        source: SourceDescriptor,
        absolute_root: impl Into<String>,
        relative_root: impl Into<String>,
        marker: impl Into<String>,
        runtime_name: impl Into<String>,
    ) -> Self {
        Self {
            source,
            absolute_root: absolute_root.into(),
            relative_root: relative_root.into(),
            marker: marker.into(),
            runtime_name: runtime_name.into(),
            ownership: CandidateOwnership::Unclassified,
            default_action: ImportAction::Review,
            ownership_detail: None,
            upstream: None,
            frontmatter_name: None,
        }
    }

    /// 仓库发现导入路径盖章长期上游坐标。
    pub fn with_upstream(mut self, upstream: crate::source::UpstreamOrigin) -> Self {
        self.upstream = Some(upstream);
        self
    }

    pub fn with_ownership(
        mut self,
        ownership: CandidateOwnership,
        default_action: ImportAction,
        detail: Option<String>,
    ) -> Self {
        self.ownership = ownership;
        self.default_action = default_action;
        self.ownership_detail = detail;
        self
    }
}
