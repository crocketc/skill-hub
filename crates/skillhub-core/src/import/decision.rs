use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

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
