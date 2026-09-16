use super::{CandidateOwnership, ImportCandidate};
use crate::relationship::DirectoryRole;
use crate::search::SearchField;
use crate::source::SourceDescriptor;
use crate::SkillId;
use serde::{Deserialize, Serialize};

/// The strongest deterministic relationship found for an imported candidate.
#[derive(
    Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum DuplicateKind {
    ExactContent,
    SameSource,
    SameRuntimeNameDifferentContent,
    SearchCandidate,
}

/// Ordered evidence used to compare a candidate with an existing Skill.
#[derive(
    Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum MatchBasis {
    CanonicalTreeHash,
    SkillHubIdentity,
    RuntimeName,
    SourceLocator,
    FtsBm25,
}

impl MatchBasis {
    fn priority(self) -> u8 {
        match self {
            Self::CanonicalTreeHash => 0,
            Self::SkillHubIdentity => 1,
            Self::RuntimeName => 2,
            Self::SourceLocator => 3,
            Self::FtsBm25 => 4,
        }
    }
}

/// Read-only Skill facts required by deterministic conflict analysis.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExistingSkillRecord {
    pub skill_id: SkillId,
    pub display_name: String,
    pub runtime_name: String,
    pub tree_hash: Option<String>,
    pub source: Option<SourceDescriptor>,
    pub ownership: CandidateOwnership,
    pub fts_similarity_basis_points: Option<u32>,
    pub matched_fields: Vec<SearchField>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportMatch {
    pub skill_id: SkillId,
    pub display_name: String,
    pub runtime_name: String,
    pub source: Option<SourceDescriptor>,
    pub ownership: CandidateOwnership,
    pub basis: MatchBasis,
    pub duplicate_kind: DuplicateKind,
    pub matched_fields: Vec<SearchField>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportConflict {
    pub skill_id: SkillId,
    pub kind: DuplicateKind,
    pub reason_code: String,
    pub requires_choice: bool,
}

/// 设计 §4.1：导入结果按关系类别分组。用户层标签与回退说明由客户端
/// 按 `classification` 渲染；core 不产出任何界面散文。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ImportGovernanceClassification {
    /// 完全重复：与库内现有 Skill 内容一致，需用户裁决。
    ExactDuplicate,
    /// 内容一致的复制副本：来源路径本身是已验证的（观察）副本。
    ContentIdenticalCopy,
    /// 同名不同内容：需判断是不同 Skill 还是同一 Skill 的不同版本。
    SameNameDifferentContent,
    /// 通用目录直接读取：来源位于共享目录内且自身不是链接。
    SharedDirectoryRead,
    /// 通用目录链接引用：来源路径自身是符号链接/目录联结。
    SharedDirectoryReference,
    /// 识别未知或共享影响未确认：目录未登记且所有权不明。
    UnrecognizedSource,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ImportGovernanceAction {
    PreserveOriginal,
    CreateTodo,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportGovernanceMember {
    pub member_id: String,
    pub display_name: String,
    /// 来源候选根路径（绝对形态）。目标始终是集中库，由客户端静态标注。
    pub source_path: String,
    /// 受该关系影响的 Agent 形态（来自已登记目录能力或归属证据）。
    pub affected_agents: Vec<String>,
}

/// 调用方（facade）在分析前解析好的来源事实。core 保持纯函数：这里只有
/// 确定性数据，没有文件系统或 LLM 访问。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportSourceFacts {
    /// 来源路径所属目录节点的角色；`None` 表示未登记。
    pub directory_role: Option<DirectoryRole>,
    /// 候选根路径自身是符号链接/目录联结（引用而非直接读取）。
    pub source_is_link: bool,
    /// 来源路径存在指纹一致的活跃观察副本（`ContentVerified`）。
    pub observed_copy_verified: bool,
    /// 受影响 Agent 形态清单（客户端展示用，来自确定性证据）。
    pub affected_agents: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportGovernanceGroup {
    pub group_id: String,
    pub classification: ImportGovernanceClassification,
    pub members: Vec<ImportGovernanceMember>,
    pub default_action: ImportGovernanceAction,
    pub available_actions: Vec<ImportGovernanceAction>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportAnalysis {
    pub candidate: ImportCandidate,
    pub duplicate_kind: Option<DuplicateKind>,
    pub matches: Vec<ImportMatch>,
    pub conflicts: Vec<ImportConflict>,
    pub actions: Vec<super::ImportDecision>,
    #[serde(default)]
    #[specta(optional)]
    pub governance_groups: Vec<ImportGovernanceGroup>,
}

pub fn analyze_import(
    candidate: ImportCandidate,
    candidate_tree_hash: Option<&str>,
    existing: &[ExistingSkillRecord],
    source_facts: &ImportSourceFacts,
) -> ImportAnalysis {
    let candidate_runtime = normalize_runtime_name(&candidate.runtime_name);
    let mut matches = existing
        .iter()
        .filter_map(|record| {
            let (basis, kind) = if candidate_tree_hash.is_some()
                && candidate_tree_hash == record.tree_hash.as_deref()
            {
                (MatchBasis::CanonicalTreeHash, DuplicateKind::ExactContent)
            } else if normalize_runtime_name(&record.runtime_name) == candidate_runtime {
                (
                    MatchBasis::RuntimeName,
                    DuplicateKind::SameRuntimeNameDifferentContent,
                )
            } else if record
                .source
                .as_ref()
                .is_some_and(|source| source == &candidate.source)
            {
                (MatchBasis::SourceLocator, DuplicateKind::SameSource)
            } else if record
                .fts_similarity_basis_points
                .is_some_and(|score| score >= 2_000)
                && !record.matched_fields.is_empty()
            {
                (MatchBasis::FtsBm25, DuplicateKind::SearchCandidate)
            } else {
                return None;
            };
            Some(ImportMatch {
                skill_id: record.skill_id,
                display_name: record.display_name.clone(),
                runtime_name: record.runtime_name.clone(),
                source: record.source.clone(),
                ownership: record.ownership,
                basis,
                duplicate_kind: kind,
                matched_fields: record.matched_fields.clone(),
            })
        })
        .collect::<Vec<_>>();

    matches.sort_by(|left, right| {
        left.basis
            .priority()
            .cmp(&right.basis.priority())
            .then_with(|| left.skill_id.to_string().cmp(&right.skill_id.to_string()))
    });

    let duplicate_kind = matches.first().map(|item| item.duplicate_kind);
    let mut actions = Vec::new();
    let mut conflicts = Vec::new();
    if let Some(primary) = matches.first() {
        match primary.duplicate_kind {
            DuplicateKind::ExactContent => {
                if primary.ownership == CandidateOwnership::ReadOnlyBuiltinOrPlugin {
                    actions.extend([
                        super::ImportDecision::CopyAsIndependentManagedSkill,
                        super::ImportDecision::Skip,
                    ]);
                } else {
                    actions.extend([
                        super::ImportDecision::ReuseExisting,
                        super::ImportDecision::EstablishManagedRelation,
                        super::ImportDecision::CopyIntoLibrary,
                        super::ImportDecision::Skip,
                    ]);
                }
                // M-14：完全重复也必须作为冲突呈现——候选与已有 Skill 的
                // 名称、路径可辨，由用户显式选择复用/复制/跳过，绝不静默
                // 判成"无需处理"。
                conflicts.push(ImportConflict {
                    skill_id: primary.skill_id,
                    kind: primary.duplicate_kind,
                    reason_code: "import.exact_duplicate_conflict".to_owned(),
                    requires_choice: true,
                });
            }
            DuplicateKind::SameRuntimeNameDifferentContent => {
                actions.extend([
                    super::ImportDecision::KeepIndependent,
                    super::ImportDecision::Skip,
                ]);
                if supports_takeover(candidate.ownership) {
                    actions.push(super::ImportDecision::TakeOverAfterVerify);
                }
                conflicts.push(ImportConflict {
                    skill_id: primary.skill_id,
                    kind: primary.duplicate_kind,
                    reason_code: "import.same_runtime_name_conflict".to_owned(),
                    requires_choice: true,
                });
            }
            DuplicateKind::SameSource => {
                actions.extend([
                    super::ImportDecision::EstablishManagedRelation,
                    super::ImportDecision::KeepIndependent,
                    super::ImportDecision::Skip,
                ]);
                if supports_takeover(candidate.ownership) {
                    actions.push(super::ImportDecision::TakeOverAfterVerify);
                }
            }
            DuplicateKind::SearchCandidate => {
                actions.extend([
                    super::ImportDecision::CopyIntoLibrary,
                    super::ImportDecision::KeepIndependent,
                    super::ImportDecision::Skip,
                ]);
            }
        }
    } else {
        actions.extend([
            super::ImportDecision::CopyIntoLibrary,
            super::ImportDecision::Skip,
        ]);
        if supports_takeover(candidate.ownership) {
            actions.push(super::ImportDecision::TakeOverAfterVerify);
        }
    }

    actions.sort_by_key(|action| {
        super::ImportDecision::ORDERED
            .iter()
            .position(|candidate| candidate == action)
            .unwrap_or(usize::MAX)
    });
    actions.dedup();
    let governance_groups = classify_governance(&conflicts, &candidate, source_facts)
        .map(|classification| vec![governance_group(classification, &candidate, source_facts)])
        .unwrap_or_default();
    ImportAnalysis {
        candidate,
        duplicate_kind,
        matches,
        conflicts,
        actions,
        governance_groups,
    }
}

/// 设计 §4.1/§4.2 的确定性分组判定。判定顺序固定：同名不同内容冲突 →
/// 已验证观察副本（比"完全重复"更具体：已知它是哪个 Skill 的副本实例）
/// → 完全重复 → 共享目录（引用先于直接读取）→ 关系明确的普通导入不
/// 建组。关系完全明确的导入不需要治理确认，避免为普通导入制造待办噪音。
fn classify_governance(
    conflicts: &[ImportConflict],
    candidate: &ImportCandidate,
    facts: &ImportSourceFacts,
) -> Option<ImportGovernanceClassification> {
    if conflicts
        .iter()
        .any(|conflict| conflict.kind == DuplicateKind::SameRuntimeNameDifferentContent)
    {
        return Some(ImportGovernanceClassification::SameNameDifferentContent);
    }
    if facts.observed_copy_verified {
        return Some(ImportGovernanceClassification::ContentIdenticalCopy);
    }
    if conflicts
        .iter()
        .any(|conflict| conflict.kind == DuplicateKind::ExactContent)
    {
        return Some(ImportGovernanceClassification::ExactDuplicate);
    }
    if facts.directory_role == Some(DirectoryRole::SharedDirectory) {
        return Some(if facts.source_is_link {
            ImportGovernanceClassification::SharedDirectoryReference
        } else {
            ImportGovernanceClassification::SharedDirectoryRead
        });
    }
    let ownership_known = matches!(
        candidate.ownership,
        CandidateOwnership::KnownAgentTarget
            | CandidateOwnership::RegisteredProject
            | CandidateOwnership::ReadOnlyBuiltinOrPlugin
            | CandidateOwnership::CentralLibrary
    );
    if facts.directory_role.is_some() || ownership_known {
        return None;
    }
    Some(ImportGovernanceClassification::UnrecognizedSource)
}

/// 分组 ID 按分类稳定命名：前端与 facade 都按它聚合同一类别的候选。
fn governance_group(
    classification: ImportGovernanceClassification,
    candidate: &ImportCandidate,
    facts: &ImportSourceFacts,
) -> ImportGovernanceGroup {
    let (group_id, default_action) = match classification {
        ImportGovernanceClassification::ExactDuplicate => {
            ("exact-duplicate", ImportGovernanceAction::PreserveOriginal)
        }
        ImportGovernanceClassification::ContentIdenticalCopy => (
            "content-identical-copy",
            ImportGovernanceAction::PreserveOriginal,
        ),
        ImportGovernanceClassification::SameNameDifferentContent => (
            "same-name-different-content",
            ImportGovernanceAction::CreateTodo,
        ),
        ImportGovernanceClassification::SharedDirectoryRead => (
            "shared-directory-read",
            ImportGovernanceAction::PreserveOriginal,
        ),
        ImportGovernanceClassification::SharedDirectoryReference => (
            "shared-directory-reference",
            ImportGovernanceAction::PreserveOriginal,
        ),
        ImportGovernanceClassification::UnrecognizedSource => {
            ("unrecognized-source", ImportGovernanceAction::CreateTodo)
        }
    };
    ImportGovernanceGroup {
        group_id: group_id.into(),
        classification,
        members: vec![ImportGovernanceMember {
            member_id: format!("{}:{}", candidate.absolute_root, candidate.relative_root),
            display_name: candidate.runtime_name.clone(),
            source_path: candidate.absolute_root.clone(),
            affected_agents: facts.affected_agents.clone(),
        }],
        default_action,
        available_actions: vec![
            ImportGovernanceAction::PreserveOriginal,
            ImportGovernanceAction::CreateTodo,
        ],
    }
}

pub(crate) fn normalize_runtime_name(value: &str) -> String {
    value.trim().to_lowercase()
}

fn supports_takeover(ownership: CandidateOwnership) -> bool {
    matches!(
        ownership,
        CandidateOwnership::KnownAgentTarget | CandidateOwnership::RegisteredProject
    )
}
