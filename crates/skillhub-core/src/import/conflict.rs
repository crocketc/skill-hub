use super::{CandidateOwnership, ImportCandidate};
use crate::relationship::DirectoryRole;
use crate::search::SearchField;
use crate::source::SourceDescriptor;
use crate::SkillId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

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

/// 规范化 runtime 名：trim + 小写。批内同名分组、覆盖名冲突检查与
/// 单导入库内冲突核对共用同一形态，避免各层自造大小写规则。
pub fn normalize_runtime_name(value: &str) -> String {
    value.trim().to_lowercase()
}

fn supports_takeover(ownership: CandidateOwnership) -> bool {
    matches!(
        ownership,
        CandidateOwnership::KnownAgentTarget | CandidateOwnership::RegisteredProject
    )
}

/// W2-2（FB-007 第一期）：批内冲突分析的输入候选事实。发现方已盖章的
/// 确定性数据；core 不读文件系统、不访问数据库。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportBatchCandidate {
    /// 稳定候选键（acquisition identity + normalized relative root）。
    pub candidate_key: String,
    /// 发现时的 runtime 名（未处置前的事实名）。
    pub runtime_name: String,
    /// 候选内容指纹；不可得为 None（无法证明同内容/不同内容）。
    pub candidate_tree_hash: Option<String>,
    /// 源身份（acquisition 来源描述符）。
    pub source: SourceDescriptor,
}

/// 同内容同来源组（明显重复）：建议保留一个、其余跳过。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportBatchSameContentGroup {
    /// 建议保留（导入）的候选键：组内候选键字典序最小者，确定性可复算。
    pub keep_candidate_key: String,
    /// 建议跳过（明显重复）的其余候选键，字典序排列。
    pub skip_candidate_keys: Vec<String>,
    /// 组内一致的规范化 runtime 名。
    pub normalized_runtime_name: String,
    /// 组内一致的候选内容指纹。
    pub candidate_tree_hash: String,
}

/// 同名不同内容组：每一项都需要用户显式处置（独立命名或跳过），
/// 不给静默默认。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportBatchSameNameGroup {
    /// 组内一致的规范化 runtime 名（分组键）。
    pub normalized_runtime_name: String,
    /// 需要逐个显式处置的候选键，字典序排列。
    pub candidate_keys: Vec<String>,
}

/// 批内冲突分析结果：两组分组加组成签名。签名覆盖全部候选的
/// （候选键、规范化名、内容指纹、源身份），提交期据此识别"决策之后
/// 批内组成已变化"，不符则拒绝并要求重新分析。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportBatchConflictAnalysis {
    pub same_content_groups: Vec<ImportBatchSameContentGroup>,
    pub same_name_groups: Vec<ImportBatchSameNameGroup>,
    /// 批内组成的确定性签名（sha256），与候选顺序无关。
    pub signature: String,
}

/// W2-2（FB-007 第一期）：批内互检纯函数。与库内分析
/// （[`analyze_import`]）同套模型：只比较确定性事实，不产生界面散文。
///
/// 分组规则（规则顺序固定）：
/// 1. 同内容同来源（内容指纹与源身份都一致）→ 合并建议组，保留键最小
///    者、其余建议跳过；
/// 2. 同名不同内容（规范化 runtime 名一致且内容指纹都可得并不同）→
///    同名组，每项 requires_choice。
///
/// 边界：空批/单候选不产组；同内容不同来源不是"明显重复"，不产合并组；
/// 内容指纹缺失（None）无法证明同或不同，两侧都不分组（诚实缺省）。
pub fn analyze_import_batch(candidates: &[ImportBatchCandidate]) -> ImportBatchConflictAnalysis {
    // 规范化名一次算好；指纹缺失的候选不参与任何内容比较。
    let entries: Vec<(&ImportBatchCandidate, String)> = candidates
        .iter()
        .map(|candidate| (candidate, normalize_runtime_name(&candidate.runtime_name)))
        .collect();
    // 规则 1：同内容 + 同来源 → 合并建议组。保留键固定取字典序最小者，
    // 与输入顺序无关；不同来源的同内容候选不在此列（来源身份不同）。
    let mut content_clusters: BTreeMap<(String, String, String), Vec<&str>> = BTreeMap::new();
    for (candidate, normalized) in &entries {
        let Some(hash) = candidate.candidate_tree_hash.as_deref() else {
            continue;
        };
        let source_identity = serde_json::to_string(&candidate.source).unwrap_or_default();
        content_clusters
            .entry((normalized.clone(), hash.to_owned(), source_identity))
            .or_default()
            .push(candidate.candidate_key.as_str());
    }
    let same_content_groups = content_clusters
        .into_iter()
        .filter_map(|((normalized, hash, _source), mut keys)| {
            keys.sort_unstable();
            let keep = *keys.first()?;
            let skips: Vec<String> = keys
                .iter()
                .filter(|key| **key != keep)
                .map(|key| (*key).to_owned())
                .collect();
            if skips.is_empty() {
                return None;
            }
            Some(ImportBatchSameContentGroup {
                keep_candidate_key: keep.to_owned(),
                skip_candidate_keys: skips,
                normalized_runtime_name: normalized,
                candidate_tree_hash: hash,
            })
        })
        .collect();
    // 规则 2：同名 + 双方指纹都可得且不同 → 同名组。指纹缺失不证明
    // 不同，不进组（诚实缺省）；同名同内容的候选已被规则 1 建议合并，
    // 不重复处置。
    let mut name_members: BTreeMap<String, Vec<(&ImportBatchCandidate, String)>> = BTreeMap::new();
    for (candidate, normalized) in &entries {
        let Some(hash) = candidate.candidate_tree_hash.clone() else {
            continue;
        };
        name_members
            .entry(normalized.clone())
            .or_default()
            .push((candidate, hash));
    }
    let same_name_groups = name_members
        .into_iter()
        .filter_map(|(normalized, members)| {
            if members.len() < 2 {
                return None;
            }
            let first = &members[0].1;
            let distinct = members.iter().any(|(_, hash)| hash != first);
            if !distinct {
                return None;
            }
            let mut keys: Vec<String> = members
                .iter()
                .map(|(candidate, _)| candidate.candidate_key.clone())
                .collect();
            keys.sort();
            Some(ImportBatchSameNameGroup {
                normalized_runtime_name: normalized,
                candidate_keys: keys,
            })
        })
        .collect();
    let signature = batch_signature(&entries);
    ImportBatchConflictAnalysis {
        same_content_groups,
        same_name_groups,
        signature,
    }
}

/// 批内组成签名：sha256 摘要 over 规范化行（候选键、规范化名、指纹、
/// 源身份），行排序后以记录分隔符拼接。任何一项变化都会改变签名；
/// 候选顺序无关。
fn batch_signature(entries: &[(&ImportBatchCandidate, String)]) -> String {
    let mut lines: Vec<String> = entries
        .iter()
        .map(|(candidate, normalized)| {
            let source_identity = serde_json::to_string(&candidate.source).unwrap_or_default();
            format!(
                "{}\u{1f}{}\u{1f}{}\u{1f}{}",
                candidate.candidate_key,
                normalized,
                candidate.candidate_tree_hash.as_deref().unwrap_or(""),
                source_identity,
            )
        })
        .collect();
    lines.sort();
    let mut hasher = Sha256::new();
    hasher.update(lines.join("\u{1e}"));
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod batch_tests {
    use super::*;

    fn candidate(
        key: &str,
        name: &str,
        hash: Option<&str>,
        source: &SourceDescriptor,
    ) -> ImportBatchCandidate {
        ImportBatchCandidate {
            candidate_key: key.to_owned(),
            runtime_name: name.to_owned(),
            candidate_tree_hash: hash.map(str::to_owned),
            source: source.clone(),
        }
    }

    fn local_source(path: &str) -> SourceDescriptor {
        SourceDescriptor::new(
            crate::source::SourceKind::Local,
            crate::source::SourceLocator::local_path(path),
        )
    }

    #[test]
    fn empty_batch_and_single_candidate_produce_no_groups() {
        let empty = analyze_import_batch(&[]);
        assert!(empty.same_content_groups.is_empty());
        assert!(empty.same_name_groups.is_empty());
        assert!(!empty.signature.is_empty());

        let source = local_source("C:\\tmp\\one");
        let single = vec![candidate("k1", "Alpha", Some("h1"), &source)];
        let analysis = analyze_import_batch(&single);
        assert!(analysis.same_content_groups.is_empty());
        assert!(analysis.same_name_groups.is_empty());
        assert_ne!(analyze_import_batch(&single).signature, empty.signature);
    }

    #[test]
    fn same_content_same_source_groups_and_excludes_other_sources() {
        let source_a = local_source("C:\\tmp\\a");
        let source_b = local_source("C:\\tmp\\b");
        let candidates = vec![
            candidate("k2", "Alpha", Some("h1"), &source_a),
            candidate("k1", "alpha", Some("h1"), &source_a),
            candidate("k3", "Alpha", Some("h1"), &source_b),
        ];
        let analysis = analyze_import_batch(&candidates);
        assert_eq!(analysis.same_content_groups.len(), 1);
        let group = &analysis.same_content_groups[0];
        assert_eq!(group.keep_candidate_key, "k1");
        assert_eq!(group.skip_candidate_keys, vec!["k2".to_owned()]);
        assert_eq!(group.candidate_tree_hash, "h1");
        assert!(analysis.same_name_groups.is_empty());
    }

    #[test]
    fn same_name_different_content_groups_and_respects_unknown_hashes() {
        let source = local_source("C:\\tmp\\a");
        let candidates = vec![
            candidate("k1", "Alpha", Some("h1"), &source),
            candidate("k2", "alpha ", Some("h2"), &source),
            // 指纹缺失：无法证明不同，不进同名组。
            candidate("k3", "Alpha", None, &source),
        ];
        let analysis = analyze_import_batch(&candidates);
        assert_eq!(analysis.same_name_groups.len(), 1);
        assert_eq!(
            analysis.same_name_groups[0].candidate_keys,
            vec!["k1".to_owned(), "k2".to_owned()]
        );
        // 同名同内容不是"不同内容"，不产同名组。
        let identical = vec![
            candidate("k1", "Alpha", Some("h1"), &source),
            candidate("k2", "alpha", Some("h1"), &source),
        ];
        assert!(analyze_import_batch(&identical).same_name_groups.is_empty());
        // 同内容不同来源不产合并组（来源身份不同，不是明显重复）。
        let other = local_source("C:\\tmp\\b");
        let diff_source = vec![
            candidate("k1", "Alpha", Some("h1"), &source),
            candidate("k2", "Alpha", Some("h1"), &other),
        ];
        let analysis = analyze_import_batch(&diff_source);
        assert!(analysis.same_content_groups.is_empty());
        assert!(analysis.same_name_groups.is_empty());
    }

    #[test]
    fn signature_ignores_order_and_reflects_composition() {
        let source = local_source("C:\\tmp\\a");
        let first = vec![
            candidate("k1", "Alpha", Some("h1"), &source),
            candidate("k2", "Beta", Some("h2"), &source),
        ];
        let reordered = vec![
            candidate("k2", "Beta", Some("h2"), &source),
            candidate("k1", "Alpha", Some("h1"), &source),
        ];
        assert_eq!(
            analyze_import_batch(&first).signature,
            analyze_import_batch(&reordered).signature
        );
        let grown = vec![
            candidate("k1", "Alpha", Some("h1"), &source),
            candidate("k2", "Beta", Some("h2"), &source),
            candidate("k3", "Gamma", Some("h3"), &source),
        ];
        assert_ne!(
            analyze_import_batch(&first).signature,
            analyze_import_batch(&grown).signature
        );
        let changed_hash = vec![
            candidate("k1", "Alpha", Some("h9"), &source),
            candidate("k2", "Beta", Some("h2"), &source),
        ];
        assert_ne!(
            analyze_import_batch(&first).signature,
            analyze_import_batch(&changed_hash).signature
        );
    }
}
