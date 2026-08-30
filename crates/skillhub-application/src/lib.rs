//! Shared application boundary implementations.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use skillhub_adapters::deployment::{DeploymentFilesystem, OwnershipProof};
use skillhub_adapters::import::SkillDetector;
use skillhub_adapters::security::BasicScanner;
use skillhub_core::api::{
    BasicCheckResult, RenameSkill, SaveMarkdownContent, SaveSkillContent, SavedSkillContent,
    SetCurrentVersion, SetFindingDisposition, SetLifecycle, SetMetadata, SetTrial,
};
use skillhub_core::application::{
    DeploymentBackend, DeploymentService, PreparedImport, ReconcileBackend, ReconcileService,
    RemovalBackend, RemovalService,
};
use skillhub_core::backup::{BackupCreated, BackupInput, BackupPackage, BackupScope};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::check::{CheckKind, CheckRun, CheckRunPhase, FindingDisposition};
use skillhub_core::deployment::{
    DeploymentPlanRequest, DeploymentRecord, DeploymentState, RegisteredTargetIndex, TargetFact,
    TargetPlan,
};
use skillhub_core::llm::LlmTaskRunner;
use skillhub_core::{
    physical_id_for_path, AllowedRoot, AppCommand, AppCommandResult, AppError, AppQuery,
    AppQueryResult, AppResult, ApplicationFacade, DeploymentCapability, ErrorCode, OperationId,
    PathPolicy, RecoveryAction, Severity,
};
use skillhub_storage::backup::{BackupService, RestoreService, RetentionService};
use skillhub_storage::{CentralLibrary, Database, LibraryPaths, VersionStore};

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
    llm_runner: Option<Arc<dyn LlmTaskRunner>>,
    prepared_imports: Mutex<HashMap<OperationId, PreparedImport>>,
}

struct LocalDeploymentBackend {
    database: Arc<Mutex<Database>>,
    library_root: Option<PathBuf>,
    filesystem: DeploymentFilesystem,
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
        Self {
            database,
            today,
            library: None,
            library_root: None,
            deployment_targets: None,
            deployment_service,
            removal_service,
            reconcile_service,
            llm_runner: None,
            prepared_imports: Mutex::new(HashMap::new()),
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
        Self {
            database,
            today: current_utc_date(),
            library: Some(VersionStore::new(LibraryPaths::from_root(&library_root))),
            library_root: Some(library_root),
            deployment_targets: None,
            deployment_service,
            removal_service,
            reconcile_service,
            llm_runner: None,
            prepared_imports: Mutex::new(HashMap::new()),
        }
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
        let response = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| {
                    AppError::new(ErrorCode::InternalError, Severity::Error)
                        .with_param("source", error.to_string())
                        .with_action(RecoveryAction::Retry)
                })?;
            runtime.block_on(runner.run(&profile, request))
        })
        .join()
        .map_err(|_| internal("execute.run_llm_safety_check.runner"))?;
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
            AppCommand::CancelOperation { .. } => "execute.cancel_operation",
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
            AppCommand::SetFindingDisposition(request) => {
                return self.set_finding_disposition(request);
            }
            AppCommand::RenameSkill(request) => return self.rename_skill(request),
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
            _ => "execute.unsupported",
        };
        Err(AppError::new(ErrorCode::InternalError, Severity::Error)
            .with_param("operation", operation)
            .with_action(RecoveryAction::Retry))
    }

    async fn query(&self, query: AppQuery) -> AppResult<AppQueryResult> {
        match query {
            AppQuery::GetBootstrapSnapshot => {
                self.with_database("query.get_bootstrap_snapshot", |database| {
                    database
                        .bootstrap_repository()
                        .build_snapshot(self.today)
                        .map(AppQueryResult::BootstrapSnapshot)
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
                SkillDetector::default()
                    .detect(root, source)
                    .map(AppQueryResult::ImportCandidates)
            }
            AppQuery::ListSkills(request) => self.with_database("query.list_skills", |database| {
                database
                    .catalog_repository()?
                    .list_page(&request)
                    .map(AppQueryResult::SkillPage)
            }),
            AppQuery::ListVersions(request) => self.list_versions(request.skill_id),
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
            _ => Err(AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("operation", "query.unsupported")
                .with_action(RecoveryAction::Retry)),
        }
    }
}

impl LocalApplicationFacade {
    fn list_deployment_targets(&self) -> AppResult<AppQueryResult> {
        self.with_database("query.list_deployment_targets", |database| {
            let targets = database
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
                            // Discovery only records target facts; until a
                            // profile explicitly confirms link support, use
                            // managed copy as the safe advertised mode.
                            modes: vec![skillhub_core::DeploymentMode::ManagedCopy],
                        })
                        .collect()
                })
                .unwrap_or_default();
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
        self.with_database("query.get_deployment_plan", |database| {
            let Some(snapshot) = database.agent_repository().load()? else {
                return RegisteredTargetIndex::from_facts([], PathPolicy::new());
            };
            let mut facts = Vec::new();
            let mut roots = Vec::new();
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
                    DeploymentCapability::new(false, false, true),
                ));
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

#[cfg(test)]
mod tests {
    use super::civil_date_from_days;

    #[test]
    fn converts_unix_epoch_to_utc_calendar_date() {
        assert_eq!(civil_date_from_days(0), (1970, 1, 1));
    }
}
