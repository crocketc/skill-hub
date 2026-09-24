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
pub use decision::{
    import_conflict_case_id, import_governance_task_id, plan_import_conflict_case,
    ImportCaseOutcome, ImportDecision, ImportGovernanceDecision,
};
pub use migration::{
    ensure_original_deletion_authorized, plan_original_migration, OriginalMigrationConflict,
    OriginalMigrationConflictReason, OriginalMigrationFacts, OriginalMigrationPlan,
    OriginalMigrationResult, OriginalMigrationState,
};
pub use model::{
    final_skill_for_import, legacy_managed_relation_rejected, AcquisitionWorkspaceKind,
    CandidateOwnership, ImportAcquisitionContext, ImportAction, ImportCandidate,
    ImportOutcomeStatus, ImportSourceClass,
};
pub use provenance::{ImportBatch, ImportProvenance, ImportProvenanceEvent};
