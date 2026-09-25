use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TargetScope {
    Global,
    Project,
    Extra,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PathCandidate {
    pub path: String,
    pub scope: TargetScope,
    pub precedence: super::DirectoryPrecedence,
    pub marker: String,
    /// OPT-20260914-07: `true` marks a cross-brand shared reference (the
    /// `.agents/skills` convention). Shared references keep their deployment
    /// and scan semantics, but the ownership card is only produced once by the
    /// brand-agnostic Agent Skills profile. Defaults to `false` so existing
    /// persisted profiles and custom agents keep loading unchanged.
    #[serde(default)]
    pub shared_reference: bool,
    /// 2026-09-25 验收裁决：`true` marks a platform-managed built-in skill
    /// directory（如 Codex 的 `.codex/skills/.system`、Cursor 的
    /// `skills-cursor`）。内置目录只读观察：不进部署目标、不参与删除；
    /// 用户级扫描同时排除其嵌套点前缀子目录，避免同一技能重复归卡。
    #[serde(default)]
    pub builtin: bool,
}
