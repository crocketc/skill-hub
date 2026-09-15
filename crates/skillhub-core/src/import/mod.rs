mod conflict;
mod decision;
mod migration;
mod model;
mod provenance;

pub use conflict::{
    analyze_import, DuplicateKind, ExistingSkillRecord, ImportAnalysis, ImportConflict,
    ImportGovernanceAction, ImportGovernanceClassification, ImportGovernanceGroup,
    ImportGovernanceMember, ImportMatch, ImportSourceFacts, MatchBasis,
};
pub use decision::{import_governance_task_id, ImportDecision, ImportGovernanceDecision};
pub use migration::{
    ensure_original_deletion_authorized, plan_original_migration, OriginalMigrationConflict,
    OriginalMigrationConflictReason, OriginalMigrationFacts, OriginalMigrationPlan,
    OriginalMigrationResult, OriginalMigrationState,
};
pub use model::{CandidateOwnership, ImportAction, ImportCandidate};
pub use provenance::ImportProvenance;
