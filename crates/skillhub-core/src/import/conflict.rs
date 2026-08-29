use super::{CandidateOwnership, ImportCandidate};
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportAnalysis {
    pub candidate: ImportCandidate,
    pub duplicate_kind: Option<DuplicateKind>,
    pub matches: Vec<ImportMatch>,
    pub conflicts: Vec<ImportConflict>,
    pub actions: Vec<super::ImportDecision>,
}

pub fn analyze_import(
    candidate: ImportCandidate,
    candidate_tree_hash: Option<&str>,
    existing: &[ExistingSkillRecord],
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
    ImportAnalysis {
        candidate,
        duplicate_kind,
        matches,
        conflicts,
        actions,
    }
}

fn normalize_runtime_name(value: &str) -> String {
    value.trim().to_lowercase()
}

fn supports_takeover(ownership: CandidateOwnership) -> bool {
    matches!(
        ownership,
        CandidateOwnership::KnownAgentTarget | CandidateOwnership::RegisteredProject
    )
}
