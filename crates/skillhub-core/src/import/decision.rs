use serde::{Deserialize, Serialize};

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
