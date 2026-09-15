use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

use crate::relationship::{
    ConflictCaseFact, ConflictClassification, ConflictEvidence, ConflictKind, ConflictMemberFact,
    IdentityDirection,
};
use crate::SkillId;

use super::conflict::normalize_runtime_name;
use super::{DuplicateKind, ImportAnalysis};

/// Explicit choices available after deterministic import analysis.
/// There is intentionally no overwrite action: importing a Skill must never
/// replace an existing deployment target or managed version implicitly.
#[derive(
    Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum ImportDecision {
    ReuseExisting,
    EstablishManagedRelation,
    CopyIntoLibrary,
    TakeOverAfterVerify,
    KeepIndependent,
    CopyAsIndependentManagedSkill,
    Skip,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportGovernanceDecision {
    pub group_actions: BTreeMap<String, super::ImportGovernanceAction>,
    pub item_overrides: BTreeMap<String, super::ImportGovernanceAction>,
}

impl ImportDecision {
    pub const ORDERED: [Self; 7] = [
        Self::ReuseExisting,
        Self::EstablishManagedRelation,
        Self::CopyIntoLibrary,
        Self::TakeOverAfterVerify,
        Self::KeepIndependent,
        Self::CopyAsIndependentManagedSkill,
        Self::Skip,
    ];
}

impl ImportGovernanceDecision {
    /// The member override is deliberately resolved before the group action.
    /// `None` means the caller has not explicitly confirmed this member/group.
    pub fn action_for_member(
        &self,
        group: &super::ImportGovernanceGroup,
        member_id: &str,
    ) -> Option<super::ImportGovernanceAction> {
        self.item_overrides
            .get(member_id)
            .copied()
            .or_else(|| self.group_actions.get(&group.group_id).copied())
    }
}

/// A governance task must remain addressable after the source path has been
/// rendered in UI copy.  Hashing the member identity avoids treating `#` or
/// other path punctuation as a UI anchor while keeping the ID stable.
pub fn import_governance_task_id(group_id: &str, member_id: &str) -> String {
    let digest = Sha256::digest(member_id.as_bytes());
    format!("import-governance:{group_id}:{digest:x}")
}

/// 确定性冲突组 ID：`import-conflict:<kind-slug>:<normalized-runtime-name>`。
/// 只由冲突类型与归一化 runtime 名决定，跨重复导入/不同来源目录稳定，
/// 不含随机数或时间。仅要求用户裁决的两类冲突会落组，其余返回 None。
pub fn import_conflict_case_id(kind: DuplicateKind, runtime_name: &str) -> Option<String> {
    let slug = match kind {
        DuplicateKind::ExactContent => "duplicate_same_content",
        DuplicateKind::SameRuntimeNameDifferentContent => "same_name_different_content",
        DuplicateKind::SameSource | DuplicateKind::SearchCandidate => return None,
    };
    Some(format!(
        "import-conflict:{slug}:{}",
        normalize_runtime_name(runtime_name)
    ))
}

/// 导入提交后的确定性产物：冲突组落库所需的其余事实由 facade 收集。
/// core 纯函数只做映射，不接触文件系统、数据库或时钟。
///
/// 内部类型（不经 IPC 暴露），与 `RemovalFacts` 一样不带 specta。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportCaseOutcome {
    /// 导入产物 Skill：复制路径为新建 Skill，复用路径为被复用的既有 Skill。
    pub skill_id: SkillId,
    /// 候选内容指纹；提交时不可得为 None，不猜。
    pub candidate_fingerprint: Option<String>,
    /// 被匹配的库内既有 Skill 的集中库可见路径；不可得为 None。
    pub library_path: Option<String>,
    /// 被匹配的库内既有 Skill 的内容指纹；不可得为 None。
    pub library_fingerprint: Option<String>,
}

/// 把导入提交的确定性冲突落成 `ConflictCaseFact`（设计 §3.4）。仅当分析
/// 存在 `requires_choice` 冲突时返回 Some：
///
/// - ExactContent → `duplicate_same_content`/`same_skill_version`，指纹一致
///   是确定性事实，`user_decision=None`（内容一致性无需用户裁决身份）；
/// - SameRuntimeNameDifferentContent → `same_name_different_content`/
///   `uncertain`，`user_decision` 由用户的 `ImportDecision` 确定性映射。
///
/// `decided_at` 恒为 None：时间是 facade 合并规则的职责，不是事实映射的。
pub fn plan_import_conflict_case(
    analysis: &ImportAnalysis,
    decision: ImportDecision,
    outcome: &ImportCaseOutcome,
) -> Option<ConflictCaseFact> {
    let conflict = analysis
        .conflicts
        .iter()
        .find(|conflict| conflict.requires_choice)?;
    let conflict_id = import_conflict_case_id(conflict.kind, &analysis.candidate.runtime_name)?;
    let (kind, classification, user_decision, evidence) = match conflict.kind {
        DuplicateKind::ExactContent => (
            ConflictKind::DuplicateSameContent,
            ConflictClassification::SameSkillVersion,
            None,
            ConflictEvidence {
                fingerprints_match: Some(true),
                names_match: Some(true),
                identity_direction: Some(IdentityDirection::SameSkill),
                sufficient_identity_evidence: true,
            },
        ),
        DuplicateKind::SameRuntimeNameDifferentContent => (
            ConflictKind::SameNameDifferentContent,
            ConflictClassification::Uncertain,
            same_name_user_decision(decision),
            ConflictEvidence {
                fingerprints_match: Some(false),
                names_match: Some(true),
                identity_direction: None,
                sufficient_identity_evidence: false,
            },
        ),
        DuplicateKind::SameSource | DuplicateKind::SearchCandidate => return None,
    };
    // 成员按契约固定两条：库内既有 Skill 在前，导入方在后。取不到的
    // 字段如实填 None，不猜。
    let library_member = ConflictMemberFact {
        skill_id: Some(conflict.skill_id),
        version_id: None,
        provenance_id: None,
        directory_node_id: None,
        path: outcome.library_path.clone(),
        fingerprint: outcome.library_fingerprint.clone(),
    };
    let importer_member = ConflictMemberFact {
        skill_id: Some(outcome.skill_id),
        version_id: None,
        provenance_id: None,
        directory_node_id: None,
        path: Some(analysis.candidate.absolute_root.clone()),
        fingerprint: outcome.candidate_fingerprint.clone(),
    };
    let mut member_skill_ids = vec![conflict.skill_id, outcome.skill_id];
    member_skill_ids.dedup();
    Some(ConflictCaseFact {
        conflict_id,
        kind,
        classification,
        member_skill_ids,
        members: vec![library_member, importer_member],
        evidence,
        user_decision,
        decided_at: None,
    })
}

/// 同名不同内容冲突的 user_decision 映射（确定性，无 AI 参与）：
/// 保留独立副本即判定为不同 Skill；复用/建立托管关系/验证后接管即判定
/// 为同一 Skill 版本；保留副本未裁决身份或跳过时不产裁决。
fn same_name_user_decision(decision: ImportDecision) -> Option<ConflictClassification> {
    match decision {
        ImportDecision::KeepIndependent => Some(ConflictClassification::DistinctSkill),
        ImportDecision::ReuseExisting
        | ImportDecision::EstablishManagedRelation
        | ImportDecision::TakeOverAfterVerify => Some(ConflictClassification::SameSkillVersion),
        ImportDecision::CopyIntoLibrary
        | ImportDecision::CopyAsIndependentManagedSkill
        | ImportDecision::Skip => None,
    }
}
