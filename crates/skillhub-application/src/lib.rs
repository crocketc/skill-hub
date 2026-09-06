//! Shared application boundary implementations.

mod external_link;
mod update_service;

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
pub use external_link::{ExternalLinkService, ExternalUrlOpener, SystemExternalUrlOpener};
use skillhub_adapters::agent::discovery::{DiscoverAgents, DiscoveryRoots};
use skillhub_adapters::app_update::github_releases::GithubReleaseProvider;
use skillhub_adapters::deployment::{DeploymentFilesystem, OwnershipProof};
use skillhub_adapters::import::SkillDetector;
use skillhub_adapters::scanner::ScanService;
use skillhub_adapters::security::BasicScanner;
use skillhub_adapters::source::{
    agents_lock_path, cleanup_stale_downloads, read_agents_lock, stale_download_retention,
    RepoDiscoveryProvider, SkillsShProvider,
};
use skillhub_core::api::{
    ApplySourceUpdate, BasicCheckResult, CheckSourceUpdate, CreateCombination, CreateSkill,
    DeleteCombination, PinProjectSkillVersion, RelinkSource, RenameSkill, SaveMarkdownContent,
    SaveSkillContent, SavedSkillContent, SetCurrentVersion, SetFindingDisposition, SetLifecycle,
    SetMetadata, SetTrial, UpdateCombination,
};
use skillhub_core::application::{
    CallPolicyBackend, CallPolicyService, DeploymentBackend, DeploymentService,
    DuplicateCandidateProvider, DuplicateService, HealthBackend, HealthService, IgnoreBackend,
    IgnoreService, PreparedImport, ReconcileBackend, ReconcileService, RecoveryBackend,
    RecoveryService, RemovalBackend, RemovalService, SearchQueryService, TranslationRepository,
    TranslationService,
};
use skillhub_core::backup::{
    BackupCreated, BackupInput, BackupPackage, BackupScope, SensitiveContentDecision,
};
use skillhub_core::call_policy::CallPolicyCapability;
use skillhub_core::catalog::CallPolicy;
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::check::{CheckKind, CheckRun, CheckRunPhase, FindingDisposition};
use skillhub_core::deployment::{
    DeploymentPlanRequest, DeploymentRecord, DeploymentState, RegisteredTargetIndex, TargetFact,
    TargetPlan,
};
use skillhub_core::duplicate::DuplicateCandidate;
use skillhub_core::evidence::UsageEvidenceAnalyzer;
use skillhub_core::health::{HealthFinding, RecoveryCandidate, RepairAction};
use skillhub_core::ignore::IgnoreRule;
use skillhub_core::llm::translation::TranslationRecord;
use skillhub_core::llm::LlmTaskRunner;
use skillhub_core::source::{SourceDescriptor, SourceLocator, SourceState, UpdateDecision};
use skillhub_core::{
    physical_id_for_path, AllowedRoot, AppCommand, AppCommandResult, AppError, AppQuery,
    AppQueryResult, AppResult, ApplicationFacade, DeploymentMode, ErrorCode, OperationId,
    PathPolicy, RecoveryAction, ResolvedPathGrant, Severity, TargetChange,
    UpdateSignaturePublicKey,
};
use skillhub_storage::backup::{BackupService, RestoreService, RetentionService};
use skillhub_storage::export::ExportService;
use skillhub_storage::{
    CentralLibrary, Database, LibraryPaths, UsageEvidenceRepository, VersionStore,
};
pub use update_service::{
    ApplicationUpdateInstaller, RollbackResult, RollbackState, UpdateDownloadPlan, UpdateService,
};

/// The date provider is kept on the facade so all date-sensitive projections
/// in one request use the same day boundary. Production uses the current UTC
/// date; tests can inject a fixed value with [`LocalApplicationFacade::new_with_today`].
pub struct LocalApplicationFacade {
    database: Arc<Mutex<Database>>,
    today: (i32, u8, u8),
    library: Option<VersionStore>,
    library_root: Option<PathBuf>,
    deployment_targets: Option<RegisteredTargetIndex>,
    deployment_service: Arc<DeploymentService<LocalDeploymentBackend>>,
    removal_service: Arc<RemovalService<LocalDeploymentBackend>>,
    reconcile_service: Arc<ReconcileService<LocalDeploymentBackend>>,
    health_service: Arc<HealthService<LocalHealthBackend>>,
    recovery_service: Arc<RecoveryService<LocalRecoveryBackend>>,
    call_policy_service: Arc<CallPolicyService<LocalCallPolicyBackend>>,
    ignore_service: Arc<IgnoreService<LocalIgnoreBackend>>,
    llm_runner: Option<Arc<dyn LlmTaskRunner>>,
    translation_records: Arc<Mutex<HashMap<(skillhub_core::SkillId, String), TranslationRecord>>>,
    evidence_repository: UsageEvidenceRepository,
    app_update_provider: Arc<GithubReleaseProvider>,
    update_service: Arc<UpdateService>,
    source_search_provider: Arc<SkillsShProvider>,
    repo_discovery_provider: Arc<RepoDiscoveryProvider>,
    prepared_imports: Mutex<HashMap<OperationId, PreparedImport>>,
    prepared_uninstall: Mutex<Option<skillhub_core::UninstallImpact>>,
    scan_service: Mutex<ScanService>,
    path_grants: Mutex<HashMap<String, ResolvedPathGrant>>,
    assembly_plans: Mutex<HashMap<OperationId, skillhub_core::AssemblyPlan>>,
    external_link_service: ExternalLinkService,
    llm_runs: Mutex<HashMap<(String, String), RunningLlmCheck>>,
    upstream_origins: Mutex<HashMap<String, skillhub_core::UpstreamOrigin>>,
}

/// One in-flight LLM check: its externally visible operation id plus the flag
/// `cancel_operation` sets to abandon it.
struct RunningLlmCheck {
    operation_id: skillhub_core::OperationId,
    cancelled: Arc<AtomicBool>,
}

struct LocalDeploymentBackend {
    database: Arc<Mutex<Database>>,
    library_root: Option<PathBuf>,
    filesystem: DeploymentFilesystem,
}

#[derive(Clone)]
struct SharedLlmRunner(Arc<dyn LlmTaskRunner>);

#[async_trait(?Send)]
impl LlmTaskRunner for SharedLlmRunner {
    async fn run(
        &self,
        profile: &skillhub_core::LlmProfile,
        request: skillhub_core::LlmTaskRequest,
    ) -> AppResult<skillhub_core::LlmTaskResponse> {
        self.0.run(profile, request).await
    }
}

struct NoopLlmRunner;

#[async_trait(?Send)]
impl LlmTaskRunner for NoopLlmRunner {
    async fn run(
        &self,
        _profile: &skillhub_core::LlmProfile,
        _request: skillhub_core::LlmTaskRequest,
    ) -> AppResult<skillhub_core::LlmTaskResponse> {
        Err(AppError::new(ErrorCode::LlmNotConfigured, Severity::Info))
    }
}

#[derive(Clone)]
struct LocalTranslationRepository {
    records: Arc<Mutex<HashMap<(skillhub_core::SkillId, String), TranslationRecord>>>,
}

#[async_trait(?Send)]
impl TranslationRepository for LocalTranslationRepository {
    async fn get(
        &self,
        skill_id: skillhub_core::SkillId,
        language: &str,
    ) -> AppResult<Option<TranslationRecord>> {
        self.records
            .lock()
            .map_err(|_| internal("translation.get"))
            .map(|records| records.get(&(skill_id, language.to_owned())).cloned())
    }

    async fn save(&self, record: TranslationRecord) -> AppResult<()> {
        self.records
            .lock()
            .map_err(|_| internal("translation.save"))?
            .insert((record.skill_id, record.language.clone()), record);
        Ok(())
    }
}

#[derive(Clone)]
struct StaticDuplicateCandidateProvider {
    candidates: Vec<DuplicateCandidate>,
}

#[async_trait(?Send)]
impl DuplicateCandidateProvider for StaticDuplicateCandidateProvider {
    async fn candidates(
        &self,
        _skill_id: skillhub_core::SkillId,
    ) -> AppResult<Vec<DuplicateCandidate>> {
        Ok(self.candidates.clone())
    }
}

impl LocalDeploymentBackend {
    fn new(database: Arc<Mutex<Database>>, library_root: Option<PathBuf>) -> Self {
        Self {
            database,
            library_root,
            filesystem: DeploymentFilesystem::new(),
        }
    }

    fn materialized_source(&self, target: &TargetPlan) -> AppResult<PathBuf> {
        let source = PathBuf::from(&target.source_path);
        if source.is_dir() {
            return Ok(source);
        }
        let Some(library_root) = &self.library_root else {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("detail", "central library source is unavailable")
                .with_action(RecoveryAction::Retry));
        };
        let paths = LibraryPaths::from_root(library_root.clone());
        if matches!(
            target.mode,
            DeploymentMode::SymbolicLink | DeploymentMode::DirectoryJunction
        ) {
            let central = CentralLibrary::initialize(library_root)?;
            if let Some((record, current)) = central.load_portable_skill(target.skill_id)? {
                if current.as_ref() == Some(&target.version_id) {
                    let visible = central
                        .visible_skill_path_for_runtime(target.skill_id, &record.runtime_name);
                    if visible.is_dir() {
                        return Ok(visible);
                    }
                }
            }
        }
        let materialized = paths
            .management_dir
            .join("deployment-trees")
            .join(target.skill_id.to_string())
            .join(target.version_id.as_str());
        if !materialized.is_dir() {
            std::fs::create_dir_all(&materialized).map_err(|error| {
                AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("io_kind", format!("{:?}", error.kind()))
                    .with_action(RecoveryAction::Retry)
            })?;
            VersionStore::new(paths).materialize(&target.version_id, &materialized)?;
        }
        Ok(materialized)
    }

    fn target_root(&self, deployment: &DeploymentRecord) -> AppResult<PathBuf> {
        let target_root: String = {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("removal.target"))?;
            database
                .connection_for_test()
                .query_row(
                    "SELECT path FROM targets WHERE id=?1",
                    [deployment.target_id.as_str()],
                    |row| row.get(0),
                )
                .map_err(|_| {
                    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                        .with_param("field", "deployment_target")
                        .with_action(RecoveryAction::Retry)
                })?
        };
        Ok(PathBuf::from(target_root))
    }

    fn deployment_proof(&self, deployment: &DeploymentRecord) -> AppResult<OwnershipProof> {
        let target_root = self.target_root(deployment)?;
        if physical_id_for_path(&target_root).as_deref() != Some(deployment.target_id.as_str()) {
            return Err(AppError::new(ErrorCode::OwnershipMismatch, Severity::Error)
                .with_param("detail", "registered deployment target identity changed")
                .with_action(RecoveryAction::InspectTarget));
        }
        let destination_path = target_root.join(&deployment.runtime_name);
        let target_identity = physical_id_for_path(&destination_path).ok_or_else(|| {
            AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("detail", "deployment target identity is unavailable")
                .with_action(RecoveryAction::InspectTarget)
        })?;
        let source_path = self
            .library_root
            .as_ref()
            .map(|root| {
                root.join("versions")
                    .join(deployment.skill_id.to_string())
                    .join(deployment.version_id.as_str())
            })
            .unwrap_or_else(|| destination_path.clone());
        Ok(OwnershipProof {
            mode: deployment.mode,
            destination_path,
            source_path,
            expected_hash: deployment.expected_hash.clone(),
            target_identity,
            skill_id: deployment.skill_id,
            version_id: deployment.version_id.clone(),
            runtime_name: deployment.runtime_name.clone(),
        })
    }

    fn active_deployments(&self) -> AppResult<Vec<DeploymentRecord>> {
        let database = self
            .database
            .lock()
            .map_err(|_| internal("removal.inspect"))?;
        Ok(database
            .deployment_repository()
            .list_all()?
            .into_iter()
            .filter(|record| record.state == DeploymentState::Deployed)
            .collect())
    }

    fn deployment_destination(&self, deployment: &DeploymentRecord) -> AppResult<PathBuf> {
        Ok(self.target_root(deployment)?.join(&deployment.runtime_name))
    }
}

#[async_trait]
impl DeploymentBackend for LocalDeploymentBackend {
    async fn apply_target(&self, target: &TargetPlan) -> AppResult<DeploymentRecord> {
        let source = self.materialized_source(target)?;
        let mut effective = target.clone();
        effective.source_path = source.to_string_lossy().into_owned();
        let prepared = self.filesystem.prepare(&effective)?;
        let applied = self.filesystem.apply(prepared)?;
        let record = DeploymentRecord {
            id: skillhub_core::DeploymentId::new(),
            skill_id: target.skill_id,
            version_id: target.version_id.clone(),
            target_id: target.physical_target_id.clone(),
            state: DeploymentState::Deployed,
            mode: target.mode,
            managed: true,
            runtime_name: target.runtime_name.clone(),
            expected_hash: applied.ownership.expected_hash,
            observed_hash: Some(applied.observed_tree_hash),
        };
        let database = self.database.lock().map_err(|_| {
            AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("operation", "execute.commit_deployment")
                .with_action(RecoveryAction::Retry)
        })?;
        database.deployment_repository().insert_sync(&record)?;
        Ok(record)
    }
}

#[async_trait]
impl RemovalBackend for LocalDeploymentBackend {
    async fn inspect_delete(
        &self,
        skill_id: skillhub_core::SkillId,
    ) -> AppResult<skillhub_core::RemovalImpact> {
        let deployments = self
            .active_deployments()?
            .into_iter()
            .filter(|record| record.skill_id == skill_id)
            .collect::<Vec<_>>();
        let requires_shared_target_choice = deployments.iter().any(|record| {
            deployments
                .iter()
                .filter(|other| other.target_id == record.target_id)
                .count()
                > 1
        });
        Ok(skillhub_core::RemovalImpact {
            operation_id: OperationId::new(),
            skill_id,
            deployments,
            requires_shared_target_choice,
            dependencies: Vec::new(),
        })
    }

    async fn inspect_undeploy(
        &self,
        deployment_id: skillhub_core::DeploymentId,
    ) -> AppResult<skillhub_core::RemovalImpact> {
        let deployment = self
            .active_deployments()?
            .into_iter()
            .find(|record| record.id == deployment_id)
            .ok_or_else(|| {
                AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("field", "deployment")
                    .with_action(RecoveryAction::Retry)
            })?;
        let shared = self
            .active_deployments()?
            .into_iter()
            .filter(|record| record.target_id == deployment.target_id)
            .count()
            > 1;
        Ok(skillhub_core::RemovalImpact {
            operation_id: OperationId::new(),
            skill_id: deployment.skill_id,
            deployments: vec![deployment],
            requires_shared_target_choice: shared,
            dependencies: Vec::new(),
        })
    }

    async fn remove_owned_target(&self, deployment: &DeploymentRecord) -> AppResult<()> {
        self.filesystem
            .remove_owned(&self.deployment_proof(deployment)?)?;
        let database = self
            .database
            .lock()
            .map_err(|_| internal("removal.remove_target"))?;
        database
            .deployment_repository()
            .mark_removed_sync(deployment.id)
    }

    async fn remove_relation(&self, deployment: &DeploymentRecord) -> AppResult<()> {
        let database = self
            .database
            .lock()
            .map_err(|_| internal("removal.remove_relation"))?;
        database
            .deployment_repository()
            .mark_removed_sync(deployment.id)
    }

    async fn detach_management(&self, deployment: &DeploymentRecord) -> AppResult<()> {
        let database = self
            .database
            .lock()
            .map_err(|_| internal("removal.detach_management"))?;
        database
            .deployment_repository()
            .detach_management_sync(deployment.id)
    }

    async fn delete_skill(&self, skill_id: skillhub_core::SkillId) -> AppResult<()> {
        let Some(library_root) = self.library_root.as_ref() else {
            return Err(unsupported("execute.delete_skill.library"));
        };
        let (skill, current) = {
            let database = self
                .database
                .lock()
                .map_err(|_| internal("execute.delete_skill"))?;
            if database
                .deployment_repository()
                .list_all()?
                .into_iter()
                .any(|record| {
                    record.skill_id == skill_id && record.state == DeploymentState::Deployed
                })
            {
                return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("detail", "active deployment relation remains")
                    .with_action(RecoveryAction::InspectTarget));
            }
            let skill = database
                .catalog_repository()?
                .get_sync(skill_id)?
                .ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))?;
            let store = VersionStore::new(LibraryPaths::from_root(library_root.clone()));
            (skill, store.current(skill_id)?)
        };
        let central = CentralLibrary::initialize(library_root)?;
        let store = VersionStore::from_library(&central);
        self.database
            .lock()
            .map_err(|_| internal("execute.delete_skill.catalog"))?
            .catalog_repository()?
            .remove_sync(skill_id)?;
        if let Err(error) = central.remove_portable_skill(skill_id) {
            let restore = self
                .database
                .lock()
                .map_err(|_| internal("execute.delete_skill.rollback"))?
                .catalog_repository()?
                .insert_sync(&skill);
            return Err(cleanup_import_error(error, restore));
        }
        if let Err(error) = store.remove_skill_sync(skill_id) {
            let restore = self
                .database
                .lock()
                .map_err(|_| internal("execute.delete_skill.rollback"))?
                .catalog_repository()?
                .insert_sync(&skill)
                .and_then(|()| central.save_portable_skill(&skill, current.as_ref()));
            return Err(cleanup_import_error(error, restore));
        }
        Ok(())
    }
}

#[async_trait]
impl ReconcileBackend for LocalDeploymentBackend {
    async fn get_deployment(&self, id: skillhub_core::DeploymentId) -> AppResult<DeploymentRecord> {
        self.active_deployments()?
            .into_iter()
            .find(|record| record.id == id)
            .ok_or_else(|| {
                AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("field", "deployment")
                    .with_action(RecoveryAction::Retry)
            })
    }

    async fn inspect_target(
        &self,
        deployment: &DeploymentRecord,
    ) -> AppResult<skillhub_core::ExternalChangeObservation> {
        let root = self.target_root(deployment)?;
        let root_identity = physical_id_for_path(&root);
        let destination = root.join(&deployment.runtime_name);
        if root_identity.as_deref() != Some(deployment.target_id.as_str()) || !destination.exists()
        {
            return Ok(skillhub_core::ExternalChangeObservation {
                state: skillhub_core::ExternalChangeState::Missing,
                observed_hash: None,
            });
        }
        let observed_hash = DeploymentFilesystem::hash_tree(&destination)?;
        let state = if observed_hash == deployment.expected_hash {
            skillhub_core::ExternalChangeState::Unchanged
        } else if deployment.observed_hash.as_deref() == Some(observed_hash.as_str()) {
            skillhub_core::ExternalChangeState::Ignored
        } else {
            skillhub_core::ExternalChangeState::Modified
        };
        Ok(skillhub_core::ExternalChangeObservation {
            state,
            observed_hash: Some(observed_hash),
        })
    }

    async fn collect_target_changes(
        &self,
        deployment: &DeploymentRecord,
    ) -> AppResult<skillhub_core::VersionId> {
        let Some(library_root) = self.library_root.as_ref() else {
            return Err(unsupported("execute.collect_deployment_changes.library"));
        };
        let destination = self.deployment_destination(deployment)?;
        let store = VersionStore::new(LibraryPaths::from_root(library_root.clone()));
        let version = store.capture(deployment.skill_id, &destination)?;
        let observed_hash = version.manifest.tree_hash.clone();
        let database = self
            .database
            .lock()
            .map_err(|_| internal("reconcile.collect"))?;
        database
            .deployment_repository()
            .update_reconcile_facts_sync(
                deployment.id,
                &version.id,
                &observed_hash,
                Some(&observed_hash),
            )?;
        Ok(version.id)
    }

    async fn restore_target(&self, deployment: &DeploymentRecord) -> AppResult<()> {
        let Some(library_root) = self.library_root.as_ref() else {
            return Err(unsupported("execute.restore_deployment.library"));
        };
        let destination = self.deployment_destination(deployment)?;
        let source = library_root
            .join("versions")
            .join(deployment.skill_id.to_string())
            .join(deployment.version_id.as_str());
        let target = TargetPlan {
            physical_target_id: deployment.target_id.clone(),
            logical_target_ids: Vec::new(),
            target_path: destination
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .to_string_lossy()
                .into_owned(),
            destination_path: destination.to_string_lossy().into_owned(),
            source_path: source.to_string_lossy().into_owned(),
            runtime_name: deployment.runtime_name.clone(),
            skill_id: deployment.skill_id,
            version_id: deployment.version_id.clone(),
            mode: deployment.mode,
            change: skillhub_core::TargetChange::Create,
            warnings: Vec::new(),
            conflicts: Vec::new(),
        };
        let proof = self.deployment_proof(deployment)?;
        self.filesystem.replace_owned(&proof)?;
        let source = self.materialized_source(&target)?;
        let mut effective = target;
        effective.source_path = source.to_string_lossy().into_owned();
        let applied = self
            .filesystem
            .apply(self.filesystem.prepare(&effective)?)?;
        let observed_hash = applied.observed_tree_hash.clone();
        let database = self
            .database
            .lock()
            .map_err(|_| internal("reconcile.restore"))?;
        database
            .deployment_repository()
            .update_reconcile_facts_sync(
                deployment.id,
                &deployment.version_id,
                &deployment.expected_hash,
                Some(&observed_hash),
            )
    }

    async fn keep_independent(&self, deployment: &DeploymentRecord) -> AppResult<()> {
        let database = self
            .database
            .lock()
            .map_err(|_| internal("reconcile.keep_independent"))?;
        database
            .deployment_repository()
            .detach_management_sync(deployment.id)
    }

    async fn ignore_external_change(&self, deployment: &DeploymentRecord) -> AppResult<()> {
        let observation = self.inspect_target(deployment).await?;
        let Some(observed_hash) = observation.observed_hash else {
            return Ok(());
        };
        let database = self
            .database
            .lock()
            .map_err(|_| internal("reconcile.ignore"))?;
        database
            .deployment_repository()
            .update_reconcile_facts_sync(
                deployment.id,
                &deployment.version_id,
                &deployment.expected_hash,
                Some(&observed_hash),
            )
    }
}

impl LocalApplicationFacade {
    /// Reads the central library root persisted via `set_library_root`, if any.
    /// Used by the desktop shell before constructing the facade so a restarted
    /// application resumes with the root chosen during onboarding.
    pub fn persisted_library_root(database_path: impl AsRef<Path>) -> Option<PathBuf> {
        let database = Database::open(database_path).ok()?;
        database
            .bootstrap_repository()
            .load_library_root()
            .ok()
            .flatten()
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
    }

    fn configured_library_path(&self) -> AppResult<PathBuf> {
        // A root chosen via `set_library_root` persists in the database and
        // wins over the constructor value once present.
        let persisted = self.with_database("bootstrap.library_root", |database| {
            database.bootstrap_repository().load_library_root()
        })?;
        if let Some(path) = persisted {
            return Ok(PathBuf::from(path));
        }
        self.library_root
            .clone()
            .ok_or_else(|| unsupported("bootstrap.library_path"))
    }

    /// Chooses the central library root before initialization completes. The
    /// chosen path is materialized immediately and persisted so the next
    /// application start uses it as the configured root. After initialization
    /// the root is immutable here; moving an initialized library is a migration.
    fn set_library_root(
        &self,
        request: skillhub_core::api::SetLibraryRoot,
    ) -> AppResult<AppCommandResult> {
        let path = request.path.trim();
        if path.is_empty() {
            return Err(invalid_input("library root path must not be empty"));
        }
        let already_initialized = self
            .with_database("execute.set_library_root.status", |database| {
                database.bootstrap_repository().load_initialization()
            })?;
        if already_initialized.as_ref().is_some_and(|status| {
            matches!(
                status.state,
                skillhub_core::InitializationState::Initialized
            )
        }) {
            return Err(AppError::new(
                skillhub_core::ErrorCode::OperationConflict,
                Severity::Error,
            )
            .with_param("detail", "library root cannot change after initialization")
            .with_action(RecoveryAction::Acknowledge));
        }
        let root = PathBuf::from(path);
        CentralLibrary::initialize(&root)?;
        let status = self.with_database("execute.set_library_root.persist", |database| {
            database.bootstrap_repository().save_library_root(path)?;
            Ok(database
                .bootstrap_repository()
                .load_initialization()?
                .unwrap_or_else(|| {
                    skillhub_core::InitializationStatus::not_initialized(
                        root.to_string_lossy().to_string(),
                    )
                }))
        })?;
        Ok(AppCommandResult::InitializationStatus(status))
    }

    fn list_skill_repos(&self) -> AppResult<AppQueryResult> {
        let repos = self.with_database("query.list_skill_repos", |database| {
            database.skill_repo_repository().list()
        })?;
        Ok(AppQueryResult::SkillRepos(repos))
    }

    /// 仓库发现（联网）：逐仓库下载扫描；单仓库失败只进 warnings，不拖垮整体。
    async fn discover_repo_skills(&self) -> AppResult<AppQueryResult> {
        self.ensure_network_enabled()?;
        let repos = self.with_database("query.discover_repo_skills.repos", |database| {
            database.skill_repo_repository().list()
        })?;
        let discovery = self.repo_discovery_provider.discover(repos).await;
        Ok(AppQueryResult::RepoDiscoveryReport(
            skillhub_core::source::RepoDiscoveryReport {
                skills: discovery.skills,
                warnings: discovery
                    .failures
                    .into_iter()
                    .map(
                        |(owner, name, reason)| skillhub_core::source::RepoDiscoveryWarning {
                            owner,
                            name,
                            reason,
                        },
                    )
                    .collect(),
            },
        ))
    }

    /// 仓库 CRUD：upsert（owner+name 相同则替换）；坐标校验拒绝非法引用。
    fn add_skill_repo(
        &self,
        request: skillhub_core::api::AddSkillRepo,
    ) -> AppResult<AppCommandResult> {
        let repo = request.repo;
        if let Err(error) = self.repo_discovery_provider.validate_repo(&repo) {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning)
                .with_param("reason", error.to_string())
                .with_action(RecoveryAction::Retry));
        }
        let repos = self.with_database("execute.add_skill_repo", |database| {
            let mut repos = database.skill_repo_repository().list()?;
            if let Some(existing) = repos
                .iter_mut()
                .find(|existing| existing.owner == repo.owner && existing.name == repo.name)
            {
                *existing = repo.clone();
            } else {
                repos.push(repo.clone());
            }
            repos.sort_by(|a, b| (&a.owner, &a.name).cmp(&(&b.owner, &b.name)));
            database.skill_repo_repository().save(&repos)?;
            Ok(repos)
        })?;
        Ok(AppCommandResult::SkillRepos(repos))
    }

    fn remove_skill_repo(
        &self,
        request: skillhub_core::api::RemoveSkillRepo,
    ) -> AppResult<AppCommandResult> {
        let repos = self.with_database("execute.remove_skill_repo", |database| {
            let mut repos = database.skill_repo_repository().list()?;
            let before = repos.len();
            repos.retain(|repo| !(repo.owner == request.owner && repo.name == request.name));
            if repos.len() == before {
                return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Warning)
                    .with_action(RecoveryAction::Acknowledge));
            }
            database.skill_repo_repository().save(&repos)?;
            Ok(repos)
        })?;
        Ok(AppCommandResult::SkillRepos(repos))
    }

    /// 下载仓库 Skill 到本机下载目录（预算受限），返回的本地路径随后
    /// 以 Local 来源身份进入现有导入管线；导入物化后才产生受管对象。
    async fn download_repo_skill(
        &self,
        request: skillhub_core::api::DownloadRepoSkill,
    ) -> AppResult<AppCommandResult> {
        self.ensure_network_enabled()?;
        let skill = request.skill;
        let repo = skillhub_core::source::SkillRepo {
            owner: skill.repo_owner.clone(),
            name: skill.repo_name.clone(),
            branch: skill.repo_branch.clone(),
            enabled: true,
        };
        if let Err(error) = self.repo_discovery_provider.validate_repo(&repo) {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning)
                .with_param("reason", error.to_string())
                .with_action(RecoveryAction::Retry));
        }
        let root = repo_downloads_root()?;
        let path = self
            .repo_discovery_provider
            .download_skill_directory(&repo, &skill.directory, &root)
            .await
            .map_err(|error| {
                AppError::new(ErrorCode::SourceSearchUnavailable, Severity::Error)
                    .with_param("source", error.to_string())
                    .with_action(RecoveryAction::Retry)
            })?;
        // 每次下载都尽力清理超过保留期的历史残留。
        cleanup_stale_downloads(&root, stale_download_retention());
        let runtime_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| skill.name.clone());
        self.register_upstream_origin(
            path.to_string_lossy(),
            skillhub_core::UpstreamOrigin {
                url: format!(
                    "https://github.com/{}/{}",
                    skill.repo_owner, skill.repo_name
                ),
                branch: skill.repo_branch.clone(),
                directory: skill.directory.clone(),
            },
        );
        Ok(AppCommandResult::DownloadedRepoSkill(
            skillhub_core::source::DownloadedRepoSkill {
                local_path: path.to_string_lossy().to_string(),
                runtime_name,
            },
        ))
    }

    fn complete_onboarding(
        &self,
        request: skillhub_core::api::CompleteOnboarding,
    ) -> AppResult<AppCommandResult> {
        let configured = self.configured_library_path()?;
        let selected = PathBuf::from(request.library_path.trim());
        if request.library_path.trim().is_empty() || !same_path(&configured, &selected) {
            return Err(invalid_input(
                "library_path must match the configured central library",
            ));
        }
        CentralLibrary::initialize(&configured)?;
        let status = skillhub_core::InitializationStatus::initialized(
            configured.to_string_lossy(),
            request.skipped,
        );
        self.with_database("execute.complete_onboarding", |database| {
            database
                .bootstrap_repository()
                .save_initialization(&status)?;
            Ok(AppCommandResult::InitializationStatus(status))
        })
    }

    fn discover_agent_targets(&self) -> AppResult<AppCommandResult> {
        let roots = DiscoveryRoots::new(current_operating_system(), user_home());
        let snapshot = DiscoverAgents::builtin().discover(&roots)?;
        self.with_database("execute.discover_agent_targets", |database| {
            let snapshot = database.agent_repository().replace(&snapshot)?;
            Ok(AppCommandResult::DiscoverySnapshot(snapshot))
        })
    }

    async fn check_application_update(
        &self,
        request: skillhub_core::CheckApplicationUpdate,
    ) -> AppResult<AppQueryResult> {
        self.ensure_network_enabled()?;
        self.update_service
            .check(request)
            .await
            .map(AppQueryResult::ApplicationUpdate)
    }

    fn set_application_update_policy(
        &self,
        request: skillhub_core::SetApplicationUpdatePolicy,
    ) -> AppResult<AppCommandResult> {
        let policy = skillhub_core::ApplicationUpdatePolicy {
            enabled: request.enabled,
            check_on_startup: request.check_on_startup,
        };
        self.with_database("execute.set_application_update_policy", |database| {
            database
                .application_update_repository()
                .save_policy(&policy)
                .map(AppCommandResult::ApplicationUpdatePolicy)
        })
    }

    fn open_official_release(
        &self,
        request: skillhub_core::OpenOfficialRelease,
    ) -> AppResult<AppCommandResult> {
        if !skillhub_core::validate_official_release_url(&request.release_url) {
            return Err(invalid_input(
                "release_url must be an official GitHub release URL",
            ));
        }
        self.external_link_service.open(&request.release_url)?;
        Ok(AppCommandResult::OperationSummary(operation_summary(
            "application_update.opened",
        )))
    }

    /// Opens one allowlisted https link in the platform browser. The URL comes
    /// from imported content, so it is validated before the platform opener is
    /// called; a rejection never reaches the browser.
    fn open_external_url(
        &self,
        request: skillhub_core::OpenExternalUrl,
    ) -> AppResult<AppCommandResult> {
        if !skillhub_core::validate_external_url(&request.url) {
            return Err(
                invalid_input("url must be an https URL on an allowlisted host").with_param(
                    "host",
                    skillhub_core::external_url_host(&request.url).unwrap_or_default(),
                ),
            );
        }
        self.external_link_service.open(&request.url)?;
        Ok(AppCommandResult::OperationSummary(operation_summary(
            "external_link.opened",
        )))
    }

    fn prepare_application_update(
        &self,
        request: skillhub_core::PrepareApplicationUpdate,
    ) -> AppResult<AppCommandResult> {
        let plan = self.update_service.prepare_download(request)?;
        self.update_service
            .record_ready(&plan, Some(&plan.current_version))
            .map(AppCommandResult::PreparedApplicationUpdate)
    }

    async fn download_application_update(
        &self,
        request: skillhub_core::DownloadApplicationUpdate,
    ) -> AppResult<AppCommandResult> {
        self.update_service
            .download(&request.artifact)
            .await
            .map(AppCommandResult::DownloadedApplicationUpdate)
    }

    async fn install_application_update(&self) -> AppResult<AppCommandResult> {
        self.update_service.install().await.map(|()| {
            AppCommandResult::ApplicationUpdateState(skillhub_core::UpdateState::ReadyToInstall)
        })
    }

    pub async fn rollback_if_unhealthy(&self) -> AppResult<RollbackResult> {
        self.update_service.rollback_if_unhealthy().await
    }

    async fn rollback_application_update(&self) -> AppResult<AppCommandResult> {
        let result = self.rollback_if_unhealthy().await?;
        let state = match result.state {
            RollbackState::RolledBack => skillhub_core::UpdateState::RolledBack,
            RollbackState::NoRollback => skillhub_core::UpdateState::UpToDate,
        };
        Ok(AppCommandResult::ApplicationUpdateState(state))
    }

    async fn search_online_sources(
        &self,
        request: skillhub_core::SearchOnlineSources,
    ) -> AppResult<AppQueryResult> {
        self.ensure_network_enabled()?;
        let now = now_seconds();
        if let Some(page) = self.with_database("query.search_online_sources.cache", |database| {
            database.source_search_cache().get(&request.query, now)
        })? {
            return Ok(AppQueryResult::SourceSearchPage(page));
        }
        let page = self
            .source_search_provider
            .search(request.query.clone())
            .await?;
        self.with_database("query.search_online_sources.cache", |database| {
            database
                .source_search_cache()
                .put(&request.query, &page, now)
        })?;
        Ok(AppQueryResult::SourceSearchPage(page))
    }

    fn ensure_network_enabled(&self) -> AppResult<()> {
        let enabled = self.with_database("settings.network_enabled", |database| {
            Ok(database
                .desktop_settings_repository()
                .get()?
                .network_enabled)
        })?;
        if enabled {
            Ok(())
        } else {
            Err(AppError::new(ErrorCode::NetworkDisabled, Severity::Warning)
                .with_action(RecoveryAction::Retry))
        }
    }

    /// Opens a file-backed facade, creating its parent directory when needed.
    pub fn open(path: impl AsRef<Path>) -> AppResult<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("source", error.to_string())
                    .with_action(RecoveryAction::Retry)
            })?;
        }
        Database::open(path).map(Self::new)
    }

    /// Opens a file-backed facade and connects it to the immutable central library.
    pub fn open_with_library(
        path: impl AsRef<Path>,
        library_root: impl AsRef<Path>,
    ) -> AppResult<Self> {
        let path = path.as_ref();
        let library_root = library_root.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("source", error.to_string())
                    .with_action(RecoveryAction::Retry)
            })?;
        }
        CentralLibrary::initialize(library_root)?;
        Database::open(path).map(|database| Self::new_with_library(database, library_root))
    }

    /// Creates a facade backed by the supplied SQLite database.
    pub fn new(database: Database) -> Self {
        Self::new_with_today(database, current_utc_date())
    }

    /// Creates a facade with an explicit date boundary for deterministic tests.
    pub fn new_with_today(database: Database, today: (i32, u8, u8)) -> Self {
        let database = Arc::new(Mutex::new(database));
        let backend = Arc::new(LocalDeploymentBackend::new(database.clone(), None));
        let deployment_service = Arc::new(DeploymentService::new(backend.clone()));
        let removal_service = Arc::new(RemovalService::new(backend));
        let reconcile_service = Arc::new(ReconcileService::new(Arc::new(
            LocalDeploymentBackend::new(database.clone(), None),
        )));
        let health_service = Arc::new(HealthService::new(Arc::new(LocalHealthBackend {
            database: database.clone(),
        })));
        let recovery_service = Arc::new(RecoveryService::new(Arc::new(LocalRecoveryBackend {
            database: database.clone(),
        })));
        let call_policy_service =
            Arc::new(CallPolicyService::new(Arc::new(LocalCallPolicyBackend {
                database: database.clone(),
                originals: Arc::new(Mutex::new(HashMap::new())),
            })));
        let ignore_service = Arc::new(IgnoreService::new(Arc::new(LocalIgnoreBackend {
            rules: Arc::new(Mutex::new(Vec::new())),
        })));
        let app_update_provider = Arc::new(GithubReleaseProvider::new());
        let update_service = Arc::new(UpdateService::new(
            database.clone(),
            app_update_provider.clone(),
        ));
        Self {
            database,
            today,
            library: None,
            library_root: None,
            deployment_targets: None,
            deployment_service,
            removal_service,
            reconcile_service,
            health_service,
            recovery_service,
            call_policy_service,
            ignore_service,
            llm_runner: None,
            translation_records: Arc::new(Mutex::new(HashMap::new())),
            evidence_repository: UsageEvidenceRepository::default(),
            app_update_provider,
            update_service,
            source_search_provider: Arc::new(SkillsShProvider::new("https://skills.sh")),
            repo_discovery_provider: Arc::new(RepoDiscoveryProvider::new()),
            prepared_imports: Mutex::new(HashMap::new()),
            prepared_uninstall: Mutex::new(None),
            scan_service: Mutex::new(ScanService::new()),
            path_grants: Mutex::new(HashMap::new()),
            assembly_plans: Mutex::new(HashMap::new()),
            external_link_service: ExternalLinkService::new(),
            llm_runs: Mutex::new(HashMap::new()),
            upstream_origins: Mutex::new(HashMap::new()),
        }
    }

    /// Creates a facade with read-only access to a central library root.
    pub fn new_with_library(database: Database, library_root: impl AsRef<Path>) -> Self {
        let library_root = library_root.as_ref().to_path_buf();
        let database = Arc::new(Mutex::new(database));
        let backend = Arc::new(LocalDeploymentBackend::new(
            database.clone(),
            Some(library_root.clone()),
        ));
        let deployment_service = Arc::new(DeploymentService::new(backend.clone()));
        let removal_service = Arc::new(RemovalService::new(backend.clone()));
        let reconcile_service = Arc::new(ReconcileService::new(backend));
        let health_service = Arc::new(HealthService::new(Arc::new(LocalHealthBackend {
            database: database.clone(),
        })));
        let recovery_service = Arc::new(RecoveryService::new(Arc::new(LocalRecoveryBackend {
            database: database.clone(),
        })));
        let call_policy_service =
            Arc::new(CallPolicyService::new(Arc::new(LocalCallPolicyBackend {
                database: database.clone(),
                originals: Arc::new(Mutex::new(HashMap::new())),
            })));
        let ignore_service = Arc::new(IgnoreService::new(Arc::new(LocalIgnoreBackend {
            rules: Arc::new(Mutex::new(Vec::new())),
        })));
        let app_update_provider = Arc::new(GithubReleaseProvider::new());
        let update_service = Arc::new(UpdateService::new(
            database.clone(),
            app_update_provider.clone(),
        ));
        Self {
            database,
            today: current_utc_date(),
            library: Some(VersionStore::new(LibraryPaths::from_root(&library_root))),
            library_root: Some(library_root),
            deployment_targets: None,
            deployment_service,
            removal_service,
            reconcile_service,
            health_service,
            recovery_service,
            call_policy_service,
            ignore_service,
            llm_runner: None,
            translation_records: Arc::new(Mutex::new(HashMap::new())),
            evidence_repository: UsageEvidenceRepository::default(),
            app_update_provider,
            update_service,
            source_search_provider: Arc::new(SkillsShProvider::new("https://skills.sh")),
            repo_discovery_provider: Arc::new(RepoDiscoveryProvider::new()),
            prepared_imports: Mutex::new(HashMap::new()),
            prepared_uninstall: Mutex::new(None),
            scan_service: Mutex::new(ScanService::new()),
            path_grants: Mutex::new(HashMap::new()),
            assembly_plans: Mutex::new(HashMap::new()),
            external_link_service: ExternalLinkService::new(),
            llm_runs: Mutex::new(HashMap::new()),
            upstream_origins: Mutex::new(HashMap::new()),
        }
    }

    /// Creates a facade with explicit online providers. Production uses the
    /// built-in GitHub releases and skills.sh providers; tests can inject
    /// providers pointed at a local HTTP fixture without touching the network.
    pub fn new_with_providers(
        database: Database,
        app_update_provider: Arc<GithubReleaseProvider>,
        source_search_provider: Arc<SkillsShProvider>,
    ) -> Self {
        Self::new_with_providers_and_update_key(
            database,
            app_update_provider,
            source_search_provider,
            UpdateSignaturePublicKey {
                value: skillhub_core::DEFAULT_UPDATE_SIGNATURE_PUBLIC_KEY.to_owned(),
            },
        )
    }

    /// Creates a facade with explicit online providers and an update key.
    /// Production callers should use [`Self::new_with_providers`]; the key
    /// override keeps test fixtures isolated from the production signing key.
    pub fn new_with_providers_and_update_key(
        database: Database,
        app_update_provider: Arc<GithubReleaseProvider>,
        source_search_provider: Arc<SkillsShProvider>,
        update_public_key: UpdateSignaturePublicKey,
    ) -> Self {
        let mut facade = Self::new(database);
        facade.update_service = Arc::new(UpdateService::with_public_key(
            facade.database.clone(),
            app_update_provider.clone(),
            update_public_key,
        ));
        facade.app_update_provider = app_update_provider;
        facade.source_search_provider = source_search_provider;
        facade
    }

    /// Creates a facade whose built-in online providers share one network
    /// switch. The switch affects only online operations; local queries and
    /// mutations continue to work when it is disabled.
    pub fn new_with_network_enabled(database: Database, enabled: bool) -> Self {
        Self::new_with_providers(
            database,
            Arc::new(GithubReleaseProvider::new().with_network_enabled(enabled)),
            Arc::new(SkillsShProvider::new("https://skills.sh").with_network_enabled(enabled)),
        )
    }

    /// Registers the desktop shell's platform installer so confirmed updates
    /// can actually launch. Facades without one keep installs blocked, so
    /// tests never start a real installer.
    pub fn set_application_update_installer(
        &self,
        installer: Arc<dyn update_service::ApplicationUpdateInstaller>,
    ) {
        self.update_service.set_installer(installer);
    }

    /// Registers the desktop shell's external URL opener so validated links
    /// can really be opened. Facades without one keep opening blocked, so
    /// tests never launch a browser.
    /// 记录仓库发现下载目录 → 上游坐标的映射；扫描该目录的导入候选会被盖章，
    /// 提交导入后坐标落库为长期 git 来源。
    pub fn register_upstream_origin(
        &self,
        local_path: impl Into<String>,
        origin: skillhub_core::UpstreamOrigin,
    ) {
        if let Ok(mut registry) = self.upstream_origins.lock() {
            registry.insert(local_path.into(), origin);
        }
    }

    pub fn set_external_url_opener(&self, opener: Arc<dyn ExternalUrlOpener>) {
        self.external_link_service.set_opener(opener);
    }

    /// Registers a directory grant issued by the native file picker. The
    /// facade never interprets caller-provided paths as grants; the host must
    /// resolve the opaque picker identifier and pass the resulting fact here.
    pub fn register_path_grant(&self, grant: ResolvedPathGrant) -> AppResult<()> {
        if grant.grant_id.trim().is_empty() || grant.path.trim().is_empty() {
            return Err(agent_invalid("path grant is incomplete"));
        }
        self.path_grants
            .lock()
            .map_err(|_| internal("register_path_grant"))?
            .insert(grant.grant_id.clone(), grant);
        Ok(())
    }

    /// Creates a library-backed facade with an explicitly registered target
    /// index. Production target discovery populates this index; tests can
    /// inject deterministic filesystem facts without scanning arbitrary paths.
    pub fn new_with_library_and_targets(
        database: Database,
        library_root: impl AsRef<Path>,
        deployment_targets: RegisteredTargetIndex,
    ) -> Self {
        let mut facade = Self::new_with_library(database, library_root);
        facade.deployment_targets = Some(deployment_targets);
        facade
    }

    /// Creates a library-backed facade with an injected LLM runner. Production
    /// wiring may supply the HTTP runner after credentials are configured;
    /// tests use a deterministic in-memory runner and never access the network.
    pub fn new_with_library_and_llm_runner(
        database: Database,
        library_root: impl AsRef<Path>,
        runner: Arc<dyn LlmTaskRunner>,
    ) -> Self {
        let mut facade = Self::new_with_library(database, library_root);
        facade.llm_runner = Some(runner);
        facade
    }

    /// Creates a facade with explicit local usage evidence for integrations
    /// that provide authorized invocation records. Evidence remains advisory
    /// and experimental; it is never synthesized from missing runtime data.
    pub fn new_with_evidence(database: Database, evidence: UsageEvidenceRepository) -> Self {
        let mut facade = Self::new(database);
        facade.evidence_repository = evidence;
        facade
    }

    /// Creates a library-backed facade with an LLM runner and explicit local
    /// usage evidence for deterministic integration tests and adapters.
    pub fn new_with_library_and_llm_runner_and_evidence(
        database: Database,
        library_root: impl AsRef<Path>,
        runner: Arc<dyn LlmTaskRunner>,
        evidence: UsageEvidenceRepository,
    ) -> Self {
        let mut facade = Self::new_with_library_and_llm_runner(database, library_root, runner);
        facade.evidence_repository = evidence;
        facade
    }

    fn with_database<T>(
        &self,
        operation: &'static str,
        action: impl FnOnce(&Database) -> AppResult<T>,
    ) -> AppResult<T> {
        let database = self.database.lock().map_err(|_| {
            AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("operation", operation)
                .with_action(RecoveryAction::Retry)
        })?;
        action(&database)
    }

    fn llm_context(
        &self,
        operation: &'static str,
    ) -> AppResult<(Arc<dyn LlmTaskRunner>, skillhub_core::LlmProfile)> {
        let runner = self
            .llm_runner
            .clone()
            .ok_or_else(|| AppError::new(ErrorCode::LlmNotConfigured, Severity::Info))?;
        let profile = self.with_database(operation, |database| {
            Ok(database.llm_profile_repository().list()?.into_iter().next())
        })?;
        let profile =
            profile.ok_or_else(|| AppError::new(ErrorCode::LlmNotConfigured, Severity::Info))?;
        Ok((runner, profile))
    }

    fn load_duplicate_candidates(
        &self,
        skill_id: skillhub_core::SkillId,
    ) -> AppResult<Vec<DuplicateCandidate>> {
        let database = self
            .database
            .lock()
            .map_err(|_| internal("duplicate.candidates"))?;
        let pairs = database.search_repository().duplicate_candidates()?;
        let mut ids = Vec::new();
        for pair in pairs {
            if pair.left_skill_id == skill_id {
                ids.push(pair.right_skill_id);
            } else if pair.right_skill_id == skill_id {
                ids.push(pair.left_skill_id);
            }
        }
        ids.sort_by_key(|id| id.to_string());
        ids.dedup();
        let mut candidates = Vec::with_capacity(ids.len() + 1);
        let mut all_ids = Vec::with_capacity(ids.len() + 1);
        all_ids.push(skill_id);
        all_ids.extend(ids);
        for id in all_ids {
            let Some(detail) = database.catalog_repository()?.get_detail(id)? else {
                continue;
            };
            candidates.push(DuplicateCandidate {
                skill_id: id,
                name: detail.display_name,
                description: detail.original_description,
                trigger: String::new(),
                permissions: Vec::new(),
                source: "local_catalog".to_owned(),
                basic_check_state: "unknown".to_owned(),
                locally_modified: false,
            });
        }
        Ok(candidates)
    }

    async fn analyze_semantic_duplicates(
        &self,
        skill_id: skillhub_core::SkillId,
    ) -> AppResult<AppCommandResult> {
        let (runner, profile) = self.llm_context("execute.analyze_semantic_duplicates.profile")?;
        let candidates = self.load_duplicate_candidates(skill_id)?;
        let service = DuplicateService::new(
            StaticDuplicateCandidateProvider { candidates },
            SharedLlmRunner(runner),
        );
        let result =
            run_non_send(move || async move { service.analyze(skill_id, &profile).await })?;
        Ok(AppCommandResult::DuplicateAnalysis(result))
    }

    async fn translate_description(
        &self,
        request: skillhub_core::TranslateDescription,
    ) -> AppResult<AppCommandResult> {
        let detail = self.with_database("execute.translate_description.skill", |database| {
            database.catalog_repository()?.get_detail(request.skill_id)
        })?;
        let detail =
            detail.ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))?;
        let (runner, profile) = self.llm_context("execute.translate_description.profile")?;
        let hash = description_hash(&detail.original_description);
        let service = TranslationService::new(
            LocalTranslationRepository {
                records: self.translation_records.clone(),
            },
            SharedLlmRunner(runner),
        );
        let original_description = detail.original_description;
        let language = request.language;
        let request_skill_id = request.skill_id;
        let result = run_non_send(move || async move {
            service
                .translate(
                    request_skill_id,
                    &original_description,
                    &hash,
                    &language,
                    Some(&profile),
                )
                .await
        })?;
        Ok(AppCommandResult::TranslationResult(result))
    }

    async fn save_user_translation_revision(
        &self,
        request: skillhub_core::SaveUserTranslationRevision,
    ) -> AppResult<AppCommandResult> {
        let exists = self
            .with_database("execute.save_user_translation_revision.skill", |database| {
                database.catalog_repository()?.get_detail(request.skill_id)
            })?;
        if exists.is_none() {
            return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error));
        }
        let service = TranslationService::new(
            LocalTranslationRepository {
                records: self.translation_records.clone(),
            },
            SharedLlmRunner(Arc::new(NoopLlmRunner)),
        );
        let skill_id = request.skill_id;
        let language = request.language;
        let source_description_hash = request.source_description_hash;
        let text = request.text;
        let save_language = language.clone();
        let save_source_description_hash = source_description_hash.clone();
        let save_text = text.clone();
        run_non_send(move || async move {
            service
                .save_user_revision(
                    skill_id,
                    &save_language,
                    &save_source_description_hash,
                    &save_text,
                )
                .await
        })?;
        Ok(AppCommandResult::TranslationResult(
            skillhub_core::llm::translation::TranslationResult {
                skill_id,
                language,
                text,
                provenance: skillhub_core::llm::translation::TranslationProvenance {
                    source_description_hash,
                    provider: "user".to_owned(),
                    model: "user_revision".to_owned(),
                    origin: skillhub_core::llm::translation::TranslationOrigin::UserRevision,
                },
            },
        ))
    }

    async fn generate_online_search_query(&self, text: String) -> AppResult<AppCommandResult> {
        let (runner, profile) = self.llm_context("execute.generate_online_search_query.profile")?;
        let result = run_non_send(move || async move {
            SearchQueryService::new(SharedLlmRunner(runner))
                .generate(&text, Some(&profile))
                .await
        })?;
        Ok(AppCommandResult::OnlineSearchQuery(result))
    }

    async fn analyze_global_skill_evidence(
        &self,
        request: skillhub_core::AnalyzeGlobalSkillEvidence,
    ) -> AppResult<AppQueryResult> {
        let evidence_repository = self.evidence_repository.clone();
        let analyzer = UsageEvidenceAnalyzer::new(evidence_repository);
        let mut analysis = run_non_send(move || async move {
            analyzer
                .analyze(request.window_days, request.threshold_calls)
                .await
        })?;
        if analysis.coverage.sources.is_empty() {
            analysis.coverage.complete = false;
            analysis.suggestions.clear();
        }
        Ok(AppQueryResult::GlobalSkillEvidence(analysis))
    }

    fn create_custom_agent(
        &self,
        request: skillhub_core::api::CreateCustomAgent,
    ) -> AppResult<AppCommandResult> {
        let resolver = LocalGrantResolver {
            grants: &self.path_grants,
        };
        let agent = skillhub_core::CustomAgent::from_draft(request.agent, &resolver)
            .map_err(|error| agent_invalid(format!("{error:?}")))?;
        self.with_database("execute.create_custom_agent", |database| {
            database
                .custom_agent_repository()
                .create(agent)
                .map(AppCommandResult::CustomAgent)
        })
    }

    fn update_custom_agent(
        &self,
        request: skillhub_core::api::UpdateCustomAgent,
    ) -> AppResult<AppCommandResult> {
        let resolver = LocalGrantResolver {
            grants: &self.path_grants,
        };
        let agent = skillhub_core::CustomAgent::from_draft(request.agent, &resolver)
            .map_err(|error| agent_invalid(format!("{error:?}")))?;
        self.with_database("execute.update_custom_agent", |database| {
            database
                .custom_agent_repository()
                .update(agent)
                .map(AppCommandResult::CustomAgent)
        })
    }

    fn remove_custom_agent(
        &self,
        request: skillhub_core::api::RemoveCustomAgent,
    ) -> AppResult<AppCommandResult> {
        self.with_database("execute.remove_custom_agent", |database| {
            database.custom_agent_repository().remove(&request.id)?;
            Ok(AppCommandResult::OperationSummary(operation_summary(
                "custom_agent.removed",
            )))
        })
    }

    fn reset_profile_override(
        &self,
        request: skillhub_core::api::ResetProfileOverride,
    ) -> AppResult<AppCommandResult> {
        self.with_database("execute.reset_profile_override", |database| {
            database
                .custom_agent_repository()
                .reset_override(&request.profile_id)?;
            Ok(AppCommandResult::OperationSummary(operation_summary(
                "agent_profile.override_reset",
            )))
        })
    }

    fn set_profile_override(
        &self,
        request: skillhub_core::api::SetProfileOverride,
    ) -> AppResult<AppCommandResult> {
        let resolver = LocalGrantResolver {
            grants: &self.path_grants,
        };
        let directory = skillhub_core::PathGrantResolver::resolve(&resolver, &request.directory)
            .map_err(|error| agent_invalid(format!("{error:?}")))?;
        let override_profile = skillhub_core::CustomAgentOverride {
            profile_id: request.profile_id,
            directory,
            profile: request.profile,
        };
        self.with_database("execute.set_profile_override", |database| {
            database
                .custom_agent_repository()
                .set_override(override_profile)
                .map(AppCommandResult::CustomAgentOverride)
        })
    }

    fn register_project(
        &self,
        request: skillhub_core::api::RegisterProject,
    ) -> AppResult<AppCommandResult> {
        self.with_database("execute.register_project", |database| {
            database
                .project_repository()
                .register(request.project)
                .map(AppCommandResult::Project)
        })
    }

    fn update_project(
        &self,
        request: skillhub_core::api::UpdateProject,
    ) -> AppResult<AppCommandResult> {
        self.with_database("execute.update_project", |database| {
            database
                .project_repository()
                .update(request.project)
                .map(AppCommandResult::Project)
        })
    }

    fn set_project_tags(
        &self,
        request: skillhub_core::api::SetProjectTags,
    ) -> AppResult<AppCommandResult> {
        self.with_database("execute.set_project_tags", |database| {
            database
                .project_repository()
                .set_tags(request.project_id, request.tags)
                .map(AppCommandResult::Project)
        })
    }

    fn save_project_view(
        &self,
        request: skillhub_core::api::SaveProjectView,
    ) -> AppResult<AppCommandResult> {
        self.with_database("execute.save_project_view", |database| {
            database
                .project_repository()
                .save_view(request.view)
                .map(AppCommandResult::SavedProjectView)
        })
    }

    fn write_shared_project_config(
        &self,
        request: skillhub_core::api::WriteSharedProjectConfig,
    ) -> AppResult<AppCommandResult> {
        self.with_database("execute.write_shared_project_config", |database| {
            database
                .project_repository()
                .write_shared_config(request.project_id, &request.config)?;
            Ok(AppCommandResult::SharedProjectConfig(request.config))
        })
    }

    fn read_shared_project_config(
        &self,
        request: skillhub_core::api::ReadSharedProjectConfig,
    ) -> AppResult<AppCommandResult> {
        self.with_database("execute.read_shared_project_config", |database| {
            database
                .project_repository()
                .read_shared_config(request.project_id)
                .map(AppCommandResult::SharedProjectConfig)
        })
    }

    fn prepare_project_assembly(
        &self,
        project_id: skillhub_core::ProjectId,
    ) -> AppResult<AppCommandResult> {
        let service = LocalAssemblyService { facade: self };
        let plan = service.prepare(project_id)?;
        self.assembly_plans
            .lock()
            .map_err(|_| internal("execute.prepare_project_assembly"))?
            .insert(plan.operation_id, plan.clone());
        Ok(AppCommandResult::AssemblyPlan(plan))
    }

    fn commit_project_assembly(
        &self,
        request: skillhub_core::api::CommitProjectAssembly,
    ) -> AppResult<AppCommandResult> {
        let service = LocalAssemblyService { facade: self };
        let result = service.commit(request.plan)?;
        self.assembly_plans
            .lock()
            .map_err(|_| internal("execute.commit_project_assembly"))?
            .insert(result.operation_id, result.clone());
        Ok(AppCommandResult::AssemblyPlan(result))
    }

    fn scan_scope_ids(&self, requested: Vec<String>) -> AppResult<Vec<String>> {
        self.with_database("execute.scan_scopes", |database| {
            let snapshot = database
                .agent_repository()
                .load()?
                .unwrap_or_else(empty_discovery);
            let mut ids = requested;
            if ids.is_empty() {
                ids.extend(
                    snapshot
                        .logical_targets
                        .iter()
                        .filter(|target| target.available && target.exists)
                        .map(|target| target.id.clone()),
                );
                ids.extend(
                    database
                        .project_repository()
                        .list()?
                        .into_iter()
                        .map(|project| project.id.to_string()),
                );
            }
            // Accept the pre-v0.2 profile/client identifiers emitted by older
            // renderers while preferring the immutable logical target IDs.
            let mut normalized_ids = Vec::with_capacity(ids.len());
            for id in ids {
                if snapshot
                    .logical_targets
                    .iter()
                    .any(|target| target.id == id)
                {
                    normalized_ids.push(id);
                    continue;
                }
                let legacy_matches = snapshot
                    .logical_targets
                    .iter()
                    .filter(|target| format!("{}:{}", target.profile_id, target.client_id) == id)
                    .map(|target| target.id.clone())
                    .collect::<Vec<_>>();
                if legacy_matches.is_empty() {
                    normalized_ids.push(id);
                } else {
                    normalized_ids.extend(legacy_matches);
                }
            }
            normalized_ids.sort();
            normalized_ids.dedup();

            let mut roots = Vec::new();
            for target in &snapshot.logical_targets {
                if target.available && target.exists {
                    if let Ok(root) = AllowedRoot::new(&target.path) {
                        roots.push(root);
                    }
                }
            }
            for project in database.project_repository().list()? {
                if let Ok(root) = AllowedRoot::new(project.path()) {
                    roots.push(root);
                }
            }
            let policy = PathPolicy::from_roots(roots)?;
            let mut scanner = self
                .scan_service
                .lock()
                .map_err(|_| internal("execute.scan_scopes"))?;
            for id in &normalized_ids {
                if snapshot
                    .logical_targets
                    .iter()
                    .any(|target| target.id == *id)
                {
                    scanner.register_discovery_target(id, &database.agent_repository(), &policy)?;
                } else {
                    let project_id = id
                        .parse()
                        .map_err(|_| invalid_input("unknown scan scope"))?;
                    scanner.register_project_scope(
                        project_id,
                        &database.project_repository(),
                        &policy,
                    )?;
                }
            }
            Ok(normalized_ids)
        })
    }

    fn run_scan(&self, requested: Vec<String>) -> AppResult<AppCommandResult> {
        let ids = self.scan_scope_ids(requested)?;
        self.with_database("execute.scan_targets", |database| {
            let mut scanner = self
                .scan_service
                .lock()
                .map_err(|_| internal("execute.scan_targets"))?;
            let result =
                scanner.scan_registered_with_repository(&ids, &database.scan_repository())?;
            Ok(AppCommandResult::ScanResult(result))
        })
    }

    fn rescan_skill(
        &self,
        request: skillhub_core::api::RescanSkill,
    ) -> AppResult<AppCommandResult> {
        self.scan_scope_ids(vec![request.scope_id.clone()])?;
        self.with_database("execute.rescan_skill", |database| {
            let mut scanner = self
                .scan_service
                .lock()
                .map_err(|_| internal("execute.rescan_skill"))?;
            let result = scanner.rescan_registered_skill(&request.scope_id, request.path)?;
            let result = database.scan_repository().replace(&result)?;
            Ok(AppCommandResult::ScanResult(result))
        })
    }

    fn build_backup_input(&self, scope: BackupScope) -> AppResult<BackupInput> {
        if scope != BackupScope::Full {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("scope", "selected_skills_requires_explicit_ids")
                .with_action(RecoveryAction::ChooseAnotherName));
        }
        let Some(library) = self.library.as_ref() else {
            return Err(unsupported("execute.prepare_backup.library"));
        };
        let Some(root) = self.library_root.as_ref() else {
            return Err(unsupported("execute.prepare_backup.library"));
        };
        let central = CentralLibrary::initialize(root)?;
        let portable_metadata = serde_json::to_string(&central.load_manifest()?)
            .map_err(|_| AppError::new(ErrorCode::InternalError, Severity::Error))?;
        let skill_ids = self.with_database("execute.prepare_backup.catalog", |database| {
            database.catalog_repository()?.list_ids_sync()
        })?;
        let mut skills = Vec::with_capacity(skill_ids.len());
        for skill_id in skill_ids {
            let version_id = library.current(skill_id)?.ok_or_else(|| {
                AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("skill_id", skill_id.to_string())
                    .with_param("reason", "current_version_missing")
                    .with_action(RecoveryAction::Retry)
            })?;
            let (_, bytes) = library.read_file(&version_id, "SKILL.md", 1_048_576)?;
            let content = String::from_utf8(bytes).map_err(|_| {
                AppError::new(ErrorCode::InvalidInput, Severity::Error)
                    .with_param("skill_id", skill_id.to_string())
                    .with_param("reason", "skill_markdown_not_utf8")
                    .with_action(RecoveryAction::InspectTarget)
            })?;
            skills.push((skill_id, content));
        }
        Ok(BackupInput::new(
            BackupScope::Full,
            portable_metadata,
            skills,
        ))
    }

    fn backup_package(path: impl AsRef<Path>) -> AppResult<BackupPackage> {
        let root = path.as_ref().to_path_buf();
        let metadata = std::fs::symlink_metadata(&root).map_err(|error| {
            let code = if error.kind() == std::io::ErrorKind::NotFound {
                ErrorCode::ObjectNotFound
            } else {
                ErrorCode::InternalError
            };
            AppError::new(code, Severity::Error)
                .with_param("path", root.to_string_lossy().into_owned())
                .with_action(RecoveryAction::ChooseAnotherName)
        })?;
        if metadata.file_type().is_symlink() {
            return Err(
                AppError::new(ErrorCode::PathOutsideAllowedRoots, Severity::Error)
                    .with_param("path", root.to_string_lossy().into_owned())
                    .with_action(RecoveryAction::InspectTarget),
            );
        }
        if !metadata.is_dir() {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "backup_path")
                .with_action(RecoveryAction::ChooseAnotherName));
        }
        Ok(BackupPackage { root })
    }

    fn export_input(
        &self,
        mut input: skillhub_core::ExportInput,
    ) -> AppResult<skillhub_core::ExportInput> {
        let Some(library) = self.library.as_ref() else {
            return Err(unsupported("execute.standard_export.library"));
        };
        if input.skills.is_empty() {
            let skill_ids = match &input.selection {
                skillhub_core::ExportSelection::Skills(ids) => ids.clone(),
                skillhub_core::ExportSelection::Combination(_) => {
                    return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                        .with_param("field", "skills")
                        .with_param("reason", "combination_members_required")
                        .with_action(RecoveryAction::ChooseAnotherName));
                }
            };
            for skill_id in skill_ids {
                let version_ids = match &input.versions {
                    skillhub_core::VersionSelection::Current => {
                        library.current(skill_id)?.into_iter().collect::<Vec<_>>()
                    }
                    skillhub_core::VersionSelection::History(ids) => ids.clone(),
                };
                for version_id in version_ids {
                    let (_, bytes) = library.read_file(&version_id, "SKILL.md", 1_048_576)?;
                    let content = String::from_utf8(bytes).map_err(|_| {
                        AppError::new(ErrorCode::InvalidInput, Severity::Error)
                            .with_param("skill_id", skill_id.to_string())
                            .with_param("reason", "skill_markdown_not_utf8")
                            .with_action(RecoveryAction::InspectTarget)
                    })?;
                    let display_name =
                        self.with_database("execute.standard_export.catalog", |database| {
                            database
                                .catalog_repository()?
                                .get_sync(skill_id)?
                                .map(|skill| skill.display_name().to_owned())
                                .ok_or_else(|| {
                                    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                                        .with_param("skill_id", skill_id.to_string())
                                        .with_action(RecoveryAction::Retry)
                                })
                        })?;
                    input.skills.push(skillhub_core::ExportSkill {
                        skill_id,
                        version_id,
                        content,
                        display_name,
                    });
                }
            }
        }
        Ok(input)
    }

    fn standard_export_destination(&self) -> AppResult<PathBuf> {
        let Some(root) = self.library_root.as_ref() else {
            return Err(unsupported("execute.standard_export.library"));
        };
        Ok(LibraryPaths::from_root(root).management_dir.join("exports"))
    }

    fn uninstall_deployments(
        &self,
        requested: &[skillhub_core::DeploymentId],
    ) -> AppResult<Vec<DeploymentRecord>> {
        self.with_database("execute.prepare_uninstall", |database| {
            let active = database
                .deployment_repository()
                .list_all()?
                .into_iter()
                .filter(|record| record.state == DeploymentState::Deployed)
                .collect::<Vec<_>>();
            let deployments = if requested.is_empty() {
                active
            } else {
                requested
                    .iter()
                    .map(|id| {
                        active
                            .iter()
                            .find(|record| record.id == *id)
                            .cloned()
                            .ok_or_else(|| {
                                AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                                    .with_param("field", "deployment")
                                    .with_param("deployment_id", id.to_string())
                                    .with_action(RecoveryAction::Retry)
                            })
                    })
                    .collect::<AppResult<Vec<_>>>()?
            };
            Ok(deployments)
        })
    }

    async fn apply_uninstall_decision(
        &self,
        actions: Vec<skillhub_core::UninstallAction>,
    ) -> AppResult<AppCommandResult> {
        if actions.is_empty() {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "actions")
                .with_action(RecoveryAction::ChooseAnotherName));
        }
        if actions.contains(&skillhub_core::UninstallAction::Cancel) {
            if actions.len() != 1 {
                return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                    .with_param("field", "actions")
                    .with_param("reason", "cancel_cannot_be_combined")
                    .with_action(RecoveryAction::ChooseAnotherName));
            }
            self.prepared_uninstall
                .lock()
                .map_err(|_| internal("execute.apply_uninstall_decision"))?
                .take();
            return Ok(AppCommandResult::OperationSummary(
                skillhub_core::OperationSummary {
                    operation_id: OperationId::new(),
                    phase: skillhub_core::OperationPhase::RolledBack,
                    message_code: "uninstall.cancelled".into(),
                    error_code: None,
                },
            ));
        }
        let unsupported_action = actions.iter().find(|action| {
            matches!(
                action,
                skillhub_core::UninstallAction::StandardExport
                    | skillhub_core::UninstallAction::RemoveDeviceData
                    | skillhub_core::UninstallAction::ClearCredentials
            )
        });
        if unsupported_action.is_some() {
            return Err(unsupported("execute.apply_uninstall_decision.action"));
        }
        let deployments = self
            .prepared_uninstall
            .lock()
            .map_err(|_| internal("execute.apply_uninstall_decision"))?
            .as_ref()
            .map(|impact| impact.deployments.clone())
            .ok_or_else(|| {
                AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("detail", "uninstall impact must be prepared first")
                    .with_action(RecoveryAction::Retry)
            })?;
        // 卸载备份（Q17）：在任何写动作之前创建完整备份包；失败则整体中止，
        // 保证"先备份后卸载"的顺序。库根或版本库缺失时如实报错。
        let wants_backup = actions.contains(&skillhub_core::UninstallAction::Backup);
        if wants_backup {
            let input = self.build_backup_input(BackupScope::Full)?;
            let Some(root) = self.library_root.as_ref() else {
                return Err(unsupported("execute.apply_uninstall_decision.library"));
            };
            let service = BackupService::new(LibraryPaths::from_root(root).backups_dir);
            let plan = service.prepare(&input)?;
            let package = service.create(&input, &plan, &[])?;
            service.verify(&package)?;
        }
        if actions.contains(&skillhub_core::UninstallAction::UndeployAll) {
            for deployment in deployments.iter().filter(|deployment| deployment.managed) {
                self.removal_service
                    .undeploy(
                        deployment.id,
                        skillhub_core::RemovalDecision::RemoveOwnedTarget,
                    )
                    .await?;
            }
        } else if actions.contains(&skillhub_core::UninstallAction::LeaveTargetsIndependent) {
            for deployment in deployments.iter().filter(|deployment| deployment.managed) {
                self.removal_service
                    .undeploy(
                        deployment.id,
                        skillhub_core::RemovalDecision::DetachManagement,
                    )
                    .await?;
            }
        }
        let ran_backup = wants_backup;
        self.prepared_uninstall
            .lock()
            .map_err(|_| internal("execute.apply_uninstall_decision"))?
            .take();
        Ok(AppCommandResult::OperationSummary(
            skillhub_core::OperationSummary {
                operation_id: OperationId::new(),
                phase: skillhub_core::OperationPhase::Committed,
                message_code: if ran_backup {
                    "uninstall.decision_applied_with_backup".into()
                } else {
                    "uninstall.decision_applied".into()
                },
                error_code: None,
            },
        ))
    }

    async fn run_basic_check(
        &self,
        skill_id: skillhub_core::SkillId,
        version_id: skillhub_core::VersionId,
    ) -> AppResult<AppCommandResult> {
        let Some(library) = self.library.as_ref() else {
            return Err(unsupported("execute.run_basic_check.library"));
        };
        let generation = self.with_database("execute.run_basic_check.generation", |database| {
            Ok(database
                .check_repository()
                .current_for_version_sync(skill_id, &version_id, CheckKind::Basic)?
                .map(|run| run.generation + 1)
                .unwrap_or(0))
        })?;
        let run_id = format!("basic-{}-{generation}", version_id.as_str());
        let started_at = now_millis();
        let scan_root = std::env::temp_dir().join(format!("skillhub-check-{}", OperationId::new()));
        std::fs::create_dir_all(&scan_root).map_err(|error| {
            AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("source", error.to_string())
                .with_action(RecoveryAction::Retry)
        })?;
        let scan_result = library
            .materialize(&version_id, &scan_root)
            .and_then(|_| BasicScanner::default().scan_version(&scan_root));
        let _ = std::fs::remove_dir_all(&scan_root);
        let mut run = match scan_result {
            Ok(findings) => {
                let mut run = CheckRun::completed(
                    run_id,
                    skill_id,
                    version_id.clone(),
                    CheckKind::Basic,
                    findings,
                );
                run.ruleset_id = Some("basic-v1".to_owned());
                run.coverage_inputs = serde_json::Value::Object(Default::default());
                run
            }
            Err(error) => {
                let mut run =
                    CheckRun::running(run_id, skill_id, version_id.clone(), CheckKind::Basic);
                run.phase = CheckRunPhase::Failed;
                run.failure_code = Some(error.code.as_str().to_owned());
                run
            }
        };
        run.generation = generation;
        run.started_at = started_at;
        run.ended_at = Some(now_millis());
        let result = skillhub_core::check::CheckResult {
            state: run.state(),
            run: Some(run.clone()),
        };
        self.with_database("execute.run_basic_check.persist", |database| {
            database.check_repository().insert_sync(&run)
        })?;
        Ok(AppCommandResult::BasicCheckResult(
            BasicCheckResult::from_check_result(skill_id, version_id, &result),
        ))
    }

    async fn run_llm_safety_check(
        &self,
        skill_id: skillhub_core::SkillId,
        version_id: skillhub_core::VersionId,
    ) -> AppResult<AppCommandResult> {
        let Some(library) = self.library.as_ref() else {
            return Err(unsupported("execute.run_llm_safety_check.library"));
        };
        let Some(runner) = self.llm_runner.clone() else {
            return Err(AppError::new(ErrorCode::LlmNotConfigured, Severity::Info));
        };
        let profile = self.with_database("execute.run_llm_safety_check.profile", |database| {
            Ok(database.llm_profile_repository().list()?.into_iter().next())
        })?;
        let Some(profile) = profile else {
            return Err(AppError::new(ErrorCode::LlmNotConfigured, Severity::Info));
        };
        let allowed_files = library.list_markdown_files(&version_id)?;
        let mut evidence = String::new();
        for file in &allowed_files {
            let (_, bytes) = library.read_file(&version_id, file, 256 * 1024)?;
            let text = String::from_utf8(bytes).map_err(|_| {
                AppError::new(ErrorCode::LlmEvidenceReferenceInvalid, Severity::Error)
            })?;
            evidence.push_str("FILE: ");
            evidence.push_str(file);
            evidence.push('\n');
            evidence.push_str(&text);
            evidence.push_str("\n\n");
        }
        let request = skillhub_core::llm::safety::build_safety_request(&evidence)?;
        let generation =
            self.with_database("execute.run_llm_safety_check.generation", |database| {
                Ok(database
                    .check_repository()
                    .current_for_version_sync(skill_id, &version_id, CheckKind::Llm)?
                    .map(|run| run.generation + 1)
                    .unwrap_or(0))
            })?;
        let run_id = format!("llm-safety-{}-{generation}", version_id.as_str());
        let started_at = now_millis();
        let model_id = profile.model.clone();
        let run_key = (skill_id.to_string(), version_id.to_string());
        let operation_id = skillhub_core::OperationId::new();
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut runs = self
                .llm_runs
                .lock()
                .map_err(|_| internal("execute.run_llm_safety_check.register"))?;
            if runs.contains_key(&run_key) {
                return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("reason", "llm_check_already_running"));
            }
            runs.insert(
                run_key.clone(),
                RunningLlmCheck {
                    operation_id,
                    cancelled: cancelled.clone(),
                },
            );
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| {
                    AppError::new(ErrorCode::InternalError, Severity::Error)
                        .with_param("source", error.to_string())
                        .with_action(RecoveryAction::Retry)
                });
            let response =
                runtime.and_then(|runtime| runtime.block_on(runner.run(&profile, request)));
            let _ = sender.send(response);
        });
        // Wait for the worker without blocking the executor, so progress
        // queries and cancel_operation stay responsive while the check runs.
        let response = loop {
            if cancelled.load(Ordering::SeqCst) {
                self.llm_runs
                    .lock()
                    .map_err(|_| internal("execute.run_llm_safety_check.registry"))?
                    .remove(&run_key);
                return Err(
                    AppError::new(ErrorCode::OperationConflict, Severity::Warning)
                        .with_param("operation_id", operation_id.to_string())
                        .with_param("reason", "operation_cancelled"),
                );
            }
            match receiver.try_recv() {
                Ok(response) => break response,
                Err(std::sync::mpsc::TryRecvError::Empty) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    self.llm_runs
                        .lock()
                        .map_err(|_| internal("execute.run_llm_safety_check.registry"))?
                        .remove(&run_key);
                    return Err(internal("execute.run_llm_safety_check.worker"));
                }
            }
        };
        self.llm_runs
            .lock()
            .map_err(|_| internal("execute.run_llm_safety_check.registry"))?
            .remove(&run_key);
        let mut run = match response {
            Ok(response) => match skillhub_core::llm::safety::parse_safety_response(
                response.output,
                &allowed_files,
            ) {
                Ok(findings) => {
                    let mut run = CheckRun::completed(
                        run_id,
                        skill_id,
                        version_id.clone(),
                        CheckKind::Llm,
                        findings,
                    );
                    run.model_id = Some(model_id);
                    run.coverage_inputs = serde_json::json!({
                        "files": allowed_files,
                        "evidence_bytes": evidence.len()
                    });
                    run
                }
                Err(error) => failed_llm_run(run_id, skill_id, version_id.clone(), error),
            },
            Err(error) => failed_llm_run(run_id, skill_id, version_id.clone(), error),
        };
        run.generation = generation;
        run.started_at = started_at;
        run.ended_at = Some(now_millis());
        let result = skillhub_core::check::CheckResult {
            state: run.state(),
            run: Some(run.clone()),
        };
        self.with_database("execute.run_llm_safety_check.persist", |database| {
            database.check_repository().insert_sync(&run)
        })?;
        Ok(AppCommandResult::LlmSafetyCheckResult(
            skillhub_core::api::LlmSafetyCheckResult::from_check_result(
                skill_id, version_id, &result,
            ),
        ))
    }

    /// Marks a running LLM check as cancelled. The awaiting run command stops
    /// waiting for the worker and refuses to persist or report a result.
    fn cancel_operation(
        &self,
        operation_id: skillhub_core::OperationId,
    ) -> AppResult<AppCommandResult> {
        let mut runs = self
            .llm_runs
            .lock()
            .map_err(|_| internal("execute.cancel_operation"))?;
        let entry = runs
            .values_mut()
            .find(|run| run.operation_id == operation_id)
            .ok_or_else(|| {
                AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("operation_id", operation_id.to_string())
            })?;
        entry.cancelled.store(true, Ordering::SeqCst);
        Ok(AppCommandResult::OperationSummary(operation_summary(
            "operation.cancel_requested",
        )))
    }

    fn list_running_llm_checks(&self) -> AppResult<AppQueryResult> {
        let runs = self
            .llm_runs
            .lock()
            .map_err(|_| internal("query.list_running_llm_checks"))?;
        Ok(AppQueryResult::RunningLlmChecks(
            runs.iter()
                .map(|((skill_id, version_id), run)| skillhub_core::LlmCheckRun {
                    skill_id: skill_id.clone(),
                    version_id: version_id.clone(),
                    operation_id: run.operation_id,
                })
                .collect(),
        ))
    }

    fn update_catalog_skill<F>(
        &self,
        skill_id: skillhub_core::SkillId,
        operation: &'static str,
        message_code: &'static str,
        update: F,
    ) -> AppResult<AppCommandResult>
    where
        F: FnOnce(&mut Skill) -> AppResult<()>,
    {
        let current = self
            .library
            .as_ref()
            .map(|library| library.current(skill_id))
            .transpose()?
            .flatten();
        let library_root = self.library_root.clone();
        self.with_database(operation, |database| {
            let repository = database.catalog_repository()?;
            let old = repository.get_sync(skill_id)?.ok_or_else(|| {
                AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("skill_id", skill_id.to_string())
                    .with_action(RecoveryAction::ChooseAnotherName)
            })?;
            let mut updated = old.clone();
            update(&mut updated)?;
            updated.validate()?;
            repository.insert_sync(&updated)?;
            if let Some(root) = library_root {
                let central = CentralLibrary::initialize(root)?;
                if let Err(error) = central.save_portable_skill(&updated, current.as_ref()) {
                    return Err(cleanup_import_error(error, repository.insert_sync(&old)));
                }
            }
            Ok(AppCommandResult::OperationSummary(
                skillhub_core::OperationSummary {
                    operation_id: OperationId::new(),
                    phase: skillhub_core::OperationPhase::Committed,
                    message_code: message_code.to_owned(),
                    error_code: None,
                },
            ))
        })
    }

    fn create_skill(&self, request: CreateSkill) -> AppResult<AppCommandResult> {
        let Some(library) = self.library.as_ref() else {
            return Err(unsupported("execute.create_skill.library"));
        };
        let Some(library_root) = self.library_root.as_ref() else {
            return Err(unsupported("execute.create_skill.library"));
        };
        let source = Path::new(&request.source_path);
        validate_skill_source(source)?;
        let skill = Skill::new(skillhub_core::SkillId::new(), request.name);
        skill.validate()?;
        let captured = library.capture_with_status(skill.id(), source)?;
        let version = captured.record;
        let central = match CentralLibrary::initialize(library_root) {
            Ok(central) => central,
            Err(error) => {
                let cleanup = if captured.created {
                    library.discard_sync(&version)
                } else {
                    Ok(())
                };
                return Err(cleanup_import_error(error, cleanup));
            }
        };
        let result = self.with_database("execute.create_skill", |database| {
            if let Err(error) = database.catalog_repository()?.insert_sync(&skill) {
                return Err(cleanup_import_error(
                    error,
                    if captured.created {
                        library.discard_sync(&version)
                    } else {
                        Ok(())
                    },
                ));
            }
            if let Err(error) = library.set_current(skill.id(), &version.id) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, &central, library, skill.id(), &version),
                ));
            }
            if let Err(error) = central.materialize_current_skill(&skill, &version.id) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, &central, library, skill.id(), &version),
                ));
            }
            if let Err(error) = central.save_portable_skill(&skill, Some(&version.id)) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, &central, library, skill.id(), &version),
                ));
            }
            let source_descriptor = SourceDescriptor::new(
                skillhub_core::SourceKind::Local,
                SourceLocator::local_path(source),
            );
            if let Err(error) = database
                .source_repository()
                .relink(skill.id(), source_descriptor)
            {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, &central, library, skill.id(), &version),
                ));
            }
            database
                .source_repository()
                .set_revision(skill.id(), Some(&version.manifest.tree_hash))?;
            Ok(AppCommandResult::OperationSummary(operation_summary(
                "catalog.skill_created",
            )))
        });
        if result.is_err() && captured.created {
            // The normal error paths above clean up while the database mutex is held.
            // This guard only handles failure before entering the closure.
            let _ = library.discard_sync(&version);
        }
        result
    }

    fn create_combination(&self, request: CreateCombination) -> AppResult<AppCommandResult> {
        self.with_database("execute.create_combination", |database| {
            database
                .combination_repository()
                .create(&request.name, &request.members)?;
            Ok(AppCommandResult::OperationSummary(operation_summary(
                "catalog.combination_created",
            )))
        })
    }

    fn update_combination(&self, request: UpdateCombination) -> AppResult<AppCommandResult> {
        self.with_database("execute.update_combination", |database| {
            database
                .combination_repository()
                .update_members(&request.name, &request.members)?;
            Ok(AppCommandResult::OperationSummary(operation_summary(
                "catalog.combination_updated",
            )))
        })
    }

    fn delete_combination(&self, request: DeleteCombination) -> AppResult<AppCommandResult> {
        self.with_database("execute.delete_combination", |database| {
            database.combination_repository().delete(&request.name)?;
            Ok(AppCommandResult::OperationSummary(operation_summary(
                "catalog.combination_deleted",
            )))
        })
    }

    fn pin_project_skill_version(
        &self,
        request: PinProjectSkillVersion,
    ) -> AppResult<AppCommandResult> {
        let Some(library) = self.library.as_ref() else {
            return Err(unsupported("execute.pin_project_skill_version.library"));
        };
        let belongs = library
            .list(request.skill_id)?
            .into_iter()
            .any(|record| record.id == request.version_id);
        if !belongs {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "version_id")
                .with_action(RecoveryAction::ChooseAnotherName));
        }
        self.with_database("execute.pin_project_skill_version", |database| {
            if database
                .catalog_repository()?
                .get_sync(request.skill_id)?
                .is_none()
            {
                return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("skill_id", request.skill_id.to_string())
                    .with_action(RecoveryAction::ChooseAnotherName));
            }
            database.project_repository().pin_skill_version(
                request.project_id,
                request.skill_id,
                request.version_id,
            )?;
            Ok(AppCommandResult::OperationSummary(operation_summary(
                "catalog.project_version_pinned",
            )))
        })
    }

    fn relink_source(&self, request: RelinkSource) -> AppResult<AppCommandResult> {
        let Some(library) = self.library.as_ref() else {
            return Err(unsupported("execute.relink_source.library"));
        };
        let source_revision = match &request.source.locator {
            SourceLocator::LocalPath(path) => {
                validate_skill_source(path)?;
                library.current(request.skill_id)?.and_then(|current| {
                    library
                        .list(request.skill_id)
                        .ok()
                        .and_then(|records| records.into_iter().find(|record| record.id == current))
                        .map(|record| record.manifest.tree_hash)
                })
            }
            SourceLocator::HttpsUrl(_) | SourceLocator::GitUrl(_) => None,
        };
        self.with_database("execute.relink_source", |database| {
            if database
                .catalog_repository()?
                .get_sync(request.skill_id)?
                .is_none()
            {
                return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("skill_id", request.skill_id.to_string())
                    .with_action(RecoveryAction::ChooseAnotherName));
            }
            database
                .source_repository()
                .relink(request.skill_id, request.source)?;
            database
                .source_repository()
                .set_revision(request.skill_id, source_revision.as_deref())?;
            Ok(AppCommandResult::OperationSummary(operation_summary(
                "source.relinked",
            )))
        })
    }

    fn check_source_update(&self, request: CheckSourceUpdate) -> AppResult<AppCommandResult> {
        let Some(library) = self.library.as_ref() else {
            return Err(unsupported("execute.check_source_update.library"));
        };
        let (source, revision) =
            self.with_database("execute.check_source_update.source", |database| {
                Ok((
                    database.source_repository().for_skill(request.skill_id)?,
                    database
                        .source_repository()
                        .revision_for_skill(request.skill_id)?,
                ))
            })?;
        let Some(source) = source else {
            return Ok(AppCommandResult::UpstreamCheckResult(
                skillhub_core::UpstreamCheckResult::new(
                    request.skill_id,
                    SourceState::SourceUnavailable,
                ),
            ));
        };
        let Some(path) = source.locator.as_local_path() else {
            return Ok(AppCommandResult::UpstreamCheckResult(
                skillhub_core::UpstreamCheckResult::new(
                    request.skill_id,
                    SourceState::SourceUnavailable,
                ),
            ));
        };
        if !path.is_dir() {
            return Ok(AppCommandResult::UpstreamCheckResult(
                skillhub_core::UpstreamCheckResult::new(
                    request.skill_id,
                    SourceState::SourceUnavailable,
                ),
            ));
        }
        let source_hash = library.hash_tree(path)?;
        let current = library.current(request.skill_id)?;
        let current_hash = current.as_ref().and_then(|current| {
            library
                .list(request.skill_id)
                .ok()
                .and_then(|records| records.into_iter().find(|record| &record.id == current))
                .map(|record| record.manifest.tree_hash)
        });
        let baseline = revision.or(current_hash.clone());
        let state = if baseline.as_deref() == Some(source_hash.as_str()) {
            if current_hash == baseline {
                SourceState::UpToDate
            } else {
                SourceState::UpdateAvailableWithLocalChanges
            }
        } else if current_hash == baseline {
            SourceState::UpdateAvailable
        } else {
            SourceState::UpdateAvailableWithLocalChanges
        };
        Ok(AppCommandResult::UpstreamCheckResult(
            skillhub_core::UpstreamCheckResult::new(request.skill_id, state)
                .with_versions(current, None),
        ))
    }

    fn apply_source_update(&self, request: ApplySourceUpdate) -> AppResult<AppCommandResult> {
        if matches!(
            request.decision,
            UpdateDecision::KeepLocal | UpdateDecision::Cancel
        ) {
            return Ok(AppCommandResult::AppliedSourceUpdate(
                skillhub_core::AppliedSourceUpdate::new(request.skill_id, request.decision),
            ));
        }
        let AppCommandResult::UpstreamCheckResult(check) =
            self.check_source_update(CheckSourceUpdate {
                skill_id: request.skill_id,
            })?
        else {
            return Err(internal("execute.apply_source_update.check"));
        };
        if request.decision == UpdateDecision::TakeUpstream
            && check.state != SourceState::UpdateAvailable
        {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param(
                    "detail",
                    "upstream update would overwrite local modifications",
                )
                .with_action(RecoveryAction::Acknowledge));
        }
        if request.decision == UpdateDecision::CreateIndependentBranch {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param(
                    "detail",
                    "independent source branches are not persisted by this facade",
                )
                .with_action(RecoveryAction::Acknowledge));
        }
        let Some(library) = self.library.as_ref() else {
            return Err(unsupported("execute.apply_source_update.library"));
        };
        let source = self.with_database("execute.apply_source_update.source", |database| {
            database.source_repository().for_skill(request.skill_id)
        })?;
        let Some(source) = source else {
            return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("skill_id", request.skill_id.to_string())
                .with_action(RecoveryAction::ChooseAnotherName));
        };
        let Some(path) = source.locator.as_local_path() else {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("detail", "remote source acquisition is not configured")
                .with_action(RecoveryAction::Retry));
        };
        validate_skill_source(path)?;
        let captured = library.capture_with_status(request.skill_id, path)?;
        let version = captured.record;
        if let Err(error) = library.set_current(request.skill_id, &version.id) {
            return Err(cleanup_import_error(
                error,
                if captured.created {
                    library.discard_sync(&version)
                } else {
                    Ok(())
                },
            ));
        }
        let skill = self.with_database("execute.apply_source_update.skill", |database| {
            database
                .catalog_repository()?
                .get_sync(request.skill_id)?
                .ok_or_else(|| {
                    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                        .with_param("skill_id", request.skill_id.to_string())
                        .with_action(RecoveryAction::ChooseAnotherName)
                })
        })?;
        let Some(root) = self.library_root.as_ref() else {
            return Err(unsupported("execute.apply_source_update.library"));
        };
        let central = CentralLibrary::initialize(root)?;
        if let Err(error) = central.materialize_current_skill(&skill, &version.id) {
            let _ = restore_version_pointer(library, request.skill_id, check.local_version);
            if captured.created {
                let _ = library.discard_sync(&version);
            }
            return Err(error);
        }
        if let Err(error) = central.save_portable_skill(&skill, Some(&version.id)) {
            let _ = restore_version_pointer(library, request.skill_id, check.local_version);
            if captured.created {
                let _ = library.discard_sync(&version);
            }
            return Err(error);
        }
        self.with_database("execute.apply_source_update.persist", |database| {
            database
                .source_repository()
                .set_revision(request.skill_id, Some(&version.manifest.tree_hash))
        })?;
        Ok(AppCommandResult::AppliedSourceUpdate(
            skillhub_core::AppliedSourceUpdate {
                skill_id: request.skill_id,
                decision: request.decision,
                new_version: Some(version.id),
                deployments_need_reconciliation: true,
            },
        ))
    }

    fn rename_skill(&self, request: RenameSkill) -> AppResult<AppCommandResult> {
        self.update_catalog_skill(
            request.skill_id,
            "execute.rename_skill",
            "catalog.skill_renamed",
            move |skill| skill.rename(request.name.clone()),
        )
    }

    fn set_metadata(&self, request: SetMetadata) -> AppResult<AppCommandResult> {
        self.update_catalog_skill(
            request.skill_id,
            "execute.set_metadata",
            "catalog.metadata_updated",
            move |skill| {
                skill.set_metadata(
                    request.display_name,
                    request.note,
                    request.tags.into_iter().collect(),
                    request.author,
                    request.license,
                )
            },
        )
    }

    fn set_lifecycle(&self, request: SetLifecycle) -> AppResult<AppCommandResult> {
        self.update_catalog_skill(
            request.skill_id,
            "execute.set_lifecycle",
            "catalog.lifecycle_updated",
            move |skill| {
                skill.set_lifecycle(request.lifecycle);
                Ok(())
            },
        )
    }

    fn set_trial(&self, request: SetTrial) -> AppResult<AppCommandResult> {
        self.update_catalog_skill(
            request.skill_id,
            "execute.set_trial",
            "catalog.trial_updated",
            move |skill| {
                skill.set_trial_due(request.due);
                Ok(())
            },
        )
    }

    fn set_current_version(&self, request: SetCurrentVersion) -> AppResult<AppCommandResult> {
        let Some(library) = self.library.as_ref() else {
            return Err(unsupported("execute.set_current_version.library"));
        };
        let Some(library_root) = self.library_root.as_ref() else {
            return Err(unsupported("execute.set_current_version.library"));
        };
        let previous = library.current(request.skill_id)?;
        let skill = self.with_database("execute.set_current_version", |database| {
            database
                .catalog_repository()?
                .get_sync(request.skill_id)?
                .ok_or_else(|| {
                    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                        .with_param("skill_id", request.skill_id.to_string())
                        .with_action(RecoveryAction::Retry)
                })
        })?;
        library.set_current(request.skill_id, &request.version_id)?;
        let central = match CentralLibrary::initialize(library_root) {
            Ok(central) => central,
            Err(error) => {
                let rollback = match previous.clone() {
                    Some(previous) => library.set_current(request.skill_id, &previous),
                    None => library.clear_current(request.skill_id),
                };
                return Err(cleanup_import_error(error, rollback));
            }
        };
        if let Err(error) = central.materialize_current_skill(&skill, &request.version_id) {
            let rollback = match previous.clone() {
                Some(previous) => library.set_current(request.skill_id, &previous),
                None => library.clear_current(request.skill_id),
            };
            return Err(cleanup_import_error(error, rollback));
        }
        if let Err(error) = central.save_portable_skill(&skill, Some(&request.version_id)) {
            let rollback = match previous {
                Some(previous) => library.set_current(request.skill_id, &previous),
                None => library.clear_current(request.skill_id),
            };
            return Err(cleanup_import_error(error, rollback));
        }
        Ok(AppCommandResult::OperationSummary(
            skillhub_core::OperationSummary {
                operation_id: OperationId::new(),
                phase: skillhub_core::OperationPhase::Committed,
                message_code: "catalog.current_version_changed".to_owned(),
                error_code: None,
            },
        ))
    }

    fn save_skill_content(&self, request: SaveSkillContent) -> AppResult<AppCommandResult> {
        let Some(library) = self.library.as_ref() else {
            return Err(unsupported("execute.save_skill_content.library"));
        };
        let Some(library_root) = self.library_root.as_ref() else {
            return Err(unsupported("execute.save_skill_content.library"));
        };
        let source = Path::new(&request.source_path);
        validate_skill_source(source)?;
        let previous = library.current(request.skill_id)?;
        let skill = self.with_database("execute.save_skill_content", |database| {
            database
                .catalog_repository()?
                .get_sync(request.skill_id)?
                .ok_or_else(|| {
                    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                        .with_param("skill_id", request.skill_id.to_string())
                        .with_action(RecoveryAction::Retry)
                })
        })?;
        let captured = library.capture_with_status(request.skill_id, source)?;
        let version = captured.record;
        if let Err(error) = library.set_current(request.skill_id, &version.id) {
            let cleanup = if captured.created {
                library.discard_sync(&version)
            } else {
                Ok(())
            };
            return Err(cleanup_import_error(error, cleanup));
        }
        let central = match CentralLibrary::initialize(library_root) {
            Ok(central) => central,
            Err(error) => {
                let rollback = restore_version_pointer(library, request.skill_id, previous.clone());
                let cleanup = rollback.and_then(|()| {
                    if captured.created {
                        library.discard_sync(&version)
                    } else {
                        Ok(())
                    }
                });
                return Err(cleanup_import_error(error, cleanup));
            }
        };
        if let Err(error) = central.materialize_current_skill(&skill, &version.id) {
            let rollback = restore_version_pointer(library, request.skill_id, previous.clone());
            let cleanup = rollback.and_then(|()| {
                if captured.created {
                    library.discard_sync(&version)
                } else {
                    Ok(())
                }
            });
            return Err(cleanup_import_error(error, cleanup));
        }
        if let Err(error) = central.save_portable_skill(&skill, Some(&version.id)) {
            let rollback = restore_version_pointer(library, request.skill_id, previous);
            let cleanup = rollback.and_then(|()| {
                if captured.created {
                    library.discard_sync(&version)
                } else {
                    Ok(())
                }
            });
            return Err(cleanup_import_error(error, cleanup));
        }
        Ok(AppCommandResult::OperationSummary(
            skillhub_core::OperationSummary {
                operation_id: OperationId::new(),
                phase: skillhub_core::OperationPhase::Committed,
                message_code: "catalog.version_saved".to_owned(),
                error_code: None,
            },
        ))
    }

    fn save_markdown_content(&self, request: SaveMarkdownContent) -> AppResult<AppCommandResult> {
        let Some(library) = self.library.as_ref() else {
            return Err(unsupported("execute.save_markdown_content.library"));
        };
        let Some(library_root) = self.library_root.as_ref() else {
            return Err(unsupported("execute.save_markdown_content.library"));
        };
        let relative = validate_markdown_path(&request.path)?;
        if request.markdown.len() > 1_048_576 {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "markdown_size")
                .with_action(RecoveryAction::ChooseAnotherName));
        }
        let current = library
            .current(request.skill_id)?
            .ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))?;
        let (identity, _) = library.read_file(&current, &request.path, 1_048_576)?;
        if identity != request.expected_identity {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("path", request.path.clone())
                .with_action(RecoveryAction::Retry));
        }
        let skill = self.with_database("execute.save_markdown_content", |database| {
            database
                .catalog_repository()?
                .get_sync(request.skill_id)?
                .ok_or_else(|| {
                    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                        .with_param("skill_id", request.skill_id.to_string())
                        .with_action(RecoveryAction::Retry)
                })
        })?;
        let staging =
            std::env::temp_dir().join(format!("skillhub-markdown-{}", OperationId::new()));
        let result = (|| {
            library.materialize(&current, &staging)?;
            let target = staging.join(&relative);
            std::fs::write(&target, request.markdown.as_bytes()).map_err(|error| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("source", error.to_string())
                    .with_action(RecoveryAction::Retry)
            })?;
            let captured = library.capture_with_status(request.skill_id, &staging)?;
            let version = captured.record;
            if let Err(error) = library.set_current(request.skill_id, &version.id) {
                let cleanup = if captured.created {
                    library.discard_sync(&version)
                } else {
                    Ok(())
                };
                return Err(cleanup_import_error(error, cleanup));
            }
            let central = match CentralLibrary::initialize(library_root) {
                Ok(central) => central,
                Err(error) => {
                    let rollback =
                        restore_version_pointer(library, request.skill_id, Some(current.clone()));
                    let cleanup = rollback.and_then(|()| {
                        if captured.created {
                            library.discard_sync(&version)
                        } else {
                            Ok(())
                        }
                    });
                    return Err(cleanup_import_error(error, cleanup));
                }
            };
            if let Err(error) = central.materialize_current_skill(&skill, &version.id) {
                let rollback =
                    restore_version_pointer(library, request.skill_id, Some(current.clone()));
                let cleanup = rollback.and_then(|()| {
                    if captured.created {
                        library.discard_sync(&version)
                    } else {
                        Ok(())
                    }
                });
                return Err(cleanup_import_error(error, cleanup));
            }
            if let Err(error) = central.save_portable_skill(&skill, Some(&version.id)) {
                let rollback =
                    restore_version_pointer(library, request.skill_id, Some(current.clone()));
                let cleanup = rollback.and_then(|()| {
                    if captured.created {
                        library.discard_sync(&version)
                    } else {
                        Ok(())
                    }
                });
                return Err(cleanup_import_error(error, cleanup));
            }
            let (content_identity, _) = library.read_file(&version.id, &request.path, 1_048_576)?;
            Ok(AppCommandResult::SavedSkillContent(SavedSkillContent {
                skill_id: request.skill_id,
                path: request.path.clone(),
                version_id: version.id,
                content_identity,
            }))
        })();
        let _ = std::fs::remove_dir_all(&staging);
        result
    }

    fn set_finding_disposition(
        &self,
        request: SetFindingDisposition,
    ) -> AppResult<AppCommandResult> {
        let updated = self.with_database("execute.set_finding_disposition", |database| {
            let repository = database.check_repository();
            let run = repository
                .current_for_version_sync(request.skill_id, &request.version_id, request.kind)?
                .ok_or_else(|| {
                    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                        .with_param("version_id", request.version_id.to_string())
                        .with_action(RecoveryAction::ReviewSecurityFindings)
                })?;
            let finding = run
                .findings
                .iter()
                .find(|finding| finding.id == request.finding_id)
                .ok_or_else(|| {
                    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                        .with_param("finding_id", request.finding_id.clone())
                        .with_action(RecoveryAction::ReviewSecurityFindings)
                })?;
            if request.disposition != FindingDisposition::Actionable
                && finding.is_high_risk()
                && !request.high_risk_confirmed
            {
                return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                    .with_param("finding_id", request.finding_id.clone())
                    .with_param("requires_high_risk_confirmation", true)
                    .with_action(RecoveryAction::ReviewSecurityFindings));
            }
            let updated = run.set_disposition(&request.finding_id, request.disposition)?;
            repository.update_sync(&updated)?;
            Ok(updated)
        })?;
        let result = skillhub_core::check::CheckResult {
            state: updated.state(),
            run: Some(updated.clone()),
        };
        Ok(match request.kind {
            CheckKind::Basic => AppCommandResult::BasicCheckResult(
                BasicCheckResult::from_check_result(request.skill_id, request.version_id, &result),
            ),
            CheckKind::Llm => AppCommandResult::LlmSafetyCheckResult(
                skillhub_core::api::LlmSafetyCheckResult::from_check_result(
                    request.skill_id,
                    request.version_id,
                    &result,
                ),
            ),
        })
    }
}

#[async_trait]
impl ApplicationFacade for LocalApplicationFacade {
    async fn execute(&self, command: AppCommand) -> AppResult<AppCommandResult> {
        let operation = match command {
            AppCommand::SetDesktopPreferences(preferences) => {
                return self.with_database("execute.set_desktop_preferences", |database| {
                    database
                        .desktop_settings_repository()
                        .save(&preferences)
                        .map(AppCommandResult::DesktopPreferences)
                })
            }
            AppCommand::OpenOfficialRelease(request) => return self.open_official_release(request),
            AppCommand::OpenExternalUrl(request) => return self.open_external_url(request),
            AppCommand::SetApplicationUpdatePolicy(request) => {
                return self.set_application_update_policy(request)
            }
            AppCommand::PrepareApplicationUpdate(request) => {
                return self.prepare_application_update(request)
            }
            AppCommand::DownloadApplicationUpdate(request) => {
                return self.download_application_update(request).await
            }
            AppCommand::InstallApplicationUpdate(_) => {
                return self.install_application_update().await
            }
            AppCommand::RollbackApplicationUpdate(_) => {
                return self.rollback_application_update().await
            }
            AppCommand::CancelOperation { operation_id } => {
                return self.cancel_operation(operation_id);
            }
            AppCommand::PrepareDeployment(request) => {
                return self.prepare_deployment(request.plan).await
            }
            AppCommand::CommitDeployment(request) => {
                return self.commit_deployment(request.prepared_deployment_id).await
            }
            AppCommand::PrepareImport(request) => return self.prepare_import(request),
            AppCommand::CommitImport(request) => return self.commit_import(request),
            AppCommand::CancelImport { prepared_import_id } => {
                return self.cancel_import(prepared_import_id)
            }
            AppCommand::PrepareUndeploy(request) => {
                let impact = self
                    .removal_service
                    .prepare_undeploy(request.deployment_id)
                    .await?;
                return Ok(AppCommandResult::RemovalImpact(impact));
            }
            AppCommand::PrepareDeleteSkill(request) => {
                let impact = self
                    .removal_service
                    .prepare_delete(request.skill_id)
                    .await?;
                return Ok(AppCommandResult::RemovalImpact(impact));
            }
            AppCommand::CommitDeleteSkill(request) => {
                let decisions = request
                    .decisions
                    .into_iter()
                    .map(|choice| (choice.deployment_id, choice.decision))
                    .collect();
                let result = self
                    .removal_service
                    .commit_delete(request.prepared_delete_id, decisions)
                    .await?;
                return Ok(AppCommandResult::RemovalResult(result));
            }
            AppCommand::CommitUndeploy(request) => {
                let result = self
                    .removal_service
                    .commit_undeploy(request.prepared_undeploy_id, request.decision)
                    .await?;
                return Ok(AppCommandResult::RemovalResult(result));
            }
            AppCommand::DetachManagement(request) => {
                let result = self
                    .removal_service
                    .undeploy(
                        request.deployment_id,
                        skillhub_core::RemovalDecision::DetachManagement,
                    )
                    .await?;
                return Ok(AppCommandResult::RemovalResult(result));
            }
            AppCommand::RunHealthCheck(_) => {
                return self
                    .health_service
                    .run()
                    .await
                    .map(AppCommandResult::HealthReport);
            }
            AppCommand::PrepareRepair(request) => {
                return self
                    .health_service
                    .prepare_repair(request.health_report_id, request.finding_index)
                    .await
                    .map(AppCommandResult::RepairPlan);
            }
            AppCommand::CommitRepair(request) => {
                self.health_service.commit_repair(request.repair_id).await?;
                return Ok(AppCommandResult::OperationSummary(
                    skillhub_core::OperationSummary {
                        operation_id: request.repair_id,
                        phase: skillhub_core::OperationPhase::Committed,
                        message_code: "health.repair_committed".to_owned(),
                        error_code: None,
                    },
                ));
            }
            AppCommand::ResolveRecovery(request) => {
                self.recovery_service
                    .resolve(request.operation_id, request.action)
                    .await?;
                return Ok(AppCommandResult::OperationSummary(
                    skillhub_core::OperationSummary {
                        operation_id: request.operation_id,
                        phase: if request.action == RecoveryAction::CompleteOperation {
                            skillhub_core::OperationPhase::Committed
                        } else {
                            skillhub_core::OperationPhase::RolledBack
                        },
                        message_code: "recovery.resolved".to_owned(),
                        error_code: None,
                    },
                ));
            }
            AppCommand::PrepareCallPolicyChange(request) => {
                return self
                    .call_policy_service
                    .prepare(request.skill_id, request.policy)
                    .await
                    .map(AppCommandResult::CallPolicyPlan);
            }
            AppCommand::CommitCallPolicyChange(request) => {
                self.call_policy_service.commit(request.plan_id).await?;
                return Ok(AppCommandResult::OperationSummary(
                    skillhub_core::OperationSummary {
                        operation_id: request.plan_id,
                        phase: skillhub_core::OperationPhase::Committed,
                        message_code: "call_policy.change_committed".to_owned(),
                        error_code: None,
                    },
                ));
            }
            AppCommand::RestoreOriginalCallPolicy(request) => {
                self.call_policy_service
                    .restore_original(request.skill_id)
                    .await?;
                return Ok(AppCommandResult::OperationSummary(
                    skillhub_core::OperationSummary {
                        operation_id: OperationId::new(),
                        phase: skillhub_core::OperationPhase::Committed,
                        message_code: "call_policy.restored".to_owned(),
                        error_code: None,
                    },
                ));
            }
            AppCommand::CreateIgnoreRule(request) => {
                return self
                    .ignore_service
                    .create(request.subject, request.reason, request.defer_until)
                    .await
                    .map(AppCommandResult::IgnoreRule);
            }
            AppCommand::RemoveIgnoreRule(request) => {
                self.ignore_service.remove(request.rule_id).await?;
                return Ok(AppCommandResult::OperationSummary(
                    skillhub_core::OperationSummary {
                        operation_id: OperationId::new(),
                        phase: skillhub_core::OperationPhase::Committed,
                        message_code: "ignore.removed".to_owned(),
                        error_code: None,
                    },
                ));
            }
            AppCommand::CollectDeploymentChanges(request) => {
                return self
                    .reconcile_service
                    .collect_changes(request.deployment_id)
                    .await
                    .map(AppCommandResult::ReconcileResult);
            }
            AppCommand::RestoreDeployment(request) => {
                return self
                    .reconcile_service
                    .restore(request.deployment_id)
                    .await
                    .map(AppCommandResult::ReconcileResult);
            }
            AppCommand::KeepIndependentCopy(request) => {
                return self
                    .reconcile_service
                    .keep_independent(request.deployment_id)
                    .await
                    .map(AppCommandResult::ReconcileResult);
            }
            AppCommand::IgnoreExternalChange(request) => {
                return self
                    .reconcile_service
                    .ignore_external_change(request.deployment_id)
                    .await
                    .map(AppCommandResult::ReconcileResult);
            }
            AppCommand::RunBasicCheck(request) => {
                return self
                    .run_basic_check(request.skill_id, request.version_id)
                    .await;
            }
            AppCommand::RecheckBasic(request) => {
                return self
                    .run_basic_check(request.skill_id, request.version_id)
                    .await;
            }
            AppCommand::CreateCustomAgent(request) => return self.create_custom_agent(request),
            AppCommand::UpdateCustomAgent(request) => return self.update_custom_agent(request),
            AppCommand::RemoveCustomAgent(request) => return self.remove_custom_agent(request),
            AppCommand::ResetProfileOverride(request) => {
                return self.reset_profile_override(request)
            }
            AppCommand::SetProfileOverride(request) => return self.set_profile_override(request),
            AppCommand::RegisterProject(request) => return self.register_project(request),
            AppCommand::UpdateProject(request) => return self.update_project(request),
            AppCommand::SetProjectTags(request) => return self.set_project_tags(request),
            AppCommand::SaveProjectView(request) => return self.save_project_view(request),
            AppCommand::WriteSharedProjectConfig(request) => {
                return self.write_shared_project_config(request)
            }
            AppCommand::ReadSharedProjectConfig(request) => {
                return self.read_shared_project_config(request)
            }
            AppCommand::PrepareProjectAssembly(request) => {
                return self.prepare_project_assembly(request.project_id)
            }
            AppCommand::CommitProjectAssembly(request) => {
                return self.commit_project_assembly(request)
            }
            AppCommand::RunInitializationScan(request) => return self.run_scan(request.scope_ids),
            AppCommand::SetLibraryRoot(request) => return self.set_library_root(request),
            AppCommand::CompleteOnboarding(request) => return self.complete_onboarding(request),
            AppCommand::DiscoverAgentTargets(_) => return self.discover_agent_targets(),
            AppCommand::ScanTargets(request) => return self.run_scan(request.scope_ids),
            AppCommand::RescanSkill(request) => return self.rescan_skill(request),
            AppCommand::SetFindingDisposition(request) => {
                return self.set_finding_disposition(request);
            }
            AppCommand::RenameSkill(request) => return self.rename_skill(request),
            AppCommand::CreateSkill(request) => return self.create_skill(request),
            AppCommand::CreateCombination(request) => return self.create_combination(request),
            AppCommand::UpdateCombination(request) => return self.update_combination(request),
            AppCommand::DeleteCombination(request) => return self.delete_combination(request),
            AppCommand::PinProjectSkillVersion(request) => {
                return self.pin_project_skill_version(request)
            }
            AppCommand::RelinkSource(request) => return self.relink_source(request),
            AppCommand::SetUiPreference(request) => {
                return self.with_database("execute.set_ui_preference", |database| {
                    database
                        .ui_preference_repository()
                        .set(&request.key, &request.value_json)?;
                    Ok(AppCommandResult::OperationSummary(operation_summary(
                        "ui_preferences.saved",
                    )))
                })
            }
            AppCommand::AddSkillRepo(request) => return self.add_skill_repo(request),
            AppCommand::RemoveSkillRepo(request) => return self.remove_skill_repo(request),
            AppCommand::DownloadRepoSkill(request) => {
                return self.download_repo_skill(request).await
            }
            AppCommand::CheckSourceUpdate(request) => return self.check_source_update(request),
            AppCommand::ApplySourceUpdate(request) => return self.apply_source_update(request),
            AppCommand::SetMetadata(request) => return self.set_metadata(request),
            AppCommand::SetLifecycle(request) => return self.set_lifecycle(request),
            AppCommand::SetTrial(request) => return self.set_trial(request),
            AppCommand::SetCurrentVersion(request) => return self.set_current_version(request),
            AppCommand::SaveSkillContent(request) => return self.save_skill_content(request),
            AppCommand::SaveMarkdownContent(request) => return self.save_markdown_content(request),
            AppCommand::PrepareBackup(request) => {
                let input = self.build_backup_input(request.scope)?;
                let Some(root) = self.library_root.as_ref() else {
                    return Err(unsupported("execute.prepare_backup.library"));
                };
                let plan = BackupService::new(LibraryPaths::from_root(root).backups_dir)
                    .prepare(&input)?;
                return Ok(AppCommandResult::BackupPlan(plan));
            }
            AppCommand::CreateBackup(request) => {
                let input = self.build_backup_input(request.scope)?;
                let Some(root) = self.library_root.as_ref() else {
                    return Err(unsupported("execute.create_backup.library"));
                };
                let service = BackupService::new(LibraryPaths::from_root(root).backups_dir);
                let plan = service.prepare(&input)?;
                let decisions = request
                    .decisions
                    .into_iter()
                    .map(|decision| (decision.skill_id, decision.decision))
                    .collect::<Vec<_>>();
                let package = service.create(&input, &plan, &decisions)?;
                let verification = service.verify(&package)?;
                return Ok(AppCommandResult::BackupCreated(BackupCreated {
                    path: package.root.to_string_lossy().into_owned(),
                    manifest: verification.manifest,
                }));
            }
            AppCommand::VerifyBackup(request) => {
                let package = Self::backup_package(request.path)?;
                let destination = package
                    .root
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| PathBuf::from("."));
                let verification = BackupService::new(destination).verify(&package)?;
                return Ok(AppCommandResult::BackupManifest(verification.manifest));
            }
            AppCommand::PrepareRestore(request) => {
                let package = Self::backup_package(request.path)?;
                let Some(root) = self.library_root.as_ref() else {
                    return Err(unsupported("execute.prepare_restore.library"));
                };
                let plan = RestoreService::new(root.clone()).prepare(&package)?;
                return Ok(AppCommandResult::RestorePlan(plan));
            }
            AppCommand::CommitRestore(request) => {
                let package = Self::backup_package(request.path)?;
                let Some(root) = self.library_root.as_ref() else {
                    return Err(unsupported("execute.commit_restore.library"));
                };
                let service = RestoreService::new(root.clone());
                let plan = service.prepare(&package)?;
                let decisions = request
                    .decisions
                    .into_iter()
                    .map(|decision| (decision.skill_id, decision.decision))
                    .collect::<Vec<_>>();
                let result = service.commit(&package, &plan, &decisions)?;
                return Ok(AppCommandResult::RestoreResult(result));
            }
            AppCommand::RunRollingBackup(request) => {
                let input = self.build_backup_input(request.scope)?;
                let Some(root) = self.library_root.as_ref() else {
                    return Err(unsupported("execute.run_rolling_backup.library"));
                };
                let paths = LibraryPaths::from_root(root);
                let backup = BackupService::new(paths.backups_dir.clone());
                let plan = backup.prepare(&input)?;
                let decisions = request
                    .decisions
                    .into_iter()
                    .map(|decision| (decision.skill_id, decision.decision))
                    .collect::<Vec<_>>();
                let package = backup.create(&input, &plan, &decisions)?;
                backup.verify(&package)?;
                let retention =
                    RetentionService::new(paths.backups_dir).apply(request.retention)?;
                return Ok(AppCommandResult::BackupRetentionResult(retention));
            }
            AppCommand::PrepareStandardExport(request) => {
                let input = self.export_input(request.input)?;
                let service = ExportService::new(self.standard_export_destination()?);
                return service.prepare(&input).map(AppCommandResult::ExportPlan);
            }
            AppCommand::CreateStandardExport(request) => {
                let input = self.export_input(request.input)?;
                let service = ExportService::new(self.standard_export_destination()?);
                let plan = service.prepare(&input)?;
                let decisions = request
                    .decisions
                    .into_iter()
                    .map(|decision| (decision.skill_id, decision.decision))
                    .collect::<Vec<_>>();
                let export = service.create(&input, &plan, &decisions)?;
                let skills_exported = input
                    .skills
                    .iter()
                    .filter(|skill| {
                        decisions
                            .iter()
                            .find(|(skill_id, _)| *skill_id == skill.skill_id)
                            .map(|(_, decision)| {
                                *decision != SensitiveContentDecision::ExcludeSkill
                            })
                            .unwrap_or(true)
                    })
                    .count() as u32;
                return Ok(AppCommandResult::ExportResult(
                    skillhub_core::ExportResult {
                        path: export.root.to_string_lossy().into_owned(),
                        skills_exported,
                    },
                ));
            }
            AppCommand::PrepareUninstall(request) => {
                let deployments = self.uninstall_deployments(&request.deployment_ids)?;
                let impact = skillhub_core::UninstallService::prepare(deployments);
                self.prepared_uninstall
                    .lock()
                    .map_err(|_| internal("execute.prepare_uninstall"))?
                    .replace(impact.clone());
                return Ok(AppCommandResult::UninstallImpact(impact));
            }
            AppCommand::ApplyUninstallDecision(request) => {
                return self.apply_uninstall_decision(request.actions).await;
            }
            AppCommand::RunLlmSafetyCheck(request) => {
                return self
                    .run_llm_safety_check(request.skill_id, request.version_id)
                    .await;
            }
            AppCommand::RecheckLlmSafety(request) => {
                return self
                    .run_llm_safety_check(request.skill_id, request.version_id)
                    .await;
            }
            AppCommand::AnalyzeSemanticDuplicates(request) => {
                return self.analyze_semantic_duplicates(request.skill_id).await;
            }
            AppCommand::TranslateDescription(request) => {
                return self.translate_description(request).await;
            }
            AppCommand::SaveUserTranslationRevision(request) => {
                return self.save_user_translation_revision(request).await;
            }
            AppCommand::GenerateOnlineSearchQuery(request) => {
                return self.generate_online_search_query(request.text).await;
            }
            _ => "execute.unsupported",
        };
        Err(AppError::new(ErrorCode::InternalError, Severity::Error)
            .with_param("operation", operation)
            .with_action(RecoveryAction::Retry))
    }

    async fn query(&self, query: AppQuery) -> AppResult<AppQueryResult> {
        match query {
            AppQuery::GetApplicationUpdatePolicy => {
                self.with_database("query.get_application_update_policy", |database| {
                    database
                        .application_update_repository()
                        .get_policy()
                        .map(AppQueryResult::ApplicationUpdatePolicy)
                })
            }
            AppQuery::CheckApplicationUpdate(request) => {
                self.check_application_update(request).await
            }
            AppQuery::SearchOnlineSources(request) => self.search_online_sources(request).await,
            AppQuery::GetUiPreference(request) => {
                let value = self.with_database("query.get_ui_preference", |database| {
                    database.ui_preference_repository().get(&request.key)
                })?;
                Ok(AppQueryResult::UiPreference(
                    skillhub_core::api::GetUiPreferenceResult {
                        key: request.key,
                        value_json: value,
                    },
                ))
            }
            AppQuery::ListSkillRepos(_) => self.list_skill_repos(),
            AppQuery::DiscoverRepoSkills(_) => self.discover_repo_skills().await,
            AppQuery::DiscoverAgentsLockSkills(_) => {
                let home = agents_home_dir()?;
                let entries = read_agents_lock(&home);
                Ok(AppQueryResult::AgentsLockEntries(
                    entries
                        .into_iter()
                        .map(|entry| skillhub_core::source::AgentsLockEntry {
                            name: entry.name,
                            owner: entry.owner,
                            repo: entry.repo,
                            branch: entry.branch,
                            skill_path: entry.skill_path,
                        })
                        .collect(),
                ))
            }
            AppQuery::GetBootstrapSnapshot => {
                let default_library_path = self
                    .configured_library_path()
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_default();
                self.with_database("query.get_bootstrap_snapshot", |database| {
                    let repository = database.bootstrap_repository();
                    let initialization = repository.load_initialization()?.unwrap_or_else(|| {
                        skillhub_core::InitializationStatus::not_initialized(default_library_path)
                    });
                    repository
                        .build_snapshot(self.today)
                        .map(|snapshot| snapshot.with_initialization(initialization))
                        .map(AppQueryResult::BootstrapSnapshot)
                })
            }
            AppQuery::GetDesktopPreferences => {
                self.with_database("query.get_desktop_preferences", |database| {
                    database
                        .desktop_settings_repository()
                        .get()
                        .map(AppQueryResult::DesktopPreferences)
                })
            }
            AppQuery::GetDiscoverySnapshot(_) => {
                self.with_database("query.discovery_snapshot", |database| {
                    let snapshot = database
                        .agent_repository()
                        .load()?
                        .unwrap_or_else(empty_discovery);
                    Ok(AppQueryResult::DiscoverySnapshot(snapshot))
                })
            }
            AppQuery::ListCustomAgents(_) => {
                self.with_database("query.custom_agents", |database| {
                    Ok(AppQueryResult::CustomAgents(
                        database.custom_agent_repository().list()?,
                    ))
                })
            }
            AppQuery::ListProjects(_) => self.with_database("query.projects", |database| {
                Ok(AppQueryResult::Projects(
                    database.project_repository().list()?,
                ))
            }),
            AppQuery::PreviewProjectDirectory(request) => {
                self.preview_project_directory(&request.path)
            }
            AppQuery::ListSavedProjectViews(_) => {
                self.with_database("query.project_views", |database| {
                    Ok(AppQueryResult::SavedProjectViews(
                        database.project_repository().list_views()?,
                    ))
                })
            }
            AppQuery::ListPendingItems(_) => {
                self.with_database("query.list_pending_items", |database| {
                    database
                        .bootstrap_repository()
                        .list_pending(self.today)
                        .map(AppQueryResult::PendingItems)
                })
            }
            AppQuery::GetSkill(request) => {
                let skill_id = request.skill_id;
                let current_version = self
                    .library
                    .as_ref()
                    .map(|library| library.current(skill_id))
                    .transpose()?
                    .flatten();
                self.with_database("query.get_skill", move |database| {
                    let skill = database
                        .catalog_repository()?
                        .get_detail(skill_id)?
                        .ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))?;
                    Ok(AppQueryResult::Skill(skillhub_core::api::SkillResult {
                        skill_id: skill.skill_id,
                        display_name: skill.display_name,
                        runtime_name: skill.runtime_name,
                        original_description: skill.original_description,
                        translated_description: skill.translated_description,
                        user_note: skill.user_note,
                        tags: skill.tags,
                        license: skill.license,
                        lifecycle: skill.lifecycle,
                        trial_due: skill.trial_due,
                        current_version,
                    }))
                })
            }
            AppQuery::Search(request) => self.with_database("query.search", |database| {
                database
                    .search_repository()
                    .search(request)
                    .map(AppQueryResult::SearchResults)
            }),
            AppQuery::AnalyzeImport(request) => {
                self.with_database("query.analyze_import", |database| {
                    database
                        .import_repository()
                        .analyze(request.candidate, request.tree_hash.as_deref())
                        .map(AppQueryResult::ImportAnalysis)
                })
            }
            AppQuery::DiscoverImportCandidates(request) => {
                let source = request.source;
                let Some(root) = source.locator.as_local_path().cloned() else {
                    return Err(unsupported("query.discover_import_candidates"));
                };
                let mut candidates = SkillDetector::default().detect(root.clone(), source)?;
                // 仓库发现下载目录 → 给候选盖上长期上游坐标，随 prepare/commit 原样回流。
                if let Ok(registry) = self.upstream_origins.lock() {
                    let key = root.to_string_lossy().to_string();
                    if let Some(origin) = registry.get(&key) {
                        for candidate in &mut candidates {
                            candidate.upstream = Some(origin.clone());
                        }
                    }
                }
                Ok(AppQueryResult::ImportCandidates(candidates))
            }
            AppQuery::ListSkills(request) => self.with_database("query.list_skills", |database| {
                database
                    .catalog_repository()?
                    .list_page(&request)
                    .map(AppQueryResult::SkillPage)
            }),
            AppQuery::ListCombinations(_) => {
                self.with_database("query.list_combinations", |database| {
                    database
                        .combination_repository()
                        .list()
                        .map(AppQueryResult::Combinations)
                })
            }
            AppQuery::ListVersions(request) => self.list_versions(request.skill_id),
            AppQuery::ListSkillOperations(request) => self.list_skill_operations(request.skill_id),
            AppQuery::ListRunningLlmChecks => self.list_running_llm_checks(),
            AppQuery::DiffVersions(request) => self.diff_versions(&request.left, &request.right),
            AppQuery::ListDeployments(request) => self.list_deployments(request.skill_id),
            AppQuery::GetDeploymentRelations(request) => {
                self.list_deployment_relations(request.skill_id)
            }
            AppQuery::GetRemovalImpact(request) => self
                .removal_service
                .prepare_delete(request.skill_id)
                .await
                .map(AppQueryResult::RemovalImpact),
            AppQuery::ListRecoveryCandidates => self
                .recovery_service
                .list()
                .await
                .map(AppQueryResult::RecoveryCandidates),
            AppQuery::GetCallPolicy(request) => self
                .call_policy_service
                .inspect(request.skill_id)
                .await
                .map(|(capability, policy)| {
                    AppQueryResult::CallPolicy(skillhub_core::CallPolicyResult {
                        skill_id: request.skill_id,
                        capability,
                        policy,
                    })
                }),
            AppQuery::ListIgnoreRules => self
                .ignore_service
                .list()
                .await
                .map(AppQueryResult::IgnoreRules),
            AppQuery::GetReconcilePlan(request) => self
                .reconcile_service
                .plan(request.deployment_id)
                .await
                .map(AppQueryResult::ReconcilePlan),
            AppQuery::GetDeploymentPlan(request) => self.get_deployment_plan(request.request),
            AppQuery::ListDeploymentTargets(_) => self.list_deployment_targets(),
            AppQuery::GetBasicCheckResult(request) => self.get_check_result(
                request.skill_id,
                request.version_id,
                skillhub_core::check::CheckKind::Basic,
            ),
            AppQuery::GetLlmSafetyCheckResult(request) => self.get_check_result(
                request.skill_id,
                request.version_id,
                skillhub_core::check::CheckKind::Llm,
            ),
            AppQuery::ListFindings(request) => {
                self.list_findings(request.skill_id, request.version_id, request.kind)
            }
            AppQuery::ListMarkdownFiles(request) => self.list_markdown_files(request.skill_id),
            AppQuery::ReadMarkdownFile(request) => {
                self.read_markdown_file(request.skill_id, &request.path)
            }
            AppQuery::AnalyzeGlobalSkillEvidence(request) => {
                self.analyze_global_skill_evidence(request).await
            }
            AppQuery::GetProjectAssemblyPlan(request) => {
                let plans = self
                    .assembly_plans
                    .lock()
                    .map_err(|_| internal("query.assembly_plan"))?;
                plans
                    .values()
                    .filter(|plan| plan.project_id == request.project_id)
                    .max_by_key(|plan| plan.operation_id.to_string())
                    .cloned()
                    .map(AppQueryResult::AssemblyPlan)
                    .ok_or_else(|| {
                        AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                            .with_param("kind", "project assembly plan")
                            .with_action(RecoveryAction::Retry)
                    })
            }
        }
    }
}

impl LocalApplicationFacade {
    /// Read-only project directory analysis used before registration: reports
    /// the project-scoped agent directories that already exist under the
    /// chosen root and the skill directories the bounded detector can scan.
    /// It must not create records, import skills, or touch the directory.
    fn preview_project_directory(&self, path: &str) -> AppResult<AppQueryResult> {
        let root = std::path::PathBuf::from(path);
        if !root.is_dir() {
            return Err(invalid_input(
                "path must be an existing readable project directory",
            ));
        }
        let canonical = root
            .canonicalize()
            .map_err(|_| invalid_input("path must be a readable project directory"))?;
        let roots = DiscoveryRoots {
            operating_system: current_operating_system(),
            user_home: user_home(),
            project_roots: vec![canonical.clone()],
        };
        let snapshot = DiscoverAgents::builtin().discover(&roots)?;
        let agent_traces = snapshot
            .logical_targets
            .into_iter()
            .filter(|target| {
                target.scope == skillhub_core::agent::TargetScope::Project
                    && target.exists
                    && std::path::Path::new(&target.path).starts_with(&canonical)
            })
            .collect::<Vec<_>>();
        let source = SourceDescriptor::new(
            skillhub_core::SourceKind::Local,
            skillhub_core::SourceLocator::local_path(canonical.clone()),
        );
        let skill_candidates = SkillDetector::default().detect(&canonical, source)?;
        Ok(AppQueryResult::ProjectDirectoryPreview(
            skillhub_core::api::ProjectDirectoryPreview {
                path: canonical.to_string_lossy().into_owned(),
                agent_traces,
                skill_candidates,
            },
        ))
    }

    fn list_deployment_targets(&self) -> AppResult<AppQueryResult> {
        let capabilities = DeploymentFilesystem::new().available_capabilities();
        let modes = [
            (
                capabilities.symlink,
                skillhub_core::DeploymentMode::SymbolicLink,
            ),
            (
                capabilities.junction,
                skillhub_core::DeploymentMode::DirectoryJunction,
            ),
            (
                capabilities.copy,
                skillhub_core::DeploymentMode::ManagedCopy,
            ),
        ]
        .into_iter()
        .filter_map(|(supported, mode)| supported.then_some(mode))
        .collect::<Vec<_>>();
        self.with_database("query.list_deployment_targets", |database| {
            let mut targets: Vec<skillhub_core::api::DeploymentTarget> = database
                .agent_repository()
                .load()?
                .map(|snapshot| {
                    snapshot
                        .logical_targets
                        .into_iter()
                        .map(|target| skillhub_core::api::DeploymentTarget {
                            id: target.id,
                            label: target.client_id,
                            path: target.path,
                            available: target.available,
                            physical_id: target.physical_id,
                            modes: modes.clone(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            targets.extend(
                database
                    .project_repository()
                    .list()?
                    .into_iter()
                    .map(|project| {
                        let available = Path::new(project.path()).is_dir();
                        skillhub_core::api::DeploymentTarget {
                            id: project.id.to_string(),
                            label: project.name,
                            path: project.device_path.clone(),
                            available,
                            physical_id: project.physical_id,
                            modes: modes.clone(),
                        }
                    }),
            );
            Ok(AppQueryResult::DeploymentTargets(targets))
        })
    }

    async fn prepare_deployment(
        &self,
        plan: skillhub_core::DeploymentPlan,
    ) -> AppResult<AppCommandResult> {
        let prepared = self.deployment_service.prepare(plan).await?;
        Ok(AppCommandResult::PreparedDeployment(Box::new(prepared)))
    }

    async fn commit_deployment(&self, id: OperationId) -> AppResult<AppCommandResult> {
        let summary = self.deployment_service.commit(id).await?;
        Ok(AppCommandResult::DeploymentSummary(Box::new(summary)))
    }

    fn get_deployment_plan(&self, request: DeploymentPlanRequest) -> AppResult<AppQueryResult> {
        let library_root = self
            .library_root
            .as_ref()
            .ok_or_else(|| unsupported("query.get_deployment_plan"))?;
        let source_path = library_root
            .join("versions")
            .join(request.skill_id.to_string())
            .join(request.version_id.as_str());
        let source_path = source_path.to_string_lossy().into_owned();
        let input = if let Some(resolver) = self.deployment_targets.as_ref() {
            request.resolve(resolver, source_path)?
        } else {
            let resolver = self.discovery_target_index()?;
            request.resolve(&resolver, source_path)?
        };
        skillhub_core::DeploymentPlanner
            .plan_request(&input)
            .map(AppQueryResult::DeploymentPlan)
    }

    fn discovery_target_index(&self) -> AppResult<RegisteredTargetIndex> {
        let capabilities = DeploymentFilesystem::new().available_capabilities();
        self.with_database("query.get_deployment_plan", |database| {
            let mut facts = Vec::new();
            let mut roots = Vec::new();
            if let Some(snapshot) = database.agent_repository().load()? {
                for target in snapshot.logical_targets {
                    if !target.available || !target.exists {
                        continue;
                    }
                    let path = PathBuf::from(&target.path);
                    let Ok(root) = AllowedRoot::new(&path) else {
                        continue;
                    };
                    roots.push(root);
                    facts.push(TargetFact::from_logical_target(
                        &target,
                        capabilities.clone(),
                    ));
                }
            }
            for project in database.project_repository().list()? {
                let path = PathBuf::from(project.path());
                let Ok(root) = AllowedRoot::new(&path) else {
                    continue;
                };
                roots.push(root);
                facts.push(TargetFact::from_project(&project, capabilities.clone()));
            }
            let policy = PathPolicy::from_roots(roots)?;
            RegisteredTargetIndex::from_facts(facts, policy)
        })
    }

    fn prepare_import(&self, request: skillhub_core::PrepareImport) -> AppResult<AppCommandResult> {
        self.with_database("execute.prepare_import", |database| {
            let analysis = database
                .import_repository()
                .analyze(request.candidate.clone(), request.tree_hash.as_deref())?;
            let prepared = PreparedImport {
                id: OperationId::new(),
                candidate: request.candidate,
                analysis,
            };
            self.prepared_imports
                .lock()
                .map_err(|_| {
                    AppError::new(ErrorCode::InternalError, Severity::Error)
                        .with_param("operation", "execute.prepare_import")
                        .with_action(RecoveryAction::Retry)
                })?
                .insert(prepared.id, prepared.clone());
            Ok(AppCommandResult::PreparedImport(Box::new(prepared)))
        })
    }

    fn cancel_import(&self, prepared_import_id: OperationId) -> AppResult<AppCommandResult> {
        let removed = self
            .prepared_imports
            .lock()
            .map_err(|_| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("operation", "execute.cancel_import")
                    .with_action(RecoveryAction::Retry)
            })?
            .remove(&prepared_import_id);
        if removed.is_none() {
            return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("prepared_import_id", prepared_import_id.to_string())
                .with_action(RecoveryAction::ChooseAnotherName));
        }
        Ok(AppCommandResult::OperationSummary(
            skillhub_core::OperationSummary {
                operation_id: prepared_import_id,
                phase: skillhub_core::OperationPhase::RolledBack,
                message_code: "import.cancelled".to_owned(),
                error_code: None,
            },
        ))
    }

    fn commit_import(&self, request: skillhub_core::CommitImport) -> AppResult<AppCommandResult> {
        let prepared = self
            .prepared_imports
            .lock()
            .map_err(|_| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("operation", "execute.commit_import")
                    .with_action(RecoveryAction::Retry)
            })?
            .get(&request.prepared_import_id)
            .cloned()
            .ok_or_else(|| {
                AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("prepared_import_id", request.prepared_import_id.to_string())
                    .with_action(RecoveryAction::ChooseAnotherName)
            })?;
        if !prepared.analysis.actions.contains(&request.decision) {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "decision")
                .with_action(RecoveryAction::ChooseAnotherName));
        }
        if request.decision == skillhub_core::ImportDecision::Skip {
            self.prepared_imports
                .lock()
                .map_err(|_| {
                    AppError::new(ErrorCode::InternalError, Severity::Error)
                        .with_param("operation", "execute.commit_import")
                        .with_action(RecoveryAction::Retry)
                })?
                .remove(&request.prepared_import_id);
            return Ok(AppCommandResult::ImportSummary(Box::new(
                skillhub_core::ImportSummary {
                    operation_id: request.prepared_import_id,
                    items: vec![skillhub_core::ImportItemResult {
                        skill_id: None,
                        decision: request.decision,
                        original_preserved: true,
                    }],
                    committed: true,
                },
            )));
        }
        if request.decision == skillhub_core::ImportDecision::ReuseExisting {
            let skill_id = prepared
                .analysis
                .matches
                .first()
                .map(|item| item.skill_id)
                .ok_or_else(|| {
                    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                        .with_param("field", "existing_skill")
                        .with_action(RecoveryAction::ChooseAnotherName)
                })?;
            self.prepared_imports
                .lock()
                .map_err(|_| {
                    AppError::new(ErrorCode::InternalError, Severity::Error)
                        .with_param("operation", "execute.commit_import")
                        .with_action(RecoveryAction::Retry)
                })?
                .remove(&request.prepared_import_id);
            return Ok(AppCommandResult::ImportSummary(Box::new(
                skillhub_core::ImportSummary {
                    operation_id: request.prepared_import_id,
                    items: vec![skillhub_core::ImportItemResult {
                        skill_id: Some(skill_id),
                        decision: request.decision,
                        original_preserved: true,
                    }],
                    committed: true,
                },
            )));
        }
        if !matches!(
            request.decision,
            skillhub_core::ImportDecision::CopyIntoLibrary
                | skillhub_core::ImportDecision::KeepIndependent
                | skillhub_core::ImportDecision::CopyAsIndependentManagedSkill
        ) {
            return Err(unsupported("execute.commit_import.decision"));
        }
        let Some(library_root) = self.library_root.as_ref() else {
            return Err(unsupported("execute.commit_import.library"));
        };
        self.with_database("execute.commit_import", |database| {
            let central = CentralLibrary::initialize(library_root)?;
            let store = VersionStore::from_library(&central);
            let skill_id = skillhub_core::SkillId::new();
            let source = Path::new(&prepared.candidate.absolute_root);
            let version = store.capture(skill_id, source)?;
            let skill = Skill::new(skill_id, prepared.candidate.runtime_name.clone());
            if let Err(error) = database.catalog_repository()?.insert_sync(&skill) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, &central, &store, skill_id, &version),
                ));
            }
            if let Err(error) = store.set_current(skill_id, &version.id) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, &central, &store, skill_id, &version),
                ));
            }
            if let Err(error) = central.materialize_current_skill(&skill, &version.id) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, &central, &store, skill_id, &version),
                ));
            }
            if let Err(error) = central.save_portable_skill(&skill, Some(&version.id)) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, &central, &store, skill_id, &version),
                ));
            }
            if let Err(error) = database
                .source_repository()
                .relink(skill_id, prepared.candidate.source.clone())
            {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, &central, &store, skill_id, &version),
                ));
            }
            if let Some(upstream) = prepared.candidate.upstream.clone() {
                if let Err(error) = database
                    .source_repository()
                    .record_upstream(skill_id, &upstream)
                {
                    return Err(cleanup_import_error(
                        error,
                        cleanup_import_state(database, &central, &store, skill_id, &version),
                    ));
                }
            }
            self.prepared_imports
                .lock()
                .map_err(|_| {
                    AppError::new(ErrorCode::InternalError, Severity::Error)
                        .with_param("operation", "execute.commit_import")
                        .with_action(RecoveryAction::Retry)
                })?
                .remove(&request.prepared_import_id);
            Ok(AppCommandResult::ImportSummary(Box::new(
                skillhub_core::ImportSummary {
                    operation_id: request.prepared_import_id,
                    items: vec![skillhub_core::ImportItemResult {
                        skill_id: Some(skill_id),
                        decision: request.decision,
                        original_preserved: true,
                    }],
                    committed: true,
                },
            )))
        })
    }
}

impl LocalApplicationFacade {
    fn list_skill_operations(&self, skill_id: skillhub_core::SkillId) -> AppResult<AppQueryResult> {
        let database = self
            .database
            .lock()
            .map_err(|_| internal("query.list_skill_operations"))?;
        let mut statement = database
            .connection_for_test()
            .prepare(
                "SELECT operation_id,kind,phase,error_code FROM operations ORDER BY created_at,operation_id",
            )
            .map_err(|error| database_error("query.list_skill_operations", error.to_string()))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|error| database_error("query.list_skill_operations", error.to_string()))?;
        let mut entries = Vec::new();
        for row in rows {
            let (operation_id, kind, phase, error_code) = row.map_err(|error| {
                database_error("query.list_skill_operations", error.to_string())
            })?;
            entries.push(skillhub_core::SkillOperationEntry {
                operation_id,
                kind,
                phase: serde_json::from_value(serde_json::Value::String(phase)).map_err(
                    |error| database_error("query.list_skill_operations", error.to_string()),
                )?,
                error_code: error_code
                    .map(|code| {
                        serde_json::from_value(serde_json::Value::String(code)).map_err(|error| {
                            database_error("query.list_skill_operations", error.to_string())
                        })
                    })
                    .transpose()?,
            });
        }
        // The journal does not record a skill dimension yet, so the answer is
        // the global journal plus an explicit limitation marker instead of a
        // filter the storage cannot actually perform.
        Ok(AppQueryResult::SkillOperations(
            skillhub_core::SkillOperationsResult {
                skill_id,
                entries,
                filtered: false,
                limitation: Some("skill_dimension_not_recorded".to_owned()),
            },
        ))
    }

    fn list_versions(&self, skill_id: skillhub_core::SkillId) -> AppResult<AppQueryResult> {
        let Some(library) = self.library.as_ref() else {
            return Err(unsupported("query.list_versions"));
        };
        let current = library.current(skill_id)?;
        let records = library.list(skill_id)?;
        let mut results = Vec::with_capacity(records.len());
        for (index, record) in records.iter().enumerate() {
            let diff = if index == 0 {
                skillhub_core::VersionDiff::default()
            } else {
                library.diff(&records[index - 1].id, &record.id)?
            };
            results.push(skillhub_core::api::VersionResult {
                version_id: record.id.clone(),
                skill_id,
                current: current.as_ref() == Some(&record.id),
                file_count: u32::try_from(record.manifest.entries.len()).unwrap_or(u32::MAX),
                added: u32::try_from(diff.added.len()).unwrap_or(u32::MAX),
                changed: u32::try_from(diff.changed.len()).unwrap_or(u32::MAX),
                removed: u32::try_from(diff.removed.len()).unwrap_or(u32::MAX),
            });
        }
        results.sort_by(|left, right| {
            right
                .current
                .cmp(&left.current)
                .then_with(|| right.version_id.as_str().cmp(left.version_id.as_str()))
        });
        Ok(AppQueryResult::Versions(results))
    }

    fn diff_versions(
        &self,
        left: &skillhub_core::VersionId,
        right: &skillhub_core::VersionId,
    ) -> AppResult<AppQueryResult> {
        let Some(library) = self.library.as_ref() else {
            return Err(unsupported("query.diff_versions"));
        };
        let diff = library.diff(left, right)?;
        Ok(AppQueryResult::VersionDiff(
            skillhub_core::api::VersionDiffResult {
                added: diff.added,
                removed: diff.removed,
                changed: diff.changed,
            },
        ))
    }

    fn list_deployments(
        &self,
        skill_id: Option<skillhub_core::SkillId>,
    ) -> AppResult<AppQueryResult> {
        self.with_database("query.list_deployments", |database| {
            let deployments = database.deployment_repository().list_all()?;
            Ok(AppQueryResult::Deployments(
                deployments
                    .into_iter()
                    .filter(|deployment| skill_id.is_none_or(|id| deployment.skill_id == id))
                    .collect(),
            ))
        })
    }

    fn list_deployment_relations(
        &self,
        skill_id: skillhub_core::SkillId,
    ) -> AppResult<AppQueryResult> {
        self.with_database("query.get_deployment_relations", |database| {
            let deployments = database.deployment_repository().list_all()?;
            Ok(AppQueryResult::DeploymentRelations(
                deployments
                    .into_iter()
                    .filter(|deployment| {
                        deployment.skill_id == skill_id
                            && !matches!(
                                deployment.state,
                                skillhub_core::DeploymentState::Planned
                                    | skillhub_core::DeploymentState::Removed
                            )
                    })
                    .collect(),
            ))
        })
    }

    fn get_check_result(
        &self,
        skill_id: skillhub_core::SkillId,
        version_id: skillhub_core::VersionId,
        kind: skillhub_core::check::CheckKind,
    ) -> AppResult<AppQueryResult> {
        self.with_database("query.get_check_result", |database| {
            let run = database.check_repository().current_for_version_sync(
                skill_id,
                &version_id,
                kind,
            )?;
            let projection = skillhub_core::check::CheckResult {
                state: run
                    .as_ref()
                    .map(skillhub_core::check::derive_check_state)
                    .unwrap_or(skillhub_core::check::CheckState::NotChecked),
                run,
            };
            match kind {
                skillhub_core::check::CheckKind::Basic => Ok(AppQueryResult::BasicCheckResult(
                    skillhub_core::api::BasicCheckResult::from_check_result(
                        skill_id,
                        version_id,
                        &projection,
                    ),
                )),
                skillhub_core::check::CheckKind::Llm => Ok(AppQueryResult::LlmSafetyCheckResult(
                    skillhub_core::api::LlmSafetyCheckResult::from_check_result(
                        skill_id,
                        version_id,
                        &projection,
                    ),
                )),
            }
        })
    }

    fn list_findings(
        &self,
        skill_id: skillhub_core::SkillId,
        version_id: skillhub_core::VersionId,
        kind: skillhub_core::check::CheckKind,
    ) -> AppResult<AppQueryResult> {
        self.with_database("query.list_findings", |database| {
            let findings = database
                .check_repository()
                .current_for_version_sync(skill_id, &version_id, kind)?
                .map(|run| {
                    run.findings
                        .iter()
                        .map(skillhub_core::api::FindingResult::from)
                        .collect()
                })
                .unwrap_or_default();
            Ok(AppQueryResult::Findings(findings))
        })
    }

    fn list_markdown_files(&self, skill_id: skillhub_core::SkillId) -> AppResult<AppQueryResult> {
        let Some(library) = self.library.as_ref() else {
            return Err(unsupported("query.list_markdown_files"));
        };
        let Some(version_id) = library.current(skill_id)? else {
            return Ok(AppQueryResult::MarkdownFiles(Vec::new()));
        };
        let paths = library.list_markdown_files(&version_id)?;
        Ok(AppQueryResult::MarkdownFiles(
            paths
                .into_iter()
                .map(|path| skillhub_core::api::MarkdownFileEntry {
                    primary: path.eq_ignore_ascii_case("SKILL.md"),
                    label: path.clone(),
                    path,
                })
                .collect(),
        ))
    }

    fn read_markdown_file(
        &self,
        skill_id: skillhub_core::SkillId,
        path: &str,
    ) -> AppResult<AppQueryResult> {
        let Some(library) = self.library.as_ref() else {
            return Err(unsupported("query.read_markdown_file"));
        };
        let extension_is_markdown = Path::new(path)
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
        if !extension_is_markdown {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "path")
                .with_param("reason", "markdown_only")
                .with_action(RecoveryAction::ChooseAnotherName));
        }
        let version_id = library
            .current(skill_id)?
            .ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))?;
        const MAX_MARKDOWN_BYTES: u64 = 1_048_576;
        let (identity, bytes) = library.read_file(&version_id, path, MAX_MARKDOWN_BYTES)?;
        let markdown = String::from_utf8(bytes).map_err(|_| {
            AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "markdown_encoding")
                .with_action(RecoveryAction::ChooseAnotherName)
        })?;
        Ok(AppQueryResult::MarkdownFile(
            skillhub_core::api::MarkdownFileContent {
                content_identity: identity,
                editable: true,
                markdown,
                path: path.to_owned(),
            },
        ))
    }
}

fn cleanup_import_state(
    database: &Database,
    central: &CentralLibrary,
    store: &VersionStore,
    skill_id: skillhub_core::SkillId,
    version: &skillhub_core::VersionRecord,
) -> AppResult<()> {
    database.catalog_repository()?.remove_sync(skill_id)?;
    store.clear_current(skill_id)?;
    central.remove_portable_skill(skill_id)?;
    store.discard_sync(version)
}

fn cleanup_import_error(original: AppError, cleanup: AppResult<()>) -> AppError {
    match cleanup {
        Ok(()) => original,
        Err(error) => AppError::new(ErrorCode::OperationConflict, Severity::Critical)
            .with_param("original_error", original.code.as_str())
            .with_param("cleanup_error", error.code.as_str())
            .with_action(RecoveryAction::RollbackOperation)
            .with_action(RecoveryAction::CompleteOperation),
    }
}

fn restore_version_pointer(
    library: &VersionStore,
    skill_id: skillhub_core::SkillId,
    previous: Option<skillhub_core::VersionId>,
) -> AppResult<()> {
    match previous {
        Some(previous) => library.set_current(skill_id, &previous),
        None => library.clear_current(skill_id),
    }
}

fn validate_skill_source(source: &Path) -> AppResult<()> {
    let path = source.join("SKILL.md");
    let metadata = std::fs::metadata(&path).map_err(|_| {
        AppError::new(ErrorCode::InvalidInput, Severity::Error)
            .with_param("field", "SKILL.md")
            .with_action(RecoveryAction::ChooseAnotherName)
    })?;
    if !metadata.is_file()
        || std::fs::read_to_string(path)
            .map_err(|_| {
                AppError::new(ErrorCode::InvalidInput, Severity::Error)
                    .with_param("field", "SKILL.md")
                    .with_action(RecoveryAction::ChooseAnotherName)
            })?
            .trim()
            .is_empty()
    {
        return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
            .with_param("field", "SKILL.md")
            .with_action(RecoveryAction::ChooseAnotherName));
    }
    Ok(())
}

fn validate_markdown_path(path: &str) -> AppResult<PathBuf> {
    if path.is_empty() || path.contains('\\') {
        return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
            .with_param("field", "path")
            .with_action(RecoveryAction::ChooseAnotherName));
    }
    let relative = Path::new(path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
        || !relative
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
            .with_param("field", "path")
            .with_action(RecoveryAction::ChooseAnotherName));
    }
    Ok(relative.to_path_buf())
}

struct LocalGrantResolver<'a> {
    grants: &'a Mutex<HashMap<String, ResolvedPathGrant>>,
}

impl skillhub_core::PathGrantResolver for LocalGrantResolver<'_> {
    fn resolve(
        &self,
        grant: &skillhub_core::PathGrant,
    ) -> Result<ResolvedPathGrant, skillhub_core::CustomAgentValidationError> {
        self.grants
            .lock()
            .map_err(|_| skillhub_core::CustomAgentValidationError::GrantNotAuthorized)?
            .get(&grant.grant_id)
            .cloned()
            .ok_or(skillhub_core::CustomAgentValidationError::GrantNotAuthorized)
    }
}

struct LocalAssemblyService<'a> {
    facade: &'a LocalApplicationFacade,
}

impl LocalAssemblyService<'_> {
    fn prepare(
        &self,
        project_id: skillhub_core::ProjectId,
    ) -> AppResult<skillhub_core::AssemblyPlan> {
        let service = skillhub_core::ProjectAssemblyService::new(
            LocalResolution {
                facade: self.facade,
            },
            LocalSource,
            LocalChecks,
            LocalAssemblyDeployment {
                facade: self.facade,
            },
        );
        service.prepare_assembly(project_id)
    }

    fn commit(&self, plan: skillhub_core::AssemblyPlan) -> AppResult<skillhub_core::AssemblyPlan> {
        let service = skillhub_core::ProjectAssemblyService::new(
            LocalResolution {
                facade: self.facade,
            },
            LocalSource,
            LocalChecks,
            LocalAssemblyDeployment {
                facade: self.facade,
            },
        );
        service.commit_assembly(plan)
    }
}

struct LocalResolution<'a> {
    facade: &'a LocalApplicationFacade,
}

impl skillhub_core::SkillResolutionPort for LocalResolution<'_> {
    fn shared_config(
        &self,
        project_id: skillhub_core::ProjectId,
    ) -> AppResult<skillhub_core::SharedProjectConfig> {
        self.facade
            .with_database("assembly.shared_config", |database| {
                database.project_repository().read_shared_config(project_id)
            })
    }

    fn resolve_requirement(
        &self,
        requirement: &skillhub_core::SharedSkillRequirement,
    ) -> AppResult<skillhub_core::SkillResolution> {
        let Some(library) = self.facade.library.as_ref() else {
            return Ok(skillhub_core::SkillResolution::Missing {
                requested_source: requirement.source.as_str().to_owned(),
            });
        };
        let version = if let Some(version) = requirement.version_id.clone() {
            Some(version)
        } else {
            library.current(requirement.skill_id)?
        };
        let Some(version) = version else {
            return Ok(skillhub_core::SkillResolution::Missing {
                requested_source: requirement.source.as_str().to_owned(),
            });
        };
        if library.load_manifest(&version).is_ok() {
            Ok(skillhub_core::SkillResolution::Satisfied {
                version_id: version,
            })
        } else {
            Ok(skillhub_core::SkillResolution::Missing {
                requested_source: requirement.source.as_str().to_owned(),
            })
        }
    }
}

struct LocalSource;
impl skillhub_core::SourcePreparationPort for LocalSource {
    fn prepare_source(
        &self,
        requirement: &skillhub_core::SharedSkillRequirement,
    ) -> AppResult<skillhub_core::SourcePreparation> {
        Ok(requirement
            .version_id
            .clone()
            .map(|version_id| skillhub_core::SourcePreparation::Ready { version_id })
            .unwrap_or_else(|| skillhub_core::SourcePreparation::Failed {
                reasons: vec!["assembly.source_acquisition_required".into()],
            }))
    }
}

struct LocalChecks;
impl skillhub_core::CheckPreparationPort for LocalChecks {
    fn prepare_checks(
        &self,
        _requirement: &skillhub_core::SharedSkillRequirement,
        _version_id: &skillhub_core::VersionId,
    ) -> AppResult<skillhub_core::CheckPreparation> {
        Ok(skillhub_core::CheckPreparation::NotNeeded)
    }
}

struct LocalAssemblyDeployment<'a> {
    facade: &'a LocalApplicationFacade,
}
impl skillhub_core::DeploymentPreparationPort for LocalAssemblyDeployment<'_> {
    fn prepare_project_deployment(
        &self,
        requirement: &skillhub_core::SharedSkillRequirement,
        _version_id: &skillhub_core::VersionId,
    ) -> AppResult<skillhub_core::DeploymentPreparation> {
        let Some(target_id) = requirement.logical_agent_id.as_ref() else {
            return Ok(skillhub_core::DeploymentPreparation::NotNeeded);
        };
        if requirement.name.contains(['/', '\\'])
            || requirement.name == "."
            || requirement.name == ".."
        {
            return Ok(skillhub_core::DeploymentPreparation::Failed {
                reasons: vec!["assembly.runtime_name_invalid".into()],
            });
        }
        let available = self.facade.with_database("assembly.target", |database| {
            Ok(database.agent_repository().load()?.is_some_and(|snapshot| {
                snapshot.logical_targets.iter().any(|target| {
                    target.id == *target_id && target.available && target.exists && target.readable
                })
            }))
        })?;
        if available {
            Ok(skillhub_core::DeploymentPreparation::Ready)
        } else {
            Ok(skillhub_core::DeploymentPreparation::Failed {
                reasons: vec!["assembly.target_unavailable".into()],
            })
        }
    }

    fn commit_project_deployment(
        &self,
        requirement: &skillhub_core::SharedSkillRequirement,
        version_id: &skillhub_core::VersionId,
    ) -> AppResult<()> {
        let Some(target_id) = requirement.logical_agent_id.as_ref() else {
            return Ok(());
        };
        let Some(library_root) = self.facade.library_root.as_ref() else {
            return Err(unsupported("assembly.commit.library"));
        };
        let (target, source_path) =
            self.facade
                .with_database("assembly.commit.target", |database| {
                    let snapshot = database.agent_repository().load()?.ok_or_else(|| {
                        AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                            .with_param("kind", "discovery snapshot")
                            .with_action(RecoveryAction::Retry)
                    })?;
                    let target = snapshot
                        .logical_targets
                        .iter()
                        .find(|target| {
                            target.id == *target_id
                                && target.available
                                && target.exists
                                && target.readable
                        })
                        .ok_or_else(|| {
                            AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                                .with_param("kind", "assembly target")
                                .with_action(RecoveryAction::InspectTarget)
                        })?
                        .clone();
                    let source = library_root
                        .join("versions")
                        .join(requirement.skill_id.to_string())
                        .join(version_id.as_str());
                    Ok((target, source))
                })?;
        let target_plan = TargetPlan {
            physical_target_id: target.physical_id.clone(),
            logical_target_ids: vec![target.id.clone()],
            target_path: target.path.clone(),
            destination_path: Path::new(&target.path)
                .join(&requirement.name)
                .to_string_lossy()
                .into_owned(),
            source_path: source_path.to_string_lossy().into_owned(),
            runtime_name: requirement.name.clone(),
            skill_id: requirement.skill_id,
            version_id: version_id.clone(),
            mode: DeploymentMode::ManagedCopy,
            change: TargetChange::Create,
            warnings: Vec::new(),
            conflicts: Vec::new(),
        };
        let filesystem = DeploymentFilesystem::new();
        let prepared = filesystem.prepare(&target_plan)?;
        let applied = filesystem.apply(prepared)?;
        let record = skillhub_core::DeploymentRecord {
            id: skillhub_core::DeploymentId::new(),
            skill_id: requirement.skill_id,
            version_id: version_id.clone(),
            target_id: target.physical_id,
            state: skillhub_core::DeploymentState::Deployed,
            mode: DeploymentMode::ManagedCopy,
            managed: true,
            runtime_name: requirement.name.clone(),
            expected_hash: applied.ownership.expected_hash,
            observed_hash: Some(applied.observed_tree_hash),
        };
        self.facade
            .with_database("assembly.commit.persist", |database| {
                database.deployment_repository().insert_sync(&record)
            })?;
        Ok(())
    }
}

fn empty_discovery() -> skillhub_core::DiscoverySnapshot {
    skillhub_core::DiscoverySnapshot {
        generation: "0".into(),
        observed_at: "0".into(),
        instances: Vec::new(),
        logical_targets: Vec::new(),
        physical_targets: Vec::new(),
    }
}

fn agent_invalid(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::AgentProfileInvalidCapability, Severity::Error)
        .with_param("detail", detail.into())
        .with_action(RecoveryAction::Acknowledge)
}

/// 仓库 Skill 下载根目录（系统临时目录下的独立子目录）。
fn repo_downloads_root() -> AppResult<std::path::PathBuf> {
    let root = std::env::temp_dir().join("skillhub-repo-skills");
    std::fs::create_dir_all(&root).map_err(|error| {
        AppError::new(ErrorCode::InternalError, Severity::Error)
            .with_param("source", error.to_string())
            .with_action(RecoveryAction::Retry)
    })?;
    Ok(root)
}

/// 用户主目录（lock 发现等以家目录为基准的读取用）。
fn agents_home_dir() -> AppResult<std::path::PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(std::path::PathBuf::from)
        .map_err(|_| {
            AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("detail", "home directory is not configured")
        })
}

fn invalid_input(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, Severity::Error)
        .with_param("detail", detail.into())
        .with_action(RecoveryAction::Acknowledge)
}

fn operation_summary(message_code: &str) -> skillhub_core::OperationSummary {
    skillhub_core::OperationSummary {
        operation_id: OperationId::new(),
        phase: skillhub_core::OperationPhase::Committed,
        message_code: message_code.to_owned(),
        error_code: None,
    }
}

fn unsupported(operation: &'static str) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("operation", operation)
        .with_action(RecoveryAction::Retry)
}

fn internal(operation: &'static str) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("operation", operation)
        .with_action(RecoveryAction::Retry)
}

fn same_path(configured: &Path, selected: &Path) -> bool {
    let configured = std::fs::canonicalize(configured).unwrap_or_else(|_| configured.to_path_buf());
    let selected = std::fs::canonicalize(selected).unwrap_or_else(|_| selected.to_path_buf());
    if cfg!(windows) {
        configured
            .to_string_lossy()
            .eq_ignore_ascii_case(&selected.to_string_lossy())
    } else {
        configured == selected
    }
}

#[cfg(windows)]
fn current_operating_system() -> skillhub_core::OperatingSystem {
    skillhub_core::OperatingSystem::Windows
}

#[cfg(target_os = "macos")]
fn current_operating_system() -> skillhub_core::OperatingSystem {
    skillhub_core::OperatingSystem::Macos
}

#[cfg(not(any(windows, target_os = "macos")))]
fn current_operating_system() -> skillhub_core::OperatingSystem {
    skillhub_core::OperatingSystem::Windows
}

#[cfg(windows)]
fn user_home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(not(windows))]
fn user_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn current_utc_date() -> (i32, u8, u8) {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 86_400;
    civil_date_from_days(days as i64)
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn description_hash(description: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in description.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a:{hash:016x}")
}

fn run_non_send<T, F, B>(build: B) -> AppResult<T>
where
    T: Send + 'static,
    F: Future<Output = AppResult<T>> + 'static,
    B: FnOnce() -> F + Send + 'static,
{
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("source", error.to_string())
                    .with_action(RecoveryAction::Retry)
            })?;
        runtime.block_on(build())
    })
    .join()
    .map_err(|_| internal("application.non_send_task"))?
}

fn failed_llm_run(
    id: String,
    skill_id: skillhub_core::SkillId,
    version_id: skillhub_core::VersionId,
    error: AppError,
) -> CheckRun {
    let mut run = CheckRun::running(id, skill_id, version_id, CheckKind::Llm);
    run.phase = CheckRunPhase::Failed;
    run.failure_code = Some(error.code.as_str().to_owned());
    run
}

// Howard Hinnant's civil_from_days algorithm, kept local to avoid adding a
// date dependency to the application boundary.
fn civil_date_from_days(days_since_epoch: i64) -> (i32, u8, u8) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let month_part = (5 * doy + 2) / 153;
    let day = doy - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    let year = year + i64::from(month <= 2);
    (year as i32, month as u8, day as u8)
}

#[allow(clippy::items_after_test_module)]
#[cfg(test)]
mod tests {
    use super::{civil_date_from_days, LocalApplicationFacade};
    use skillhub_core::api::{AppCommand, AppQuery};
    use skillhub_core::catalog::{CallPolicy, Skill};
    use skillhub_core::{
        ApplicationFacade, IgnoreSubject, OperationRecord, OperationRepository, RecoveryAction,
        SkillId,
    };
    use skillhub_storage::Database;

    #[test]
    fn converts_unix_epoch_to_utc_calendar_date() {
        assert_eq!(civil_date_from_days(0), (1970, 1, 1));
    }

    #[tokio::test]
    async fn facade_runs_health_and_lists_recovery_and_ignore_policy_state() {
        let database = Database::open_in_memory().unwrap();
        let skill_id = SkillId::new();
        database
            .catalog_repository()
            .unwrap()
            .insert_sync(&Skill::new(skill_id, "test"))
            .unwrap();
        let facade = LocalApplicationFacade::new(database);
        let health = facade
            .execute(AppCommand::RunHealthCheck(skillhub_core::RunHealthCheck))
            .await
            .unwrap();
        assert!(matches!(
            health,
            skillhub_core::AppCommandResult::HealthReport(_)
        ));

        let recovery = facade
            .query(AppQuery::ListRecoveryCandidates)
            .await
            .unwrap();
        assert!(matches!(
            recovery,
            skillhub_core::AppQueryResult::RecoveryCandidates(_)
        ));

        let policy = facade
            .query(AppQuery::GetCallPolicy(skillhub_core::GetCallPolicy {
                skill_id,
            }))
            .await
            .unwrap();
        assert!(matches!(
            policy,
            skillhub_core::AppQueryResult::CallPolicy(_)
        ));

        let ignored = facade
            .execute(AppCommand::CreateIgnoreRule(
                skillhub_core::CreateIgnoreRule {
                    subject: IgnoreSubject::exact_path("skills/test").unwrap(),
                    reason: "test".into(),
                    defer_until: None,
                },
            ))
            .await
            .unwrap();
        assert!(matches!(
            ignored,
            skillhub_core::AppCommandResult::IgnoreRule(_)
        ));
    }

    #[tokio::test]
    async fn facade_commits_and_restores_policy_and_rejects_repeated_or_unknown_writes() {
        let database = Database::open_in_memory().unwrap();
        let skill_id = SkillId::new();
        database
            .catalog_repository()
            .unwrap()
            .insert_sync(&Skill::new(skill_id, "test"))
            .unwrap();
        let facade = LocalApplicationFacade::new(database);

        let prepared = facade
            .execute(AppCommand::PrepareCallPolicyChange(
                skillhub_core::PrepareCallPolicyChange {
                    skill_id,
                    policy: CallPolicy::ManualOnly,
                },
            ))
            .await
            .unwrap();
        let plan = match prepared {
            skillhub_core::AppCommandResult::CallPolicyPlan(plan) => plan,
            other => panic!("unexpected result: {other:?}"),
        };
        facade
            .execute(AppCommand::CommitCallPolicyChange(
                skillhub_core::CommitCallPolicyChange { plan_id: plan.id },
            ))
            .await
            .unwrap();
        assert_eq!(
            facade
                .query(AppQuery::GetCallPolicy(skillhub_core::GetCallPolicy {
                    skill_id
                }))
                .await
                .unwrap(),
            skillhub_core::AppQueryResult::CallPolicy(skillhub_core::CallPolicyResult {
                skill_id,
                capability: skillhub_core::CallPolicyCapability::Editable,
                policy: CallPolicy::ManualOnly,
            })
        );
        let repeated = facade
            .execute(AppCommand::CommitCallPolicyChange(
                skillhub_core::CommitCallPolicyChange { plan_id: plan.id },
            ))
            .await
            .unwrap_err();
        assert_eq!(repeated.code, skillhub_core::ErrorCode::ObjectNotFound);
        facade
            .execute(AppCommand::RestoreOriginalCallPolicy(
                skillhub_core::RestoreOriginalCallPolicy { skill_id },
            ))
            .await
            .unwrap();
        let unknown_restore = facade
            .execute(AppCommand::RestoreOriginalCallPolicy(
                skillhub_core::RestoreOriginalCallPolicy { skill_id },
            ))
            .await
            .unwrap_err();
        assert_eq!(
            unknown_restore.code,
            skillhub_core::ErrorCode::ObjectNotFound
        );
    }

    #[tokio::test]
    async fn facade_repairs_unfinished_operation_and_requires_valid_ignore_removal() {
        let database = Database::open_in_memory().unwrap();
        let operation_id = skillhub_core::OperationId::new();
        database
            .operation_repository()
            .insert(&OperationRecord::planned(
                operation_id,
                "test",
                "fingerprint",
            ))
            .await
            .unwrap();
        let facade = LocalApplicationFacade::new(database);

        let candidates = facade
            .query(AppQuery::ListRecoveryCandidates)
            .await
            .unwrap();
        assert!(matches!(
            candidates,
            skillhub_core::AppQueryResult::RecoveryCandidates(ref values)
                if values.len() == 1 && values[0].operation_id == operation_id
        ));
        let report = match facade
            .execute(AppCommand::RunHealthCheck(skillhub_core::RunHealthCheck))
            .await
            .unwrap()
        {
            skillhub_core::AppCommandResult::HealthReport(report) => report,
            other => panic!("unexpected result: {other:?}"),
        };
        let repair = match facade
            .execute(AppCommand::PrepareRepair(skillhub_core::PrepareRepair {
                health_report_id: report.id,
                finding_index: 0,
            }))
            .await
            .unwrap()
        {
            skillhub_core::AppCommandResult::RepairPlan(plan) => plan,
            other => panic!("unexpected result: {other:?}"),
        };
        facade
            .execute(AppCommand::CommitRepair(skillhub_core::CommitRepair {
                repair_id: repair.id,
            }))
            .await
            .unwrap();
        assert!(matches!(
            facade.query(AppQuery::ListRecoveryCandidates).await.unwrap(),
            skillhub_core::AppQueryResult::RecoveryCandidates(ref values)
                if values.len() == 1 && values[0].operation_id == operation_id
        ));
        facade
            .execute(AppCommand::ResolveRecovery(
                skillhub_core::ResolveRecovery {
                    operation_id,
                    action: RecoveryAction::RollbackOperation,
                },
            ))
            .await
            .unwrap();
        assert!(matches!(
            facade.query(AppQuery::ListRecoveryCandidates).await.unwrap(),
            skillhub_core::AppQueryResult::RecoveryCandidates(values) if values.is_empty()
        ));

        let rule = match facade
            .execute(AppCommand::CreateIgnoreRule(
                skillhub_core::CreateIgnoreRule {
                    subject: IgnoreSubject::exact_path("skills/test").unwrap(),
                    reason: "test".into(),
                    defer_until: None,
                },
            ))
            .await
            .unwrap()
        {
            skillhub_core::AppCommandResult::IgnoreRule(rule) => rule,
            other => panic!("unexpected result: {other:?}"),
        };
        let duplicate = facade
            .execute(AppCommand::CreateIgnoreRule(
                skillhub_core::CreateIgnoreRule {
                    subject: IgnoreSubject::exact_path("skills/test").unwrap(),
                    reason: "duplicate".into(),
                    defer_until: None,
                },
            ))
            .await
            .unwrap_err();
        assert_eq!(duplicate.code, skillhub_core::ErrorCode::OperationConflict);
        facade
            .execute(AppCommand::RemoveIgnoreRule(
                skillhub_core::RemoveIgnoreRule { rule_id: rule.id },
            ))
            .await
            .unwrap();
        let missing = facade
            .execute(AppCommand::RemoveIgnoreRule(
                skillhub_core::RemoveIgnoreRule {
                    rule_id: "missing".into(),
                },
            ))
            .await
            .unwrap_err();
        assert_eq!(missing.code, skillhub_core::ErrorCode::ObjectNotFound);

        let invalid_recovery = facade
            .execute(AppCommand::ResolveRecovery(
                skillhub_core::ResolveRecovery {
                    operation_id,
                    action: RecoveryAction::Acknowledge,
                },
            ))
            .await
            .unwrap_err();
        assert_eq!(
            invalid_recovery.code,
            skillhub_core::ErrorCode::ObjectNotFound
        );
    }
}

fn database_error(operation: &'static str, source: String) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("operation", operation)
        .with_param("source", source)
        .with_action(RecoveryAction::Retry)
}

#[async_trait]
impl HealthBackend for LocalHealthBackend {
    async fn check(&self) -> AppResult<Vec<HealthFinding>> {
        let database = self.database.lock().map_err(|_| internal("health.check"))?;
        let mut statement = database
            .connection_for_test()
            .prepare(
                "SELECT operation_id FROM operations WHERE phase IN ('planned','prepared','applying','verifying') ORDER BY operation_id",
            )
            .map_err(|error| database_error("health.check", error.to_string()))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| database_error("health.check", error.to_string()))?;
        let mut findings = Vec::new();
        for row in rows {
            row.map_err(|error| database_error("health.check", error.to_string()))?;
            findings.push(HealthFinding {
                code: "health.unfinished_operation".to_owned(),
                severity: Severity::Warning,
                repair: RepairAction::MarkOperationNeedsRecovery,
            });
        }
        Ok(findings)
    }

    async fn repair(&self, finding: &HealthFinding) -> AppResult<()> {
        if finding.repair != RepairAction::MarkOperationNeedsRecovery {
            return Err(unsupported("health.repair"));
        }
        let database = self
            .database
            .lock()
            .map_err(|_| internal("health.repair"))?;
        database
            .connection_for_test()
            .execute(
                "UPDATE operations SET phase='needs_recovery', state='needs_recovery' WHERE phase IN ('planned','prepared','applying','verifying')",
                [],
            )
            .map_err(|error| database_error("health.repair", error.to_string()))?;
        Ok(())
    }
}

#[async_trait]
impl RecoveryBackend for LocalRecoveryBackend {
    async fn list_candidates(&self) -> AppResult<Vec<RecoveryCandidate>> {
        let database = self
            .database
            .lock()
            .map_err(|_| internal("recovery.list"))?;
        let mut statement = database
            .connection_for_test()
            .prepare(
                "SELECT operation_id FROM operations WHERE phase IN ('planned','prepared','applying','verifying','needs_recovery') ORDER BY operation_id",
            )
            .map_err(|error| database_error("recovery.list", error.to_string()))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| database_error("recovery.list", error.to_string()))?;
        let mut candidates = Vec::new();
        for row in rows {
            let id = row
                .map_err(|error| database_error("recovery.list", error.to_string()))?
                .parse()
                .map_err(|_| database_error("recovery.list", "invalid operation id".to_owned()))?;
            candidates.push(RecoveryCandidate {
                operation_id: id,
                actions: vec![
                    RecoveryAction::CompleteOperation,
                    RecoveryAction::RollbackOperation,
                ],
            });
        }
        Ok(candidates)
    }

    async fn resolve(&self, operation_id: OperationId, action: RecoveryAction) -> AppResult<()> {
        let phase = match action {
            RecoveryAction::CompleteOperation => ("committed", "completed"),
            RecoveryAction::RollbackOperation => ("rolled_back", "rolled_back"),
            _ => return Err(unsupported("recovery.resolve")),
        };
        let database = self
            .database
            .lock()
            .map_err(|_| internal("recovery.resolve"))?;
        let operation_id = operation_id.to_string();
        let changed = database
            .connection_for_test()
            .execute(
                &format!(
                    "UPDATE operations SET phase='{}', state='{}' WHERE operation_id='{}' AND phase IN ('planned','prepared','applying','verifying','needs_recovery')",
                    phase.0, phase.1, operation_id
                ),
                [],
            )
            .map_err(|error| database_error("recovery.resolve", error.to_string()))?;
        if changed == 0 {
            return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("field", "recovery_candidate")
                .with_action(RecoveryAction::Retry));
        }
        Ok(())
    }
}

#[async_trait]
impl CallPolicyBackend for LocalCallPolicyBackend {
    async fn inspect(
        &self,
        skill_id: skillhub_core::SkillId,
    ) -> AppResult<(CallPolicyCapability, CallPolicy)> {
        let database = self
            .database
            .lock()
            .map_err(|_| internal("call_policy.inspect"))?;
        let skill = database
            .catalog_repository()?
            .get_sync(skill_id)?
            .ok_or_else(|| {
                AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("field", "skill")
                    .with_action(RecoveryAction::Retry)
            })?;
        Ok((CallPolicyCapability::Editable, skill.call_policy()))
    }

    async fn apply(&self, skill_id: skillhub_core::SkillId, policy: CallPolicy) -> AppResult<()> {
        let database = self
            .database
            .lock()
            .map_err(|_| internal("call_policy.apply"))?;
        let repository = database.catalog_repository()?;
        let skill = repository.get_sync(skill_id)?.ok_or_else(|| {
            AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("field", "skill")
                .with_action(RecoveryAction::Retry)
        })?;
        self.originals
            .lock()
            .map_err(|_| internal("call_policy.apply.original"))?
            .entry(skill_id)
            .or_insert_with(|| skill.call_policy());
        let updated = Skill::from_parts(
            skill.id(),
            skill.display_name().to_owned(),
            skill.runtime_name().to_owned(),
            skill.original_description().to_owned(),
            skill.translated_description().map(str::to_owned),
            skill.note().map(str::to_owned),
            skill.tags().clone(),
            skill.author().map(str::to_owned),
            skill.license().map(str::to_owned),
            policy,
            skill.lifecycle(),
            skill.requirements().to_vec(),
            skill.trial_due(),
        )?;
        repository.insert_sync(&updated)
    }

    async fn restore_original(&self, skill_id: skillhub_core::SkillId) -> AppResult<()> {
        let original = self
            .originals
            .lock()
            .map_err(|_| internal("call_policy.restore"))?
            .remove(&skill_id)
            .ok_or_else(|| {
                AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("field", "original_call_policy")
                    .with_action(RecoveryAction::Retry)
            })?;
        let database = self
            .database
            .lock()
            .map_err(|_| internal("call_policy.restore"))?;
        let repository = database.catalog_repository()?;
        let skill = repository.get_sync(skill_id)?.ok_or_else(|| {
            AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("field", "skill")
                .with_action(RecoveryAction::Retry)
        })?;
        let updated = Skill::from_parts(
            skill.id(),
            skill.display_name().to_owned(),
            skill.runtime_name().to_owned(),
            skill.original_description().to_owned(),
            skill.translated_description().map(str::to_owned),
            skill.note().map(str::to_owned),
            skill.tags().clone(),
            skill.author().map(str::to_owned),
            skill.license().map(str::to_owned),
            original,
            skill.lifecycle(),
            skill.requirements().to_vec(),
            skill.trial_due(),
        )?;
        repository.insert_sync(&updated)
    }
}

#[async_trait]
impl IgnoreBackend for LocalIgnoreBackend {
    async fn create(&self, mut rule: IgnoreRule) -> AppResult<IgnoreRule> {
        rule.created_at = now_millis().to_string();
        let mut rules = self.rules.lock().map_err(|_| internal("ignore.create"))?;
        if rules
            .iter()
            .any(|existing| existing.subject == rule.subject)
        {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "ignore_rule_exists")
                .with_action(RecoveryAction::Acknowledge));
        }
        rules.push(rule.clone());
        Ok(rule)
    }

    async fn remove(&self, id: String) -> AppResult<()> {
        let mut rules = self.rules.lock().map_err(|_| internal("ignore.remove"))?;
        let Some(index) = rules.iter().position(|rule| rule.id == id) else {
            return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("field", "ignore_rule")
                .with_action(RecoveryAction::Retry));
        };
        rules.remove(index);
        Ok(())
    }

    async fn list(&self) -> AppResult<Vec<IgnoreRule>> {
        Ok(self
            .rules
            .lock()
            .map_err(|_| internal("ignore.list"))?
            .clone())
    }
}

struct LocalHealthBackend {
    database: Arc<Mutex<Database>>,
}

struct LocalRecoveryBackend {
    database: Arc<Mutex<Database>>,
}

struct LocalCallPolicyBackend {
    database: Arc<Mutex<Database>>,
    originals: Arc<Mutex<HashMap<skillhub_core::SkillId, CallPolicy>>>,
}

struct LocalIgnoreBackend {
    rules: Arc<Mutex<Vec<IgnoreRule>>>,
}
