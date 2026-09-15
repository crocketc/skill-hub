pub mod agent;
pub mod api;
pub mod app_update;
pub mod application;
pub mod backup;
pub mod bootstrap;
pub mod call_policy;
pub mod catalog;
pub mod check;
pub mod deployment;
pub mod duplicate;
mod error;
pub mod evidence;
pub mod export;
pub mod external_link;
pub mod health;
mod ids;
pub mod ignore;
pub mod import;
pub mod llm;
mod operation;
mod path_policy;
pub mod pending;
pub mod project;
pub mod relationship;
pub mod scan;
pub mod search;
pub mod settings;
pub mod source;
pub mod versioning;

/// OPT-20260914-08：跨 IPC 的 64 位整数序列化约定（字符串承载）。Specta
/// 禁止把 i64/u64 等 BigInt 类型导出为 TS number（精度丢失），与
/// `app_update::u64_string` 采用同一裁决：边界上是字符串，域内保持 i64。
pub mod i64_string {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

/// [`i64_string`] 的可缺省版本：`Option<i64>` 字段在 TS 侧是
/// `string | null`。
pub mod i64_option_string {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &Option<i64>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(value) => serializer.serialize_some(&value.to_string()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<i64>, D::Error> {
        let value = Option::<String>::deserialize(deserializer)?;
        value
            .map(|text| text.parse().map_err(serde::de::Error::custom))
            .transpose()
    }
}

pub use agent::{
    AgentClient, AgentProfile, AgentRepository, CallPolicy, ClientInstance, ClientKind,
    ClientPresence, CustomAgent, CustomAgentDraft, CustomAgentOverride, CustomAgentValidationError,
    DeploymentCapability, DirectoryPrecedence, DiscoverySnapshot, LogicalTarget, OperatingSystem,
    PathCandidate, PathGrant, PathGrantResolver, PhysicalTarget, ProfileCatalog, ResolvedPathGrant,
    TargetScope,
};
pub use api::{
    ActivateLibraryRoot, AddSkillRepo, AnalyzeGlobalSkillEvidence, AnalyzeImport,
    AnalyzeSemanticDuplicates, AppCommand, AppCommandResult, AppEvent, AppQuery, AppQueryResult,
    ApplicationFacade, ApplySourceUpdate, ApplyUninstallDecision, BackupDecision,
    CheckApplicationUpdate, CheckSourceUpdate, CollectDeploymentChanges, CommitCallPolicyChange,
    CommitDeleteSkill, CommitDeployment, CommitImport, CommitInitialRestore,
    CommitRelationMigration, CommitRepair, CommitRestore, CommitUndeploy, CreateBackup,
    CreateIgnoreRule, CreateStandardExport, DeploymentTarget, DetachManagement,
    DiscoverAgentsLockSkills, DiscoverImportCandidates, DiscoverRepoSkills,
    DownloadApplicationUpdate, DownloadRepoSkill, FactsChanged, GenerateOnlineSearchQuery,
    GetCallPolicy, GetDeploymentPlan, GetDeploymentRelations, GetLlmSafetyCheckResult,
    GetProjectAssemblyPlan, GetReconcilePlan, GetRelationshipOverview,
    GetRelationshipRemovalImpact, GetRemovalImpact, GetUiPreference, GetUiPreferenceResult,
    IgnoreExternalChange, InstallApplicationUpdate, KeepIndependentCopy, ListDeploymentTargets,
    ListDeployments, ListMarkdownFiles, ListPendingItems, ListSkillOperations, ListSkillRepos,
    ListSkills, LlmCheckRun, MarkdownFileContent, MarkdownFileEntry, OpenOfficialRelease, Page,
    PrepareApplicationUpdate, PrepareBackup, PrepareCallPolicyChange, PrepareDeleteSkill,
    PrepareDeployment, PrepareImport, PrepareInitialRestore, PrepareRelationMigration,
    PrepareRepair, PrepareRestore, PrepareStandardExport, PrepareUndeploy, PrepareUninstall,
    ReadMarkdownFile, RecheckLlmSafety, RefreshSkillRepo, RelationMigrationInput,
    RelationMigrationTargetMode, RelationshipMigrationBackupPolicy, RelationshipOverview,
    RelationshipOverviewScope, RelationshipScope, RelinkSource, RemoveIgnoreRule, RemoveSkillRepo,
    ResolveRecovery, RestoreDecision, RestoreDeployment, RestoreOriginalCallPolicy,
    RollbackApplicationUpdate, RollbackRelationMigration, RunHealthCheck, RunImportAiChecks,
    RunLlmSafetyCheck, RunRollingBackup, SaveUserTranslationRevision, SearchOnlineSources,
    SearchOnlineSourcesAssisted, SetApplicationUpdatePolicy, SetUiPreference, SkillListItem,
    SkillListPage, SkillOperationEntry, SkillOperationsResult, TranslateDescription,
    TranslateDescriptionsBatch, VerifyBackup,
};
pub use app_update::{
    install_action_for, select_artifact, validate_official_artifact_url,
    validate_official_release_url, verify_artifact, verify_downloaded_artifact, version_is_newer,
    ApplicationUpdate, ApplicationUpdatePolicy, BuildTrust, DownloadedApplicationUpdate,
    InstallAction, PreparedApplicationUpdate, UpdateArtifact, UpdateManifest, UpdatePlatform,
    UpdateSignaturePublicKey, UpdateState, DEFAULT_UPDATE_SIGNATURE_PUBLIC_KEY,
    TAURI_UPDATE_SIGNATURE_PUBLIC_KEY,
};
pub use application::{
    BasicCheckOutput, BasicCheckScanner, CallPolicyBackend, CallPolicyService, CheckService,
    DeploymentBackend, DeploymentService, DeploymentSummary, DuplicateCandidateProvider,
    DuplicateService, HealthBackend, HealthService, IgnoreBackend, IgnoreService, ImportBackend,
    ImportItemResult, ImportItemStatus, ImportService, ImportSummary, LlmSafetyService,
    OperationService, PreparedDeployment, PreparedImport, ProjectAssemblyService, ReconcileBackend,
    ReconcileService, RecoveryBackend, RecoveryService, RemovalBackend, RemovalService,
    RuntimeScheduler, SearchQueryService, TargetOperationError, TargetOperationResult,
    TargetOperationStatus, TranslationRepository, TranslationService, VersionMaterializer,
};
pub use application::{WatchConfirmation, WatchHint, WatchHintKind, WatchService};
pub use bootstrap::{
    BootstrapSnapshot, DeploymentChartCategory, DeploymentDimension, InitializationState,
    InitializationStatus, PendingSummary, RecentOperationSummary, StartupRecoveryState,
};
pub use error::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};
pub use evidence::{
    EvidenceCoverage, EvidenceProvider, GlobalSkillRecommendation, GlobalSkillSuggestion,
    UsageEvidence, UsageEvidenceAnalysis, UsageEvidenceAnalyzer,
};
pub use export::{
    ExportDecision, ExportFile, ExportFormat, ExportInput, ExportPlan, ExportResult,
    ExportSelection, ExportSkill, ExportSkillSummary, UninstallAction, UninstallImpact,
    UninstallService, VersionSelection,
};
pub use external_link::{
    external_url_host, validate_external_url, OpenExternalUrl, EXTERNAL_URL_ALLOWED_HOSTS,
};
pub use operation::{
    InverseOperation, OperationContext, OperationJournal, OperationObjectResult, OperationPhase,
    OperationProgress, OperationRecord, OperationRepository, OperationStatus, OperationSummary,
    PreparedRelationMigration, RelationMigrationResult, RelationMigrationState, UndoPlan,
};
pub use path_policy::{
    physical_id_for_path, symlink_physical_id_for_path, AllowedRoot, AllowedRootId, PathPolicy,
    SafePath,
};
pub use settings::DesktopPreferences;

pub use call_policy::{CallPolicyCapability, CallPolicyPlan, CallPolicyResult};
pub use catalog::{LibraryManifest, LibraryPaths, PortableSkillRecord};
pub use deployment::reconcile::{
    ExternalChangeObservation, ExternalChangeState, ReconcileAction, ReconcilePlan, ReconcileResult,
};
pub use deployment::removal::{
    DeploymentRemovalResult, ProjectVersionPin, RemovalChoice, RemovalDecision, RemovalImpact,
    RemovalResult,
};
pub use deployment::{
    path_lives_under, reconcile_observed_row, DeploymentCapabilities, DeploymentMode,
    DeploymentPlan, DeploymentPlanInput, DeploymentPlanRequest, DeploymentPlanner,
    DeploymentRecord, DeploymentRepository, DeploymentRequest, DeploymentState, ExistingDeployment,
    ExistingOwnership, ObservedDeployment, ObservedMatchState, ObservedOrigin,
    ObservedPathObservation, ObservedRowAction, ObservedStatus, RegisteredTargetIndex,
    RegisteredTargetResolver, TargetCapabilities, TargetChange, TargetConflict,
    TargetConflictReason, TargetFact, TargetFactSource, TargetPlan, VerifiedTarget,
};
pub use health::{HealthFinding, HealthReport, RecoveryCandidate, RepairAction, RepairPlan};
pub use ids::{
    AgentProfileId, ClientInstanceId, CombinationId, DeploymentId, LogicalTargetId,
    ObservedDeploymentId, OperationId, PhysicalTargetId, ProjectId, SkillId, VersionId,
};
pub use ignore::{IgnoreRule, IgnoreSubject};
pub use import::{
    analyze_import, ensure_original_deletion_authorized, import_governance_task_id,
    plan_original_migration, CandidateOwnership, DuplicateKind, ExistingSkillRecord, ImportAction,
    ImportAnalysis, ImportCandidate, ImportConflict, ImportDecision, ImportGovernanceAction,
    ImportGovernanceClassification, ImportGovernanceDecision, ImportGovernanceGroup,
    ImportGovernanceMember, ImportMatch, ImportProvenance, ImportSourceFacts, MatchBasis,
    OriginalMigrationConflict, OriginalMigrationConflictReason, OriginalMigrationFacts,
    OriginalMigrationPlan, OriginalMigrationResult, OriginalMigrationState,
};
pub use llm::{search_query, translation};
pub use llm::{
    CredentialRef, CredentialStore, LlmProfile, LlmTaskKind, LlmTaskRequest, LlmTaskResponse,
    LlmTaskRunner,
};
pub use project::{
    AssemblyChoice, AssemblyConflictKind, AssemblyItemPlan, AssemblyItemStatus, AssemblyPlan,
    CheckPreparation, CheckPreparationPort, DeploymentPreparation, DeploymentPreparationPort,
    PortableSource, Project, ProjectMetadata, ProjectRepository, ProjectTag, SavedProjectView,
    SharedProjectConfig, SharedSkillRequirement, SkillResolution, SkillResolutionPort,
    SourcePreparation, SourcePreparationPort,
};
pub use relationship::{
    classify_conflict_evidence, file_representation_display_label, relation_display_label,
    AgentDirectoryCapabilityFact, ConflictCaseFact, ConflictClassification, ConflictEvidence,
    ConflictKind, ConflictMemberFact, DeploymentRelationFact, DirectoryNodeFact,
    DirectoryRecognition, DirectoryRole, FileRepresentation, GovernanceTaskFact,
    GovernanceTaskKind, IdentityDirection, OwnershipState, RelationshipType, SourceRelationFact,
};
pub use scan::{DiscoveredSkill, ScanGeneration, ScanIssue, ScanRepository, ScanResult, ScanScope};
pub use source::{
    AgentsLockEntry, SearchCandidateRecord, SearchCandidateStatus, SearchHitOrigin,
    SourceDescriptor, SourceKind, SourceLocator, SourceRecord, SourceRole, SourceSearchHit,
    SourceSearchPage, SourceSearchQuery, UpstreamOrigin,
};
pub use source::{
    AppliedSourceUpdate, SourceState, SourceUpdateBackend, UpdateDecision, UpstreamCheckResult,
};
pub use versioning::{FileEntry, VersionDiff, VersionManifest, VersionRecord, VersionRepository};
