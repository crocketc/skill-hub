//! Shared application boundary implementations.

mod external_link;
pub mod library_runtime;
mod relationship_governance_batch;
mod relationship_governance_service;
pub mod relationship_validation_service;
pub mod relationship_watch_confirmation;
mod update_service;

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
pub use external_link::{ExternalLinkService, ExternalUrlOpener, SystemExternalUrlOpener};
use skillhub_adapters::agent::discovery::{DiscoverAgents, DiscoveryRoots};
use skillhub_adapters::app_update::github_releases::GithubReleaseProvider;
use skillhub_adapters::credentials::{OsCredentialStore, SessionCredentialStore};
use skillhub_adapters::deployment::{AppliedTarget, DeploymentFilesystem, OwnershipProof};
use skillhub_adapters::import::SkillDetector;
use skillhub_adapters::llm::HttpLlmTaskRunner;
use skillhub_adapters::scanner::ScanService;
use skillhub_adapters::security::BasicScanner;
use skillhub_adapters::source::{
    cleanup_stale_downloads, stale_download_retention, AcquiredSource, AcquisitionLimits,
    ArchiveExtractor, GixSourceFetcher, HttpsSourceFetcher, RepoDiscoveryProvider,
    SkillsShProvider,
};
use skillhub_core::api::{
    ApplySourceUpdate, BasicCheckResult, BatchTranslationItemFailure, BatchTranslationOutcome,
    CheckSourceUpdate, CheckSourceUpdates, ClearLlmProviderCredential, CreateCombination,
    CreateSkill, DeleteCombination, DeleteLlmProvider, FetchLlmModels, FetchLlmProvider,
    PinProjectSkillVersion, RelinkSource, RenameCombination, RenameSkill, SaveLlmProvider,
    SaveMarkdownAsCopy, SaveMarkdownContent, SaveSkillContent, SavedSkillContent,
    SetCurrentVersion, SetDefaultLlmProvider, SetFindingDisposition, SetLifecycle,
    SetLlmProviderEnabled, SetMetadata, SetTrial, SourceUpdateCheckOutcome, TestLlmConnection,
    TranslateDescriptionsBatch, UpdateCombination,
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
    observed_path_key, path_lives_under, plan_target_preview, reconcile_observed_row,
    DeploymentPlan, DeploymentPlanInput, DeploymentPlanRequest, DeploymentPlanner,
    DeploymentRecord, DeploymentState, ExistingDeployment, ExistingOwnership,
    RegisteredTargetIndex, RegisteredTargetResolver, TargetFact, TargetPlan, VerifiedTarget,
};
use skillhub_core::duplicate::{
    build_conflict_analysis_input, conflict_case_matches_scope, parse_conflict_analysis_response,
    AnalyzeConflictScope, ConflictAnalysisRecord, ConflictCaseAnalysis, DuplicateCandidate,
};
use skillhub_core::evidence::UsageEvidenceAnalyzer;
use skillhub_core::health::{HealthFinding, RecoveryCandidate, RepairAction};
use skillhub_core::ignore::IgnoreRule;
use skillhub_core::import::{original_migration_backup_key, resolve_original_migration_recovery};
use skillhub_core::llm::translation::TranslationRecord;
use skillhub_core::llm::{
    ConnectionTestResult, CredentialRef, CredentialStore, LastConnectionTestView, LlmAdmin,
    LlmConnectionIdentity, LlmProfile, LlmProviderConfig, LlmProviderView, LlmTaskKind,
    LlmTaskRunner, NetworkGate, TranslationResult, TranslationView,
};
use skillhub_core::relationship::{DirectoryRole, SourceCopyRelationFact};
use skillhub_core::source::{
    RepoDiscoveryReport, RepoDiscoveryWarning, RepoScanState, SkillRepo, SourceDescriptor,
    SourceLocator, SourceState, UpdateDecision,
};
use skillhub_core::{ensure_original_deletion_authorized, plan_original_migration};
use skillhub_core::{
    physical_id_for_path, symlink_physical_id_for_path, AllowedRoot, AppCommand, AppCommandResult,
    AppError, AppQuery, AppQueryResult, AppResult, ApplicationFacade, DeploymentMode, ErrorCode,
    OperationId, PathPolicy, RecoveryAction, ResolvedPathGrant, Severity, TargetChange,
    UpdateSignaturePublicKey,
};
use skillhub_storage::backup::{BackupService, RestoreService, RetentionService};
use skillhub_storage::export::ExportService;
use skillhub_storage::{
    CentralLibrary, Database, GovernanceHistoryEvent, LibraryPaths, PersistedConnectionTest,
    PersistedTranslation, UsageEvidenceRepository, VersionStore,
};
pub use update_service::{
    ApplicationUpdateInstaller, RollbackResult, RollbackState, UpdateDownloadPlan, UpdateService,
};

/// 计划 8.5：原始目录删除抽象。生产直接走文件系统；测试注入失败假象
/// （权限墙/占用等无法跨平台稳定模拟的场景）。
pub trait OriginalMigrationDeletion: Send + Sync {
    fn delete_dir_all(&self, path: &Path) -> std::io::Result<()>;
}

/// 生产实现：直接删除目录树。
#[derive(Clone, Copy, Debug)]
pub struct FilesystemDeletion;

impl OriginalMigrationDeletion for FilesystemDeletion {
    fn delete_dir_all(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_dir_all(path)
    }
}

pub(crate) fn default_original_migration_deletion() -> std::sync::Arc<dyn OriginalMigrationDeletion>
{
    std::sync::Arc::new(FilesystemDeletion)
}

/// The date provider is kept on the facade so all date-sensitive projections
/// in one request use the same day boundary. Production uses the current UTC
/// date; tests can inject a fixed value with [`LocalApplicationFacade::new_with_today`].
pub struct LocalApplicationFacade {
    database: Arc<Mutex<Database>>,
    today: (i32, u8, u8),
    library_runtime: Arc<library_runtime::LibraryRuntime>,
    suggested_library_root: Option<PathBuf>,
    deployment_targets: Option<RegisteredTargetIndex>,
    backend: Arc<LocalDeploymentBackend>,
    deployment_service: Arc<DeploymentService<LocalDeploymentBackend>>,
    removal_service: Arc<RemovalService<LocalDeploymentBackend>>,
    reconcile_service: Arc<ReconcileService<LocalDeploymentBackend>>,
    health_service: Arc<HealthService<LocalHealthBackend>>,
    recovery_service: Arc<RecoveryService<LocalRecoveryBackend>>,
    call_policy_service: Arc<CallPolicyService<LocalCallPolicyBackend>>,
    ignore_service: Arc<IgnoreService<LocalIgnoreBackend>>,
    llm_runner: Option<Arc<dyn LlmTaskRunner>>,
    llm_credentials: Arc<dyn CredentialStore>,
    llm_admin: Option<Arc<dyn LlmAdmin>>,
    network_gate: NetworkGate,
    evidence_repository: UsageEvidenceRepository,
    app_update_provider: Arc<GithubReleaseProvider>,
    update_service: Arc<UpdateService>,
    source_search_provider: Arc<SkillsShProvider>,
    repo_discovery_provider: RwLock<Arc<RepoDiscoveryProvider>>,
    prepared_imports: Mutex<HashMap<OperationId, PreparedImport>>,
    /// OPT-20260914-08：已准备的原始文件迁移计划。准备只读；提交必须
    /// 携带用户明确确认，且任何失败都保留现场。
    prepared_migrations: Mutex<HashMap<OperationId, skillhub_core::OriginalMigrationPlan>>,
    prepared_relation_migrations:
        Mutex<HashMap<OperationId, skillhub_core::PreparedRelationMigration>>,
    relation_migration_results: Mutex<HashMap<OperationId, skillhub_core::RelationMigrationResult>>,
    /// Serializes relationship mutations and the source-fact snapshot through
    /// the filesystem phase of a relation migration.  This closes the
    /// in-process source_relations TOCTOU window.
    relation_migration_lock: Mutex<()>,
    prepared_uninstall: Mutex<Option<skillhub_core::UninstallImpact>>,
    scan_service: Mutex<ScanService>,
    path_grants: Mutex<HashMap<String, ResolvedPathGrant>>,
    assembly_plans: Mutex<HashMap<OperationId, skillhub_core::AssemblyPlan>>,
    external_link_service: ExternalLinkService,
    llm_runs: Mutex<HashMap<(String, String), RunningLlmCheck>>,
    upstream_origins: Mutex<HashMap<String, skillhub_core::UpstreamOrigin>>,
    /// Keeps remote acquisition workspaces alive from discovery through import
    /// preparation/commit. Candidate paths are valid while the facade owns it.
    acquired_import_sources: Mutex<HashMap<String, AcquiredImportSource>>,
    /// 发现时固化的权威来源分类，按 observed_path_key 索引；提交阶段按
    /// 同一 key 取回，不按路径拼写或显示名反推类别与物理身份。
    import_source_classifications: Mutex<HashMap<String, ClassifiedImportSource>>,
    /// 关系路径探测实现；生产走真实文件系统，测试可注入受控假象。
    relationship_probe:
        Mutex<std::sync::Arc<dyn relationship_validation_service::RelationshipPathProbing>>,
    /// 计划 8.5：原始目录删除实现；生产走文件系统，测试可注入失败。
    original_migration_deletion: Mutex<std::sync::Arc<dyn OriginalMigrationDeletion>>,
}

/// 获取阶段落地的完整来源记录：原始 descriptor、临时工作区、权威类别与
/// 工作区形态一体保存，不再只保存临时目录。
pub struct AcquiredImportSource {
    pub source: SourceDescriptor,
    pub workspace: AcquiredSource,
    pub source_class: skillhub_core::ImportSourceClass,
    pub workspace_kind: skillhub_core::AcquisitionWorkspaceKind,
}

/// 发现时固化的权威分类结果。`physical_source_id` 为 None 表示身份缺失
/// 或来源不可治理（Online/CentralLibrary），后续治理必须 fail-closed。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClassifiedImportSource {
    pub source_class: skillhub_core::ImportSourceClass,
    pub physical_source_id: Option<String>,
    pub source_container_id: Option<String>,
    pub agent_client_id: Option<String>,
}

/// 一次成功导入在持久层的落点摘要。事件/关系/批次项的具体 ID 以不可变
/// 事件与批次项行为准，后续治理面通过历史查询读取，不在调用方回传。
/// `source_relation_id` 随摘要项逐项返回（计划 9.7），供导入完成页
/// 直连“这次导入”的治理上下文。
struct RecordedImportOutcome {
    provenance: Option<skillhub_core::ImportProvenance>,
    source_relation_id: Option<String>,
}

/// 一次导入提交在批次中的定位：批次 ID 与候选键一起唯一定位一个批次项。
struct ImportBatchSlot {
    batch_id: String,
    candidate_key: String,
}

/// One in-flight LLM check: its externally visible operation id plus the flag
/// `cancel_operation` sets to abandon it.
struct RunningLlmCheck {
    operation_id: skillhub_core::OperationId,
    cancelled: Arc<AtomicBool>,
}

struct LocalDeploymentBackend {
    database: Arc<Mutex<Database>>,
    library_runtime: Arc<library_runtime::LibraryRuntime>,
    filesystem: DeploymentFilesystem,
    /// Target index injected in place of production discovery (tests and
    /// embedding callers).  Revalidation must re-check against exactly the
    /// facts the preview resolved, never against whatever the probing host
    /// discovers.
    injected_targets: Arc<Mutex<Option<RegisteredTargetIndex>>>,
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

/// Storage-backed translation repository. Rows persist across restarts and
/// record the skill's current version so provenance says what was translated.
#[derive(Clone)]
struct StorageTranslationRepository {
    database: Arc<Mutex<Database>>,
}

#[async_trait(?Send)]
impl TranslationRepository for StorageTranslationRepository {
    async fn get(
        &self,
        skill_id: skillhub_core::SkillId,
        language: &str,
    ) -> AppResult<Option<TranslationRecord>> {
        let database = self
            .database
            .lock()
            .map_err(|_| internal("translation.get"))?;
        Ok(database
            .translation_record_repository()
            .get(&skill_id, language)?
            .map(|row| row.record))
    }

    async fn save(&self, record: TranslationRecord) -> AppResult<()> {
        let database = self
            .database
            .lock()
            .map_err(|_| internal("translation.save"))?;
        let version_id = database
            .catalog_repository()?
            .get_detail(record.skill_id)?
            .and_then(|detail| detail.current_version)
            .map(|version| version.to_string());
        let now = now_epoch_seconds();
        database
            .translation_record_repository()
            .save(&PersistedTranslation {
                record,
                version_id,
                created_at: now,
                updated_at: now,
            })
    }
}

/// 把仓库配置列表与持久化扫描状态合成为逐仓视图（键 "owner/name"）。
fn skill_repo_views(
    repos: Vec<SkillRepo>,
    scans: &std::collections::BTreeMap<String, RepoScanState>,
) -> Vec<skillhub_core::source::SkillRepoView> {
    repos
        .into_iter()
        .map(|repo| {
            let scan = scans.get(&format!("{}/{}", repo.owner, repo.name)).cloned();
            skillhub_core::source::SkillRepoView { repo, scan }
        })
        .collect()
}

/// 把 provider 的 (owner, name, reason) 失败元组映射为告警类型。
fn warnings_from_failures(failures: Vec<(String, String, String)>) -> Vec<RepoDiscoveryWarning> {
    failures
        .into_iter()
        .map(|(owner, name, reason)| RepoDiscoveryWarning {
            owner,
            name,
            reason,
        })
        .collect()
}

fn now_epoch_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// 当前 UTC 时刻的秒精度 RFC3339 字符串（`YYYY-MM-DDTHH:MM:SSZ`）。
/// 仓库扫描状态等缓存性质记录的落盘时间戳；前端经 `Intl` 解析展示。
fn now_rfc3339_utc() -> String {
    format_rfc3339_utc(now_epoch_seconds())
}

/// epoch 秒 → RFC3339 UTC 字符串；日历换算复用既有 [`civil_date_from_days`]，
/// 不为应用边界引入时间库依赖。
fn format_rfc3339_utc(epoch_seconds: i64) -> String {
    let days = epoch_seconds.div_euclid(86_400);
    let seconds_of_day = epoch_seconds.rem_euclid(86_400);
    let (year, month, day) = civil_date_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z",
        hour = seconds_of_day / 3_600,
        minute = (seconds_of_day % 3_600) / 60,
        second = seconds_of_day % 60,
    )
}

/// D3：把持久化的最近一次连接测试摘要映射为视图字段。只有 provider id 存在
/// 记录、且配置身份指纹（身份字段 + 凭据在场）与当前配置一致时才返回
/// `Some`；改过 endpoint/model/协议/兼容档或清除了凭据，旧结果自动失效。
fn fresh_connection_test(
    tests: &std::collections::BTreeMap<String, PersistedConnectionTest>,
    config: &LlmProviderConfig,
    credential_configured: bool,
) -> Option<LastConnectionTestView> {
    let identity = LlmConnectionIdentity::from_provider_config(config, credential_configured);
    let entry = tests.get(&config.id)?;
    if entry.fingerprint != identity.fingerprint() {
        return None;
    }
    Some(LastConnectionTestView {
        service_ok: entry.service_ok,
        model_ok: entry.model_ok,
        structured_ok: entry.structured_ok,
        tested_at: entry.tested_at.clone(),
    })
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
    fn new(
        database: Arc<Mutex<Database>>,
        library_runtime: Arc<library_runtime::LibraryRuntime>,
    ) -> Self {
        Self {
            database,
            library_runtime,
            filesystem: DeploymentFilesystem::new(),
            injected_targets: Arc::new(Mutex::new(None)),
        }
    }

    /// Revalidation index: the injected facts when present, else the
    /// database-registered discovery facts.
    fn revalidation_index(&self) -> AppResult<RegisteredTargetIndex> {
        if let Some(index) = self
            .injected_targets
            .lock()
            .map_err(|_| internal("deployment.revalidate"))?
            .clone()
        {
            return Ok(index);
        }
        let host_capabilities = self.filesystem.available_capabilities();
        let database = self
            .database
            .lock()
            .map_err(|_| internal("deployment.revalidate"))?;
        registered_target_index(&database, &host_capabilities)
    }

    fn materialized_source(&self, target: &TargetPlan) -> AppResult<PathBuf> {
        let source = PathBuf::from(&target.source_path);
        if source.is_dir() {
            return Ok(source);
        }
        let library = self.library_runtime.snapshot()?;
        let paths = LibraryPaths::from_root(library.root.clone());
        if matches!(
            target.mode,
            DeploymentMode::SymbolicLink | DeploymentMode::DirectoryJunction
        ) {
            if let Some((record, current)) = library.central.load_portable_skill(target.skill_id)? {
                if current.as_ref() == Some(&target.version_id) {
                    let visible = library
                        .central
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
            .join(skillhub_core::deployment::deployment_tree_dir_name(
                &target.version_id,
            ));
        if !materialized.is_dir() {
            std::fs::create_dir_all(&materialized).map_err(|error| {
                AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("io_kind", format!("{:?}", error.kind()))
                    .with_action(RecoveryAction::Retry)
            })?;
            library
                .store
                .materialize(&target.version_id, &materialized)?;
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
        // Symbolic-link deployments pin the proof to the link itself, so the
        // reconstruction must use the same identity the adapters captured at
        // apply time (the central source may have been replaced meanwhile).
        let identity_for_mode = |path: &std::path::Path| {
            if deployment.mode == DeploymentMode::SymbolicLink {
                symlink_physical_id_for_path(path)
            } else {
                physical_id_for_path(path)
            }
        };
        let target_identity = identity_for_mode(&destination_path).ok_or_else(|| {
            AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("detail", "deployment target identity is unavailable")
                .with_action(RecoveryAction::InspectTarget)
        })?;
        let library = self.library_runtime.snapshot()?;
        let source_path = library
            .root
            .join("versions")
            .join(deployment.skill_id.to_string())
            .join(deployment.version_id.as_str());
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

    /// Registers (or refreshes) the physical `targets` row for a committed
    /// deployment.  `deployments.target_id` carries a hard foreign key to
    /// `targets(id)`, and removal plus ownership proofs read the registered
    /// path back from that row, so accounting and disk state must land
    /// together.
    fn ensure_targets_row(database: &Database, target: &TargetPlan) -> AppResult<()> {
        let (agent_id, scope, project_id) = Self::target_registration(database, target)?;
        database.target_repository().upsert_physical_target(
            &skillhub_storage::PhysicalTargetRegistration {
                id: &target.physical_target_id,
                agent_id: &agent_id,
                project_id: project_id.as_deref(),
                scope,
                path: &target.target_path,
            },
        )
    }

    /// Resolves who owns the target for the legacy `targets` columns:
    /// discovery targets carry their agent client, project targets carry the
    /// project, and anything else is recorded as a SkillHub registration.
    fn target_registration(
        database: &Database,
        target: &TargetPlan,
    ) -> AppResult<(String, &'static str, Option<String>)> {
        if let Some(snapshot) = database.agent_repository().load()? {
            for logical_id in &target.logical_target_ids {
                if let Some(logical) = snapshot
                    .logical_targets
                    .iter()
                    .find(|candidate| &candidate.id == logical_id)
                {
                    let scope = match logical.scope {
                        skillhub_core::agent::TargetScope::Project => "project",
                        skillhub_core::agent::TargetScope::Global
                        | skillhub_core::agent::TargetScope::Extra => "global",
                    };
                    return Ok((logical.client_id.clone(), scope, None));
                }
            }
        }
        for project in database.project_repository().list()? {
            if target
                .logical_target_ids
                .iter()
                .any(|id| *id == project.id.to_string())
            {
                return Ok((
                    "skillhub".to_owned(),
                    "project",
                    Some(project.id.to_string()),
                ));
            }
        }
        Ok(("skillhub".to_owned(), "global", None))
    }
}

#[async_trait]
impl DeploymentBackend for LocalDeploymentBackend {
    /// Task 13B: a prepared plan is only a claim about registered reality.
    /// Before anything is applied, the claim is re-derived from the current
    /// registered targets, occupancy, capabilities and source version; any
    /// drift refuses the stale plan instead of being applied blindly.
    async fn revalidate(&self, plan: &DeploymentPlan) -> AppResult<DeploymentPlan> {
        let index = self.revalidation_index()?;
        let library = self.library_runtime.snapshot()?;
        // The planned source version must still exist and still declare the
        // runtime name agents will see.
        let content = match library
            .store
            .read_file(&plan.version_id, "SKILL.md", 256 * 1024)
        {
            Ok((_, bytes)) => bytes,
            Err(error) if error.code == ErrorCode::ObjectNotFound => {
                return Err(target_changed_error("the planned source version is gone"))
            }
            Err(error) => return Err(error),
        };
        if let Some(declared) = read_frontmatter_name(&String::from_utf8_lossy(&content)) {
            if declared != plan.runtime_name {
                return Err(target_changed_error(
                    "the version's declared name no longer matches the plan",
                ));
            }
        }
        for target in &plan.targets {
            let mut candidates = index.resolve(&target.logical_target_ids).map_err(|_| {
                target_changed_error("a registered target of the plan is no longer available")
            })?;
            if candidates.iter().any(|candidate| {
                candidate.physical_target_id() != target.physical_target_id
                    || candidate.path() != target.target_path
            }) {
                return Err(target_changed_error(
                    "the registered target identity or path changed",
                ));
            }
            if !target.mode.is_supported_by(candidates[0].capabilities()) {
                return Err(target_changed_error(
                    "the target no longer supports the planned mode",
                ));
            }
            {
                let database = self
                    .database
                    .lock()
                    .map_err(|_| internal("deployment.revalidate"))?;
                attach_target_occupancy_with(&database, &plan.runtime_name, &mut candidates)?;
            }
            let input = DeploymentPlanInput {
                skill_id: plan.skill_id,
                version_id: plan.version_id.clone(),
                runtime_name: plan.runtime_name.clone(),
                source_path: target.source_path.clone(),
                targets: candidates,
                mode_override: Some(target.mode),
                security_gate: skillhub_core::deployment::DeploymentSecurityGate::default(),
            };
            let fresh = DeploymentPlanner.plan(input)?;
            let fresh_target = fresh
                .targets
                .first()
                .ok_or_else(|| target_changed_error("the target no longer plans to an entry"))?;
            if fresh_target.destination_path != target.destination_path
                || fresh_target.change != target.change
                || fresh_target.conflicts != target.conflicts
            {
                return Err(target_changed_error(
                    "destination facts changed since the plan was made",
                ));
            }
        }
        Ok(plan.clone())
    }

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
            expected_hash: applied.ownership.expected_hash.clone(),
            observed_hash: Some(applied.observed_tree_hash.clone()),
        };
        match self.persist_target(target, &record) {
            Ok(id) => Ok(DeploymentRecord { id, ..record }),
            // Undo the write when the accounting row cannot be created: a tree
            // with no row is invisible to every query and to the reconciler
            // (which needs a known deployment id), so it would sit in the
            // user's Agent directory with no way to find or clean it up.
            Err(error) => Err(self.roll_back_applied(&applied, error)),
        }
    }
}

impl LocalDeploymentBackend {
    /// Writes the accounting row for a target that is already on disk, and
    /// returns the id the row actually carries.  `insert_sync` reuses the row
    /// that already owns this `(target, runtime_name)` position, so the
    /// returned id can differ from the freshly generated one.
    fn persist_target(
        &self,
        target: &TargetPlan,
        record: &DeploymentRecord,
    ) -> AppResult<skillhub_core::DeploymentId> {
        let database = self
            .database
            .lock()
            .map_err(|_| internal("execute.commit_deployment"))?;
        Self::ensure_targets_row(&database, target)?;
        database.deployment_repository().insert_sync(record)
    }

    /// Undoes a written target after its accounting row failed.  Reports
    /// `residue` on the error so the caller can tell "fully rolled back" apart
    /// from "something is still on disk": only the latter needs a user
    /// decision, and treating a clean rollback as recoverable would gate the
    /// next launch for no reason.
    fn roll_back_applied(&self, applied: &AppliedTarget, error: AppError) -> AppError {
        // `replace_owned` checks the physical identity but tolerates a content
        // mismatch: the tree was written moments ago and is not the same
        // object the ownership proof was minted for.
        let residue = self.filesystem.replace_owned(&applied.ownership).is_err();
        let mut error = error;
        if residue {
            error.params.insert(
                "path".to_owned(),
                serde_json::Value::String(
                    applied
                        .ownership
                        .destination_path
                        .to_string_lossy()
                        .into_owned(),
                ),
            );
            error.params.insert(
                "runtime_name".to_owned(),
                serde_json::Value::String(applied.ownership.runtime_name.clone()),
            );
            error.params.insert(
                "requested_mode".to_owned(),
                serde_json::Value::String(
                    match applied.ownership.mode {
                        DeploymentMode::ManagedCopy => "managed_copy",
                        DeploymentMode::SymbolicLink => "symbolic_link",
                        DeploymentMode::DirectoryJunction => "directory_junction",
                    }
                    .to_owned(),
                ),
            );
        }
        error
            .params
            .insert("residue".to_owned(), serde_json::Value::Bool(residue));
        error
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
        // QA-001/US-051：删除前重新扫描项目配置、固定版本、组合、
        // 声明依赖、相关 Skill 和未知外部引用；未知内容只提示不修改。
        let database = self
            .database
            .lock()
            .map_err(|_| internal("removal.inspect_delete"))?;
        let managed_target_ids: std::collections::HashSet<String> = deployments
            .iter()
            .map(|record| record.target_id.clone())
            .collect();
        let matrix = deletion_impact_matrix(&database, skill_id, &managed_target_ids)?;
        Ok(skillhub_core::RemovalImpact {
            operation_id: OperationId::new(),
            skill_id,
            deployments,
            requires_shared_target_choice,
            dependencies: matrix.dependencies,
            project_configs: matrix.project_configs,
            pinned_versions: matrix.pinned_versions,
            combinations: matrix.combinations,
            related_skills: matrix.related_skills,
            unknown_external_references: matrix.unknown_external_references,
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
            // 解除部署不删除 Skill 本体，目录/组合/引用维度不适用。
            dependencies: Vec::new(),
            project_configs: Vec::new(),
            pinned_versions: Vec::new(),
            combinations: Vec::new(),
            related_skills: Vec::new(),
            unknown_external_references: Vec::new(),
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
        let library = self.library_runtime.snapshot()?;
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
            (skill, library.current(skill_id)?)
        };
        self.database
            .lock()
            .map_err(|_| internal("execute.delete_skill.catalog"))?
            .catalog_repository()?
            .remove_sync(skill_id)?;
        if let Err(error) = library.central.remove_portable_skill(skill_id) {
            let restore = self
                .database
                .lock()
                .map_err(|_| internal("execute.delete_skill.rollback"))?
                .catalog_repository()?
                .insert_sync(&skill);
            return Err(cleanup_import_error(error, restore));
        }
        if let Err(error) = library.remove_skill_sync(skill_id) {
            let restore = self
                .database
                .lock()
                .map_err(|_| internal("execute.delete_skill.rollback"))?
                .catalog_repository()?
                .insert_sync(&skill)
                .and_then(|()| {
                    library
                        .central
                        .save_portable_skill(&skill, current.as_ref())
                });
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
        let library = self.library_runtime.snapshot()?;
        let destination = self.deployment_destination(deployment)?;
        let version = library.capture(deployment.skill_id, &destination)?;
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
        let library = self.library_runtime.snapshot()?;
        let destination = self.deployment_destination(deployment)?;
        let source = library
            .root
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
    /// Reads the central library root persisted via `activate_library_root`, if any.
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
        // A root chosen via `activate_library_root` persists in the database and
        // wins over the constructor value once present.
        let persisted = self.with_database("bootstrap.library_root", |database| {
            database.bootstrap_repository().load_library_root()
        })?;
        if let Some(path) = persisted {
            return Ok(PathBuf::from(path));
        }
        self.library_runtime
            .snapshot()
            .map(|library| library.root.clone())
            .or_else(|_| {
                self.suggested_library_root
                    .clone()
                    .ok_or_else(|| unsupported("bootstrap.library_path"))
            })
    }

    fn activate_library_root(
        &self,
        request: skillhub_core::api::ActivateLibraryRoot,
    ) -> AppResult<AppCommandResult> {
        let path = request.path.trim();
        if path.is_empty() {
            return Err(invalid_input("library root path must not be empty"));
        }
        let root = PathBuf::from(path);
        let mode = request.mode;
        self.library_runtime.activate(|| {
            let already_initialized = self
                .with_database("execute.activate_library_root.status", |database| {
                    database.bootstrap_repository().load_initialization()
                })?;
            if already_initialized.as_ref().is_some_and(|status| {
                matches!(
                    status.state,
                    skillhub_core::InitializationState::Initialized
                )
            }) {
                return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("reason", "library_root_locked")
                    .with_action(RecoveryAction::Acknowledge));
            }
            let central = match mode {
                skillhub_core::api::LibraryActivationMode::Create => CentralLibrary::create(&root),
                skillhub_core::api::LibraryActivationMode::Existing => {
                    CentralLibrary::open_existing(&root)
                }
            }?;
            let context = Arc::new(library_runtime::LibraryContext::from_library(central));
            self.with_database("execute.activate_library_root.persist", |database| {
                database.bootstrap_repository().save_library_root(path)
            })?;
            Ok(context)
        })?;
        let status = self.with_database("execute.activate_library_root.result", |database| {
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

    fn initial_restore_library(root: &Path) -> AppResult<CentralLibrary> {
        let paths = LibraryPaths::from_root(root);
        if paths.manifest_path.is_file() {
            CentralLibrary::open_existing(root)
        } else {
            CentralLibrary::create(root)
        }
    }

    fn ensure_initial_restore_pending(&self) -> AppResult<()> {
        if self.library_runtime.snapshot().is_ok() {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "library_root_locked")
                .with_action(RecoveryAction::Acknowledge));
        }
        let initialized = self.with_database("execute.initial_restore.status", |database| {
            database.bootstrap_repository().load_initialization()
        })?;
        if initialized.is_some_and(|status| {
            matches!(
                status.state,
                skillhub_core::InitializationState::Initialized
            )
        }) {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "library_root_locked")
                .with_action(RecoveryAction::Acknowledge));
        }
        Ok(())
    }

    fn prepare_initial_restore(
        &self,
        request: skillhub_core::api::PrepareInitialRestore,
    ) -> AppResult<AppCommandResult> {
        self.ensure_initial_restore_pending()?;
        if request.library_path.trim().is_empty() {
            return Err(invalid_input("library root path must not be empty"));
        }
        let package = Self::backup_package(request.backup_path)?;
        let root = PathBuf::from(request.library_path.trim());
        let _candidate = Self::initial_restore_library(&root)?;
        let plan = RestoreService::new(root).prepare(&package)?;
        Ok(AppCommandResult::RestorePlan(plan))
    }

    fn commit_initial_restore(
        &self,
        request: skillhub_core::api::CommitInitialRestore,
    ) -> AppResult<AppCommandResult> {
        if request.library_path.trim().is_empty() {
            return Err(invalid_input("library root path must not be empty"));
        }
        let package = Self::backup_package(request.backup_path)?;
        let root = PathBuf::from(request.library_path.trim());
        let decisions = request
            .decisions
            .into_iter()
            .map(|decision| (decision.skill_id, decision.decision))
            .collect::<Vec<_>>();
        self.ensure_initial_restore_pending()?;
        let result = self.library_runtime.activate_with_result(|| {
            let initialized = self.with_database("execute.initial_restore.status", |database| {
                database.bootstrap_repository().load_initialization()
            })?;
            if initialized.is_some_and(|status| {
                matches!(
                    status.state,
                    skillhub_core::InitializationState::Initialized
                )
            }) {
                return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("reason", "library_root_locked")
                    .with_action(RecoveryAction::Acknowledge));
            }
            let _candidate = Self::initial_restore_library(&root)?;
            let service = RestoreService::new(root.clone());
            let plan = service.prepare(&package)?;
            let result = service.commit(&package, &plan, &decisions)?;
            let central = CentralLibrary::initialize(&root)?;
            let context = Arc::new(library_runtime::LibraryContext::from_library(central));
            self.with_database("execute.initial_restore.persist", |database| {
                database
                    .bootstrap_repository()
                    .save_library_root(root.to_string_lossy().as_ref())
            })?;
            Ok((context, result))
        })?;
        Ok(AppCommandResult::RestoreResult(result))
    }

    fn list_skill_repos(&self) -> AppResult<AppQueryResult> {
        let views = self.with_database("query.list_skill_repos", |database| {
            let repos = database.skill_repo_repository().list()?;
            let scans = database.skill_repo_scan_state_repository().load()?;
            Ok(skill_repo_views(repos, &scans))
        })?;
        Ok(AppQueryResult::SkillRepos(views))
    }

    /// 仓库发现（联网）：逐仓库下载扫描；单仓库失败只进 warnings，不拖垮整体。
    /// 完成后按仓库记录最近一次扫描状态，供仓库管理页展示“上次扫描”。
    async fn discover_repo_skills(&self) -> AppResult<AppQueryResult> {
        self.ensure_network_enabled()?;
        let repos = self.with_database("query.discover_repo_skills.repos", |database| {
            database.skill_repo_repository().list()
        })?;
        // 先克隆 Arc 再 await：RwLockReadGuard 不是 Send，不能跨 await 持有。
        let provider = Arc::clone(&*self.repo_provider());
        let discovery = provider.discover(repos.clone()).await;
        self.record_repo_scan_states(&repos, &discovery.failures, |repo| {
            discovery
                .skills
                .iter()
                .filter(|skill| skill.repo_owner == repo.owner && skill.repo_name == repo.name)
                .count() as u32
        })?;
        Ok(AppQueryResult::RepoDiscoveryReport(
            skillhub_core::source::RepoDiscoveryReport {
                skills: discovery.skills,
                warnings: warnings_from_failures(discovery.failures),
            },
        ))
    }

    /// 逐仓刷新（联网）：对单个已配置仓库重跑发现并记录其扫描状态，返回
    /// 该仓库自己的发现报告。坐标复用持久化配置并重新校验（不信任存量数据），
    /// 网络开关语义与整体发现一致；显式刷新不受启用开关抑制。
    async fn refresh_skill_repo(
        &self,
        request: skillhub_core::RefreshSkillRepo,
    ) -> AppResult<AppCommandResult> {
        let stored = self.with_database("execute.refresh_skill_repo.lookup", |database| {
            Ok(database
                .skill_repo_repository()
                .list()?
                .into_iter()
                .find(|repo| repo.owner == request.owner && repo.name == request.name))
        })?;
        let Some(mut repo) = stored else {
            return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Warning)
                .with_action(RecoveryAction::Acknowledge));
        };
        if let Err(error) = self.repo_provider().validate_repo(&repo) {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning)
                .with_param("reason", error.to_string())
                .with_action(RecoveryAction::Retry));
        }
        self.ensure_network_enabled()?;
        // 显式刷新不受启停抑制：扫描副本按启用仓处理（记录扫描状态），
        // 持久化的 enabled 保持用户配置不变。
        repo.enabled = true;
        // 先克隆 Arc 再 await：RwLockReadGuard 不是 Send，不能跨 await 持有。
        let provider = Arc::clone(&*self.repo_provider());
        let discovery = provider.discover(vec![repo.clone()]).await;
        self.record_repo_scan_states(&[repo], &discovery.failures, |repo| {
            discovery
                .skills
                .iter()
                .filter(|skill| skill.repo_owner == repo.owner && skill.repo_name == repo.name)
                .count() as u32
        })?;
        Ok(AppCommandResult::RepoDiscoveryReport(RepoDiscoveryReport {
            skills: discovery.skills,
            warnings: warnings_from_failures(discovery.failures),
        }))
    }

    /// 把一次（整体或单仓）发现结果按仓库写入最近扫描状态：成功仓记
    /// ok=true + 候选数；失败仓记 ok=false + 错误摘要。禁用的仓库不参与
    /// 扫描，因此也不写状态（保留“从未扫描”的诚实空态）。
    fn record_repo_scan_states(
        &self,
        repos: &[SkillRepo],
        failures: &[(String, String, String)],
        candidate_count: impl Fn(&SkillRepo) -> u32,
    ) -> AppResult<()> {
        self.with_database("repo_scan_state.record", |database| {
            let scan_repository = database.skill_repo_scan_state_repository();
            for repo in repos.iter().filter(|repo| repo.enabled) {
                let error = failures
                    .iter()
                    .find(|(owner, name, _)| owner == &repo.owner && name == &repo.name)
                    .map(|(_, _, reason)| reason.clone());
                let state = RepoScanState {
                    scanned_at: now_rfc3339_utc(),
                    ok: error.is_none(),
                    candidate_count: if error.is_none() {
                        candidate_count(repo)
                    } else {
                        0
                    },
                    error,
                };
                scan_repository.put(&repo.owner, &repo.name, &state)?;
            }
            Ok(())
        })
    }

    /// 仓库 CRUD：upsert（owner+name 相同则替换）；坐标校验拒绝非法引用。
    fn add_skill_repo(
        &self,
        request: skillhub_core::api::AddSkillRepo,
    ) -> AppResult<AppCommandResult> {
        let repo = request.repo;
        if let Err(error) = self.repo_provider().validate_repo(&repo) {
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
            let scans = database.skill_repo_scan_state_repository().load()?;
            Ok(skill_repo_views(repos, &scans))
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
            // 同步遗忘该仓库的扫描状态：重新添加同名仓库时不得误读旧结果。
            database
                .skill_repo_scan_state_repository()
                .remove(&request.owner, &request.name)?;
            let scans = database.skill_repo_scan_state_repository().load()?;
            Ok(skill_repo_views(repos, &scans))
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
        if let Err(error) = self.repo_provider().validate_repo(&repo) {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning)
                .with_param("reason", error.to_string())
                .with_action(RecoveryAction::Retry));
        }
        let root = repo_downloads_root()?;
        // 先克隆 Arc 再 await：RwLockReadGuard 不是 Send，不能跨 await 持有。
        let provider = Arc::clone(&*self.repo_provider());
        let path = provider
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
        // P1-05：只有 branch+directory 坐标完整时才登记上游坐标。整仓下载
        // （哨兵为空）没有可验证的定位坐标，盖章只会产生 branch/directory 为空
        // 的无效上游（更新检测永远读不出来）——诚实缺省优于盖假坐标。
        if !skill.repo_branch.trim().is_empty() && !skill.directory.trim().is_empty() {
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
        }
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
        let page = self.cached_source_search(&request.query).await?;
        Ok(AppQueryResult::SourceSearchPage(page))
    }

    async fn cached_source_search(
        &self,
        query: &skillhub_core::source::SourceSearchQuery,
    ) -> AppResult<skillhub_core::source::SourceSearchPage> {
        let now = now_seconds();
        if let Some(page) = self.with_database("query.search_online_sources.cache", |database| {
            database.source_search_cache().get(query, now)
        })? {
            return Ok(page);
        }
        let page = self.source_search_provider.search(query.clone()).await?;
        self.with_database("query.search_online_sources.cache", |database| {
            database.source_search_cache().put(query, &page, now)
        })?;
        Ok(page)
    }

    /// Assisted online search: the original text always runs first and its
    /// hits keep their provider order. AI query extension may append further
    /// REAL provider hits marked as such; any LLM failure falls back to the
    /// plain results (requirement 5.38). The LLM cannot invent entries.
    async fn search_online_sources_assisted(
        &self,
        request: skillhub_core::api::SearchOnlineSourcesAssisted,
    ) -> AppResult<AppQueryResult> {
        self.ensure_network_enabled()?;
        let text = request.text.trim().to_owned();
        let original_query = skillhub_core::source::SourceSearchQuery::new(&text);
        let mut page = self.cached_source_search(&original_query).await?;

        let capabilities = self.llm_capabilities()?;
        if !capabilities.online_search_assist {
            return Ok(AppQueryResult::SourceSearchPage(page));
        }
        let Ok((runner, profile)) =
            self.llm_context("query.search_online_sources_assisted.profile")
        else {
            // Unconfigured LLM: the plain results are the honest answer.
            return Ok(AppQueryResult::SourceSearchPage(page));
        };
        let query_text = text.clone();
        let expanded = run_non_send(move || async move {
            SearchQueryService::new(SharedLlmRunner(runner))
                .generate(&query_text, Some(&profile))
                .await
        });
        let Ok(suggestion) = expanded else {
            // Query expansion failing must not lose the base results.
            return Ok(AppQueryResult::SourceSearchPage(page));
        };
        let expanded_text = suggestion.query.trim().to_owned();
        if expanded_text.is_empty() || expanded_text == text {
            return Ok(AppQueryResult::SourceSearchPage(page));
        }
        let expanded_query = skillhub_core::source::SourceSearchQuery::new(&expanded_text);
        if expanded_query.query.trim().chars().count() < 2 {
            return Ok(AppQueryResult::SourceSearchPage(page));
        }
        let Ok(extra) = self.cached_source_search(&expanded_query).await else {
            // Extension search failing (provider hiccup) keeps the base page.
            return Ok(AppQueryResult::SourceSearchPage(page));
        };
        let mut seen: std::collections::HashSet<String> =
            page.items.iter().map(|hit| hit.source_id.clone()).collect();
        for mut hit in extra.items {
            if seen.insert(hit.source_id.clone()) {
                hit.via = skillhub_core::source::SearchHitOrigin::ExpandedQuery;
                page.items.push(hit);
            }
        }
        page.count = u32::try_from(page.items.len()).unwrap_or(u32::MAX);
        page.ai_assisted = true;
        page.expanded_query = Some(expanded_text);
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

    // ------------------------------------------------------------------
    // P1-05 来源模型：搜索候选的持久化与来源投影。
    //
    // 底线语义：搜索结果本身仍是纯查询（不落任何 skill/source 记录）；
    // 只有显式 SaveSearchCandidates 才把命中落为待确认候选，且只写
    // search_candidates 表。确认候选仅登记导入意向，成为来源只有导入
    // 向导提交这一条路。三个 mutation 全部写持久操作日志。
    // ------------------------------------------------------------------

    fn save_search_candidates(
        &self,
        request: skillhub_core::api::SaveSearchCandidates,
    ) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "save_search_candidates");
        let result = self.with_database("execute.save_search_candidates", |database| {
            let saved = database
                .search_candidate_repository()
                .save_page(&request.page, now_seconds())?;
            Ok(AppCommandResult::SearchCandidates(saved))
        });
        self.journal_settle(
            operation_id,
            "save_search_candidates",
            result.as_ref().err(),
        );
        result
    }

    fn confirm_search_candidate(
        &self,
        request: skillhub_core::api::ConfirmSearchCandidate,
    ) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "confirm_search_candidate");
        let result = self.with_database("execute.confirm_search_candidate", |database| {
            database.search_candidate_repository().set_status(
                &request.candidate_id,
                skillhub_core::SearchCandidateStatus::Confirmed,
            )?;
            Ok(AppCommandResult::OperationSummary(
                skillhub_core::OperationSummary {
                    operation_id,
                    phase: skillhub_core::OperationPhase::Committed,
                    message_code: "source.search_candidate_confirmed".to_owned(),
                    error_code: None,
                },
            ))
        });
        self.journal_settle(
            operation_id,
            "confirm_search_candidate",
            result.as_ref().err(),
        );
        result
    }

    fn dismiss_search_candidate(
        &self,
        request: skillhub_core::api::DismissSearchCandidate,
    ) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "dismiss_search_candidate");
        let result = self.with_database("execute.dismiss_search_candidate", |database| {
            database.search_candidate_repository().set_status(
                &request.candidate_id,
                skillhub_core::SearchCandidateStatus::Dismissed,
            )?;
            Ok(AppCommandResult::OperationSummary(
                skillhub_core::OperationSummary {
                    operation_id,
                    phase: skillhub_core::OperationPhase::Committed,
                    message_code: "source.search_candidate_dismissed".to_owned(),
                    error_code: None,
                },
            ))
        });
        self.journal_settle(
            operation_id,
            "dismiss_search_candidate",
            result.as_ref().err(),
        );
        result
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

    pub fn open_with_suggested_library(
        path: impl AsRef<Path>,
        suggested_root: impl AsRef<Path>,
    ) -> AppResult<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("source", error.to_string())
                    .with_action(RecoveryAction::Retry)
            })?;
        }
        Database::open(path)
            .map(|database| Self::new_with_suggested_library(database, suggested_root))
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
        let library_runtime = Arc::new(library_runtime::LibraryRuntime::new());
        let backend = Arc::new(LocalDeploymentBackend::new(
            database.clone(),
            library_runtime.clone(),
        ));
        let deployment_service = Arc::new(DeploymentService::new(backend.clone()));
        let removal_service = Arc::new(RemovalService::new(backend.clone()));
        let reconcile_service = Arc::new(ReconcileService::new(Arc::new(
            LocalDeploymentBackend::new(database.clone(), library_runtime.clone()),
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
            database: database.clone(),
        })));
        let app_update_provider = Arc::new(GithubReleaseProvider::new());
        let update_service = Arc::new(UpdateService::new(
            database.clone(),
            app_update_provider.clone(),
        ));
        let facade = Self {
            database,
            today,
            library_runtime,
            suggested_library_root: None,
            deployment_targets: None,
            backend,
            deployment_service,
            removal_service,
            reconcile_service,
            health_service,
            recovery_service,
            call_policy_service,
            ignore_service,
            llm_runner: None,
            evidence_repository: UsageEvidenceRepository::default(),
            app_update_provider,
            update_service,
            source_search_provider: Arc::new(SkillsShProvider::new("https://skills.sh")),
            repo_discovery_provider: RwLock::new(Arc::new(RepoDiscoveryProvider::new())),
            prepared_imports: Mutex::new(HashMap::new()),
            prepared_migrations: Mutex::new(HashMap::new()),
            prepared_relation_migrations: Mutex::new(HashMap::new()),
            relation_migration_results: Mutex::new(HashMap::new()),
            relation_migration_lock: Mutex::new(()),
            prepared_uninstall: Mutex::new(None),
            scan_service: Mutex::new(ScanService::new()),
            path_grants: Mutex::new(HashMap::new()),
            assembly_plans: Mutex::new(HashMap::new()),
            external_link_service: ExternalLinkService::new(),
            llm_runs: Mutex::new(HashMap::new()),
            upstream_origins: Mutex::new(HashMap::new()),
            acquired_import_sources: Mutex::new(HashMap::new()),
            import_source_classifications: Mutex::new(HashMap::new()),
            relationship_probe: Mutex::new(
                relationship_validation_service::default_relationship_probe(),
            ),
            original_migration_deletion: Mutex::new(default_original_migration_deletion()),
            llm_credentials: Arc::new(SessionCredentialStore::default()),
            llm_admin: None,
            network_gate: NetworkGate::open(),
        };
        facade.sync_network_gate();
        facade
    }

    /// Creates a facade with read-only access to a central library root.
    pub fn new_with_library(database: Database, library_root: impl AsRef<Path>) -> Self {
        let library_root = library_root.as_ref().to_path_buf();
        let database = Arc::new(Mutex::new(database));
        let central = CentralLibrary::initialize(&library_root)
            .expect("new_with_library requires a valid central library");
        let library_runtime = Arc::new(library_runtime::LibraryRuntime::from_active(Arc::new(
            library_runtime::LibraryContext::from_library(central),
        )));
        let backend = Arc::new(LocalDeploymentBackend::new(
            database.clone(),
            library_runtime.clone(),
        ));
        let deployment_service = Arc::new(DeploymentService::new(backend.clone()));
        let removal_service = Arc::new(RemovalService::new(backend.clone()));
        let reconcile_service = Arc::new(ReconcileService::new(backend.clone()));
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
            database: database.clone(),
        })));
        let app_update_provider = Arc::new(GithubReleaseProvider::new());
        let update_service = Arc::new(UpdateService::new(
            database.clone(),
            app_update_provider.clone(),
        ));
        let facade = Self {
            database,
            today: current_utc_date(),
            library_runtime,
            suggested_library_root: None,
            deployment_targets: None,
            backend,
            deployment_service,
            removal_service,
            reconcile_service,
            health_service,
            recovery_service,
            call_policy_service,
            ignore_service,
            llm_runner: None,
            evidence_repository: UsageEvidenceRepository::default(),
            app_update_provider,
            update_service,
            source_search_provider: Arc::new(SkillsShProvider::new("https://skills.sh")),
            repo_discovery_provider: RwLock::new(Arc::new(RepoDiscoveryProvider::new())),
            prepared_imports: Mutex::new(HashMap::new()),
            prepared_migrations: Mutex::new(HashMap::new()),
            prepared_relation_migrations: Mutex::new(HashMap::new()),
            relation_migration_results: Mutex::new(HashMap::new()),
            relation_migration_lock: Mutex::new(()),
            prepared_uninstall: Mutex::new(None),
            scan_service: Mutex::new(ScanService::new()),
            path_grants: Mutex::new(HashMap::new()),
            assembly_plans: Mutex::new(HashMap::new()),
            external_link_service: ExternalLinkService::new(),
            llm_runs: Mutex::new(HashMap::new()),
            upstream_origins: Mutex::new(HashMap::new()),
            acquired_import_sources: Mutex::new(HashMap::new()),
            import_source_classifications: Mutex::new(HashMap::new()),
            relationship_probe: Mutex::new(
                relationship_validation_service::default_relationship_probe(),
            ),
            original_migration_deletion: Mutex::new(default_original_migration_deletion()),
            llm_credentials: Arc::new(SessionCredentialStore::default()),
            llm_admin: None,
            network_gate: NetworkGate::open(),
        };
        facade.sync_network_gate();
        facade
    }

    #[doc(hidden)]
    pub fn library_runtime(&self) -> Arc<library_runtime::LibraryRuntime> {
        self.library_runtime.clone()
    }

    /// Test-only database handle used by relationship facade fixtures to seed
    /// deterministic normalized facts without introducing a second adapter.
    #[doc(hidden)]
    pub fn database_for_tests(&self) -> Arc<Mutex<Database>> {
        self.database.clone()
    }

    pub fn new_with_suggested_library(
        database: Database,
        suggested_root: impl AsRef<Path>,
    ) -> Self {
        let mut facade = Self::new(database);
        facade.suggested_library_root = Some(suggested_root.as_ref().to_path_buf());
        facade
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
    fn repo_provider(&self) -> std::sync::RwLockReadGuard<'_, Arc<RepoDiscoveryProvider>> {
        self.repo_discovery_provider.read().expect("repo provider")
    }

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

    /// 仅供测试：按路径（大小写/斜杠不敏感）读取发现时固化的来源分类。
    #[doc(hidden)]
    pub fn import_source_classification_for_tests(
        &self,
        root: impl Into<String>,
    ) -> Option<ClassifiedImportSource> {
        let key = observed_path_key(&root.into());
        self.import_source_classifications
            .lock()
            .ok()?
            .get(&key)
            .cloned()
    }

    /// 仅供测试：把仓库归档下载指向本地 fixture 服务器。
    #[doc(hidden)]
    pub fn set_repo_discovery_provider_for_tests(&self, provider: Arc<RepoDiscoveryProvider>) {
        *self.repo_discovery_provider.write().expect("repo provider") = provider;
    }

    /// 仅供测试观测：读取单个 Skill 的来源投影（角色 + 可选上游坐标）。
    /// `get_skill_source` 已从 IPC 契约退役（前端无调用方）；来源语义的
    /// 行为测试仍需要无网络副作用的观测点，故保留此诊断入口。
    /// 未知 Skill 明确报错；已知 Skill 无来源行返回 None（仅本地展示）。
    #[doc(hidden)]
    pub fn skill_source_for_tests(
        &self,
        skill_id: skillhub_core::SkillId,
    ) -> AppResult<Option<skillhub_core::source::SourceRecord>> {
        self.with_database("diagnostic.skill_source_for_tests", |database| {
            if database.catalog_repository()?.get_sync(skill_id)?.is_none() {
                return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("skill_id", skill_id.to_string())
                    .with_action(RecoveryAction::ChooseAnotherName));
            }
            database
                .source_repository()
                .source_record_for_skill(skill_id)
        })
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
        facade.deployment_targets = Some(deployment_targets.clone());
        if let Ok(mut injected) = facade.backend.injected_targets.lock() {
            *injected = Some(deployment_targets);
        }
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

    /// Attaches the LLM task runner after construction. Production wiring and
    /// tests both use this to keep construction composable.
    pub fn with_llm_runner(mut self, runner: Arc<dyn LlmTaskRunner>) -> Self {
        self.llm_runner = Some(runner);
        self
    }

    /// Attaches the provider-administration runtime: the network gate shared
    /// with the HTTP runner, the OS credential store and the admin seam used
    /// for model-list fetches and connection tests. Tests inject fakes so no
    /// test touches a real vault or the network.
    pub fn with_llm_runtime(
        mut self,
        gate: NetworkGate,
        credentials: Arc<dyn CredentialStore>,
        admin: Arc<dyn LlmAdmin>,
    ) -> Self {
        self.network_gate = gate;
        self.llm_credentials = credentials;
        self.llm_admin = Some(admin);
        self
    }

    /// Installs the production HTTP runner, OS credential store and
    /// administration seam. The same network gate is shared by the facade
    /// and runner so the persisted network preference applies uniformly.
    pub fn with_production_llm_runtime(mut self) -> Self {
        let gate = self.network_gate.clone();
        let credentials = Arc::new(OsCredentialStore::native());
        let runner =
            Arc::new(HttpLlmTaskRunner::new(credentials.clone()).with_network_gate(gate.clone()));
        self.llm_runner = Some(runner.clone());
        self.llm_credentials = credentials;
        self.llm_admin = Some(runner);
        self
    }

    /// Aligns the LLM network gate with the stored preference so a persisted
    /// "disable all networking" choice survives a restart.
    fn sync_network_gate(&self) {
        let enabled = self
            .with_database("llm.sync_network_gate", |database| {
                Ok(database
                    .desktop_settings_repository()
                    .get()?
                    .network_enabled)
            })
            .unwrap_or(true);
        self.network_gate.set_open(enabled);
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

    fn lock_relation_migration(
        &self,
        operation: &'static str,
    ) -> AppResult<std::sync::MutexGuard<'_, ()>> {
        self.relation_migration_lock.lock().map_err(|_| {
            AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("operation", operation)
                .with_action(RecoveryAction::Retry)
        })
    }

    // ------------------------------------------------------------------
    // Persistent operation journal (`operations` table).
    //
    // The table is the durable history behind the operations page and the
    // recovery entry; the in-process prepared maps only carry "fetch at
    // commit time" state. Legacy single-step journal helpers remain
    // best-effort, but relationship migrations use persist_relation_operation
    // and treat a post-filesystem checkpoint failure as a recovery event. Rows
    // only ever contain the stable kind, the phase and a whitelisted error
    // code — never skill content, credentials or raw error payloads.
    // ------------------------------------------------------------------

    /// Starts a single-step flow with a `planned` record.
    fn journal_begin(&self, operation_id: OperationId, kind: &'static str) {
        self.journal_insert(journal_record(
            operation_id,
            kind,
            skillhub_core::OperationPhase::Planned,
            None,
        ));
    }

    /// Records the prepared, retryable state of a multi-step flow.
    fn journal_prepared(&self, operation_id: OperationId, kind: &'static str) {
        self.journal_insert(journal_record(
            operation_id,
            kind,
            skillhub_core::OperationPhase::Prepared,
            None,
        ));
    }

    /// Settles a single-step flow: `committed` on success, `rolled_back`
    /// with the failing error code on the failure path.
    fn journal_settle(
        &self,
        operation_id: OperationId,
        kind: &'static str,
        error: Option<&AppError>,
    ) {
        match error {
            None => self.journal_advance(
                operation_id,
                kind,
                skillhub_core::OperationPhase::Committed,
                None,
            ),
            Some(error) => self.journal_advance(
                operation_id,
                kind,
                skillhub_core::OperationPhase::RolledBack,
                Some(error.code),
            ),
        }
    }

    /// Advances a flow record to `phase`. When no row exists (the flow failed
    /// before any record was written) a terminal row is inserted instead, so
    /// validation failures still surface in the operations history without
    /// creating recovery entries.
    fn journal_advance(
        &self,
        operation_id: OperationId,
        kind: &'static str,
        phase: skillhub_core::OperationPhase,
        error_code: Option<ErrorCode>,
    ) {
        self.journal_write(journal_record(operation_id, kind, phase, error_code));
    }

    /// [`Self::journal_advance`] plus the durable details a user needs to act:
    /// the per-object result and the data recovery reads to undo the write.
    fn journal_advance_with_details(
        &self,
        operation_id: OperationId,
        kind: &'static str,
        phase: skillhub_core::OperationPhase,
        error_code: Option<ErrorCode>,
        result: Option<serde_json::Value>,
        recovery_data: serde_json::Value,
    ) {
        let mut record = journal_record(operation_id, kind, phase, error_code);
        record.result = result;
        record.recovery_data = recovery_data;
        self.journal_write(record);
    }

    fn journal_write(&self, record: skillhub_core::OperationRecord) {
        let updated = self.with_database("operation_journal.advance", |database| {
            database.operation_repository().update_sync(&record)
        });
        if updated.is_err() {
            self.journal_insert(record);
        }
    }

    fn journal_insert(&self, record: skillhub_core::OperationRecord) {
        let _ = self.with_database("operation_journal.insert", |database| {
            database.operation_repository().insert_sync(&record)
        });
    }

    /// AI import checks stage temporary prepared imports. They are advisory
    /// only; the commit loop prepares its own operation, so the staging
    /// records must be settled before the next startup snapshot is built.
    fn discard_prepared_imports(&self, operation_ids: &[OperationId]) {
        for operation_id in operation_ids {
            let removed = self
                .prepared_imports
                .lock()
                .map(|mut prepared| prepared.remove(operation_id).is_some())
                .unwrap_or(false);
            if removed {
                self.journal_advance(
                    *operation_id,
                    "import_skill",
                    skillhub_core::OperationPhase::RolledBack,
                    None,
                );
            }
        }
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
            let preferences = database.desktop_settings_repository().get()?;
            if let Some(id) = &preferences.default_llm_provider_id {
                if let Some(config) = database.llm_provider_repository().get(id)? {
                    if config.enabled {
                        return config.to_profile().map(Some);
                    }
                }
            }
            Ok(database.llm_profile_repository().list()?.into_iter().next())
        })?;
        let profile =
            profile.ok_or_else(|| AppError::new(ErrorCode::LlmNotConfigured, Severity::Info))?;
        Ok((runner, profile))
    }

    fn llm_capabilities(&self) -> AppResult<skillhub_core::settings::LlmCapabilitySettings> {
        self.with_database("llm.capabilities", |database| {
            Ok(database
                .desktop_settings_repository()
                .get()?
                .llm_capabilities)
        })
    }

    /// Capability switches default to off: no LLM call may happen that the
    /// user has not opted into, regardless of provider configuration.
    fn require_llm_capability(&self, enabled: bool, kind: LlmTaskKind) -> AppResult<()> {
        if !enabled {
            return Err(AppError::llm_capability_disabled(kind));
        }
        Ok(())
    }

    fn ensure_online_allowed(&self, profile: &LlmProfile) -> AppResult<()> {
        if !self.network_gate.allows(profile.deployment) {
            return Err(AppError::new(ErrorCode::NetworkDisabled, Severity::Warning)
                .with_action(RecoveryAction::Acknowledge));
        }
        Ok(())
    }

    /// True when the provider needs no secret (local runtimes) or the OS
    /// store currently holds its credential. The value itself never leaves
    /// the store.
    async fn credential_configured(&self, config: &LlmProviderConfig) -> AppResult<bool> {
        self.credential_reference_configured(&config.credential_ref)
            .await
    }

    /// Same verdict as [`Self::credential_configured`], keyed on the raw
    /// reference so call sites that only hold a runtime profile can reuse it.
    async fn credential_reference_configured(
        &self,
        reference: &Option<CredentialRef>,
    ) -> AppResult<bool> {
        let Some(reference) = reference else {
            return Ok(true);
        };
        let store = self.llm_credentials.clone();
        let reference = reference.clone();
        run_non_send(
            move || async move { store.get(&reference).await.map(|value| value.is_some()) },
        )
    }

    fn resolve_admin_target(&self, provider: FetchLlmProvider) -> AppResult<LlmProfile> {
        match provider {
            FetchLlmProvider::Draft { provider } => provider.to_profile(),
            FetchLlmProvider::Saved { id } => {
                let config = self
                    .with_database("llm.resolve_admin_target", |database| {
                        database.llm_provider_repository().get(&id)
                    })?
                    .ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))?;
                if !config.enabled {
                    return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error));
                }
                config.to_profile()
            }
        }
    }

    fn resolve_model_list_target(&self, provider: FetchLlmProvider) -> AppResult<LlmProfile> {
        match provider {
            FetchLlmProvider::Draft { provider } => provider.to_model_listing_profile(),
            FetchLlmProvider::Saved { id } => {
                let config = self
                    .with_database("llm.resolve_model_list_target", |database| {
                        database.llm_provider_repository().get(&id)
                    })?
                    .ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))?;
                if !config.enabled {
                    return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error));
                }
                config.to_model_listing_profile()
            }
        }
    }

    async fn save_llm_provider(&self, request: SaveLlmProvider) -> AppResult<AppCommandResult> {
        let mut config = request.provider;
        if let Some(secret) = &request.credential {
            let reference = config
                .credential_ref
                .clone()
                .unwrap_or_else(|| CredentialRef::new(format!("llm-provider:{}", config.id)));
            config.credential_ref = Some(reference.clone());
            let store = self.llm_credentials.clone();
            let secret = secret.clone();
            run_non_send(move || async move { store.set(&reference, &secret).await })?;
        }
        self.with_database("execute.save_llm_provider", |database| {
            database.llm_provider_repository().save(&config)?;
            Ok(())
        })?;
        let credential_configured = self.credential_configured(&config).await?;
        let is_default = self.with_database("execute.save_llm_provider.default", |database| {
            Ok(database
                .desktop_settings_repository()
                .get()?
                .default_llm_provider_id
                .as_deref()
                == Some(config.id.as_str()))
        })?;
        let last_connection_test =
            self.with_database("execute.save_llm_provider.last_test", |database| {
                Ok(fresh_connection_test(
                    &database.llm_connection_test_repository().load()?,
                    &config,
                    credential_configured,
                ))
            })?;
        Ok(AppCommandResult::LlmProviderView(LlmProviderView {
            config,
            credential_configured,
            is_default,
            last_connection_test,
        }))
    }

    async fn delete_llm_provider(&self, request: DeleteLlmProvider) -> AppResult<AppCommandResult> {
        let config = self.with_database("execute.delete_llm_provider", |database| {
            database.llm_provider_repository().get(&request.id)
        })?;
        if let Some(config) = &config {
            if let Some(reference) = &config.credential_ref {
                let store = self.llm_credentials.clone();
                let reference = reference.clone();
                run_non_send(move || async move { store.delete(&reference).await })?;
            }
        }
        let preferences = self.with_database("execute.delete_llm_provider.row", |database| {
            database.llm_provider_repository().delete(&request.id)?;
            // D3：供应商已删除，其最近一次连接测试记录一并移除，防止同 id
            // 重建后旧结果被错误沿用。
            database
                .llm_connection_test_repository()
                .remove(&request.id)?;
            let mut preferences = database.desktop_settings_repository().get()?;
            if preferences.default_llm_provider_id.as_deref() == Some(request.id.as_str()) {
                preferences.default_llm_provider_id = None;
                preferences = database.desktop_settings_repository().save(&preferences)?;
            }
            Ok(preferences)
        })?;
        Ok(AppCommandResult::DesktopPreferences(preferences))
    }

    async fn clear_llm_provider_credential(
        &self,
        request: ClearLlmProviderCredential,
    ) -> AppResult<AppCommandResult> {
        let config = self
            .with_database("execute.clear_llm_provider_credential", |database| {
                database.llm_provider_repository().get(&request.id)
            })?
            .ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))?;
        if let Some(reference) = &config.credential_ref {
            let store = self.llm_credentials.clone();
            let reference = reference.clone();
            run_non_send(move || async move { store.delete(&reference).await })?;
        }
        // D3：清凭据后按凭据库实况重算在场状态；指纹随之失配，最近一次
        // 连接测试结果自动失效（不再宣称"已验证"）。
        let credential_configured = self.credential_configured(&config).await?;
        let is_default = self.with_database(
            "execute.clear_llm_provider_credential.default",
            |database| {
                Ok(database
                    .desktop_settings_repository()
                    .get()?
                    .default_llm_provider_id
                    .as_deref()
                    == Some(config.id.as_str()))
            },
        )?;
        let last_connection_test = self.with_database(
            "execute.clear_llm_provider_credential.last_test",
            |database| {
                Ok(fresh_connection_test(
                    &database.llm_connection_test_repository().load()?,
                    &config,
                    credential_configured,
                ))
            },
        )?;
        Ok(AppCommandResult::LlmProviderView(LlmProviderView {
            config,
            credential_configured,
            is_default,
            last_connection_test,
        }))
    }

    async fn set_llm_provider_enabled(
        &self,
        request: SetLlmProviderEnabled,
    ) -> AppResult<AppCommandResult> {
        let mut config = self
            .with_database("execute.set_llm_provider_enabled", |database| {
                database.llm_provider_repository().get(&request.id)
            })?
            .ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))?;
        config.enabled = request.enabled;
        self.with_database("execute.set_llm_provider_enabled.save", |database| {
            database.llm_provider_repository().save(&config)?;
            Ok(())
        })?;
        let credential_configured = self.credential_configured(&config).await?;
        let is_default =
            self.with_database("execute.set_llm_provider_enabled.default", |database| {
                Ok(database
                    .desktop_settings_repository()
                    .get()?
                    .default_llm_provider_id
                    .as_deref()
                    == Some(config.id.as_str()))
            })?;
        // enabled 不在指纹内：停用/启用不否定连接事实。
        let last_connection_test =
            self.with_database("execute.set_llm_provider_enabled.last_test", |database| {
                Ok(fresh_connection_test(
                    &database.llm_connection_test_repository().load()?,
                    &config,
                    credential_configured,
                ))
            })?;
        Ok(AppCommandResult::LlmProviderView(LlmProviderView {
            config,
            credential_configured,
            is_default,
            last_connection_test,
        }))
    }

    fn set_default_llm_provider(
        &self,
        request: SetDefaultLlmProvider,
    ) -> AppResult<AppCommandResult> {
        let preferences = self.with_database("execute.set_default_llm_provider", |database| {
            if let Some(id) = &request.id {
                let config = database
                    .llm_provider_repository()
                    .get(id)?
                    .ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))?;
                if !config.enabled {
                    return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error));
                }
            }
            let mut preferences = database.desktop_settings_repository().get()?;
            preferences.default_llm_provider_id = request.id.clone();
            database.desktop_settings_repository().save(&preferences)
        })?;
        Ok(AppCommandResult::DesktopPreferences(preferences))
    }

    async fn fetch_llm_models(&self, request: FetchLlmModels) -> AppResult<AppCommandResult> {
        let profile = self.resolve_model_list_target(request.provider)?;
        self.ensure_online_allowed(&profile)?;
        let admin = self
            .llm_admin
            .clone()
            .ok_or_else(|| AppError::new(ErrorCode::LlmNotConfigured, Severity::Info))?;
        let credential = request.credential;
        let models =
            run_non_send(move || async move { admin.fetch_models(&profile, credential).await })?;
        Ok(AppCommandResult::LlmModels(models))
    }

    async fn test_llm_connection(&self, request: TestLlmConnection) -> AppResult<AppCommandResult> {
        let profile = self.resolve_admin_target(request.provider)?;
        self.ensure_online_allowed(&profile)?;
        let admin = self
            .llm_admin
            .clone()
            .ok_or_else(|| AppError::new(ErrorCode::LlmNotConfigured, Severity::Info))?;
        let credential = request.credential;
        let inline_credential_present = credential.is_some();
        let profile_for_record = profile.clone();
        let report = run_non_send(move || async move {
            let report = admin.check_connection(&profile, credential).await;
            Ok(report)
        })?;
        // D3：把最近一次三级测试结果如实落到 settings KV，供在线发现页的
        // 可用性检查区分"已验证"与"连接尚未验证"。记录是尽力而为：命令的
        // 首要产出是测试报告，持久化失败不掩盖它。
        let _ = self
            .record_connection_test_outcome(&profile_for_record, inline_credential_present, &report)
            .await;
        Ok(AppCommandResult::ConnectionTest(report))
    }

    /// Records the just-finished connection test for the provider it ran
    /// against, whatever the per-level verdicts were. Drafts with an empty id
    /// have no stable identity to attach a result to and are skipped.
    async fn record_connection_test_outcome(
        &self,
        profile: &LlmProfile,
        inline_credential_present: bool,
        report: &ConnectionTestResult,
    ) -> AppResult<()> {
        // 供应商身份在 profile.provider（to_profile 从 config.id 复制）；
        // profile.id 是运行时组合键 "{provider}:{model}"，不能当存储键用。
        let provider_id = profile.provider.as_str();
        if provider_id.trim().is_empty() {
            return Ok(());
        }
        // 凭据在场 = 请求里带了临时凭据，或 OS 凭据库当前持有该引用的密钥。
        // 只看 credential_ref 是否存在无法区分"测过但密钥已清除"。
        let credential_present = inline_credential_present
            || self
                .credential_reference_configured(&profile.credential_ref)
                .await?;
        let entry = PersistedConnectionTest {
            service_ok: report.endpoint.reachable,
            model_ok: report.model_ok(),
            structured_ok: report.structured.as_ref().map(|structured| structured.ok),
            tested_at: now_epoch_seconds().to_string(),
            fingerprint: LlmConnectionIdentity::from_profile(profile, credential_present)
                .fingerprint(),
        };
        self.with_database("execute.test_llm_connection.record", |database| {
            database
                .llm_connection_test_repository()
                .put(provider_id, &entry)
        })
    }

    async fn list_llm_providers(&self) -> AppResult<AppQueryResult> {
        let (configs, tests) = self.with_database("query.list_llm_providers", |database| {
            let configs = database.llm_provider_repository().list()?;
            let tests = database.llm_connection_test_repository().load()?;
            Ok((configs, tests))
        })?;
        let default_id = self.with_database("query.list_llm_providers.default", |database| {
            Ok(database
                .desktop_settings_repository()
                .get()?
                .default_llm_provider_id)
        })?;
        let mut providers = Vec::with_capacity(configs.len());
        for config in configs {
            let is_default = default_id.as_deref() == Some(config.id.as_str());
            let credential_configured = self.credential_configured(&config).await?;
            // D3：最近一次连接测试摘要仅在指纹新鲜时随视图返回。
            let last_connection_test =
                fresh_connection_test(&tests, &config, credential_configured);
            providers.push(LlmProviderView {
                config,
                credential_configured,
                is_default,
                last_connection_test,
            });
        }
        Ok(AppQueryResult::LlmProviders(providers))
    }

    fn list_llm_provider_presets(&self) -> AppResult<AppQueryResult> {
        Ok(AppQueryResult::LlmProviderPresets(
            skillhub_core::llm::builtin_provider_presets(),
        ))
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
        let capabilities = self.llm_capabilities()?;
        self.require_llm_capability(
            capabilities.semantic_duplicate,
            LlmTaskKind::DuplicateAnalysis,
        )?;
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

    /// Task 8: optional AI conflict analysis over deterministic conflict
    /// groups. Deterministic baselines always come back untouched: without a
    /// configured LLM (or with the capability off) the run answers with a
    /// baseline-only result plus an honest failure code, and a failed LLM call
    /// leaves trackable per-case records. Nothing here ever writes
    /// `ConflictCase.user_decision`.
    async fn analyze_conflict(&self, scope: AnalyzeConflictScope) -> AppResult<AppCommandResult> {
        let cases = self.with_database("execute.analyze_conflict.cases", |database| {
            let all = database.conflict_repository().list_cases()?;
            Ok(all
                .into_iter()
                .filter(|case| conflict_case_matches_scope(case, &scope))
                .collect::<Vec<_>>())
        })?;
        let skipped_decided_cases = u32::try_from(
            cases
                .iter()
                .filter(|case| case.user_decision.is_some())
                .count(),
        )
        .unwrap_or(u32::MAX);
        // 已有用户裁决的冲突组不再送分析：AI 意见不得追随或覆盖裁决。
        let undecided: Vec<_> = cases
            .iter()
            .filter(|case| case.user_decision.is_none())
            .cloned()
            .collect();

        // 基线兜底结果同样上报范围内总数：cases 为空表示本次没有任何
        // 结论可展示，失败码负责说明原因。
        let total_case_count = u32::try_from(undecided.len()).unwrap_or(u32::MAX);
        let without_llm = |failure_code: Option<String>| {
            AppCommandResult::ConflictAnalysis(skillhub_core::duplicate::ConflictAnalysis {
                scope: scope.clone(),
                input_fingerprint: String::new(),
                cases: Vec::new(),
                skipped_decided_cases,
                total_case_count,
                source: skillhub_core::duplicate::DuplicateAnalysisSource::DeterministicOnly,
                failure_code,
            })
        };

        let capabilities = self.llm_capabilities()?;
        if !capabilities.semantic_duplicate {
            return Ok(without_llm(Some(
                ErrorCode::LlmCapabilityDisabled.as_str().to_owned(),
            )));
        }
        let (runner, profile) = match self.llm_context("execute.analyze_conflict.profile") {
            Ok(context) => context,
            Err(error) => return Ok(without_llm(Some(error.code.as_str().to_owned()))),
        };
        if undecided.is_empty() {
            return Ok(without_llm(None));
        }
        let input = build_conflict_analysis_input(&scope, &undecided)?;

        let run = run_non_send(move || async move {
            (runner as Arc<dyn LlmTaskRunner>)
                .run(&profile, input.request)
                .await
        });
        let response = match run {
            Ok(response) => response,
            Err(error) => {
                self.persist_conflict_analysis_records(
                    &scope,
                    &input.fingerprint,
                    &undecided,
                    &[],
                    Some(&error.code),
                )?;
                return Ok(without_llm(Some(error.code.as_str().to_owned())));
            }
        };
        match parse_conflict_analysis_response(
            &scope,
            &input.fingerprint,
            skipped_decided_cases,
            &undecided,
            response.output,
        ) {
            Ok(analysis) => {
                self.persist_conflict_analysis_records(
                    &scope,
                    &input.fingerprint,
                    &undecided,
                    &analysis.cases,
                    None,
                )?;
                Ok(AppCommandResult::ConflictAnalysis(analysis))
            }
            Err(error) => {
                self.persist_conflict_analysis_records(
                    &scope,
                    &input.fingerprint,
                    &undecided,
                    &[],
                    Some(&error.code),
                )?;
                Ok(without_llm(Some(error.code.as_str().to_owned())))
            }
        }
    }

    /// Writes one analysis record per analyzed case: an AI conclusion when the
    /// run produced one, otherwise a traceable failure record. Records are
    /// advisory; the conflict case's decision fields are never touched here.
    fn persist_conflict_analysis_records(
        &self,
        scope: &AnalyzeConflictScope,
        fingerprint: &str,
        cases: &[skillhub_core::relationship::ConflictCaseFact],
        conclusions: &[ConflictCaseAnalysis],
        failure_code: Option<&ErrorCode>,
    ) -> AppResult<()> {
        let analyzed_at = now_epoch_seconds();
        // 亚秒 nonce 拼接 conflict_id，保证同一次运行内 record_id 唯一，
        // 重复分析不互相覆盖。
        let record_nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.subsec_nanos())
            .unwrap_or_default();
        let failure_text = failure_code.map(|code| code.as_str().to_owned());
        let run_failed = failure_code.is_some();
        self.with_database("execute.analyze_conflict.persist", |database| {
            let repository = database.conflict_analysis_repository();
            for case in cases {
                let conclusion = conclusions
                    .iter()
                    .find(|conclusion| conclusion.conflict_id == case.conflict_id);
                repository.insert_record(&ConflictAnalysisRecord {
                    record_id: format!(
                        "analysis:{conflict_id}:{nonce}",
                        conflict_id = case.conflict_id,
                        nonce = record_nonce
                    ),
                    conflict_id: case.conflict_id.clone(),
                    scope: scope.clone(),
                    input_fingerprint: fingerprint.to_owned(),
                    baseline_classification: case.classification,
                    conclusion: conclusion.cloned(),
                    source: if conclusion.is_some() && !run_failed {
                        skillhub_core::duplicate::DuplicateAnalysisSource::Llm
                    } else {
                        skillhub_core::duplicate::DuplicateAnalysisSource::DeterministicOnly
                    },
                    analyzed_at,
                    failure_code: failure_text.clone(),
                    adopted_by_user: false,
                })?;
            }
            Ok(())
        })
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
        let capabilities = self.llm_capabilities()?;
        self.require_llm_capability(
            capabilities.description_translation,
            LlmTaskKind::Translation,
        )?;
        let (runner, profile) = self.llm_context("execute.translate_description.profile")?;
        let hash = description_hash(&detail.original_description);
        let service = TranslationService::new(
            StorageTranslationRepository {
                database: self.database.clone(),
            },
            SharedLlmRunner(runner),
        );
        let original_description = detail.original_description;
        let language = request.language;
        let request_skill_id = request.skill_id;
        let overwrite = request.overwrite_user_revision;
        let result = run_non_send(move || async move {
            service
                .translate(
                    request_skill_id,
                    &original_description,
                    &hash,
                    &language,
                    Some(&profile),
                    overwrite,
                )
                .await
        })?;
        Ok(AppCommandResult::TranslationResult(result))
    }

    /// Batch translation: every item is attempted independently so one
    /// failure never loses the other results (requirement 5.35).
    async fn translate_descriptions_batch(
        &self,
        request: TranslateDescriptionsBatch,
    ) -> AppResult<AppCommandResult> {
        let capabilities = self.llm_capabilities()?;
        self.require_llm_capability(
            capabilities.description_translation,
            LlmTaskKind::Translation,
        )?;
        let (runner, profile) = self.llm_context("execute.translate_descriptions_batch.profile")?;
        let repository = StorageTranslationRepository {
            database: self.database.clone(),
        };
        let mut translated = Vec::new();
        let mut failed = Vec::new();
        for skill_id in request.skill_ids {
            match self
                .translate_one(
                    &repository,
                    runner.clone(),
                    profile.clone(),
                    skill_id,
                    &request.language,
                )
                .await
            {
                Ok(result) => translated.push(result),
                Err(error) => failed.push(BatchTranslationItemFailure {
                    skill_id,
                    code: error.code.as_str().to_owned(),
                    message: error.to_string(),
                }),
            }
        }
        Ok(AppCommandResult::BatchTranslationResult(
            BatchTranslationOutcome {
                language: request.language,
                translated,
                failed,
            },
        ))
    }

    async fn translate_one(
        &self,
        repository: &StorageTranslationRepository,
        runner: Arc<dyn LlmTaskRunner>,
        profile: LlmProfile,
        skill_id: skillhub_core::SkillId,
        language: &str,
    ) -> AppResult<TranslationResult> {
        let detail = self
            .with_database("execute.translate_descriptions_batch.skill", |database| {
                database.catalog_repository()?.get_detail(skill_id)
            })?;
        let detail =
            detail.ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))?;
        let hash = description_hash(&detail.original_description);
        let service = TranslationService::new(repository.clone(), SharedLlmRunner(runner.clone()));
        let original_description = detail.original_description;
        let language = language.to_owned();
        run_non_send(move || async move {
            service
                .translate(
                    skill_id,
                    &original_description,
                    &hash,
                    &language,
                    Some(&profile),
                    false,
                )
                .await
        })
    }

    /// Import-flow AI pre-checks (step 5): one advisory safety analysis per
    /// prepared import. Findings never change the deterministic import gates;
    /// failures are reported per object and never abort the batch.
    async fn run_import_ai_checks(
        &self,
        request: skillhub_core::api::RunImportAiChecks,
    ) -> AppResult<AppCommandResult> {
        let operation_ids = request.prepared_import_ids.clone();
        let result = self.run_import_ai_checks_inner(request).await;
        self.discard_prepared_imports(&operation_ids);
        result
    }

    async fn run_import_ai_checks_inner(
        &self,
        request: skillhub_core::api::RunImportAiChecks,
    ) -> AppResult<AppCommandResult> {
        let capabilities = self.llm_capabilities()?;
        self.require_llm_capability(capabilities.safety_check, LlmTaskKind::Safety)?;
        let (runner, profile) = self.llm_context("execute.run_import_ai_checks.profile")?;
        let mut outcomes = Vec::with_capacity(request.prepared_import_ids.len());
        for id in request.prepared_import_ids {
            let prepared = self
                .prepared_imports
                .lock()
                .map_err(|_| internal("execute.run_import_ai_checks.registry"))?
                .get(&id)
                .cloned();
            let Some(prepared) = prepared else {
                outcomes.push(skillhub_core::api::ImportAiCheckOutcome {
                    prepared_import_id: id,
                    state: skillhub_core::check::CheckState::Failed,
                    finding_count: 0,
                    file_count: 0,
                    failure_code: Some(ErrorCode::ObjectNotFound.as_str().to_owned()),
                });
                continue;
            };
            let files = import_markdown_files(&prepared.candidate.absolute_root);
            let file_count = u32::try_from(files.len()).unwrap_or(u32::MAX);
            let evidence = read_import_evidence(&prepared.candidate.absolute_root, &files);
            let outcome = match evidence.and_then(|evidence| {
                skillhub_core::llm::safety::build_safety_request(
                    &skillhub_adapters::security::mask_credentials(&evidence),
                )
                .map(|request| {
                    (
                        request,
                        skillhub_core::llm::safety::SAFETY_PROMPT_VERSION.to_owned(),
                    )
                })
            }) {
                Ok((safety_request, _prompt_version)) => {
                    let model_profile = profile.clone();
                    let task_runner = runner.clone();
                    let llm = run_non_send(move || async move {
                        task_runner.run(&model_profile, safety_request).await
                    });
                    match llm.and_then(|response| {
                        skillhub_core::llm::safety::parse_safety_response(response.output, &files)
                    }) {
                        Ok(findings) => skillhub_core::api::ImportAiCheckOutcome {
                            prepared_import_id: id,
                            state: skillhub_core::check::CheckState::Passed,
                            finding_count: u32::try_from(findings.len()).unwrap_or(u32::MAX),
                            file_count,
                            failure_code: None,
                        },
                        Err(error) => skillhub_core::api::ImportAiCheckOutcome {
                            prepared_import_id: id,
                            state: skillhub_core::check::CheckState::Failed,
                            finding_count: 0,
                            file_count,
                            failure_code: Some(error.code.as_str().to_owned()),
                        },
                    }
                }
                Err(error) => skillhub_core::api::ImportAiCheckOutcome {
                    prepared_import_id: id,
                    state: skillhub_core::check::CheckState::Failed,
                    finding_count: 0,
                    file_count,
                    failure_code: Some(error.code.as_str().to_owned()),
                },
            };
            outcomes.push(outcome);
        }
        Ok(AppCommandResult::ImportAiChecksReport(
            skillhub_core::api::ImportAiChecksReport {
                provider: profile.provider.clone(),
                model: profile.model.clone(),
                requested: u32::try_from(outcomes.len()).unwrap_or(u32::MAX),
                outcomes,
            },
        ))
    }

    fn list_translations(&self, skill_id: skillhub_core::SkillId) -> AppResult<AppQueryResult> {
        let detail = self.with_database("query.list_translations.skill", |database| {
            database.catalog_repository()?.get_detail(skill_id)
        })?;
        let current_hash = detail
            .as_ref()
            .map(|detail| description_hash(&detail.original_description));
        let rows = self.with_database("query.list_translations.rows", |database| {
            database
                .translation_record_repository()
                .list_for_skill(&skill_id)
        })?;
        let translations = rows
            .into_iter()
            .map(|row| TranslationView {
                needs_update: current_hash.as_deref()
                    != Some(row.record.provenance.source_description_hash.as_str()),
                version_id: row.version_id,
                created_at: row.created_at.to_string(),
                updated_at: row.updated_at.to_string(),
                record: row.record,
            })
            .collect();
        Ok(AppQueryResult::Translations(translations))
    }

    async fn save_user_translation_revision(
        &self,
        request: skillhub_core::SaveUserTranslationRevision,
    ) -> AppResult<AppCommandResult> {
        let exists = self
            .with_database("execute.save_user_translation_revision.skill", |database| {
                database.catalog_repository()?.get_detail(request.skill_id)
            })?;
        let detail =
            exists.ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))?;
        // The UI cannot recompute the description hash; an empty hash means
        // "hash of the current original description" so a freshly typed
        // revision is not born stale.
        let source_description_hash = if request.source_description_hash.is_empty() {
            description_hash(&detail.original_description)
        } else {
            request.source_description_hash
        };
        let service = TranslationService::new(
            StorageTranslationRepository {
                database: self.database.clone(),
            },
            SharedLlmRunner(Arc::new(NoopLlmRunner)),
        );
        let skill_id = request.skill_id;
        let language = request.language;
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
        let capabilities = self.llm_capabilities()?;
        self.require_llm_capability(capabilities.online_search_assist, LlmTaskKind::SearchQuery)?;
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
        // M-31：文件系统遍历可能持续很久（首次初始化扫描整个用户目录树）。
        // 数据库句柄是全 facade 共享的单把锁，绝不能跨遍历持有——否则
        // complete_onboarding、activate_library_root 乃至 GetBootstrapSnapshot
        // 全部排在扫描后面，"完成初始化"看起来像失效。这里把持久化收敛成
        // 两个短临界区：遍历前装载上次快照，遍历后落盘新快照；遍历本身只
        // 独占 scan_service（扫描互斥），不占数据库锁。
        let previous = self.with_database("execute.scan_targets.load", |database| {
            database.scan_repository().load()
        })?;
        let result = {
            let mut scanner = self
                .scan_service
                .lock()
                .map_err(|_| internal("execute.scan_targets"))?;
            match previous {
                Some(previous) => scanner.scan_registered_with_previous(&ids, &previous)?,
                None => scanner.scan_registered(&ids)?,
            }
        };
        let stored = self.with_database("execute.scan_targets.replace", |database| {
            database.scan_repository().replace(&result)
        })?;
        // OPT-20260914-08：扫描落盘后与集中库比对，产出/更新已观察部署
        // 关系。比对只写关系表，绝不触碰用户文件。
        self.reconcile_observed_deployments(&stored)?;
        Ok(AppCommandResult::ScanResult(stored))
    }

    fn rescan_skill(
        &self,
        request: skillhub_core::api::RescanSkill,
    ) -> AppResult<AppCommandResult> {
        self.scan_scope_ids(vec![request.scope_id.clone()])?;
        let rescan_path = request.path.clone();
        let stored = self.with_database("execute.rescan_skill", |database| {
            let mut scanner = self
                .scan_service
                .lock()
                .map_err(|_| internal("execute.rescan_skill"))?;
            let result = scanner.rescan_registered_skill(&request.scope_id, request.path)?;
            database.scan_repository().replace(&result)
        })?;
        self.reconcile_observed_deployments(&stored)?;
        // 5B：单 Skill 重扫后对命中该路径的来源关系做 Light 校验。
        self.validate_relationships_after_path_change(&rescan_path);
        Ok(AppCommandResult::ScanResult(stored))
    }

    fn build_backup_input(&self, scope: BackupScope) -> AppResult<BackupInput> {
        if scope != BackupScope::Full {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("scope", "selected_skills_requires_explicit_ids")
                .with_action(RecoveryAction::ChooseAnotherName));
        }
        let library = self.library_runtime.snapshot()?;
        let portable_metadata = serde_json::to_string(&library.central.load_manifest()?)
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
        let library = self.library_runtime.snapshot()?;
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
                    // AR-025：导出完整目录内容——逐文件读出版本内容并 base64
                    // 编码；单文件上限 16 MiB、单版本累计 64 MiB，超出时诚实
                    // 报错而不是静默截断。
                    use base64::Engine as _;
                    let manifest = library.load_manifest(&version_id)?;
                    let mut files = Vec::with_capacity(manifest.entries.len());
                    let mut total_bytes: u64 = 0;
                    for entry in &manifest.entries {
                        const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
                        const MAX_VERSION_BYTES: u64 = 64 * 1024 * 1024;
                        if entry.size > MAX_FILE_BYTES {
                            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                                .with_param("skill_id", skill_id.to_string())
                                .with_param("path", entry.path.clone())
                                .with_param("reason", "export_file_too_large"));
                        }
                        total_bytes += entry.size;
                        if total_bytes > MAX_VERSION_BYTES {
                            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                                .with_param("skill_id", skill_id.to_string())
                                .with_param("reason", "export_version_too_large"));
                        }
                        let (_, file_bytes) =
                            library.read_file(&version_id, &entry.path, MAX_FILE_BYTES)?;
                        files.push(skillhub_core::ExportFile {
                            path: entry.path.clone(),
                            data_base64: base64::engine::general_purpose::STANDARD
                                .encode(file_bytes),
                        });
                    }
                    input.skills.push(skillhub_core::ExportSkill {
                        skill_id,
                        version_id,
                        content,
                        display_name,
                        files,
                    });
                }
            }
        }
        Ok(input)
    }

    fn standard_export_destination(&self) -> AppResult<PathBuf> {
        let library = self.library_runtime.snapshot()?;
        Ok(library.root.join(".skillhub").join("exports"))
    }

    /// AR-025：校验用户选择的导出输出目录——必须是已存在的目录，且宿主
    /// 已通过系统选择器为其签发路径 grant（grant_id 即规范化路径）。
    /// 未授权的路径一律拒绝，不绕过路径边界。
    fn granted_export_destination(&self, raw: &str) -> AppResult<PathBuf> {
        let canonical = std::fs::canonicalize(raw).map_err(|error| {
            AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("path", raw.to_owned())
                .with_param("source", error.to_string())
                .with_action(RecoveryAction::ChooseAnotherName)
        })?;
        if !canonical.is_dir() {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "output_dir")
                .with_action(RecoveryAction::ChooseAnotherName));
        }
        let normalized = normalize_windows_path(&canonical.to_string_lossy());
        let raw = canonical.to_string_lossy().into_owned();
        let authorized = self
            .path_grants
            .lock()
            .map_err(|_| internal("execute.standard_export.grants"))?
            .values()
            .any(|grant| {
                let id = grant.grant_id.as_str();
                let path = grant.path.as_str();
                id == normalized || path == normalized || id == raw || path == raw
            });
        if !authorized {
            return Err(AppError::new(
                skillhub_core::ErrorCode::PathOutsideAllowedRoots,
                Severity::Error,
            )
            .with_param("path", normalized)
            .with_action(RecoveryAction::InspectTarget));
        }
        Ok(canonical)
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
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "uninstall_skill");
        let result = self.apply_uninstall_decision_flow(actions).await;
        match result.as_ref() {
            // The cancel decision answers with a rolled_back summary: the
            // journal records the same terminal state the caller sees.
            Ok(AppCommandResult::OperationSummary(summary)) => {
                self.journal_advance(operation_id, "uninstall_skill", summary.phase, None)
            }
            Ok(_) => self.journal_advance(
                operation_id,
                "uninstall_skill",
                skillhub_core::OperationPhase::Committed,
                None,
            ),
            Err(error) => self.journal_advance(
                operation_id,
                "uninstall_skill",
                skillhub_core::OperationPhase::RolledBack,
                Some(error.code),
            ),
        }
        result
    }

    async fn apply_uninstall_decision_flow(
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
            let library = self.library_runtime.snapshot()?;
            let service = BackupService::new(library.root.join(".skillhub").join("backups"));
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
        let run = self
            .execute_basic_check(skill_id, version_id.clone())
            .await?;
        let result = skillhub_core::check::CheckResult {
            state: run.state(),
            run: Some(run),
        };
        Ok(AppCommandResult::BasicCheckResult(
            BasicCheckResult::from_check_result(skill_id, version_id, &result),
        ))
    }

    /// The deterministic basic check for one version, freshly executed and
    /// persisted. The AI safety check builds on it.
    async fn execute_basic_check(
        &self,
        skill_id: skillhub_core::SkillId,
        version_id: skillhub_core::VersionId,
    ) -> AppResult<CheckRun> {
        let library = self.library_runtime.snapshot()?;
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
        self.with_database("execute.run_basic_check.persist", |database| {
            database.check_repository().insert_sync(&run)
        })?;
        Ok(run)
    }

    /// The AI check always stands on a current deterministic basic run
    /// (requirement 5.36): a completed `basic-v1` run for this version is
    /// reused, anything else is re-run first.
    async fn ensure_current_basic_check(
        &self,
        skill_id: skillhub_core::SkillId,
        version_id: &skillhub_core::VersionId,
    ) -> AppResult<CheckRun> {
        let current = self.with_database("execute.run_llm_safety_check.basic", |database| {
            database.check_repository().current_for_version_sync(
                skill_id,
                version_id,
                CheckKind::Basic,
            )
        })?;
        match current {
            Some(run)
                if run.phase == CheckRunPhase::Completed
                    && run.ruleset_id.as_deref() == Some("basic-v1") =>
            {
                Ok(run)
            }
            _ => self.execute_basic_check(skill_id, version_id.clone()).await,
        }
    }

    async fn run_llm_safety_check(
        &self,
        skill_id: skillhub_core::SkillId,
        version_id: skillhub_core::VersionId,
    ) -> AppResult<AppCommandResult> {
        let capabilities = self.llm_capabilities()?;
        self.require_llm_capability(capabilities.safety_check, LlmTaskKind::Safety)?;
        let library = self.library_runtime.snapshot()?;
        let Some(runner) = self.llm_runner.clone() else {
            return Err(AppError::new(ErrorCode::LlmNotConfigured, Severity::Info));
        };
        let profile = self.with_database("execute.run_llm_safety_check.profile", |database| {
            Ok(database.llm_profile_repository().list()?.into_iter().next())
        })?;
        let Some(profile) = profile else {
            return Err(AppError::new(ErrorCode::LlmNotConfigured, Severity::Info));
        };
        // The AI check runs on top of a fresh deterministic basic check and
        // links it, so findings from both layers can be shown together.
        let basic_run = self
            .ensure_current_basic_check(skill_id, &version_id)
            .await?;
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
        // Plaintext credential values are masked before anything leaves the
        // device; the deterministic basic rules decide, not an LLM.
        let evidence = skillhub_adapters::security::mask_credentials(&evidence);
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
                        "evidence_bytes": evidence.len(),
                        "basic_run_id": basic_run.id,
                        "prompt_version": skillhub_core::llm::safety::SAFETY_PROMPT_VERSION,
                        "secret_masking": "applied",
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
        let library = self.library_runtime.snapshot().ok();
        let current = library
            .as_ref()
            .map(|library| library.current(skill_id))
            .transpose()?
            .flatten();
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
            if let Some(library) = library.as_ref() {
                if let Err(error) = library
                    .central
                    .save_portable_skill(&updated, current.as_ref())
                {
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
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "create_skill");
        let result = self.create_skill_flow(request, operation_id);
        self.journal_settle(operation_id, "create_skill", result.as_ref().err());
        result
    }

    fn create_skill_flow(
        &self,
        request: CreateSkill,
        operation_id: OperationId,
    ) -> AppResult<AppCommandResult> {
        let library = self.library_runtime.snapshot()?;
        let source = Path::new(&request.source_path);
        validate_skill_source(source)?;
        let skill = Skill::new(skillhub_core::SkillId::new(), request.name);
        skill.validate()?;
        let captured = library.capture_with_status(skill.id(), source)?;
        let version = captured.record;
        let central = &library.central;
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
                    cleanup_import_state(database, central, &library.store, skill.id(), &version),
                ));
            }
            if let Err(error) = central.materialize_current_skill(&skill, &version.id) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, central, &library.store, skill.id(), &version),
                ));
            }
            if let Err(error) = central.save_portable_skill(&skill, Some(&version.id)) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, central, &library.store, skill.id(), &version),
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
                    cleanup_import_state(database, central, &library.store, skill.id(), &version),
                ));
            }
            database
                .source_repository()
                .set_revision(skill.id(), Some(&version.manifest.tree_hash))?;
            if let Err(error) = database.record_current_version(skill.id(), &version) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, central, &library.store, skill.id(), &version),
                ));
            }
            Ok(AppCommandResult::OperationSummary(
                skillhub_core::OperationSummary {
                    operation_id,
                    phase: skillhub_core::OperationPhase::Committed,
                    message_code: "catalog.skill_created".to_owned(),
                    error_code: None,
                },
            ))
        });
        if result.is_err() && captured.created {
            // The normal error paths above clean up while the database mutex is held.
            // This guard only handles failure before entering the closure.
            let _ = library.discard_sync(&version);
        }
        result
    }

    fn create_combination(&self, request: CreateCombination) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "create_combination");
        let result = self.with_database("execute.create_combination", |database| {
            database
                .combination_repository()
                .create(&request.name, &request.members)?;
            Ok(AppCommandResult::OperationSummary(
                skillhub_core::OperationSummary {
                    operation_id,
                    phase: skillhub_core::OperationPhase::Committed,
                    message_code: "catalog.combination_created".to_owned(),
                    error_code: None,
                },
            ))
        });
        self.journal_settle(operation_id, "create_combination", result.as_ref().err());
        result
    }

    fn update_combination(&self, request: UpdateCombination) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "update_combination");
        let result = self.with_database("execute.update_combination", |database| {
            database
                .combination_repository()
                .update_members(&request.name, &request.members)?;
            Ok(AppCommandResult::OperationSummary(
                skillhub_core::OperationSummary {
                    operation_id,
                    phase: skillhub_core::OperationPhase::Committed,
                    message_code: "catalog.combination_updated".to_owned(),
                    error_code: None,
                },
            ))
        });
        self.journal_settle(operation_id, "update_combination", result.as_ref().err());
        result
    }

    fn rename_combination(&self, request: RenameCombination) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "rename_combination");
        let result = self.with_database("execute.rename_combination", |database| {
            database
                .combination_repository()
                .rename(&request.from, &request.to)
                .map(AppCommandResult::Combination)
        });
        self.journal_settle(operation_id, "rename_combination", result.as_ref().err());
        result
    }

    fn delete_combination(&self, request: DeleteCombination) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "delete_combination");
        let result = self.with_database("execute.delete_combination", |database| {
            database.combination_repository().delete(&request.name)?;
            Ok(AppCommandResult::OperationSummary(
                skillhub_core::OperationSummary {
                    operation_id,
                    phase: skillhub_core::OperationPhase::Committed,
                    message_code: "catalog.combination_deleted".to_owned(),
                    error_code: None,
                },
            ))
        });
        self.journal_settle(operation_id, "delete_combination", result.as_ref().err());
        result
    }

    fn pin_project_skill_version(
        &self,
        request: PinProjectSkillVersion,
    ) -> AppResult<AppCommandResult> {
        let library = self.library_runtime.snapshot()?;
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
        let library = self.library_runtime.snapshot()?;
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

    fn persist_upstream_check(
        &self,
        result: AppResult<AppCommandResult>,
    ) -> AppResult<AppCommandResult> {
        let result = result?;
        if let AppCommandResult::UpstreamCheckResult(check) = &result {
            self.with_database("execute.check_source_update.persist", |database| {
                database.source_repository().record_update_check(check)
            })?;
        }
        Ok(result)
    }

    fn check_source_update(&self, request: CheckSourceUpdate) -> AppResult<AppCommandResult> {
        let (skill_exists, source) =
            self.with_database("execute.check_source_update.source", |database| {
                Ok((
                    database
                        .catalog_repository()?
                        .get_sync(request.skill_id)?
                        .is_some(),
                    database.source_repository().for_skill(request.skill_id)?,
                ))
            })?;
        if !skill_exists {
            return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("skill_id", request.skill_id.to_string()));
        }
        let Some(source) = source else {
            // AR-020：没有来源记录就没有上游；本地目录不是上游来源。
            return self.persist_upstream_check(Ok(AppCommandResult::UpstreamCheckResult(
                skillhub_core::UpstreamCheckResult::new(request.skill_id, SourceState::NoUpstream),
            )));
        };
        if source.kind != skillhub_core::SourceKind::Git {
            // AR-020：本地目录来源（导入路径或用户自建）不是可检查的上游；
            // 本地文件变化由外部变化与健康检查追踪，不伪装成"来源更新"。
            return self.persist_upstream_check(Ok(AppCommandResult::UpstreamCheckResult(
                skillhub_core::UpstreamCheckResult::new(request.skill_id, SourceState::NoUpstream),
            )));
        }
        // 远端 git 来源（含 N7a 记录的仓库导入坐标）：拉取远端归档做哈希对比。
        self.persist_upstream_check(self.check_remote_source_update(request.skill_id))
    }

    /// 读取 Skill 的 UpstreamOrigin 坐标，经仓库归档下载把远端 Skill 目录
    /// 取回到调用方持有的临时工作区。check 与 apply 的远端路径共用，
    /// 保证"检查到什么"和"采用到什么"是同一条下载管线。
    /// AR-021 口径对齐：远端对比基线优先取最新 release/tag 的归档
    /// （/archive/refs/tags/{tag}.zip），并返回 tag 作为"来源版本"；
    /// 无 release（tag 抓取为 None）时回退分支归档（tag 为 None）。
    /// 下载是异步阻塞操作：在独立线程上跑临时 current-thread runtime，
    /// 产物落到调用方持有的临时目录。
    fn fetch_remote_source_dir(
        &self,
        skill_id: skillhub_core::SkillId,
        workspace_path: &std::path::Path,
    ) -> AppResult<(std::path::PathBuf, Option<String>)> {
        self.ensure_network_enabled()?;
        let unavailable = || {
            AppError::new(ErrorCode::OperationConflict, Severity::Warning)
                .with_param("reason", "source_unavailable")
                .with_param("skill_id", skill_id.to_string())
        };
        let Some(upstream) = self
            .with_database("execute.check_source_update.upstream", |database| {
                database.source_repository().upstream_for_skill(skill_id)
            })?
        else {
            return Err(unavailable());
        };
        let Some((owner, name)) = parse_github_repo_url(&upstream.url) else {
            return Err(unavailable());
        };
        let repo = skillhub_core::source::SkillRepo {
            owner,
            name,
            branch: upstream.branch.clone(),
            enabled: true,
        };
        if self.repo_provider().validate_repo(&repo).is_err() {
            return Err(unavailable());
        }
        let provider = Arc::clone(&*self.repo_provider());
        let directory = upstream.directory.clone();
        let workspace = workspace_path.to_path_buf();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| anyhow::anyhow!("runtime: {error}"))?;
            runtime.block_on(async {
                // 取数口径：release tag 归档优先；无 release 回退分支归档。
                let tag: Option<String> = provider
                    .fetch_latest_release_tag(&repo)
                    .await
                    .ok()
                    .flatten();
                let dir: std::path::PathBuf = match &tag {
                    Some(tag) => {
                        provider
                            .download_tag_skill_directory(
                                &repo.owner,
                                &repo.name,
                                tag,
                                &directory,
                                &workspace,
                            )
                            .await?
                    }
                    None => {
                        provider
                            .download_skill_directory(&repo, &directory, &workspace)
                            .await?
                    }
                };
                Ok::<_, anyhow::Error>((dir, tag))
            })
        })
        .join()
        .map_err(|_| internal("execute.check_source_update.remote_fetch"))?
        .map_err(|_| unavailable())
    }

    /// N7b：远端 git 来源的更新检测。读取 N7a 记录的 UpstreamOrigin 坐标，
    /// 经仓库归档下载定位远端 Skill 目录，与当前版本 tree_hash 对比：
    /// 一致 → UpToDate；不一致 → UpdateAvailable（无本地改动维度可判定，
    /// 不伪造 UpdateAvailableWithLocalChanges）。任何远端不可达/坐标缺失都
    /// 诚实降级为 SourceUnavailable。
    fn check_remote_source_update(
        &self,
        skill_id: skillhub_core::SkillId,
    ) -> AppResult<AppCommandResult> {
        let library = self.library_runtime.snapshot()?;
        let unavailable = || {
            Ok(AppCommandResult::UpstreamCheckResult(
                skillhub_core::UpstreamCheckResult::new(skill_id, SourceState::SourceUnavailable),
            ))
        };
        let current = library.current(skill_id)?;
        let current_hash = current.as_ref().and_then(|current| {
            library
                .list(skill_id)
                .ok()
                .and_then(|records| records.into_iter().find(|record| &record.id == current))
                .map(|record| record.manifest.tree_hash)
        });
        let Some(baseline) = current_hash.clone() else {
            return unavailable();
        };
        let workspace = tempfile::tempdir().map_err(|error| {
            AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("source", error.to_string())
        })?;
        let (remote_dir, upstream_label) =
            match self.fetch_remote_source_dir(skill_id, workspace.path()) {
                Ok(pair) => pair,
                Err(_) => return unavailable(),
            };
        let remote_hash = library.hash_tree(remote_dir)?;
        let state = if remote_hash == baseline {
            SourceState::UpToDate
        } else {
            SourceState::UpdateAvailable
        };
        Ok(AppCommandResult::UpstreamCheckResult(
            skillhub_core::UpstreamCheckResult::new(skill_id, state)
                .with_versions(current, None)
                .with_upstream_label(upstream_label),
        ))
    }

    /// N8：批量来源更新检查。逐 Skill 复用单条 check_source_update（本地与
    /// 远端 git 来源都支持）；任何单条错误（未知 Skill、网络关闭、来源缺失、
    /// 远端不可达）都按项诚实降级为 SourceUnavailable——批次不整体失败，
    /// 单条问题绝不掩盖其余 Skill 的结果。
    async fn check_source_updates(&self, request: CheckSourceUpdates) -> AppResult<AppQueryResult> {
        let mut outcomes = Vec::with_capacity(request.skill_ids.len());
        for skill_id in request.skill_ids {
            let state = match self.check_source_update(CheckSourceUpdate { skill_id }) {
                Ok(AppCommandResult::UpstreamCheckResult(check)) => check.state,
                _ => SourceState::SourceUnavailable,
            };
            outcomes.push(SourceUpdateCheckOutcome { skill_id, state });
        }
        Ok(AppQueryResult::SourceUpdateChecks(outcomes))
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
        if request.decision == UpdateDecision::TakeUpstream {
            if check.state == SourceState::NoUpstream {
                // AR-020：没有上游就没有"采用上游"可执行，如实拒绝并给出
                // 可读原因，而不是笼统冲突。
                return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("reason", "no_upstream_source")
                    .with_param("skill_id", request.skill_id.to_string())
                    .with_action(RecoveryAction::Acknowledge));
            }
            if check.state != SourceState::UpdateAvailable {
                return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param(
                        "detail",
                        "upstream update would overwrite local modifications",
                    )
                    .with_action(RecoveryAction::Acknowledge));
            }
        }
        if request.decision == UpdateDecision::CreateIndependentBranch {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param(
                    "detail",
                    "independent source branches are not persisted by this facade",
                )
                .with_action(RecoveryAction::Acknowledge));
        }
        let library = self.library_runtime.snapshot()?;
        let source = self.with_database("execute.apply_source_update.source", |database| {
            database.source_repository().for_skill(request.skill_id)
        })?;
        let Some(source) = source else {
            return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("skill_id", request.skill_id.to_string())
                .with_action(RecoveryAction::ChooseAnotherName));
        };
        // AR-017：git 来源（远端坐标）的"采用上游"必须真实下载远端内容，
        // 与检查阶段共用同一条下载管线；本地路径来源才直接从路径捕获。
        // 临时工作区必须活到捕获完成，不能在 match 臂内提前释放。
        let remote_workspace = if source.locator.as_local_path().is_none() {
            Some(tempfile::tempdir().map_err(|error| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("source", error.to_string())
            })?)
        } else {
            None
        };
        let capture_source = match (&remote_workspace, source.locator.as_local_path()) {
            (_, Some(path)) => std::borrow::Cow::Borrowed(path),
            (Some(workspace), None) => std::borrow::Cow::Owned(
                self.fetch_remote_source_dir(request.skill_id, workspace.path())?
                    .0,
            ),
            (None, None) => {
                return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("reason", "source_unavailable")
                    .with_param("skill_id", request.skill_id.to_string())
                    .with_action(RecoveryAction::Retry));
            }
        };
        let capture_source = capture_source.as_ref();
        validate_skill_source(capture_source)?;
        let captured = library.capture_with_status(request.skill_id, capture_source)?;
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
        if let Err(error) = library
            .central
            .materialize_current_skill(&skill, &version.id)
        {
            let _ = restore_version_pointer(&library.store, request.skill_id, check.local_version);
            if captured.created {
                let _ = library.discard_sync(&version);
            }
            return Err(error);
        }
        if let Err(error) = library
            .central
            .save_portable_skill(&skill, Some(&version.id))
        {
            let _ = restore_version_pointer(&library.store, request.skill_id, check.local_version);
            if captured.created {
                let _ = library.discard_sync(&version);
            }
            return Err(error);
        }
        self.with_database("execute.apply_source_update.persist", |database| {
            let source_repository = database.source_repository();
            source_repository.set_revision(request.skill_id, Some(&version.manifest.tree_hash))?;
            source_repository.record_update_check(
                &skillhub_core::UpstreamCheckResult::new(request.skill_id, SourceState::UpToDate)
                    .with_versions(Some(version.id.clone()), Some(version.id.clone())),
            )
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
                    request.user_purpose,
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
        let library = self.library_runtime.snapshot()?;
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
        if let Err(error) = library
            .central
            .materialize_current_skill(&skill, &request.version_id)
        {
            let rollback = match previous.clone() {
                Some(previous) => library.set_current(request.skill_id, &previous),
                None => library.clear_current(request.skill_id),
            };
            return Err(cleanup_import_error(error, rollback));
        }
        if let Err(error) = library
            .central
            .save_portable_skill(&skill, Some(&request.version_id))
        {
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
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "save_skill_content");
        let result = self.save_skill_content_flow(request, operation_id);
        self.journal_settle(operation_id, "save_skill_content", result.as_ref().err());
        result
    }

    fn save_skill_content_flow(
        &self,
        request: SaveSkillContent,
        operation_id: OperationId,
    ) -> AppResult<AppCommandResult> {
        let library = self.library_runtime.snapshot()?;
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
        if let Err(error) = library
            .central
            .materialize_current_skill(&skill, &version.id)
        {
            let rollback =
                restore_version_pointer(&library.store, request.skill_id, previous.clone());
            let cleanup = rollback.and_then(|()| {
                if captured.created {
                    library.discard_sync(&version)
                } else {
                    Ok(())
                }
            });
            return Err(cleanup_import_error(error, cleanup));
        }
        if let Err(error) = library
            .central
            .save_portable_skill(&skill, Some(&version.id))
        {
            let rollback = restore_version_pointer(&library.store, request.skill_id, previous);
            let cleanup = rollback.and_then(|()| {
                if captured.created {
                    library.discard_sync(&version)
                } else {
                    Ok(())
                }
            });
            return Err(cleanup_import_error(error, cleanup));
        }
        if let Err(error) = self.with_database("execute.save_skill_content.persist", |database| {
            database.record_current_version(request.skill_id, &version)
        }) {
            let rollback =
                restore_version_pointer(&library.store, request.skill_id, previous.clone());
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
                operation_id,
                phase: skillhub_core::OperationPhase::Committed,
                message_code: "catalog.version_saved".to_owned(),
                error_code: None,
            },
        ))
    }

    fn save_markdown_content(&self, request: SaveMarkdownContent) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "save_markdown_content");
        let result = self.save_markdown_content_flow(request);
        self.journal_settle(operation_id, "save_markdown_content", result.as_ref().err());
        result
    }

    fn save_markdown_content_flow(
        &self,
        request: SaveMarkdownContent,
    ) -> AppResult<AppCommandResult> {
        let library = self.library_runtime.snapshot()?;
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
            if let Err(error) = library
                .central
                .materialize_current_skill(&skill, &version.id)
            {
                let rollback = restore_version_pointer(
                    &library.store,
                    request.skill_id,
                    Some(current.clone()),
                );
                let cleanup = rollback.and_then(|()| {
                    if captured.created {
                        library.discard_sync(&version)
                    } else {
                        Ok(())
                    }
                });
                return Err(cleanup_import_error(error, cleanup));
            }
            if let Err(error) = library
                .central
                .save_portable_skill(&skill, Some(&version.id))
            {
                let rollback = restore_version_pointer(
                    &library.store,
                    request.skill_id,
                    Some(current.clone()),
                );
                let cleanup = rollback.and_then(|()| {
                    if captured.created {
                        library.discard_sync(&version)
                    } else {
                        Ok(())
                    }
                });
                return Err(cleanup_import_error(error, cleanup));
            }
            if let Err(error) = self
                .with_database("execute.save_markdown_content.persist", |database| {
                    database.record_current_version(request.skill_id, &version)
                })
            {
                let rollback = restore_version_pointer(
                    &library.store,
                    request.skill_id,
                    Some(current.clone()),
                );
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

    fn save_markdown_as_copy(&self, request: SaveMarkdownAsCopy) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "save_markdown_as_copy");
        let result = self.save_markdown_as_copy_flow(request);
        self.journal_settle(operation_id, "save_markdown_as_copy", result.as_ref().err());
        result
    }

    fn save_markdown_as_copy_flow(
        &self,
        request: SaveMarkdownAsCopy,
    ) -> AppResult<AppCommandResult> {
        let library = self.library_runtime.snapshot()?;
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
        let skill = self.with_database("execute.save_markdown_as_copy", |database| {
            database
                .catalog_repository()?
                .get_sync(request.skill_id)?
                .ok_or_else(|| {
                    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                        .with_param("skill_id", request.skill_id.to_string())
                        .with_action(RecoveryAction::Retry)
                })
        })?;
        let copy = Skill::from_parts(
            skillhub_core::SkillId::new(),
            format!("{} (copy)", skill.display_name()),
            format!("{}-copy", skill.runtime_name()),
            skill.original_description().to_owned(),
            skill.translated_description().map(str::to_owned),
            skill.note().map(str::to_owned),
            skill.user_purpose().map(str::to_owned),
            skill.tags().clone(),
            skill.author().map(str::to_owned),
            skill.license().map(str::to_owned),
            skill.call_policy(),
            skill.lifecycle(),
            skill.requirements().to_vec(),
            skill.trial_due(),
        )?;
        let staging =
            std::env::temp_dir().join(format!("skillhub-markdown-copy-{}", OperationId::new()));
        let result = (|| {
            library.materialize(&current, &staging)?;
            let target = staging.join(&relative);
            std::fs::write(&target, request.markdown.as_bytes()).map_err(|error| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("source", error.to_string())
                    .with_action(RecoveryAction::Retry)
            })?;
            let captured = library.capture_with_status(copy.id(), &staging)?;
            let version = captured.record;
            self.with_database("execute.save_markdown_as_copy.commit", |database| {
                if let Err(error) = database.catalog_repository()?.insert_sync(&copy) {
                    return Err(cleanup_import_error(
                        error,
                        if captured.created {
                            library.discard_sync(&version)
                        } else {
                            Ok(())
                        },
                    ));
                }
                if let Err(error) = library.set_current(copy.id(), &version.id) {
                    return Err(cleanup_import_error(
                        error,
                        cleanup_import_state(
                            database,
                            &library.central,
                            &library.store,
                            copy.id(),
                            &version,
                        ),
                    ));
                }
                if let Err(error) = library
                    .central
                    .materialize_current_skill(&copy, &version.id)
                {
                    return Err(cleanup_import_error(
                        error,
                        cleanup_import_state(
                            database,
                            &library.central,
                            &library.store,
                            copy.id(),
                            &version,
                        ),
                    ));
                }
                if let Err(error) = library
                    .central
                    .save_portable_skill(&copy, Some(&version.id))
                {
                    return Err(cleanup_import_error(
                        error,
                        cleanup_import_state(
                            database,
                            &library.central,
                            &library.store,
                            copy.id(),
                            &version,
                        ),
                    ));
                }
                if let Err(error) = database.record_current_version(copy.id(), &version) {
                    return Err(cleanup_import_error(
                        error,
                        cleanup_import_state(
                            database,
                            &library.central,
                            &library.store,
                            copy.id(),
                            &version,
                        ),
                    ));
                }
                let (content_identity, _) =
                    library.read_file(&version.id, &request.path, 1_048_576)?;
                Ok(AppCommandResult::SavedSkillContent(SavedSkillContent {
                    skill_id: copy.id(),
                    path: request.path.clone(),
                    version_id: version.id,
                    content_identity,
                }))
            })
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
                let result = self.with_database("execute.set_desktop_preferences", |database| {
                    database
                        .desktop_settings_repository()
                        .save(&preferences)
                        .map(AppCommandResult::DesktopPreferences)
                });
                self.network_gate.set_open(preferences.network_enabled);
                return result;
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
            AppCommand::CommitDeploymentPreview(request) => {
                return self.commit_deployment_preview(request).await
            }
            AppCommand::CommitDeployment(request) => {
                return self.commit_deployment(request.prepared_deployment_id).await
            }
            AppCommand::PrepareImport(request) => return self.prepare_import(request),
            AppCommand::BeginImportBatch(_) => return self.begin_import_batch(),
            AppCommand::FinalizeImportBatch(request) => return self.finalize_import_batch(request),
            AppCommand::RunRelationshipCheck(request) => {
                return self.run_relationship_check(request)
            }
            AppCommand::CommitImport(request) => return self.commit_import(request),
            AppCommand::PrepareOriginalMigration(request) => {
                return self.prepare_original_migration(request)
            }
            AppCommand::RetainSourceCopy(request) => return self.retain_source_copy(request),
            AppCommand::RelinkSourceCopy(request) => return self.relink_source_copy(request),
            AppCommand::CommitOriginalMigration(request) => {
                return self.commit_original_migration(request)
            }
            AppCommand::RollbackOriginalMigration(request) => {
                return self.rollback_original_migration(request)
            }
            AppCommand::PrepareRelationMigration(request) => {
                return self.prepare_relation_migration(request)
            }
            AppCommand::CommitRelationMigration(request) => {
                return self.commit_relation_migration(request).await
            }
            AppCommand::RollbackRelationMigration(request) => {
                return self.rollback_relation_migration(request).await
            }
            AppCommand::PrepareRelationGovernanceBatch(request) => {
                return self.prepare_relation_governance_batch(request)
            }
            AppCommand::CommitRelationGovernanceBatch(request) => {
                return self.commit_relation_governance_batch(request).await
            }
            AppCommand::RollbackRelationGovernanceBatch(request) => {
                return self.rollback_relation_governance_batch(request).await
            }
            AppCommand::CancelImport { prepared_import_id } => {
                return self.cancel_import(prepared_import_id)
            }
            AppCommand::PrepareUndeploy(request) => {
                return self.prepare_undeploy(request.deployment_id).await;
            }
            AppCommand::PrepareDeleteSkill(request) => {
                return self.prepare_delete_skill(request.skill_id).await;
            }
            AppCommand::CommitDeleteSkill(request) => {
                let decisions = request
                    .decisions
                    .into_iter()
                    .map(|choice| (choice.deployment_id, choice.decision))
                    .collect();
                return self
                    .commit_delete_skill(request.prepared_delete_id, decisions)
                    .await;
            }
            AppCommand::CommitUndeploy(request) => {
                return self
                    .commit_undeploy(request.prepared_undeploy_id, request.decision)
                    .await;
            }
            AppCommand::DetachManagement(request) => {
                return self.detach_management(request.deployment_id).await;
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
                return self.remove_ignore_rule(request.rule_id).await;
            }
            AppCommand::CollectDeploymentChanges(request) => {
                return self.reconcile_collect_changes(request.deployment_id).await;
            }
            AppCommand::RestoreDeployment(request) => {
                return self.reconcile_restore(request.deployment_id).await;
            }
            AppCommand::KeepIndependentCopy(request) => {
                return self.reconcile_keep_independent(request.deployment_id).await;
            }
            AppCommand::IgnoreExternalChange(request) => {
                return self
                    .reconcile_ignore_external_change(request.deployment_id)
                    .await;
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
            AppCommand::ActivateLibraryRoot(request) => return self.activate_library_root(request),
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
            AppCommand::RenameCombination(request) => return self.rename_combination(request),
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
            AppCommand::SetVersionLabel(request) => {
                return self.set_version_label(request).await;
            }
            AppCommand::AddSkillRepo(request) => return self.add_skill_repo(request),
            AppCommand::RemoveSkillRepo(request) => return self.remove_skill_repo(request),
            AppCommand::RefreshSkillRepo(request) => {
                return self.refresh_skill_repo(request).await;
            }
            AppCommand::DownloadRepoSkill(request) => {
                return self.download_repo_skill(request).await;
            }
            AppCommand::SaveSearchCandidates(request) => {
                return self.save_search_candidates(request);
            }
            AppCommand::ConfirmSearchCandidate(request) => {
                return self.confirm_search_candidate(request);
            }
            AppCommand::DismissSearchCandidate(request) => {
                return self.dismiss_search_candidate(request);
            }
            AppCommand::CheckSourceUpdate(request) => return self.check_source_update(request),
            AppCommand::ApplySourceUpdate(request) => return self.apply_source_update(request),
            AppCommand::SetMetadata(request) => return self.set_metadata(request),
            AppCommand::SetLifecycle(request) => return self.set_lifecycle(request),
            AppCommand::SetTrial(request) => return self.set_trial(request),
            AppCommand::SetCurrentVersion(request) => return self.set_current_version(request),
            AppCommand::SaveSkillContent(request) => return self.save_skill_content(request),
            AppCommand::SaveMarkdownContent(request) => return self.save_markdown_content(request),
            AppCommand::SaveMarkdownAsCopy(request) => return self.save_markdown_as_copy(request),
            AppCommand::PrepareBackup(request) => {
                let input = self.build_backup_input(request.scope)?;
                let library = self.library_runtime.snapshot()?;
                let plan = BackupService::new(library.root.join(".skillhub").join("backups"))
                    .prepare(&input)?;
                return Ok(AppCommandResult::BackupPlan(plan));
            }
            AppCommand::CreateBackup(request) => {
                let input = self.build_backup_input(request.scope)?;
                let library = self.library_runtime.snapshot()?;
                let service = BackupService::new(library.root.join(".skillhub").join("backups"));
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
                let library = self.library_runtime.snapshot()?;
                let plan = RestoreService::new(library.root.clone()).prepare(&package)?;
                return Ok(AppCommandResult::RestorePlan(plan));
            }
            AppCommand::PrepareInitialRestore(request) => {
                return self.prepare_initial_restore(request);
            }
            AppCommand::CommitRestore(request) => {
                let package = Self::backup_package(request.path)?;
                let library = self.library_runtime.snapshot()?;
                let service = RestoreService::new(library.root.clone());
                let plan = service.prepare(&package)?;
                let decisions = request
                    .decisions
                    .into_iter()
                    .map(|decision| (decision.skill_id, decision.decision))
                    .collect::<Vec<_>>();
                let result = service.commit(&package, &plan, &decisions)?;
                return Ok(AppCommandResult::RestoreResult(result));
            }
            AppCommand::CommitInitialRestore(request) => {
                return self.commit_initial_restore(request);
            }
            AppCommand::RunRollingBackup(request) => {
                let input = self.build_backup_input(request.scope)?;
                let library = self.library_runtime.snapshot()?;
                let backup = BackupService::new(library.root.join(".skillhub").join("backups"));
                let plan = backup.prepare(&input)?;
                let decisions = request
                    .decisions
                    .into_iter()
                    .map(|decision| (decision.skill_id, decision.decision))
                    .collect::<Vec<_>>();
                let package = backup.create(&input, &plan, &decisions)?;
                backup.verify(&package)?;
                let retention =
                    RetentionService::new(library.root.join(".skillhub").join("backups"))
                        .apply(request.retention)?;
                return Ok(AppCommandResult::BackupRetentionResult(retention));
            }
            AppCommand::PrepareStandardExport(request) => {
                let input = self.export_input(request.input)?;
                let service = ExportService::new(self.standard_export_destination()?);
                return service.prepare(&input).map(AppCommandResult::ExportPlan);
            }
            AppCommand::CreateStandardExport(request) => {
                // AR-025：用户可通过系统选择器指定输出目录（宿主在拾取时
                // 已签发路径 grant）；未指定时仍写集中库导出目录。
                let destination = match request.input.output_dir.as_deref() {
                    Some(dir) if !dir.trim().is_empty() => self.granted_export_destination(dir)?,
                    _ => self.standard_export_destination()?,
                };
                let input = self.export_input(request.input)?;
                let service = ExportService::new(destination);
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
            AppCommand::AnalyzeConflict(request) => {
                return self.analyze_conflict(request.scope).await;
            }
            AppCommand::ResolveConflictCase(request) => {
                return self.resolve_conflict_case(request);
            }
            AppCommand::TranslateDescription(request) => {
                return self.translate_description(request).await;
            }
            AppCommand::TranslateDescriptionsBatch(request) => {
                return self.translate_descriptions_batch(request).await;
            }
            AppCommand::SaveUserTranslationRevision(request) => {
                return self.save_user_translation_revision(request).await;
            }
            AppCommand::GenerateOnlineSearchQuery(request) => {
                return self.generate_online_search_query(request.text).await;
            }
            AppCommand::SaveLlmProvider(request) => {
                return self.save_llm_provider(request).await;
            }
            AppCommand::DeleteLlmProvider(request) => {
                return self.delete_llm_provider(request).await;
            }
            AppCommand::ClearLlmProviderCredential(request) => {
                return self.clear_llm_provider_credential(request).await;
            }
            AppCommand::SetLlmProviderEnabled(request) => {
                return self.set_llm_provider_enabled(request).await;
            }
            AppCommand::SetDefaultLlmProvider(request) => {
                return self.set_default_llm_provider(request);
            }
            AppCommand::FetchLlmModels(request) => {
                return self.fetch_llm_models(request).await;
            }
            AppCommand::TestLlmConnection(request) => {
                return self.test_llm_connection(request).await;
            }
            AppCommand::RunImportAiChecks(request) => {
                return self.run_import_ai_checks(request).await;
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
            AppQuery::SearchOnlineSourcesAssisted(request) => {
                self.search_online_sources_assisted(request).await
            }
            AppQuery::ListSearchCandidates(_) => {
                self.with_database("query.list_search_candidates", |database| {
                    let candidates = database.search_candidate_repository().list()?;
                    Ok(AppQueryResult::SearchCandidates(candidates))
                })
            }
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
                // P1-06 口径：`instances[].kind` 是证据型枚举，只来自 profile 声明
                // （证据链 = official_references + research_date）；`available` 仅为
                // 目录存在/可读/可写的文件系统证据，`client_presence` 恒为 Unknown
                // ——后端不声称、也不伪造运行时可判定性。同物理目录的多个
                // logical target 已由适配器归并进同一 physical_target。
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
            AppQuery::ListDeterministicDuplicates(request) => {
                let entries =
                    self.with_database("query.list_deterministic_duplicates", |database| {
                        database
                            .bootstrap_repository()
                            .list_deterministic_duplicates(&request.skill_id.to_string())
                    })?;
                let mut parsed = Vec::with_capacity(entries.len());
                for (entry_skill_id, label, content_hash) in entries {
                    parsed.push(skillhub_core::api::DeterministicDuplicateEntry {
                        skill_id: entry_skill_id
                            .parse::<skillhub_core::SkillId>()
                            .map_err(|_| internal("query.deterministic_duplicates.parse"))?,
                        label,
                        content_hash,
                    });
                }
                Ok(AppQueryResult::DeterministicDuplicates(parsed))
            }
            AppQuery::ListPendingItems(_) => {
                let items = self.with_database("query.list_pending_items", |database| {
                    database.bootstrap_repository().list_pending(self.today)
                })?;
                let rules = self.ignore_service.list().await?;
                Ok(AppQueryResult::PendingItems(filter_pending_items(
                    items, &rules, self.today,
                )))
            }
            AppQuery::GetSkill(request) => {
                let skill_id = request.skill_id;
                let current_version = self
                    .library_runtime
                    .snapshot()
                    .ok()
                    .and_then(|library| library.current(skill_id).ok())
                    .flatten();
                // QA-010：可读标签在详情查询前计算，哈希不进入展示层。
                let current_version_label = match current_version.as_ref() {
                    Some(version_id) => {
                        self.readable_current_version_label(skill_id, version_id)?
                    }
                    None => None,
                };
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
                        user_purpose: skill.user_purpose,
                        tags: skill.tags,
                        author: skill.author,
                        license: skill.license,
                        lifecycle: skill.lifecycle,
                        trial_due: skill.trial_due,
                        current_version,
                        current_version_label,
                        invocation_policy: skill.invocation_policy,
                        declared_requirements: skill.declared_requirements,
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
                let candidate = request.candidate;
                let tree_hash = self.candidate_tree_hash(&candidate, request.tree_hash.as_deref());
                self.with_database("query.analyze_import", |database| {
                    let facts = Self::import_source_facts(database, &candidate)?;
                    database
                        .import_repository()
                        .analyze(candidate, tree_hash.as_deref(), &facts)
                        .map(AppQueryResult::ImportAnalysis)
                })
            }
            AppQuery::DiscoverImportCandidates(request) => {
                let source = request.source;
                let root = match source.locator.as_local_path().cloned() {
                    Some(root) => root,
                    None => self.acquire_import_source(&source).await?,
                };
                // 获取上下文只能来自获取流程的显式盖章；本地目录是直接来源。
                let acquired = serde_json::to_string(&source).ok().and_then(|cache_key| {
                    self.acquired_import_sources
                        .lock()
                        .ok()?
                        .get(&cache_key)
                        .map(|acquired| acquired.workspace_kind)
                });
                let acquisition = acquired
                    .map(|workspace_kind| skillhub_core::ImportAcquisitionContext {
                        workspace_kind,
                        workspace_path: None,
                    })
                    .or_else(|| {
                        source.locator.as_local_path().map(|_| {
                            skillhub_core::ImportAcquisitionContext {
                                workspace_kind:
                                    skillhub_core::AcquisitionWorkspaceKind::DirectSource,
                                workspace_path: None,
                            }
                        })
                    });
                let mut candidates = SkillDetector::default().detect_with_context(
                    root.clone(),
                    source.clone(),
                    acquisition,
                )?;
                // DEV-3：读取每个候选的 SKILL.md frontmatter `name`，供界面
                // 在「文件夹名 ≠ frontmatter name」时给出非阻塞警告；读取
                // 失败或缺省字段保持 None（诚实缺省），绝不据此拒绝导入。
                for candidate in &mut candidates {
                    let marker_path =
                        std::path::Path::new(&candidate.absolute_root).join(&candidate.marker);
                    if let Ok(content) = std::fs::read_to_string(&marker_path) {
                        candidate.frontmatter_name = read_frontmatter_name(&content);
                    }
                }
                // 仓库发现下载目录 → 给候选盖上长期上游坐标，随 prepare/commit 原样回流。
                if let Ok(registry) = self.upstream_origins.lock() {
                    let key = root.to_string_lossy().to_string();
                    if let Some(origin) = registry.get(&key) {
                        for candidate in &mut candidates {
                            candidate.upstream = Some(origin.clone());
                        }
                    }
                }
                // 权威来源分类只在应用层发生：下载缓存/上游注册路径一律
                // Online，本地路径按目录证据归类；结果固化供提交阶段取回。
                let central_root = self
                    .library_runtime
                    .snapshot()
                    .ok()
                    .map(|library| library.root.to_string_lossy().into_owned());
                let mut classifications = Vec::with_capacity(candidates.len());
                for candidate in &mut candidates {
                    let classified = if candidate.upstream.is_some() {
                        candidate.source_class = Some(skillhub_core::ImportSourceClass::Online);
                        candidate.acquisition = Some(skillhub_core::ImportAcquisitionContext {
                            workspace_kind: skillhub_core::AcquisitionWorkspaceKind::TemporaryCache,
                            workspace_path: None,
                        });
                        ClassifiedImportSource {
                            source_class: skillhub_core::ImportSourceClass::Online,
                            physical_source_id: None,
                            source_container_id: None,
                            agent_client_id: None,
                        }
                    } else {
                        let classified = self.with_database(
                            "query.discover_import_candidates.classify",
                            |database| {
                                Self::classify_import_source(
                                    database,
                                    &candidate.source,
                                    &candidate.absolute_root,
                                    central_root.as_deref(),
                                )
                            },
                        )?;
                        candidate.source_class = Some(classified.source_class);
                        candidate.source_container_id = classified.source_container_id.clone();
                        classified
                    };
                    classifications.push((observed_path_key(&candidate.absolute_root), classified));
                }
                if let Ok(mut registry) = self.import_source_classifications.lock() {
                    for (key, classified) in classifications {
                        registry.insert(key, classified);
                    }
                }
                Ok(AppQueryResult::ImportCandidates(candidates))
            }
            AppQuery::QueryOpenImportBatch(_) => {
                self.with_database("query.open_import_batches", |database| {
                    let batches = database
                        .provenance_repository()
                        .list_open_import_batches()?
                        .into_iter()
                        .map(
                            |(batch_id, started_at)| skillhub_core::api::OpenImportBatch {
                                batch_id,
                                started_at,
                            },
                        )
                        .collect();
                    Ok(AppQueryResult::OpenImportBatches(batches))
                })
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
            AppQuery::ListLlmProviders => self.list_llm_providers().await,
            AppQuery::ListTranslations(request) => self.list_translations(request.skill_id),
            AppQuery::ListLlmProviderPresets => self.list_llm_provider_presets(),
            AppQuery::CheckSourceUpdates(request) => self.check_source_updates(request).await,
            AppQuery::DiffVersions(request) => self.diff_versions(&request.left, &request.right),
            AppQuery::ListDeployments(request) => self.list_deployments(request.skill_id),
            AppQuery::GetDeploymentRelations(request) => {
                self.list_deployment_relations(request.skill_id)
            }
            AppQuery::GetSkillProvenance(request) => self
                .skill_provenance(request.skill_id)
                .map(AppQueryResult::SkillProvenance),
            AppQuery::GetRemovalImpact(request) => self
                .removal_service
                .prepare_delete(request.skill_id)
                .await
                .map(AppQueryResult::RemovalImpact),
            AppQuery::GetRelationshipOverview(request) => {
                self.get_relationship_overview(request.scope)
            }
            AppQuery::GetRelationshipRemovalImpact(request) => {
                self.get_relationship_removal_impact(&request.relation_id)
            }
            AppQuery::GetSkillRelationshipGraph(request) => {
                self.get_skill_relationship_graph(request)
            }
            AppQuery::ListSkillRelationshipCandidates(request) => {
                self.list_skill_relationship_candidates(request)
            }
            AppQuery::GetConflictWorkspace(_) => self.get_conflict_workspace(),
            AppQuery::ListRelationGovernance(request) => self.list_relation_governance(request),
            AppQuery::ListGovernanceHistory(request) => self.list_governance_history(request),
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
            AppQuery::GetDeploymentBatchPreview(request) => {
                self.get_deployment_batch_preview(request)
            }
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
        let host_capabilities = DeploymentFilesystem::new().available_capabilities();
        let modes = offered_modes(&host_capabilities);
        self.with_database("query.list_deployment_targets", |database| {
            let mut targets: Vec<skillhub_core::api::DeploymentTarget> = database
                .agent_repository()
                .load()?
                .map(|snapshot| {
                    let mut targets = Vec::new();
                    let mut targets_by_physical_id = BTreeMap::new();
                    for target in snapshot.logical_targets {
                        targets_by_physical_id
                            .entry(target.physical_id.clone())
                            .or_insert_with(Vec::new)
                            .push(target);
                    }
                    for (_, mut physical_targets) in targets_by_physical_id {
                        physical_targets.sort_by(|left, right| left.id.cmp(&right.id));
                        let is_shared_directory = physical_targets
                            .iter()
                            .any(|target| target.shared_reference);
                        if !is_shared_directory {
                            for target in physical_targets {
                                let modes = offered_modes(&effective_target_capabilities(
                                    &target.client_id,
                                    &host_capabilities,
                                ));
                                targets.push(skillhub_core::api::DeploymentTarget {
                                    id: target.id,
                                    label: target.client_id.clone(),
                                    path: target.path,
                                    available: target.available,
                                    physical_id: target.physical_id,
                                    modes,
                                    agent_client_id: Some(target.client_id),
                                    agent_profile_id: Some(target.profile_id),
                                    shared_directory: false,
                                    shared_agent_brands: Vec::new(),
                                });
                            }
                            continue;
                        }
                        // The directory's own generic profile is the canonical
                        // deployment entry. Every brand that recognises that physical
                        // directory is metadata on this one selectable target.
                        let canonical = physical_targets
                            .iter()
                            .find(|target| target.profile_id == "agent-skills")
                            .unwrap_or_else(|| {
                                physical_targets
                                    .first()
                                    .expect("physical target group is never empty")
                            });
                        let modes = offered_modes(&effective_target_capabilities(
                            &canonical.client_id,
                            &host_capabilities,
                        ));
                        let mut shared_agent_brands = physical_targets
                            .iter()
                            .filter(|target| target.profile_id != "agent-skills")
                            .map(|target| target.profile_id.clone())
                            .collect::<Vec<_>>();
                        shared_agent_brands.sort();
                        shared_agent_brands.dedup();
                        targets.push(skillhub_core::api::DeploymentTarget {
                            id: canonical.id.clone(),
                            label: canonical.client_id.clone(),
                            path: canonical.path.clone(),
                            available: canonical.available,
                            physical_id: canonical.physical_id.clone(),
                            modes,
                            agent_client_id: Some(canonical.client_id.clone()),
                            agent_profile_id: None,
                            shared_directory: true,
                            shared_agent_brands,
                        });
                    }
                    targets
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
                            agent_client_id: None,
                            agent_profile_id: None,
                            shared_directory: false,
                            shared_agent_brands: Vec::new(),
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
        let result = self.deployment_service.prepare(plan).await;
        match result.as_ref() {
            Ok(prepared) => self.journal_prepared(prepared.id, "deploy_skill"),
            Err(error) => self.journal_advance(
                OperationId::new(),
                "deploy_skill",
                skillhub_core::OperationPhase::RolledBack,
                Some(error.code),
            ),
        }
        result
            .map(Box::new)
            .map(AppCommandResult::PreparedDeployment)
    }

    async fn commit_deployment(&self, id: OperationId) -> AppResult<AppCommandResult> {
        let result = self.deployment_service.commit(id).await;
        match result.as_ref() {
            Ok(summary) if summary.committed => self.journal_advance(
                id,
                "deploy_skill",
                skillhub_core::OperationPhase::Committed,
                None,
            ),
            Ok(summary) => {
                // Failure classification: the user is only asked to decide when
                // something is actually left behind.  A target the backend
                // fully undid is accounted as rolled back, so a plain rejected
                // add — a foreign directory in the way, say — no longer gates
                // the next launch.  `needs_recovery` is reserved for residue
                // the app could not clean up on its own.
                let residue = summary.targets.iter().any(|target| target.residue);
                let error_code = summary
                    .targets
                    .iter()
                    .filter_map(|target| target.error.as_ref().map(|error| error.code))
                    .next()
                    .unwrap_or(ErrorCode::InternalError);
                self.journal_advance_with_details(
                    id,
                    "deploy_skill",
                    if residue {
                        skillhub_core::OperationPhase::NeedsRecovery
                    } else {
                        skillhub_core::OperationPhase::RolledBack
                    },
                    Some(error_code),
                    serde_json::to_value(summary).ok(),
                    if residue {
                        pending_recovery_targets(summary)
                    } else {
                        serde_json::Value::Object(Default::default())
                    },
                );
            }
            // A commit that fails before touching a target (no prepared
            // deployment, a rejected revalidation) leaves nothing behind, so
            // it settles as rolled back too.
            Err(error) => self.journal_advance(
                id,
                "deploy_skill",
                skillhub_core::OperationPhase::RolledBack,
                Some(error.code),
            ),
        }
        result
            .map(Box::new)
            .map(AppCommandResult::DeploymentSummary)
    }

    fn get_deployment_plan(&self, request: DeploymentPlanRequest) -> AppResult<AppQueryResult> {
        let library = self.library_runtime.snapshot()?;
        let source_path = library
            .root
            .join("versions")
            .join(request.skill_id.to_string())
            .join(request.version_id.as_str());
        let source_path = source_path.to_string_lossy().into_owned();
        let mut input = if let Some(resolver) = self.deployment_targets.as_ref() {
            request.resolve(resolver, source_path)?
        } else {
            let resolver = self.discovery_target_index()?;
            request.resolve(&resolver, source_path)?
        };
        self.attach_target_occupancy(&input.runtime_name, &mut input.targets)?;
        let plan = skillhub_core::DeploymentPlanner.plan_request(&input)?;
        self.enforce_deployment_name_boundary(&plan)?;
        Ok(AppQueryResult::DeploymentPlan(plan))
    }

    /// Reads the deployed version's own SKILL.md and compares its `name`
    /// with the folder name agents will see.  A mismatch means agents will
    /// not recognize the deployed skill, so the plan carries a warning
    /// instead of deploying silently.
    fn enforce_deployment_name_boundary(
        &self,
        plan: &skillhub_core::DeploymentPlan,
    ) -> AppResult<()> {
        let library = self.library_runtime.snapshot()?;
        let content = match library
            .store
            .read_file(&plan.version_id, "SKILL.md", 256 * 1024)
        {
            Ok((_, bytes)) => bytes,
            Err(error) if error.code == ErrorCode::ObjectNotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let Some(frontmatter_name) = read_frontmatter_name(&String::from_utf8_lossy(&content))
        else {
            return Ok(());
        };
        if frontmatter_name == plan.runtime_name {
            return Ok(());
        }
        Err(
            AppError::new(ErrorCode::DeploymentNameMismatch, Severity::Error)
                .with_param("runtime_name", plan.runtime_name.clone())
                .with_param("declared_name", frontmatter_name)
                .with_action(RecoveryAction::ChooseAnotherName),
        )
    }

    /// Task 13B: server-owned batch deployment preview.  The client names
    /// Skills, targets and a preference; versions, runtime names, physical
    /// identities, occupancy and capabilities are all resolved here, one pair
    /// at a time, and the resulting snapshot is stored under a preview id a
    /// later commit must reference.
    fn get_deployment_batch_preview(
        &self,
        request: skillhub_core::api::GetDeploymentBatchPreview,
    ) -> AppResult<AppQueryResult> {
        let library = self.library_runtime.snapshot()?;
        let link_permission_denied = DeploymentFilesystem::new().link_unavailability_cause()
            == Some(skillhub_adapters::deployment::LinkUnavailableCause::Permission);
        let now = now_epoch_seconds();

        // One target index serves the whole batch; an injected index keeps
        // preview outcomes independent of the probing host.
        let injected = self.deployment_targets.as_ref();
        let discovered = if injected.is_none() {
            Some(self.discovery_target_index()?)
        } else {
            None
        };
        let resolve = |logical_id: &str| -> AppResult<Vec<VerifiedTarget>> {
            let ids = vec![logical_id.to_owned()];
            match injected {
                Some(index) => index.resolve(&ids),
                None => discovered
                    .as_ref()
                    .expect("discovered index exists when none is injected")
                    .resolve(&ids),
            }
        };
        let discovery_targets =
            self.with_database("query.get_deployment_batch_preview", |database| {
                Ok(database
                    .agent_repository()
                    .load()?
                    .map(|snapshot| snapshot.logical_targets)
                    .unwrap_or_default())
            })?;

        let mut pairs: Vec<skillhub_core::api::DeploymentPairPreview> = Vec::new();
        for item in &request.items {
            self.collect_batch_pair_previews(
                item,
                &library,
                &resolve,
                &discovery_targets,
                link_permission_denied,
                &mut pairs,
            )?;
        }
        // 同一物理目标在多个条目里重复出现时保留首个 pair；顺序确定化。
        pairs.sort_by(|left, right| left.pair_id.cmp(&right.pair_id));
        pairs.dedup_by(|left, right| left.pair_id == right.pair_id);
        for pair in &mut pairs {
            pair.confirmation_preserved = request
                .confirmations
                .get(&pair.pair_id)
                .map(|held| *held == pair.confirmation_fingerprint)
                .unwrap_or(false);
        }
        let preserved_confirmation_ids = pairs
            .iter()
            .filter(|pair| pair.confirmation_preserved)
            .map(|pair| pair.pair_id.clone())
            .collect::<Vec<_>>();

        let preview_id = OperationId::new().to_string();
        let payload = serde_json::to_string(&pairs)
            .map_err(|_| internal("query.get_deployment_batch_preview"))?;
        self.with_database("query.get_deployment_batch_preview", |database| {
            database.deployment_preview_repository().insert(
                &skillhub_storage::DeploymentPreviewSnapshot {
                    preview_id: preview_id.clone(),
                    payload_json: payload,
                    status: "active".to_owned(),
                    created_at: now,
                    expires_at: now + DEPLOYMENT_PREVIEW_TTL_SECONDS,
                },
            )
        })?;
        Ok(AppQueryResult::DeploymentBatchPreview(
            skillhub_core::api::DeploymentBatchPreview {
                preview_id,
                expires_at: format_rfc3339_utc(now + DEPLOYMENT_PREVIEW_TTL_SECONDS),
                pairs,
                preserved_confirmation_ids,
            },
        ))
    }

    /// Resolves one request item into per-pair previews.  Every logical
    /// target is resolved on its own so one broken target never hides the
    /// other targets of the same Skill.
    fn collect_batch_pair_previews(
        &self,
        item: &skillhub_core::api::DeploymentBatchPreviewRequestItem,
        library: &library_runtime::LibraryContext,
        resolve: &dyn Fn(&str) -> AppResult<Vec<VerifiedTarget>>,
        discovery_targets: &[skillhub_core::LogicalTarget],
        link_permission_denied: bool,
        out: &mut Vec<skillhub_core::api::DeploymentPairPreview>,
    ) -> AppResult<()> {
        let (display_name, catalog_runtime_name) =
            self.with_database("query.get_deployment_batch_preview", |database| {
                Ok(database
                    .catalog_repository()?
                    .get_identity(item.skill_id)?
                    .unwrap_or_else(|| ("Skill".into(), String::new())))
            })?;
        let projects = self.with_database("query.get_deployment_batch_preview", |database| {
            database.project_repository().list()
        })?;

        // Version: explicit, else the library's current version for the Skill.
        let version_id = match &item.version_id {
            Some(version) => version.clone(),
            None => library
                .central
                .load_portable_skill(item.skill_id)?
                .and_then(|(_, current)| current)
                .ok_or_else(|| {
                    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                        .with_param("field", "current_version")
                        .with_action(RecoveryAction::Retry)
                })?,
        };
        // Runtime name: explicit, else the version's declared SKILL.md name,
        // else the catalog runtime name.
        let runtime_name = match &item.runtime_name {
            Some(name) => name.clone(),
            None => library
                .store
                .read_file(&version_id, "SKILL.md", 256 * 1024)
                .ok()
                .and_then(|(_, bytes)| read_frontmatter_name(&String::from_utf8_lossy(&bytes)))
                .unwrap_or(catalog_runtime_name),
        };
        if runtime_name.is_empty() {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "runtime_name")
                .with_action(RecoveryAction::ChooseAnotherName));
        }

        let source_path = library
            .root
            .join("versions")
            .join(item.skill_id.to_string())
            .join(version_id.as_str());
        let mut verified: Vec<VerifiedTarget> = Vec::new();
        let mut failures: Vec<(String, AppError)> = Vec::new();
        for logical_id in &item.logical_target_ids {
            match resolve(logical_id) {
                Ok(mut targets) => verified.append(&mut targets),
                Err(error) => failures.push((logical_id.clone(), error)),
            }
        }
        self.with_database("query.get_deployment_batch_preview", |database| {
            attach_target_occupancy_with(database, &runtime_name, &mut verified)
        })?;

        // Group by physical identity; merged capabilities and the occupancy
        // snapshot come from the whole group, exactly like the planner merge.
        let mut groups: BTreeMap<String, Vec<VerifiedTarget>> = BTreeMap::new();
        for target in verified {
            groups
                .entry(target.physical_target_id().to_owned())
                .or_default()
                .push(target);
        }
        for (physical_id, mut group) in groups {
            let occupancy = group
                .iter()
                .flat_map(|target| target.existing().iter().cloned())
                .collect::<Vec<_>>();
            let capabilities = merged_capabilities_of(&group);
            let target_path = group
                .first()
                .map(|target| target.path().to_owned())
                .unwrap_or_default();
            let group_logical_ids = group
                .iter()
                .flat_map(|target| target.logical_target_ids().iter().cloned())
                .collect::<Vec<_>>();
            let automatic = DeploymentPlanner.plan(DeploymentPlanInput::new(
                item.skill_id,
                version_id.clone(),
                runtime_name.clone(),
                source_path.to_string_lossy().into_owned(),
                std::mem::take(&mut group),
            ));
            let (technical_error, mode, change, conflicts, warnings, logical_target_ids) =
                match automatic {
                    Ok(plan) => {
                        let target = plan
                            .targets
                            .first()
                            .expect("one physical group plans to one target");
                        (
                            None,
                            Some(target.mode),
                            target.change,
                            target.conflicts.clone(),
                            target.warnings.clone(),
                            target.logical_target_ids.clone(),
                        )
                    }
                    Err(error) => {
                        // A whole-group planning failure (invalid declared
                        // name, unusable capability set) blocks the pair; the
                        // mapped reason stays conservative and the original
                        // error travels as technical detail.
                        (
                            Some(error.into()),
                            None,
                            TargetChange::Create,
                            Vec::new(),
                            Vec::new(),
                            group_logical_ids.clone(),
                        )
                    }
                };
            let shared = discovery_targets
                .iter()
                .any(|entry| entry.shared_reference && logical_target_ids.contains(&entry.id));
            let mut facts = skillhub_core::deployment::DeploymentPairFacts {
                skill_id: item.skill_id,
                version_id: version_id.clone(),
                runtime_name: runtime_name.clone(),
                physical_target_id: physical_id,
                destination_path: String::new(),
                capabilities: skillhub_core::DeploymentCapability::new(false, false, false),
                link_permission_denied,
                preference: item.preference,
                mode,
                change,
                conflicts,
                occupancy,
                path_available: true,
                requires_shared_impact_confirmation: shared,
            };
            if mode.is_some() {
                facts.capabilities = capabilities;
                facts.destination_path = Path::new(&target_path)
                    .join(&runtime_name)
                    .to_string_lossy()
                    .into_owned();
            } else {
                // Nothing was plannable: block conservatively so the
                // fingerprint and the reason stay consistent.
                facts.path_available = false;
            }
            let decision = plan_target_preview(&facts);
            let first_logical = logical_target_ids.first().cloned().unwrap_or_default();
            out.push(skillhub_core::api::DeploymentPairPreview {
                pair_id: format!("{}:{}", item.skill_id, facts.physical_target_id),
                skill_id: item.skill_id,
                skill_display_name: display_name.clone(),
                version_id: version_id.clone(),
                runtime_name: runtime_name.clone(),
                logical_target_ids,
                target_label: batch_target_label(discovery_targets, &projects, &first_logical),
                target_path,
                destination_path: facts.destination_path.clone(),
                preference: decision.preference,
                disposition: decision.disposition,
                mode: decision.mode,
                fallback_mode: decision.fallback_mode,
                block_reason: decision.block_reason,
                warnings,
                confirmation_preserved: false,
                confirmation_fingerprint: decision.confirmation_fingerprint,
                technical_error,
            });
        }

        // Unresolvable logical ids stay visible as their own blocked pairs.
        for (logical_id, error) in failures {
            let facts = skillhub_core::deployment::DeploymentPairFacts {
                skill_id: item.skill_id,
                version_id: version_id.clone(),
                runtime_name: runtime_name.clone(),
                physical_target_id: logical_id.clone(),
                destination_path: String::new(),
                capabilities: skillhub_core::DeploymentCapability::new(false, false, false),
                link_permission_denied,
                preference: item.preference,
                mode: None,
                change: TargetChange::Create,
                conflicts: Vec::new(),
                occupancy: Vec::new(),
                path_available: false,
                requires_shared_impact_confirmation: false,
            };
            let decision = plan_target_preview(&facts);
            out.push(skillhub_core::api::DeploymentPairPreview {
                pair_id: format!("{}:{}", item.skill_id, logical_id),
                skill_id: item.skill_id,
                skill_display_name: display_name.clone(),
                version_id: version_id.clone(),
                runtime_name: runtime_name.clone(),
                logical_target_ids: vec![logical_id.clone()],
                target_label: batch_target_label(discovery_targets, &projects, &logical_id),
                target_path: String::new(),
                destination_path: String::new(),
                preference: decision.preference,
                disposition: decision.disposition,
                mode: None,
                fallback_mode: None,
                block_reason: decision.block_reason,
                warnings: Vec::new(),
                confirmation_preserved: false,
                confirmation_fingerprint: decision.confirmation_fingerprint,
                technical_error: Some(error.into()),
            });
        }
        Ok(())
    }

    /// Task 13B trusted commit protocol: the request only names the preview,
    /// pairs, fallback confirmations and exclusions.  Every executable pair is
    /// fingerprint-revalidated against current facts and re-planned by the
    /// backend before the existing prepare/commit pipeline runs it.
    async fn commit_deployment_preview(
        &self,
        request: skillhub_core::api::CommitDeploymentPreview,
    ) -> AppResult<AppCommandResult> {
        for requested in &request.pairs {
            if requested.pair_id.trim().is_empty() {
                return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                    .with_param("field", "pair_id")
                    .with_action(RecoveryAction::Retry));
            }
            if requested.exclude && requested.confirm_fallback {
                return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                    .with_param("field", "pair_id")
                    .with_param("detail", "a pair cannot be excluded and confirmed at once")
                    .with_action(RecoveryAction::Retry));
            }
        }
        let now = now_epoch_seconds();
        let idempotency_key = preview_commit_key(&request);

        // 1. An identical earlier commit replays its recorded result.
        let recorded = self.with_database("execute.commit_deployment_preview", |database| {
            database
                .deployment_preview_repository()
                .find_commit_result(&idempotency_key)
        })?;
        if let Some(recorded) = recorded {
            let mut result: skillhub_core::api::DeploymentPreviewCommitResult =
                serde_json::from_str(&recorded)
                    .map_err(|_| internal("execute.commit_deployment_preview"))?;
            result.replayed = true;
            return Ok(AppCommandResult::DeploymentPreviewCommitResult(result));
        }

        // 2. The snapshot must still exist, be active and be unexpired.
        let snapshot = self
            .with_database("execute.commit_deployment_preview", |database| {
                database
                    .deployment_preview_repository()
                    .get_active(&request.preview_id, now)
            })?
            .ok_or_else(|| {
                target_changed_error("the preview snapshot is unknown, expired or consumed")
            })?;
        let stored_pairs: Vec<skillhub_core::api::DeploymentPairPreview> =
            serde_json::from_str(&snapshot.payload_json)
                .map_err(|_| internal("execute.commit_deployment_preview"))?;
        for requested in &request.pairs {
            if !stored_pairs
                .iter()
                .any(|pair| pair.pair_id == requested.pair_id)
            {
                return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                    .with_param("field", "pair_id")
                    .with_param("pair_id", requested.pair_id.clone())
                    .with_action(RecoveryAction::Retry));
            }
        }

        // 3. Decide every pair; executable ones are re-planned server-side.
        let link_permission_denied = DeploymentFilesystem::new().link_unavailability_cause()
            == Some(skillhub_adapters::deployment::LinkUnavailableCause::Permission);
        let mut fresh: Vec<(String, skillhub_core::TargetPlan)> = Vec::new();
        let mut results: Vec<skillhub_core::api::DeploymentPairCommitResult> = Vec::new();
        for pair in &stored_pairs {
            let requested = request
                .pairs
                .iter()
                .find(|requested| requested.pair_id == pair.pair_id);
            let requested = match requested {
                Some(requested) => requested,
                None => {
                    // Unlisted pairs count as cancelled; they touch nothing.
                    results.push(pair_result(
                        pair,
                        skillhub_core::api::DeploymentPairCommitOutcome::Excluded,
                        None,
                        None,
                    ));
                    continue;
                }
            };
            if requested.exclude {
                results.push(pair_result(
                    pair,
                    skillhub_core::api::DeploymentPairCommitOutcome::Excluded,
                    None,
                    None,
                ));
                continue;
            }
            if pair.disposition == skillhub_core::deployment::DeploymentPreviewDisposition::Blocked
            {
                results.push(pair_result(
                    pair,
                    skillhub_core::api::DeploymentPairCommitOutcome::Blocked,
                    None,
                    None,
                ));
                continue;
            }
            let confirmed_fallback = pair.disposition
                == skillhub_core::deployment::DeploymentPreviewDisposition::RecommendCopy;
            if confirmed_fallback && !requested.confirm_fallback {
                // 未确认的 RecommendCopy 不进入 prepare。
                results.push(pair_result(
                    pair,
                    skillhub_core::api::DeploymentPairCommitOutcome::Blocked,
                    None,
                    None,
                ));
                continue;
            }
            let requested_mode = if confirmed_fallback {
                pair.fallback_mode
                    .expect("a recommend-copy pair carries its fallback mode")
            } else {
                pair.mode
                    .expect("an executable pair carries its selected mode")
            };
            match self.replan_stored_pair(pair, requested_mode, link_permission_denied) {
                Ok(target) => fresh.push((pair.pair_id.clone(), target)),
                Err(error) => {
                    let outcome = if error.code == ErrorCode::TargetChanged {
                        skillhub_core::api::DeploymentPairCommitOutcome::Blocked
                    } else {
                        skillhub_core::api::DeploymentPairCommitOutcome::Failed
                    };
                    results.push(pair_result(pair, outcome, None, Some(error.into())));
                }
            }
        }

        // 4. Group executable targets into per-Skill plans and run the
        // existing prepare/commit pipeline (which revalidates once more).
        let mut groups: BTreeMap<
            (String, String, String),
            Vec<(String, skillhub_core::TargetPlan)>,
        > = BTreeMap::new();
        for (pair_id, target) in fresh {
            groups
                .entry((
                    target.skill_id.to_string(),
                    target.version_id.as_str().to_owned(),
                    target.runtime_name.clone(),
                ))
                .or_default()
                .push((pair_id, target));
        }
        for (_, entries) in groups {
            let mut targets = Vec::new();
            let mut warnings = Vec::new();
            for (_, target) in &entries {
                targets.push(target.clone());
                for warning in &target.warnings {
                    if !warnings.contains(warning) {
                        warnings.push(warning.clone());
                    }
                }
            }
            let mode = targets[0].mode;
            let plan = skillhub_core::DeploymentPlan {
                skill_id: targets[0].skill_id,
                version_id: targets[0].version_id.clone(),
                runtime_name: targets[0].runtime_name.clone(),
                mode,
                targets,
                warnings,
                conflicts: Vec::new(),
            };
            let prepared = self.prepare_deployment(plan).await?;
            let AppCommandResult::PreparedDeployment(prepared) = prepared else {
                return Err(internal("execute.commit_deployment_preview"));
            };
            let operation_id = prepared.id;
            let summary = self.commit_deployment(operation_id).await?;
            let AppCommandResult::DeploymentSummary(summary) = summary else {
                return Err(internal("execute.commit_deployment_preview"));
            };
            for (pair_id, target) in entries {
                let stored = stored_pairs
                    .iter()
                    .find(|pair| pair.pair_id == pair_id)
                    .expect("the pair came from the stored snapshot");
                let operation = summary
                    .targets
                    .iter()
                    .find(|result| result.physical_target_id == target.physical_target_id);
                match operation {
                    Some(result)
                        if result.status == skillhub_core::TargetOperationStatus::Succeeded =>
                    {
                        let outcome = if target.change == TargetChange::NoOp {
                            skillhub_core::api::DeploymentPairCommitOutcome::NoChange
                        } else {
                            skillhub_core::api::DeploymentPairCommitOutcome::Deployed
                        };
                        results.push(pair_result(
                            stored,
                            outcome,
                            Some(summary.operation_id),
                            None,
                        ));
                    }
                    Some(result) => {
                        let outcome = skillhub_core::api::DeploymentPairCommitOutcome::Failed;
                        results.push(pair_result(stored, outcome, None, result.error.clone()));
                    }
                    None => {
                        results.push(pair_result(
                            stored,
                            skillhub_core::api::DeploymentPairCommitOutcome::Failed,
                            None,
                            Some(internal("execute.commit_deployment_preview").into()),
                        ));
                    }
                }
            }
        }

        let mut result = skillhub_core::api::DeploymentPreviewCommitResult {
            preview_id: request.preview_id.clone(),
            replayed: false,
            pairs: results,
        };
        result
            .pairs
            .sort_by(|left, right| left.pair_id.cmp(&right.pair_id));

        // 5. Only a commit that actually ran consumes the snapshot and
        // records its idempotent result; a pure consultation (everything
        // blocked or excluded) stays repeatable.
        let executed_any = result.pairs.iter().any(|pair| {
            matches!(
                pair.outcome,
                skillhub_core::api::DeploymentPairCommitOutcome::Deployed
                    | skillhub_core::api::DeploymentPairCommitOutcome::NoChange
                    | skillhub_core::api::DeploymentPairCommitOutcome::Failed
            )
        });
        if executed_any {
            let payload = serde_json::to_string(&result)
                .map_err(|_| internal("execute.commit_deployment_preview"))?;
            self.with_database("execute.commit_deployment_preview", |database| {
                let repository = database.deployment_preview_repository();
                repository.insert_commit_result(
                    &idempotency_key,
                    &request.preview_id,
                    &payload,
                    now,
                )?;
                repository.consume(&request.preview_id)
            })?;
        }
        Ok(AppCommandResult::DeploymentPreviewCommitResult(result))
    }

    /// Re-derives one stored pair from current registered reality, refuses on
    /// any fingerprint drift, and re-plans with the requested effective mode.
    fn replan_stored_pair(
        &self,
        pair: &skillhub_core::api::DeploymentPairPreview,
        requested_mode: skillhub_core::DeploymentMode,
        link_permission_denied: bool,
    ) -> AppResult<skillhub_core::TargetPlan> {
        let library = self.library_runtime.snapshot()?;
        let injected = self.deployment_targets.as_ref();
        let discovered = if injected.is_none() {
            Some(self.discovery_target_index()?)
        } else {
            None
        };
        let resolve = |logical_id: &str| -> AppResult<Vec<VerifiedTarget>> {
            let ids = vec![logical_id.to_owned()];
            match injected {
                Some(index) => index.resolve(&ids),
                None => discovered
                    .as_ref()
                    .expect("discovered index exists when none is injected")
                    .resolve(&ids),
            }
        };
        let discovery_targets =
            self.with_database("execute.commit_deployment_preview", |database| {
                Ok(database
                    .agent_repository()
                    .load()?
                    .map(|snapshot| snapshot.logical_targets)
                    .unwrap_or_default())
            })?;

        let mut verified: Vec<VerifiedTarget> = Vec::new();
        for logical_id in &pair.logical_target_ids {
            match resolve(logical_id) {
                Ok(mut targets) => verified.append(&mut targets),
                Err(_) => {
                    return Err(target_changed_error(
                        "a registered target of the pair is no longer available",
                    ))
                }
            }
        }
        self.with_database("execute.commit_deployment_preview", |database| {
            attach_target_occupancy_with(database, &pair.runtime_name, &mut verified)
        })?;
        let source_path = library
            .root
            .join("versions")
            .join(pair.skill_id.to_string())
            .join(pair.version_id.as_str());
        let automatic = DeploymentPlanner
            .plan(DeploymentPlanInput::new(
                pair.skill_id,
                pair.version_id.clone(),
                pair.runtime_name.clone(),
                source_path.to_string_lossy().into_owned(),
                verified.clone(),
            ))
            // The precise reason (occupied, vanished, renamed) belongs to the
            // next preview; a stale commit is refused as changed facts.
            .map_err(|_| {
                target_changed_error("the pair no longer plans as it did at preview time")
            })?;
        let planned = automatic
            .targets
            .first()
            .ok_or_else(|| target_changed_error("the pair no longer plans to a target"))?;
        let shared = discovery_targets
            .iter()
            .any(|entry| entry.shared_reference && planned.logical_target_ids.contains(&entry.id));
        let facts = skillhub_core::deployment::DeploymentPairFacts {
            skill_id: pair.skill_id,
            version_id: pair.version_id.clone(),
            runtime_name: pair.runtime_name.clone(),
            physical_target_id: planned.physical_target_id.clone(),
            destination_path: planned.destination_path.clone(),
            capabilities: merged_capabilities_of(&verified),
            link_permission_denied,
            preference: pair.preference,
            mode: Some(planned.mode),
            change: planned.change,
            conflicts: planned.conflicts.clone(),
            occupancy: verified
                .iter()
                .flat_map(|target| target.existing().iter().cloned())
                .collect(),
            path_available: true,
            requires_shared_impact_confirmation: shared,
        };
        let rechecked = plan_target_preview(&facts);
        if rechecked.confirmation_fingerprint != pair.confirmation_fingerprint {
            return Err(target_changed_error(
                "the deployment facts changed since the preview",
            ));
        }
        let effective = DeploymentPlanner.plan(DeploymentPlanInput {
            skill_id: pair.skill_id,
            version_id: pair.version_id.clone(),
            runtime_name: pair.runtime_name.clone(),
            source_path: source_path.to_string_lossy().into_owned(),
            targets: verified,
            mode_override: Some(requested_mode),
            security_gate: skillhub_core::deployment::DeploymentSecurityGate::default(),
        })?;
        Ok(effective
            .targets
            .into_iter()
            .next()
            .expect("one physical target re-plans to one executable target"))
    }

    fn discovery_target_index(&self) -> AppResult<RegisteredTargetIndex> {
        let host_capabilities = DeploymentFilesystem::new().available_capabilities();
        self.with_database("query.get_deployment_plan", |database| {
            registered_target_index(database, &host_capabilities)
        })
    }

    /// D-11: the planner is pure and never sees the database or the disk, so
    /// occupancy facts must ride in on the verified targets.  An active managed
    /// row of this physical target is reported as `managed`; when no such row
    /// covers the runtime name, an entry already sitting at the destination is
    /// reported as unknown ownership.  A detached (`managed=0`) or removed row
    /// owns nothing, so the disk probe decides for it.  Without this
    /// attachment, planning answers `create` with no conflicts for an occupied
    /// destination and the collision only surfaces as a rejected commit.
    fn attach_target_occupancy(
        &self,
        runtime_name: &str,
        targets: &mut [VerifiedTarget],
    ) -> AppResult<()> {
        if targets.is_empty() {
            return Ok(());
        }
        self.with_database("query.get_deployment_plan", |database| {
            attach_target_occupancy_with(database, runtime_name, targets)
        })
    }

    fn prepare_import(&self, request: skillhub_core::PrepareImport) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        let candidate = request.candidate;
        let tree_hash = self.candidate_tree_hash(&candidate, request.tree_hash.as_deref());
        let result = self.with_database("execute.prepare_import", |database| {
            let facts = Self::import_source_facts(database, &candidate)?;
            let analysis = database.import_repository().analyze(
                candidate.clone(),
                tree_hash.as_deref(),
                &facts,
            )?;
            let prepared = PreparedImport {
                id: operation_id,
                candidate,
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
        });
        match result.as_ref() {
            Ok(_) => self.journal_prepared(operation_id, "import_skill"),
            Err(error) => self.journal_advance(
                operation_id,
                "import_skill",
                skillhub_core::OperationPhase::RolledBack,
                Some(error.code),
            ),
        }
        result
    }

    /// Native import callers currently omit the optional hash. Compute the
    /// canonical manifest-equivalent hash at the application boundary so
    /// identical trees can be recognized without mutating the library.
    fn candidate_tree_hash(
        &self,
        candidate: &skillhub_core::ImportCandidate,
        requested: Option<&str>,
    ) -> Option<String> {
        requested.map(str::to_owned).or_else(|| {
            self.library_runtime
                .snapshot()
                .ok()?
                .store
                .hash_tree_read_only(Path::new(&candidate.absolute_root))
                .ok()
        })
    }

    /// Materializes a remote import into a bounded temporary workspace. The
    /// workspace is retained because candidate paths are reused by analyze,
    /// prepare, and commit after discovery returns.
    async fn acquire_import_source(&self, source: &SourceDescriptor) -> AppResult<PathBuf> {
        let cache_key = serde_json::to_string(source)
            .map_err(|_| internal("query.discover_import_candidates.key"))?;
        if let Some(root) = self
            .acquired_import_sources
            .lock()
            .map_err(|_| internal("query.discover_import_candidates.acquire"))?
            .get(&cache_key)
            .map(|acquired| acquired.workspace.root().to_path_buf())
        {
            return Ok(root);
        }
        self.ensure_network_enabled()?;
        let acquired = match (&source.kind, &source.locator) {
            (skillhub_core::SourceKind::Git, SourceLocator::GitUrl(url)) => {
                GixSourceFetcher::default()
                    .fetch(url)
                    .await
                    .map_err(|error| {
                        AppError::new(ErrorCode::OperationConflict, Severity::Warning)
                            .with_param("reason", error.code.as_str())
                            .with_param("detail", error.to_string())
                            .with_action(RecoveryAction::Retry)
                    })?
            }
            (skillhub_core::SourceKind::Https, SourceLocator::HttpsUrl(url)) => {
                let downloaded =
                    HttpsSourceFetcher::default()
                        .fetch(url)
                        .await
                        .map_err(|error| {
                            AppError::new(ErrorCode::OperationConflict, Severity::Warning)
                                .with_param("reason", error.code.as_str())
                                .with_param("detail", error.to_string())
                                .with_action(RecoveryAction::Retry)
                        })?;
                if !is_supported_remote_archive(url) {
                    return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                        .with_param("reason", "source.archive_required")
                        .with_param("detail", "HTTPS imports must point to a ZIP or TAR archive")
                        .with_action(RecoveryAction::Acknowledge));
                }
                let named_archive = downloaded.root().join("source.zip");
                std::fs::rename(downloaded.root().join("source"), &named_archive).map_err(
                    |error| {
                        AppError::new(ErrorCode::InternalError, Severity::Error)
                            .with_param("source", error.to_string())
                            .with_action(RecoveryAction::Retry)
                    },
                )?;
                // ArchiveExtractor owns a separate bounded workspace. The
                // downloaded workspace is dropped after extraction completes.
                drop(downloaded);
                ArchiveExtractor::new(AcquisitionLimits::default())
                    .extract(named_archive)
                    .map_err(|error| {
                        AppError::new(ErrorCode::InvalidInput, Severity::Error)
                            .with_param("reason", error.code.as_str())
                            .with_param("detail", error.to_string())
                            .with_action(RecoveryAction::Acknowledge)
                    })?
            }
            _ => {
                return Err(unsupported("query.discover_import_candidates"));
            }
        };
        let root = acquired.root().to_path_buf();
        self.acquired_import_sources
            .lock()
            .map_err(|_| internal("query.discover_import_candidates.store"))?
            .insert(
                cache_key,
                AcquiredImportSource {
                    source: source.clone(),
                    workspace: acquired,
                    source_class: skillhub_core::ImportSourceClass::Online,
                    workspace_kind: skillhub_core::AcquisitionWorkspaceKind::TemporaryCache,
                },
            );
        Ok(root)
    }

    /// Import is a write boundary: run the deterministic scanner against the
    /// user source before creating any catalog/version/materialized files.
    /// Findings are returned as structured evidence so clients can explain
    /// the block without parsing a localized error sentence.
    fn enforce_import_security_gate(candidate: &skillhub_core::ImportCandidate) -> AppResult<()> {
        let report =
            BasicScanner::default().scan_version_report(Path::new(&candidate.absolute_root))?;
        if report.findings.is_empty() {
            return Ok(());
        }
        let evidence = report
            .findings
            .iter()
            .map(|finding| {
                serde_json::json!({
                    "code": finding.code,
                    "file": finding.file,
                    "line": finding.line_start,
                })
            })
            .collect::<Vec<_>>();
        Err(AppError::new(ErrorCode::CheckBlocked, Severity::Error)
            .with_param("reason", "import_basic_check")
            .with_param("finding_count", report.findings.len() as u64)
            .with_param("findings", serde_json::Value::Array(evidence))
            .with_action(RecoveryAction::ReviewSecurityFindings))
    }

    fn cancel_import(&self, prepared_import_id: OperationId) -> AppResult<AppCommandResult> {
        let result = self.cancel_import_flow(prepared_import_id);
        // A cancel always ends the record as rolled_back: updated when the
        // prepared import existed, inserted as a terminal row otherwise.
        self.journal_advance(
            prepared_import_id,
            "import_skill",
            skillhub_core::OperationPhase::RolledBack,
            result.as_ref().err().map(|error| error.code),
        );
        result
    }

    fn cancel_import_flow(&self, prepared_import_id: OperationId) -> AppResult<AppCommandResult> {
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

    /// 打开一个导入批次：一个向导会话对应一个 batch_id，所有提交共享。
    fn begin_import_batch(&self) -> AppResult<AppCommandResult> {
        let batch_id = format!("batch-{}", OperationId::new());
        self.with_database("execute.begin_import_batch", |database| {
            database
                .provenance_repository()
                .begin_import_batch(&batch_id, now_epoch_seconds())
        })?;
        Ok(AppCommandResult::ImportBatchStarted(
            skillhub_core::api::ImportBatchStarted { batch_id },
        ))
    }

    /// 终结导入批次：manageable_source_count 从持久化批次项映射计算，
    /// 绝不信任前端汇总；重复终结幂等并返回相同计数（4.11）。
    fn finalize_import_batch(
        &self,
        request: skillhub_core::api::FinalizeImportBatch,
    ) -> AppResult<AppCommandResult> {
        self.with_database("execute.finalize_import_batch", |database| {
            let repository = database.provenance_repository();
            if repository.import_batch(&request.batch_id)?.is_none() {
                return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("field", "import_batch")
                    .with_param("batch_id", request.batch_id.clone())
                    .with_action(RecoveryAction::ChooseAnotherName));
            }
            let manageable_source_count = repository.manageable_source_count(&request.batch_id)?;
            repository.finalize_import_batch(
                &request.batch_id,
                skillhub_storage::ImportBatchFinalStatus::Completed,
                now_epoch_seconds(),
            )?;
            Ok(AppCommandResult::ImportBatchFinalized(
                skillhub_core::api::ImportBatchFinalized {
                    batch_id: request.batch_id,
                    manageable_source_count,
                },
            ))
        })
    }

    fn commit_import(&self, request: skillhub_core::CommitImport) -> AppResult<AppCommandResult> {
        let _relation_migration_guard = self.lock_relation_migration("execute.commit_import")?;
        let operation_id = request.prepared_import_id;
        // `needs_recovery` is reserved for an import cleanup failure that may
        // have left residue. A prepared import can otherwise fail before any
        // central-library write (for example, at the mandatory security gate);
        // that failure remains visible in history but must not block startup.
        let prepared_known = self
            .prepared_imports
            .lock()
            .map(|prepared| prepared.contains_key(&operation_id))
            .unwrap_or(false);
        let result = self.commit_import_flow(request);
        match result.as_ref() {
            Ok(_) => self.journal_advance(
                operation_id,
                "import_skill",
                skillhub_core::OperationPhase::Committed,
                None,
            ),
            Err(error) if prepared_known && error.severity == Severity::Critical => self
                .journal_advance(
                    operation_id,
                    "import_skill",
                    skillhub_core::OperationPhase::NeedsRecovery,
                    Some(error.code),
                ),
            Err(error) => self.journal_advance(
                operation_id,
                "import_skill",
                skillhub_core::OperationPhase::RolledBack,
                Some(error.code),
            ),
        }
        result
    }

    /// 提交导入：解析批次与候选键，把每次决策映射为持久化事实；任何
    /// 失败都落一条 failed 批次项（不建事件、不动来源文件），原样传播
    /// 首个错误。
    fn commit_import_flow(
        &self,
        request: skillhub_core::CommitImport,
    ) -> AppResult<AppCommandResult> {
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
        if request.decision == skillhub_core::ImportDecision::EstablishManagedRelation {
            // 旧的“导入时直接建管”决策由导入事实流取代：明确拒绝，
            // 不写文件、不静默转换成其他决定（plan 4.5）。
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "decision")
                .with_param("reason", "legacy_import_relation_decision")
                .with_action(RecoveryAction::ChooseAnotherName));
        }
        let batch_id = request
            .batch_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| format!("implicit-{}", request.prepared_import_id));
        let candidate_key = request
            .candidate_key
            .clone()
            .filter(|key| !key.trim().is_empty())
            .unwrap_or_else(|| Self::candidate_key_for(&prepared.candidate));
        self.with_database("execute.commit_import.batch", |database| {
            if database
                .provenance_repository()
                .import_batch(&batch_id)?
                .is_none()
            {
                database
                    .provenance_repository()
                    .begin_import_batch(&batch_id, now_epoch_seconds())?;
            }
            Ok(())
        })?;
        let result = self.commit_import_apply(&prepared, &request, &batch_id, &candidate_key);
        if let Ok(AppCommandResult::ImportSummary(summary)) = result.as_ref() {
            if let Some(skill_id) = summary.items.first().and_then(|item| item.skill_id) {
                // 5B：导入成功即触发受影响关系的定向校验；失败不影响导入。
                self.validate_relationships_after_import(skill_id);
            }
        }
        if let Err(error) = result.as_ref() {
            let _ = self.with_database("execute.commit_import.failure_item", |database| {
                database.provenance_repository().record_batch_item(
                    &skillhub_storage::ImportBatchItemRecord {
                        batch_id: batch_id.clone(),
                        candidate_key: candidate_key.clone(),
                        skill_id: None,
                        provenance_id: None,
                        source_relation_id: None,
                        status: skillhub_storage::ImportBatchItemStatus::Failed,
                        reason: Some(error.code.as_str().to_owned()),
                    },
                )
            });
        }
        result
    }

    fn commit_import_apply(
        &self,
        prepared: &skillhub_core::PreparedImport,
        request: &skillhub_core::CommitImport,
        batch_id: &str,
        candidate_key: &str,
    ) -> AppResult<AppCommandResult> {
        if !prepared.analysis.actions.contains(&request.decision) {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "decision")
                .with_action(RecoveryAction::ChooseAnotherName));
        }
        for (group_id, action) in &request.governance_decision.group_actions {
            let Some(group) = prepared
                .analysis
                .governance_groups
                .iter()
                .find(|group| &group.group_id == group_id)
            else {
                return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                    .with_param("field", "governance_decision.group_actions"));
            };
            if !group.available_actions.contains(action) {
                return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                    .with_param("field", "governance_decision.group_actions"));
            }
        }
        for (member_id, action) in &request.governance_decision.item_overrides {
            let member_group = prepared.analysis.governance_groups.iter().find(|group| {
                group
                    .members
                    .iter()
                    .any(|member| member.member_id == *member_id)
            });
            if !member_group.is_some_and(|group| group.available_actions.contains(action)) {
                return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                    .with_param("field", "governance_decision.item_overrides"));
            }
        }
        // 导入只复制到集中库并记录可核对的关系事实；它绝不在此阶段
        // 变更 Agent 原目录。旧客户端可继续提交治理决定以创建待办，
        // 但空决定同样有效，治理由完成后的独立工作台显式发起。
        let governance_tasks =
            Self::import_governance_tasks(&prepared.analysis, &request.governance_decision);
        if request.decision == skillhub_core::ImportDecision::Skip {
            self.with_database("execute.commit_import.governance_task", |database| {
                Self::persist_import_governance_tasks(database, &governance_tasks)
            })?;
            // 跳过只落批次项，不建事件、不建来源关系（4.10）。
            self.with_database("execute.commit_import.skip_item", |database| {
                database.provenance_repository().record_batch_item(
                    &skillhub_storage::ImportBatchItemRecord {
                        batch_id: batch_id.to_owned(),
                        candidate_key: candidate_key.to_owned(),
                        skill_id: None,
                        provenance_id: None,
                        source_relation_id: None,
                        status: skillhub_storage::ImportBatchItemStatus::Skipped,
                        reason: Some("import.skipped_by_user".into()),
                    },
                )
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
                        skill_id: None,
                        decision: request.decision,
                        status: if governance_tasks.is_empty() {
                            skillhub_core::ImportItemStatus::Skipped
                        } else {
                            skillhub_core::ImportItemStatus::Todo
                        },
                        original_preserved: true,
                        reason_code: Some("import.skipped_by_user".into()),
                        governance_tasks,
                        provenance: None,
                        source_relation_id: None,
                    }],
                    committed: true,
                    batch: Some(skillhub_core::ImportBatchContext {
                        batch_id: batch_id.to_owned(),
                    }),
                },
            )));
        }
        Self::enforce_import_security_gate(&prepared.candidate)?;
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
            // 复用同样是一次成功导入：每次都追加本次不可变存证并把可治理
            // 来源挂到最终命中的 Skill；不再“已有存证则跳过”（plan 4.8）。
            let fingerprint = self
                .candidate_tree_hash(&prepared.candidate, None)
                .ok_or_else(|| {
                    AppError::new(ErrorCode::InvalidInput, Severity::Error)
                        .with_param("reason", "import.fingerprint_unavailable")
                        .with_action(RecoveryAction::Retry)
                })?;
            let reuse_source_relation_id =
                self.with_database("execute.commit_import.outcome", |database| {
                    self.record_import_outcome(
                        database,
                        &ImportBatchSlot {
                            batch_id: batch_id.to_owned(),
                            candidate_key: candidate_key.to_owned(),
                        },
                        &prepared.candidate,
                        skill_id,
                        &fingerprint,
                        false,
                    )
                    .map(|recorded| recorded.source_relation_id)
                })?;
            self.with_database("execute.commit_import.governance_task", |database| {
                Self::persist_import_governance_tasks(database, &governance_tasks)
            })?;
            self.with_database("execute.commit_import.conflict_case", |database| {
                self.record_import_conflict_case(
                    database,
                    prepared,
                    request.decision,
                    skill_id,
                    Some(fingerprint),
                )
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
                        status: if governance_tasks.is_empty() {
                            skillhub_core::ImportItemStatus::Succeeded
                        } else {
                            skillhub_core::ImportItemStatus::Todo
                        },
                        original_preserved: true,
                        reason_code: None,
                        governance_tasks,
                        provenance: None,
                        source_relation_id: reuse_source_relation_id,
                    }],
                    committed: true,
                    batch: Some(skillhub_core::ImportBatchContext {
                        batch_id: batch_id.to_owned(),
                    }),
                },
            )));
        }
        if !matches!(
            request.decision,
            skillhub_core::ImportDecision::CopyIntoLibrary
                | skillhub_core::ImportDecision::KeepIndependent
                | skillhub_core::ImportDecision::CopyAsIndependentManagedSkill
                | skillhub_core::ImportDecision::TakeOverAfterVerify
        ) {
            return Err(unsupported("execute.commit_import.decision"));
        }
        let library = self.library_runtime.snapshot()?;
        self.with_database("execute.commit_import", |database| {
            let central = &library.central;
            let store = &library.store;
            let skill_id = skillhub_core::SkillId::new();
            let source = Path::new(&prepared.candidate.absolute_root);
            let version = store.capture(skill_id, source)?;
            // QA-009：导入时读取 SKILL.md 头部 description 作为原始说明；
            // 头部缺失或不可读时保持空串，不阻塞导入。
            let mut skill = Skill::new(skill_id, prepared.candidate.runtime_name.clone());
            if let Some(description) = read_frontmatter_description(source) {
                skill = skill.with_description(description);
            }
            if let Err(error) = database.catalog_repository()?.insert_sync(&skill) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, central, store, skill_id, &version),
                ));
            }
            if let Err(error) = store.set_current(skill_id, &version.id) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, central, store, skill_id, &version),
                ));
            }
            if let Err(error) = central.materialize_current_skill(&skill, &version.id) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, central, store, skill_id, &version),
                ));
            }
            if let Err(error) = central.save_portable_skill(&skill, Some(&version.id)) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, central, store, skill_id, &version),
                ));
            }
            // 仓库导入（带上游坐标）：git 来源即长期 origin——临时下载目录不是
            // 真实来源，不能落库，否则 for_skill 取行非确定且目录随时会被清理。
            let origin_source = match prepared.candidate.upstream.clone() {
                Some(upstream) => SourceDescriptor::new(
                    skillhub_core::SourceKind::Git,
                    SourceLocator::git_url(upstream.url.clone()),
                ),
                None => prepared.candidate.source.clone(),
            };
            if let Err(error) = database.source_repository().relink(skill_id, origin_source) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, central, store, skill_id, &version),
                ));
            }
            if let Some(upstream) = prepared.candidate.upstream.clone() {
                if let Err(error) = database
                    .source_repository()
                    .record_upstream(skill_id, &upstream)
                {
                    return Err(cleanup_import_error(
                        error,
                        cleanup_import_state(database, central, store, skill_id, &version),
                    ));
                }
            }
            if let Err(error) = database.record_current_version(skill_id, &version) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, central, store, skill_id, &version),
                ));
            }
            // 导入即存证（单一 record_import_outcome）：在同一事务里追加
            // 不可变事件、批次项，并按权威类别/物理身份 upsert 来源副本；
            // Online/项目/集中库只写事件。失败视为导入失败并回滚库内
            // 状态——“无存证的导入”不是完成的导入。
            let outcome = self.record_import_outcome(
                database,
                &ImportBatchSlot {
                    batch_id: batch_id.to_owned(),
                    candidate_key: candidate_key.to_owned(),
                },
                &prepared.candidate,
                skill_id,
                &version.manifest.tree_hash,
                true,
            );
            let recorded = match outcome {
                Ok(recorded) => recorded,
                Err(error) => {
                    return Err(cleanup_import_error(
                        error,
                        cleanup_import_state(database, central, store, skill_id, &version),
                    ));
                }
            };
            if request.decision == skillhub_core::ImportDecision::TakeOverAfterVerify {
                // Takeover keeps the original source.  The separate original
                // migration flow owns deletion and its explicit backup/rollback
                // confirmation; this step only verifies the managed copy.
                if let Err(error) =
                    store
                        .hash_tree_read_only(central.visible_skill_path_for_runtime(
                            skill_id,
                            &prepared.candidate.runtime_name,
                        ))
                        .and_then(|hash| {
                            if hash == version.manifest.tree_hash {
                                Ok(hash)
                            } else {
                                Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                                    .with_param("reason", "takeover_verification_mismatch")
                                    .with_action(RecoveryAction::RollbackOperation))
                            }
                        })
                {
                    return Err(cleanup_import_error(
                        error,
                        cleanup_import_state(database, central, store, skill_id, &version),
                    ));
                }
            }
            if let Err(error) = Self::persist_import_governance_tasks(database, &governance_tasks) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, central, store, skill_id, &version),
                ));
            }
            // Task 10：导入提交即落冲突组。失败视为导入失败并回滚库内
            // 状态——"无冲突组的冲突导入"不是完成的导入。
            if let Err(error) = self.record_import_conflict_case(
                database,
                prepared,
                request.decision,
                skill_id,
                Some(version.manifest.tree_hash.clone()),
            ) {
                return Err(cleanup_import_error(
                    error,
                    cleanup_import_state(database, central, store, skill_id, &version),
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
                        status: if governance_tasks.is_empty() {
                            skillhub_core::ImportItemStatus::Succeeded
                        } else {
                            skillhub_core::ImportItemStatus::Todo
                        },
                        original_preserved: true,
                        reason_code: None,
                        governance_tasks,
                        provenance: recorded.provenance,
                        source_relation_id: recorded.source_relation_id,
                    }],
                    committed: true,
                    batch: Some(skillhub_core::ImportBatchContext {
                        batch_id: batch_id.to_owned(),
                    }),
                },
            )))
        })
    }

    /// 治理待办 detail 持久化稳定键；客户端按 i18n 键渲染，不入散文。
    fn import_governance_task_detail_key(
        classification: skillhub_core::ImportGovernanceClassification,
    ) -> String {
        let slug = match classification {
            skillhub_core::ImportGovernanceClassification::ExactDuplicate => {
                "select_authoritative_version"
            }
            skillhub_core::ImportGovernanceClassification::ContentIdenticalCopy => {
                "convert_copy_to_managed_link"
            }
            skillhub_core::ImportGovernanceClassification::SameNameDifferentContent => {
                "classify_same_name_skill"
            }
            skillhub_core::ImportGovernanceClassification::SharedDirectoryRead => {
                "confirm_shared_directory_impact"
            }
            skillhub_core::ImportGovernanceClassification::SharedDirectoryReference => {
                "convert_shared_reference_to_managed_link"
            }
            skillhub_core::ImportGovernanceClassification::UnrecognizedSource => {
                "unknown_directory_recognition"
            }
        };
        format!("import.governance.task.{slug}")
    }

    fn import_governance_tasks(
        analysis: &skillhub_core::ImportAnalysis,
        decision: &skillhub_core::import::ImportGovernanceDecision,
    ) -> Vec<skillhub_core::GovernanceTaskFact> {
        analysis
            .governance_groups
            .iter()
            .flat_map(|group| {
                group
                    .members
                    .iter()
                    .filter(|member| {
                        decision.action_for_member(group, &member.member_id)
                            == Some(skillhub_core::ImportGovernanceAction::CreateTodo)
                    })
                    .map(|member| skillhub_core::GovernanceTaskFact {
                        task_id: skillhub_core::import_governance_task_id(
                            &group.group_id,
                            &member.member_id,
                        ),
                        kind: match group.classification {
                            skillhub_core::ImportGovernanceClassification::ExactDuplicate => {
                                skillhub_core::GovernanceTaskKind::SelectAuthoritativeVersion
                            }
                            skillhub_core::ImportGovernanceClassification::ContentIdenticalCopy => {
                                skillhub_core::GovernanceTaskKind::ConvertCopyToManagedLink
                            }
                            skillhub_core::ImportGovernanceClassification::SameNameDifferentContent => {
                                skillhub_core::GovernanceTaskKind::ClassifySameNameSkill
                            }
                            skillhub_core::ImportGovernanceClassification::SharedDirectoryRead => {
                                skillhub_core::GovernanceTaskKind::ConfirmSharedDirectoryImpact
                            }
                            skillhub_core::ImportGovernanceClassification::SharedDirectoryReference => {
                                skillhub_core::GovernanceTaskKind::ConvertSharedReferenceToManagedLink
                            }
                            skillhub_core::ImportGovernanceClassification::UnrecognizedSource => {
                                skillhub_core::GovernanceTaskKind::UnknownDirectoryRecognition
                            }
                        },
                        subject_id: member.member_id.clone(),
                        // 持久化稳定键而非界面散文；展示文案由客户端翻译。
                        detail: Self::import_governance_task_detail_key(group.classification),
                        resolved: false,
                        created_at: now_epoch_seconds(),
                        resolved_at: None,
                    })
            })
            .collect()
    }

    fn persist_import_governance_tasks(
        database: &Database,
        tasks: &[skillhub_core::GovernanceTaskFact],
    ) -> AppResult<()> {
        for task in tasks {
            database.governance_task_repository().create(task)?;
        }
        Ok(())
    }

    // ===== Task 10：导入冲突组生产写入（设计 §3.4 冲突组） =====

    /// 导入成功提交后的冲突组落库入口。仅当分析存在 `requires_choice`
    /// 冲突时写库；事实映射全部在 core 纯函数内，这里只收集提交时才能
    /// 取到的其余事实（产物 Skill、候选指纹、库内可见路径/指纹）。
    fn record_import_conflict_case(
        &self,
        database: &Database,
        prepared: &skillhub_core::PreparedImport,
        decision: skillhub_core::ImportDecision,
        outcome_skill_id: skillhub_core::SkillId,
        candidate_fingerprint: Option<String>,
    ) -> AppResult<()> {
        let Some(conflict) = prepared
            .analysis
            .conflicts
            .iter()
            .find(|conflict| conflict.requires_choice)
        else {
            return Ok(());
        };
        let matched_runtime_name = prepared
            .analysis
            .matches
            .iter()
            .find(|item| item.skill_id == conflict.skill_id)
            .map(|item| item.runtime_name.clone());
        let outcome = skillhub_core::ImportCaseOutcome {
            skill_id: outcome_skill_id,
            candidate_fingerprint,
            library_path: self
                .library_visible_path(conflict.skill_id, matched_runtime_name.as_deref()),
            library_fingerprint: Self::library_content_fingerprint(database, conflict.skill_id)?,
        };
        let Some(fact) =
            skillhub_core::plan_import_conflict_case(&prepared.analysis, decision, &outcome)
        else {
            return Ok(());
        };
        let existing = database
            .conflict_repository()
            .list_cases()?
            .into_iter()
            .find(|case| case.conflict_id == fact.conflict_id);
        let merged =
            Self::merge_import_conflict_decision(fact, existing.as_ref(), now_epoch_seconds());
        database.conflict_repository().create_case(&merged)
    }

    /// 库内既有 Skill 的集中库可见路径；不可得（无运行时上下文或可见树
    /// 尚不存在）时如实返回 None，不猜。
    fn library_visible_path(
        &self,
        skill_id: skillhub_core::SkillId,
        runtime_name: Option<&str>,
    ) -> Option<String> {
        runtime_name
            .and_then(|runtime_name| {
                self.library_runtime.snapshot().ok().map(|library| {
                    library
                        .central
                        .visible_skill_path_for_runtime(skill_id, runtime_name)
                })
            })
            .filter(|path| path.exists())
            .map(|path| path.to_string_lossy().into_owned())
    }

    /// 库内既有 Skill 当前版本的内容指纹；无版本记录时为 None。
    fn library_content_fingerprint(
        database: &Database,
        skill_id: skillhub_core::SkillId,
    ) -> AppResult<Option<String>> {
        Ok(database
            .import_repository()
            .list_existing()?
            .into_iter()
            .find(|record| record.skill_id == skill_id)
            .and_then(|record| record.tree_hash))
    }

    /// user_decision 合并规则（纯逻辑，`now` 可注入以便测试）：
    /// - 本次有显式裁决：以其更新并刷新 decided_at；
    /// - 本次推导为 None 且既有裁决非 None：保留既有裁决与 decided_at，
    ///   绝不拿 NULL 覆盖用户已有裁决；
    /// - 两者皆无：维持未裁决状态。
    fn merge_import_conflict_decision(
        mut fact: skillhub_core::ConflictCaseFact,
        existing: Option<&skillhub_core::ConflictCaseFact>,
        now: i64,
    ) -> skillhub_core::ConflictCaseFact {
        match fact.user_decision {
            Some(_) => fact.decided_at = Some(now),
            None => {
                if let Some(existing) = existing {
                    if existing.user_decision.is_some() {
                        fact.user_decision = existing.user_decision;
                        fact.decided_at = existing.decided_at;
                    }
                }
            }
        }
        fact
    }

    // ===== OPT-20260914-08：已部署 Skill 识别、导入存证与原始文件迁移 =====

    /// 已知 Agent 目录清单（logical target 路径 → client_id）。归属判定按
    /// 最长前缀取胜：原生目录（如 ~/.trae-cn/skills）比共享目录
    /// （.agents/skills）更具体。没有目录证据的路径不归属。
    ///
    /// 接收调用方已持有的 `&Database`：所有调用点都在 `with_database`
    /// 临界区内，这里绝不能再锁数据库（`Mutex` 不可重入，重入即死锁）。
    fn discovery_client_dirs(database: &Database) -> AppResult<Vec<(String, String)>> {
        let Some(snapshot) = database.agent_repository().load()? else {
            return Ok(Vec::new());
        };
        Ok(snapshot
            .logical_targets
            .into_iter()
            .filter(|target| target.available && target.exists)
            .map(|target| (target.path, target.client_id))
            .collect())
    }

    /// 把候选路径归属到已知 Agent 形态；无证据返回 None（来源不明，不猜）。
    ///
    /// 归属与关系比对都在"文件系统同一性"上进行：scanner 产出的是
    /// canonicalize 后的路径（macOS 上 /var → /private/var 等），而导入候
    /// 选/注册 target 常带未解析的符号链接前缀。两边必须先折叠到同一形
    /// 态再比较，否则归属与关系会静默失配。
    fn resolve_agent_client_id(database: &Database, path: &str) -> AppResult<Option<String>> {
        let candidate = Self::canonical_path_string(path);
        let dirs = Self::discovery_client_dirs(database)?
            .into_iter()
            .map(|(root, client)| (Self::canonical_path_string(&root), client))
            .collect::<Vec<_>>();
        Ok(dirs
            .into_iter()
            .filter(|(root, _)| path_lives_under(&candidate, root))
            .max_by_key(|(root, _)| root.chars().count())
            .map(|(_, client_id)| client_id))
    }

    /// 解析导入候选的确定性来源事实（设计 §4.1 关系分组输入）。只读：
    /// 目录节点、目录能力、观察部署与链接形态判定，不写任何表。
    ///
    /// 比较统一在 `canonical_path_string` 同一性上进行（与
    /// `resolve_agent_client_id` 相同的理由）：scanner/注册 target 与候选
    /// 常带不同的符号链接前缀形态。候选根是符号链接时，canonical 形态
    /// 已解析到链接目标，因此节点匹配天然落在目标目录上，
    /// `source_is_link` 再把"引用"与"直接读取"区分开。Windows 目录联结
    /// 被 std 视作目录（is_symlink 为 false），此处按直接读取归类；
    /// 转换层（关系迁移）对 junction 另有 fail-closed 判定。
    fn import_source_facts(
        database: &Database,
        candidate: &skillhub_core::ImportCandidate,
    ) -> AppResult<skillhub_core::ImportSourceFacts> {
        let source_is_link = std::fs::symlink_metadata(&candidate.absolute_root)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false);
        let canonical_root = Self::canonical_path_string(&candidate.absolute_root);
        let directory_node = database
            .directory_repository()
            .list_nodes()?
            .into_iter()
            .filter(|node| node.exists)
            .map(|node| {
                let canonical_node = Self::canonical_path_string(&node.path);
                (node, canonical_node)
            })
            .filter(|(node, canonical_node)| {
                path_lives_under(&canonical_root, canonical_node)
                    || observed_path_key(&candidate.absolute_root) == observed_path_key(&node.path)
            })
            .max_by_key(|(node, _)| node.path.chars().count());
        let mut affected_agents = match &directory_node {
            Some((node, _)) => {
                let mut agents = database
                    .relationship_repository()
                    .list_capabilities()?
                    .into_iter()
                    .filter(|capability| {
                        capability.directory_node_id == node.node_id
                            && capability.recognition
                                == skillhub_core::DirectoryRecognition::Supported
                    })
                    .map(|capability| capability.agent_client_id)
                    .collect::<Vec<_>>();
                agents.sort();
                agents.dedup();
                agents
            }
            None => Self::resolve_agent_client_id(database, &candidate.absolute_root)?
                .into_iter()
                .collect(),
        };
        let observed_rows: Vec<skillhub_core::ObservedDeployment> = database
            .provenance_repository()
            .list_observed()?
            .into_iter()
            .filter(|observed| {
                observed.status == skillhub_core::ObservedStatus::Active
                    && observed.released_at.is_none()
                    && observed_path_key(&observed.original_path)
                        == observed_path_key(&candidate.absolute_root)
            })
            .collect();
        let observed_copy_verified = observed_rows.iter().any(|observed| {
            observed.match_state == skillhub_core::ObservedMatchState::ContentVerified
        });
        if affected_agents.is_empty() {
            // 目录能力未给出任何 Agent 时（未登记节点或节点无能力
            // 记录），归属证据回退到观察行的 Agent 形态；仍无证据则
            // 保持为空，不猜测。
            affected_agents = observed_rows
                .iter()
                .map(|observed| observed.client_id.clone())
                .chain(Self::resolve_agent_client_id(
                    database,
                    &candidate.absolute_root,
                )?)
                .collect::<Vec<_>>();
            affected_agents.sort();
            affected_agents.dedup();
        }
        Ok(skillhub_core::ImportSourceFacts {
            directory_role: directory_node.as_ref().map(|(node, _)| node.role),
            source_is_link,
            observed_copy_verified,
            affected_agents,
        })
    }

    /// 发现时的权威来源分类（设计 §3.6）。输入来源 descriptor、已解析的
    /// 候选根与集中库根；项目根、Agent 目录与目录节点证据从数据库读取。
    /// 用户选择只提供 locator，不作为类别权威；全部根按最长物理路径匹配，
    /// 嵌套时最具体根获胜，同长时集中库 > 项目 > Agent。
    /// 物理身份用 `physical_id_for_path` 权威推导；推导失败或类别不可治理
    /// （Online/CentralLibrary）时为 None，治理侧据此 fail-closed。
    fn classify_import_source(
        database: &Database,
        source: &SourceDescriptor,
        resolved_root: &str,
        central_root: Option<&str>,
    ) -> AppResult<ClassifiedImportSource> {
        Ok(
            match Self::classify_import_source_core(database, source, resolved_root, central_root)?
            {
                Some(classified) => classified,
                None => ClassifiedImportSource {
                    source_class: skillhub_core::ImportSourceClass::UserLocal,
                    physical_source_id: skillhub_core::physical_id_for_path(resolved_root),
                    source_container_id: None,
                    agent_client_id: None,
                },
            },
        )
    }

    /// 带可证明性的分类核心：None 表示没有任何正面根证据（plan 5.13 的
    /// legacy 对账只用它，不把 UserLocal 兜底当作证明）。
    fn classify_import_source_core(
        database: &Database,
        source: &SourceDescriptor,
        resolved_root: &str,
        central_root: Option<&str>,
    ) -> AppResult<Option<ClassifiedImportSource>> {
        #[derive(Clone, Copy, PartialEq, Eq)]
        enum RootKind {
            Central,
            Project,
            Agent,
        }
        let kind_rank = |kind: &RootKind| match kind {
            RootKind::Central => 3,
            RootKind::Project => 2,
            RootKind::Agent => 1,
        };
        if source.locator.as_local_path().is_none() {
            // 在线来源只保存业务坐标；临时缓存不产生长期身份事实。
            return Ok(Some(ClassifiedImportSource {
                source_class: skillhub_core::ImportSourceClass::Online,
                physical_source_id: None,
                source_container_id: None,
                agent_client_id: None,
            }));
        }
        // 目录节点先收集，Agent 逻辑目标后收集：同为最长匹配时目标自带
        // client_id，优先作为归属证据。
        let mut roots: Vec<(String, RootKind, Option<String>, Option<String>)> = Vec::new();
        if let Some(central) = central_root {
            roots.push((
                Self::canonical_path_string(central),
                RootKind::Central,
                None,
                None,
            ));
        }
        for node in database
            .directory_repository()
            .list_nodes()?
            .into_iter()
            .filter(|node| node.exists)
        {
            roots.push((
                Self::canonical_path_string(&node.path),
                RootKind::Agent,
                Some(node.node_id),
                None,
            ));
        }
        if let Some(snapshot) = database.agent_repository().load()? {
            for target in snapshot
                .logical_targets
                .into_iter()
                .filter(|target| target.available && target.exists)
            {
                roots.push((
                    Self::canonical_path_string(&target.path),
                    RootKind::Agent,
                    None,
                    Some(target.client_id),
                ));
            }
        }
        for project in database.project_repository().list()? {
            roots.push((
                Self::canonical_path_string(&project.device_path),
                RootKind::Project,
                None,
                None,
            ));
        }
        let canonical = Self::canonical_path_string(resolved_root);
        let matched = roots
            .into_iter()
            .filter(|(root, _, _, _)| canonical == *root || path_lives_under(&canonical, root))
            .max_by_key(|(root, kind, _, _)| (root.chars().count(), kind_rank(kind)));
        let physical = skillhub_core::physical_id_for_path(resolved_root);
        Ok(
            matched.map(|(_, kind, node_id, client_id)| ClassifiedImportSource {
                source_class: match kind {
                    RootKind::Central => skillhub_core::ImportSourceClass::CentralLibrary,
                    RootKind::Project => skillhub_core::ImportSourceClass::RegisteredProject,
                    RootKind::Agent => skillhub_core::ImportSourceClass::AgentLocal,
                },
                physical_source_id: match kind {
                    RootKind::Central => None,
                    _ => physical,
                },
                source_container_id: node_id,
                agent_client_id: client_id,
            }),
        )
    }

    /// 库内每个 Skill 当前版本的 (skill_id, content_hash)。
    fn library_content_hashes(
        database: &Database,
    ) -> AppResult<Vec<(skillhub_core::SkillId, String)>> {
        let mut statement = database
            .connection_for_test()
            .prepare(
                "SELECT p.skill_id, v.content_hash FROM current_pointers p \
                 JOIN versions v ON v.id=p.version_id",
            )
            .map_err(|error| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("source", error.to_string())
            })?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("source", error.to_string())
            })?;
        rows.map(|row| {
            let (skill, hash) = row.map_err(|error| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("source", error.to_string())
            })?;
            let skill_id = skill.parse().map_err(|_| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("reason", "skill_id_corrupt")
            })?;
            Ok((skill_id, hash))
        })
        .collect()
    }

    /// 扫描指纹与库内 content_hash 是两种算法：关系比对必须使用与版本
    /// 清单一致的 canonical tree hash（复用 hash_tree_read_only），而不是
    /// scanner 的传输校验指纹。单个路径哈希失败只意味着"本次无法核验"，
    /// 该路径跳过判定，绝不据此释放或改写既有关系。
    fn scan_observations(
        &self,
        scan: &skillhub_core::ScanResult,
        library: &Arc<library_runtime::LibraryContext>,
    ) -> Vec<skillhub_core::ObservedPathObservation> {
        let mut observations = Vec::with_capacity(scan.discovered.len());
        for discovered in &scan.discovered {
            let Ok(fingerprint) = library.store.hash_tree_read_only(&discovered.path) else {
                continue;
            };
            observations.push(skillhub_core::ObservedPathObservation {
                path: discovered.path.clone(),
                fingerprint,
            });
        }
        observations
    }

    /// 扫描落盘后的比对产出（M-08 设计取舍：由 facade 比对而非扩展
    /// scanner——adapters 不依赖 storage/catalog，且指纹可比性要求使用
    /// VersionStore 的 canonical hash；ScanResult 持久化契约保持不变）。
    /// 身份可靠（指纹一致）自动建立/维持关系；不可靠标注分叉；路径消失
    /// 收回关系。全程只写 SkillHub 自己的表，绝不触碰用户文件。
    fn reconcile_observed_deployments(&self, scan: &skillhub_core::ScanResult) -> AppResult<()> {
        let _relation_migration_guard = self.lock_relation_migration("observed.reconcile")?;
        // 未激活集中库时没有任何可比对象：诚实缺省为"无关系"，不报错。
        let Ok(library) = self.library_runtime.snapshot() else {
            return Ok(());
        };
        let observations = self.scan_observations(scan, &library);
        let observed_at = now_epoch_seconds();
        self.with_database("observed.reconcile", |database| {
            let hashes = Self::library_content_hashes(database)?;
            let repository = database.provenance_repository();
            let existing = repository.list_observed()?;
            let scanned_roots = scan
                .roots
                .iter()
                .map(|root| Self::canonical_path_string(root))
                .collect::<Vec<_>>();
            for row in &existing {
                // 只裁决本次扫描覆盖的根之下的关系；未扫描范围不动。行里
                // 存的路径可能来自导入候选（未解析符号链接前缀），先折叠
                // 到 canonical 形态再比较。
                let row_path = Self::canonical_path_string(&row.original_path);
                if !scanned_roots
                    .iter()
                    .any(|root| path_lives_under(&row_path, root))
                {
                    continue;
                }
                let observation = observations
                    .iter()
                    .find(|item| observed_path_key(&item.path) == observed_path_key(&row_path));
                let matched = observation.as_ref().and_then(|item| {
                    hashes
                        .iter()
                        .find(|(_, hash)| hash == &item.fingerprint)
                        .map(|(skill_id, _)| *skill_id)
                });
                let action = reconcile_observed_row(Some(row), observation, matched);
                // 既有行始终用它自己存储的路径寻址：upsert/状态迁移都按
                // path_key 命中，改传观察路径可能错过历史行。
                repository.apply_observed_row_action(
                    &row.client_id,
                    &row.original_path,
                    &action,
                    row.origin,
                    observed_at,
                )?;
            }
            // 新观察：只有在已知 Agent 目录之下且指纹与库内某 Skill 一致
            // 时才建档；不一致（不猜）或归属不明（不猜）一律不建档。
            for observation in &observations {
                let already_rowed = existing.iter().any(|row| {
                    observed_path_key(&Self::canonical_path_string(&row.original_path))
                        == observed_path_key(&observation.path)
                });
                if already_rowed {
                    continue;
                }
                let Some(client_id) = Self::resolve_agent_client_id(database, &observation.path)?
                else {
                    continue;
                };
                let matched = hashes
                    .iter()
                    .find(|(_, hash)| hash == &observation.fingerprint)
                    .map(|(skill_id, _)| *skill_id);
                let action = reconcile_observed_row(None, Some(observation), matched);
                repository.apply_observed_row_action(
                    &client_id,
                    &observation.path,
                    &action,
                    skillhub_core::ObservedOrigin::Scan,
                    observed_at,
                )?;
            }
            Ok(())
        })
    }

    /// Skill 详情/导入摘要消费的溯源 + 已观察关系视图。纯读取。
    fn skill_provenance(
        &self,
        skill_id: skillhub_core::SkillId,
    ) -> AppResult<skillhub_core::api::SkillProvenanceResult> {
        self.with_database("query.get_skill_provenance", |database| {
            let repository = database.provenance_repository();
            Ok(skillhub_core::api::SkillProvenanceResult {
                skill_id,
                provenance: repository.provenance_for_skill(skill_id)?,
                observed_deployments: repository.list_observed_for_skill(skill_id)?,
            })
        })
    }

    /// 导入提交即存证：写溯源、并在身份可靠（指纹一致）且归属明确时
    /// 自动建立已观察部署关系。复用已有 Skill 时不覆盖其既有存证历史。
    /// 单一导入结果写入点（plan 4.9）：在一个数据库事务里追加不可变
    /// provenance 事件、写批次项，并按权威类别/物理身份 upsert 活动来源
    /// 副本（仅 AgentLocal/UserLocal 可建）。同一物理身份已活动映射其他
    /// Skill 时返回 needs_identity_decision，绝不覆盖旧关系；
    /// Online/项目/集中库只写事件；TemporaryCache 不落临时目录路径。
    /// 兼容投影在同一事务维护，供既有读取方继续工作。
    /// 发现阶段未运行（直接 Prepare/Commit 的调用方）时的按需分类兜底：
    /// 仍走唯一的权威分类器并回写注册表，绝不从路径猜类别。仓库下载
    /// 缓存（带上游坐标）与发现路径一致按 Online 处理。
    fn classify_import_source_on_demand(
        &self,
        database: &Database,
        candidate: &skillhub_core::ImportCandidate,
        observed_key: &str,
    ) -> Option<ClassifiedImportSource> {
        let classified = if candidate.upstream.is_some() {
            ClassifiedImportSource {
                source_class: skillhub_core::ImportSourceClass::Online,
                physical_source_id: None,
                source_container_id: None,
                agent_client_id: None,
            }
        } else {
            let central_root = self
                .library_runtime
                .snapshot()
                .ok()
                .map(|library| library.root.to_string_lossy().into_owned());
            Self::classify_import_source(
                database,
                &candidate.source,
                &candidate.absolute_root,
                central_root.as_deref(),
            )
            .ok()?
        };
        if let Ok(mut registry) = self.import_source_classifications.lock() {
            registry.insert(observed_key.to_owned(), classified.clone());
        }
        Some(classified)
    }

    fn record_import_outcome(
        &self,
        database: &Database,
        slot: &ImportBatchSlot,
        candidate: &skillhub_core::ImportCandidate,
        final_skill_id: skillhub_core::SkillId,
        fingerprint: &str,
        establish_observed: bool,
    ) -> AppResult<RecordedImportOutcome> {
        let observed_key = observed_path_key(&candidate.absolute_root);
        let classification = self
            .import_source_classifications
            .lock()
            .ok()
            .and_then(|registry| registry.get(&observed_key).cloned())
            .or_else(|| self.classify_import_source_on_demand(database, candidate, &observed_key));
        let source_class = classification
            .as_ref()
            .map(|classified| classified.source_class)
            .or(candidate.source_class)
            .unwrap_or(skillhub_core::ImportSourceClass::LegacyUnclassified);
        let temporary_cache = matches!(
            candidate.acquisition,
            Some(skillhub_core::ImportAcquisitionContext {
                workspace_kind: skillhub_core::AcquisitionWorkspaceKind::TemporaryCache,
                ..
            })
        );
        // 仓库导入的长期来源是 git 坐标；下载缓存目录绝不进入长期事实。
        let origin_source = match candidate.upstream.clone() {
            Some(upstream) => SourceDescriptor::new(
                skillhub_core::SourceKind::Git,
                SourceLocator::git_url(upstream.url.clone()),
            ),
            None => candidate.source.clone(),
        };
        let local_source_path =
            if source_class == skillhub_core::ImportSourceClass::Online || temporary_cache {
                None
            } else {
                Some(candidate.absolute_root.clone())
            };
        let physical_source_id = classification
            .as_ref()
            .and_then(|classified| classified.physical_source_id.clone());
        let source_container_id = classification
            .as_ref()
            .and_then(|classified| classified.source_container_id.clone())
            .or_else(|| candidate.source_container_id.clone());
        let agent_client_id = classification
            .as_ref()
            .and_then(|classified| classified.agent_client_id.clone())
            .or_else(|| {
                Self::resolve_agent_client_id(database, &candidate.absolute_root)
                    .ok()
                    .flatten()
            });
        let event = skillhub_core::import::ImportProvenanceEvent {
            provenance_id: format!("prov-{}", skillhub_core::OperationId::new()),
            batch_id: slot.batch_id.clone(),
            skill_id: final_skill_id,
            source_class,
            source: origin_source,
            local_source_path,
            source_container_id,
            physical_source_id: physical_source_id.clone(),
            agent_client_id: agent_client_id.clone(),
            content_fingerprint: fingerprint.to_owned(),
            imported_at: now_epoch_seconds(),
        };
        let mut provenance = skillhub_core::ImportProvenance::new(
            final_skill_id,
            &candidate.absolute_root,
            candidate.source.clone(),
            candidate.ownership,
            fingerprint,
            event.imported_at,
        );
        if let Some(client) = agent_client_id.as_ref() {
            provenance = provenance.with_agent_client_id(client.clone());
        }
        let transaction = database.begin_transaction()?;
        skillhub_storage::ProvenanceRepository::append_provenance_event_tx(&transaction, &event)?;
        let mut source_relation_id = None;
        if let Some(physical_id) = physical_source_id.as_deref() {
            let active = database
                .relationship_repository()
                .list_source_copy_relations(true)?;
            // 身份冲突（plan 4.4）：同一物理身份已活动映射其他 Skill 时，
            // 指向新 Skill 的决策必须显式裁决，不覆盖旧关系。
            if let Some(existing) = active
                .iter()
                .find(|relation| {
                    relation.physical_source_id == physical_id
                        && relation.skill_id != final_skill_id
                })
                .cloned()
            {
                transaction.rollback().ok();
                return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                    .with_param("reason", "needs_identity_decision")
                    .with_param("relation_id", existing.relation_id)
                    .with_action(RecoveryAction::ChooseAnotherName));
            }
            // 同一 Skill 重复导入同一来源时刷新既有活动关系而不是新插一
            // 行：(Skill, 物理身份/路径) 是唯一活动槽位，upsert 以
            // relation_id 为键。
            let relation_id = active
                .iter()
                .find(|relation| {
                    relation.skill_id == final_skill_id
                        && (relation.physical_source_id == physical_id
                            || relation.source_path_key == observed_key)
                })
                .map(|relation| relation.relation_id.clone())
                .unwrap_or_else(|| format!("rel-{}", skillhub_core::OperationId::new()));
            if let Some(fact) =
                skillhub_core::relationship::SourceCopyRelationFact::from_import_event(
                    relation_id,
                    &event,
                    observed_key,
                    physical_id,
                )
            {
                skillhub_storage::RelationshipRepository::upsert_source_copy_relation_tx(
                    &transaction,
                    &fact,
                    "fs",
                    1,
                )?;
                source_relation_id = Some(fact.relation_id.clone());
            }
        }
        skillhub_storage::ProvenanceRepository::record_batch_item_tx(
            &transaction,
            &skillhub_storage::ImportBatchItemRecord {
                batch_id: slot.batch_id.clone(),
                candidate_key: slot.candidate_key.clone(),
                skill_id: Some(final_skill_id),
                provenance_id: Some(event.provenance_id.clone()),
                source_relation_id: source_relation_id.clone(),
                status: skillhub_storage::ImportBatchItemStatus::Succeeded,
                reason: None,
            },
        )?;
        // 兼容投影（deprecated）：同事务维护，供 collect_migration_facts
        // 等既有读取方继续工作；身份以不可变事件为准。覆写保持关闭——
        // 复用确认绝不改写被复用 Skill 的首次存证事实。
        skillhub_storage::ProvenanceRepository::upsert_provenance_projection_tx(
            &transaction,
            &provenance,
            false,
        )?;
        skillhub_storage::Database::commit_transaction(transaction)?;
        // 已观察部署关系：只在"指纹一致 + 归属明确"且本次是真正复制入库
        // 的导入时建立（既有语义）；复用确认只补事件与关系事实，观察行
        // 交给扫描以 canonical 形态建档。
        if let Some(client) = agent_client_id.as_ref() {
            if establish_observed
                && Self::fingerprint_matches_current_version(database, final_skill_id, fingerprint)?
            {
                let observation = skillhub_core::ObservedPathObservation {
                    path: candidate.absolute_root.clone(),
                    fingerprint: fingerprint.to_owned(),
                };
                let action = reconcile_observed_row(None, Some(&observation), Some(final_skill_id));
                database.provenance_repository().apply_observed_row_action(
                    client,
                    &observation.path,
                    &action,
                    skillhub_core::ObservedOrigin::Import,
                    now_epoch_seconds(),
                )?;
            }
        }
        Ok(RecordedImportOutcome {
            provenance: Some(provenance),
            source_relation_id,
        })
    }

    /// 稳定候选键 = acquisition identity + normalized relative skill root；
    /// 显示名绝不参与（plan 4.7）。
    fn candidate_key_for(candidate: &skillhub_core::ImportCandidate) -> String {
        let identity = serde_json::to_string(&candidate.source).unwrap_or_default();
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        std::hash::Hash::hash(&identity, &mut hasher);
        format!(
            "{:016x}|{}",
            std::hash::Hasher::finish(&hasher),
            observed_path_key(&candidate.relative_root)
        )
    }

    fn fingerprint_matches_current_version(
        database: &Database,
        skill_id: skillhub_core::SkillId,
        fingerprint: &str,
    ) -> AppResult<bool> {
        Ok(Self::library_content_hashes(database)?
            .into_iter()
            .any(|(candidate, hash)| candidate == skill_id && hash == fingerprint))
    }

    /// 比较用的路径同一性形态：能 canonicalize 就解析符号链接前缀
    /// （macOS 的 /var → /private/var、/tmp → /private/tmp 等），不能
    /// （路径不存在等）就保留原样。只用于比较，绝不落库——存储侧保留
    /// 各链路"观察到的形态"，同一目录不会因前缀形态不同而重复建档或
    /// 漏判归属。
    fn canonical_path_string(path: &str) -> String {
        std::fs::canonicalize(path)
            .map(|resolved| resolved.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.to_owned())
    }

    // ----- 原始文件迁移（独立、明确、可回滚；与扫描/导入完全解耦） -----

    /// 采集迁移准备所需的文件系统与库事实。只读，绝不修改。
    /// 计划 8.12：迁移事实只从活动来源关系取得路径/期望指纹；探针与
    /// 指纹复核由 Task 5 的 Full 校验完成并落库，这里补齐文件系统形态、
    /// 部署占用，以及 Agent 呈现/逻辑目标上下文（共享目录展开关联
    /// Agent，不压扁成单一 agent）。
    fn collect_migration_facts(
        &self,
        database: &Database,
        relation: &SourceCopyRelationFact,
    ) -> AppResult<skillhub_core::OriginalMigrationFacts> {
        let original_path = PathBuf::from(&relation.source_path);
        let metadata = std::fs::symlink_metadata(&original_path).ok();
        let (shared_directory_node_id, associated_agent_client_ids) =
            match relation.source_container_id.as_deref() {
                Some(node_id) => {
                    let node = database
                        .directory_repository()
                        .get_node(node_id)?
                        .filter(|node| node.role == DirectoryRole::SharedDirectory);
                    let associated = if node.is_some() {
                        let mut agents = database
                            .relationship_repository()
                            .list_capabilities()?
                            .into_iter()
                            .filter(|capability| capability.directory_node_id == node_id)
                            .map(|capability| capability.agent_client_id)
                            .collect::<Vec<_>>();
                        agents.sort();
                        agents.dedup();
                        agents
                    } else {
                        Vec::new()
                    };
                    (node.map(|_| node_id.to_owned()), associated)
                }
                None => (None, Vec::new()),
            };
        Ok(skillhub_core::OriginalMigrationFacts {
            relation: Some(relation.clone()),
            path_exists: metadata.is_some(),
            is_symlink_or_junction: metadata
                .as_ref()
                .is_some_and(|metadata| metadata.file_type().is_symlink()),
            is_directory: metadata.as_ref().is_some_and(|metadata| metadata.is_dir()),
            // 指纹以 Full 校验后的关系为准，不在这里二次哈希。
            current_fingerprint: relation.current_fingerprint.clone(),
            has_managed_deployment_at_path: Self::has_managed_deployment_at_path(
                database,
                &original_path,
            )?,
            relationship_revision: database.relationship_repository().relationship_revision()?,
            agent_client_id: relation.agent_client_id.clone(),
            shared_directory_node_id,
            associated_agent_client_ids,
        })
    }

    /// 该路径当前是否是某个 SkillHub 活跃部署的目的地。是则必须先解除
    /// 部署——迁移绝不与部署所有权纠缠。
    fn has_managed_deployment_at_path(
        database: &Database,
        original_path: &Path,
    ) -> AppResult<bool> {
        let mut statement = database
            .connection_for_test()
            .prepare(
                "SELECT t.path, d.runtime_name FROM deployments d \
                 JOIN targets t ON t.id=d.target_id WHERE d.state='deployed'",
            )
            .map_err(|error| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("source", error.to_string())
            })?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("source", error.to_string())
            })?;
        for row in rows {
            let (target, runtime_name) = row.map_err(|error| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("source", error.to_string())
            })?;
            // 两边都折叠到 canonical 形态：注册 target 与导入存证的路径
            // 可能带不同的符号链接前缀，但指向同一个目录。
            let deployed_path = Self::canonical_path_string(
                &PathBuf::from(&target).join(&runtime_name).to_string_lossy(),
            );
            let provenance_path = Self::canonical_path_string(&original_path.to_string_lossy());
            if observed_path_key(&deployed_path) == observed_path_key(&provenance_path) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn prepare_original_migration(
        &self,
        request: skillhub_core::api::PrepareOriginalMigration,
    ) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        let journal_denied = |error: &AppError| {
            self.journal_advance(
                operation_id,
                "migrate_original",
                skillhub_core::OperationPhase::RolledBack,
                Some(error.code),
            )
        };
        // 迁移以来源关系为对象（计划 8A）：先取关系（独立短锁），缺行
        // 即拒；已归档关系是历史，不复活。
        let relation = self
            .with_database("execute.prepare_original_migration.load", |database| {
                database
                    .relationship_repository()
                    .list_source_copy_relations(false)?
                    .into_iter()
                    .find(|relation| relation.relation_id == request.source_relation_id)
                    .ok_or_else(|| {
                        AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                            .with_param("source_relation_id", request.source_relation_id.clone())
                            .with_action(RecoveryAction::ChooseAnotherName)
                    })
            })
            .inspect_err(journal_denied)?;
        if !relation.active {
            let error = AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("source_relation_id", request.source_relation_id.clone())
                .with_param("detail", "source relation is archived")
                .with_action(RecoveryAction::Acknowledge);
            journal_denied(&error);
            return Err(error);
        }
        // 计划 8.12：Full 校验先行（自取数据库锁，不嵌套），健康与最新
        // 指纹落库后重读关系，冲突判定以校验后的事实为准。
        if let Err(error) = self.run_relationship_check(skillhub_core::api::RunRelationshipCheck {
            level: skillhub_core::relationship::RelationshipCheckLevel::Full,
            scope: skillhub_core::relationship::RelationshipCheckScope::RelationIds {
                relation_ids: vec![relation.relation_id.clone()],
            },
        }) {
            journal_denied(&error);
            return Err(error);
        }
        let plan = self.with_database("execute.prepare_original_migration.plan", |database| {
            let checked = database
                .relationship_repository()
                .list_source_copy_relations(false)?
                .into_iter()
                .find(|relation| relation.relation_id == request.source_relation_id)
                .ok_or_else(|| {
                    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                        .with_param("source_relation_id", request.source_relation_id.clone())
                        .with_action(RecoveryAction::ChooseAnotherName)
                })?;
            let facts = self.collect_migration_facts(database, &checked)?;
            Ok(plan_original_migration(
                operation_id,
                checked.skill_id,
                &facts,
            ))
        });
        match plan.as_ref() {
            Ok(plan) => {
                self.prepared_migrations
                    .lock()
                    .map_err(|_| internal("execute.prepare_original_migration"))?
                    .insert(plan.operation_id, plan.clone());
                self.journal_prepared(plan.operation_id, "migrate_original");
            }
            Err(error) => journal_denied(error),
        }
        plan.map(AppCommandResult::OriginalMigrationPlan)
    }

    /// 计划 8.15：保留来源副本——只把决策改为 Retained 并记录治理历史，
    /// 绝不读写来源目录。幂等：已是 Retained 原样返回，不重复写历史。
    /// 仅供测试：注入删除失败假象（权限墙/占用等无法跨平台模拟）。
    #[doc(hidden)]
    pub fn set_original_migration_deletion_for_tests(
        &self,
        deletion: std::sync::Arc<dyn OriginalMigrationDeletion>,
    ) {
        *self
            .original_migration_deletion
            .lock()
            .expect("deletion lock") = deletion;
    }

    fn retain_source_copy(
        &self,
        request: skillhub_core::api::RetainSourceCopy,
    ) -> AppResult<AppCommandResult> {
        let database = self.database.clone();
        let database = database.lock().expect("database lock");
        let relation = database
            .relationship_repository()
            .list_source_copy_relations(false)?
            .into_iter()
            .find(|relation| relation.relation_id == request.source_relation_id)
            .ok_or_else(|| {
                AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("source_relation_id", request.source_relation_id.clone())
                    .with_action(RecoveryAction::ChooseAnotherName)
            })?;
        if !relation.active {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("source_relation_id", request.source_relation_id)
                .with_param("detail", "source relation is archived")
                .with_action(RecoveryAction::Acknowledge));
        }
        if relation.decision == skillhub_core::relationship::SourceCopyDecision::Retained {
            return Ok(AppCommandResult::SourceCopyRelationUpdated(relation));
        }
        let mut retained = relation.clone();
        retained.decision = skillhub_core::relationship::SourceCopyDecision::Retained;
        let display_name = database
            .catalog_repository()
            .and_then(|repository| repository.get_sync(relation.skill_id))
            .ok()
            .flatten()
            .map(|skill| skill.runtime_name().to_owned())
            .unwrap_or_else(|| "unknown-skill".to_owned());
        let transaction = database.begin_transaction()?;
        skillhub_storage::RelationshipRepository::upsert_source_copy_relation_tx(
            &transaction,
            &retained,
            "fs",
            1,
        )?;
        skillhub_storage::GovernanceHistoryRepository::append_tx(
            &transaction,
            &GovernanceHistoryEvent {
                event_id: format!("hist-{}", OperationId::new()),
                relation_id: relation.relation_id.clone(),
                skill_id: Some(relation.skill_id.to_string()),
                skill_display_name: display_name,
                agent_presentation: serde_json::json!({
                    "client_id": relation.agent_client_id,
                }),
                path: relation.source_path.clone(),
                scope: "source_copy".to_owned(),
                project_id: relation.source_container_id.clone(),
                action: "retain".to_owned(),
                result: "retained".to_owned(),
                reason: None,
                operation_id: None,
                occurred_at: now_epoch_seconds(),
            },
        )?;
        Database::commit_transaction(transaction)?;
        Ok(AppCommandResult::SourceCopyRelationUpdated(retained))
    }

    /// 计划 8.8/8.15：重新关联——把已因外部删除归档的来源关系指向用户
    /// 重新选择的目录。身份与内容必须完整校验：新目录的 SKILL.md 声明名
    /// 必须与集中库 runtime_name 一致（绝不按目录名猜测身份），新物理身份
    /// 必须可建立且不与活动关系冲突。成功时始终创建新关系与新历史事件，
    /// 旧关系与旧 provenance event 原样保留。
    fn relink_source_copy(
        &self,
        request: skillhub_core::api::RelinkSourceCopy,
    ) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "relink_source_copy");
        let journal_denied = |error: &AppError| {
            self.journal_advance(
                operation_id,
                "relink_source_copy",
                skillhub_core::OperationPhase::RolledBack,
                Some(error.code),
            )
        };
        // 独立短锁取旧关系（含归档）：只有 ExternalRemoved 是重关联对象。
        let old = self
            .with_database("execute.relink_source_copy.load", |database| {
                database
                    .relationship_repository()
                    .list_source_copy_relations(false)?
                    .into_iter()
                    .find(|relation| relation.relation_id == request.source_relation_id)
                    .ok_or_else(|| {
                        AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                            .with_param("source_relation_id", request.source_relation_id.clone())
                            .with_action(RecoveryAction::ChooseAnotherName)
                    })
            })
            .inspect_err(journal_denied)?;
        if old.active
            || old.archive_reason
                != Some(skillhub_core::relationship::SourceCopyArchiveReason::ExternalRemoved)
        {
            let error = AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("source_relation_id", old.relation_id.clone())
                .with_param(
                    "detail",
                    "only externally removed relations can be relinked",
                )
                .with_action(RecoveryAction::Acknowledge);
            journal_denied(&error);
            return Err(error);
        }
        // 新目录核验（文件系统短操作）：存在、是真实目录、声明了 Skill
        // 身份；集中库内部路径不是用户来源。
        let new_path = PathBuf::from(&request.new_source_path);
        let metadata = std::fs::symlink_metadata(&new_path).map_err(|_| {
            AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("path", request.new_source_path.clone())
                .with_param("detail", "chosen directory does not exist")
                .with_action(RecoveryAction::ChooseAnotherName)
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            let error = AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("path", request.new_source_path.clone())
                .with_param("detail", "chosen path is not a real directory")
                .with_action(RecoveryAction::ChooseAnotherName);
            journal_denied(&error);
            return Err(error);
        }
        let markdown = std::fs::read_to_string(new_path.join("SKILL.md")).map_err(|_| {
            AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("path", request.new_source_path.clone())
                .with_param("detail", "chosen directory has no SKILL.md")
                .with_action(RecoveryAction::ChooseAnotherName)
        })?;
        let declared_name = read_frontmatter_name(&markdown).ok_or_else(|| {
            AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("path", request.new_source_path.clone())
                .with_param("detail", "chosen directory does not declare a skill name")
                .with_action(RecoveryAction::ChooseAnotherName)
        })?;
        let library = self.library_runtime.snapshot()?;
        let canonical = Self::canonical_path_string(&request.new_source_path);
        // 库根与候选路径同走规范化，避免 Windows 扩展长度前缀（\\?\）
        // 造成前缀比较失效（与导入分类的库根比较同款处理）。
        let library_root = Self::canonical_path_string(&library.root.to_string_lossy());
        if path_lives_under(&canonical, &library_root) {
            let error = AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("path", canonical.clone())
                .with_param("detail", "chosen path lives under the central library")
                .with_action(RecoveryAction::ChooseAnotherName);
            journal_denied(&error);
            return Err(error);
        }
        // 身份核验（8.8）：声明名必须与集中库 runtime_name 一致；绝不
        // 按目录名猜测，也绝不按名称搜索替代目录。
        let runtime_name = self
            .with_database("execute.relink_source_copy.identity", |database| {
                let detail = database
                    .catalog_repository()?
                    .get_detail(old.skill_id)?
                    .ok_or_else(|| {
                        AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                            .with_param("skill_id", old.skill_id.to_string())
                            .with_action(RecoveryAction::ChooseAnotherName)
                    })?;
                Ok(detail.runtime_name)
            })
            .inspect_err(journal_denied)?;
        if declared_name != runtime_name {
            let error = AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("runtime_name", runtime_name)
                .with_param("declared_name", declared_name)
                .with_param(
                    "detail",
                    "chosen directory does not declare this skill's identity",
                )
                .with_action(RecoveryAction::ChooseAnotherName);
            journal_denied(&error);
            return Err(error);
        }
        // 新物理身份（8.8）：恢复/移动后的目录是新的物理目录；身份可建立
        // 且槽位（物理身份、路径键）不被活动关系占用。
        let physical_source_id = physical_id_for_path(&new_path).ok_or_else(|| {
            AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("path", canonical.clone())
                .with_param(
                    "detail",
                    "cannot establish a physical identity for the path",
                )
                .with_action(RecoveryAction::ChooseAnotherName)
        })?;
        let source_path_key = observed_path_key(&canonical);
        let mut relation = old.clone();
        relation.relation_id = format!("rel-{}", OperationId::new());
        relation.source_path = canonical.clone();
        relation.source_path_key = source_path_key;
        relation.physical_source_id = physical_source_id;
        relation.active = true;
        relation.archived_at = None;
        relation.archive_reason = None;
        relation.health = skillhub_core::relationship::SourceCopyHealth::NeedsValidation;
        relation.current_fingerprint = None;
        relation.last_verified_at = None;
        let occupied = self
            .with_database("execute.relink_source_copy.slots", |database| {
                let existing = database
                    .relationship_repository()
                    .list_source_copy_relations(true)?;
                Ok(
                    skillhub_core::relationship::SourceCopyRelationFact::active_physical_conflict(
                        &existing, &relation,
                    ) || existing
                        .iter()
                        .any(|candidate| candidate.source_path_key == relation.source_path_key),
                )
            })
            .inspect_err(journal_denied)?;
        if occupied {
            let error = AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("path", canonical)
                .with_param(
                    "detail",
                    "another active source relation occupies this slot",
                )
                .with_action(RecoveryAction::InspectTarget);
            journal_denied(&error);
            return Err(error);
        }
        // 单事务：新建关系 + 新历史事件（锚在旧关系 id 上）；旧关系与旧
        // provenance event 原样保留。
        self.with_database("execute.relink_source_copy.commit", |database| {
            let display_name = database
                .catalog_repository()
                .and_then(|repository| repository.get_sync(old.skill_id))
                .ok()
                .flatten()
                .map(|skill| skill.runtime_name().to_owned())
                .unwrap_or_else(|| "unknown-skill".to_owned());
            let transaction = database.begin_transaction()?;
            skillhub_storage::RelationshipRepository::upsert_source_copy_relation_tx(
                &transaction,
                &relation,
                "fs",
                1,
            )?;
            skillhub_storage::GovernanceHistoryRepository::append_tx(
                &transaction,
                &GovernanceHistoryEvent {
                    event_id: format!("hist-{}", OperationId::new()),
                    relation_id: old.relation_id.clone(),
                    skill_id: Some(old.skill_id.to_string()),
                    skill_display_name: display_name,
                    agent_presentation: serde_json::json!({
                        "client_id": old.agent_client_id,
                    }),
                    path: relation.source_path.clone(),
                    scope: "source_copy".to_owned(),
                    project_id: old.source_container_id.clone(),
                    action: "relink".to_owned(),
                    result: "relinked".to_owned(),
                    reason: None,
                    operation_id: Some(operation_id.to_string()),
                    occurred_at: now_epoch_seconds(),
                },
            )?;
            Database::commit_transaction(transaction)?;
            Ok(())
        })
        .inspect_err(journal_denied)?;
        // 建立后的 Full 校验核对内容（结果如实落库：一致→Normal，分叉→
        // ContentChanged；校验结果不否定关系重建本身）。
        let _ = self.run_relationship_check(skillhub_core::api::RunRelationshipCheck {
            level: skillhub_core::relationship::RelationshipCheckLevel::Full,
            scope: skillhub_core::relationship::RelationshipCheckScope::RelationIds {
                relation_ids: vec![relation.relation_id.clone()],
            },
        });
        let fact = self
            .with_database("execute.relink_source_copy.reload", |database| {
                Ok(database
                    .relationship_repository()
                    .list_source_copy_relations(false)?
                    .into_iter()
                    .find(|candidate| candidate.relation_id == relation.relation_id)
                    .unwrap_or(relation))
            })
            .inspect_err(journal_denied)?;
        self.journal_advance(
            operation_id,
            "relink_source_copy",
            skillhub_core::OperationPhase::Committed,
            None,
        );
        Ok(AppCommandResult::SourceCopyRelationUpdated(fact))
    }

    fn commit_original_migration(
        &self,
        request: skillhub_core::api::CommitOriginalMigration,
    ) -> AppResult<AppCommandResult> {
        let plan = self
            .prepared_migrations
            .lock()
            .map_err(|_| internal("execute.commit_original_migration"))?
            .get(&request.prepared_migration_id)
            .cloned()
            .ok_or_else(|| {
                AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param(
                        "prepared_migration_id",
                        request.prepared_migration_id.to_string(),
                    )
                    .with_action(RecoveryAction::ChooseAnotherName)
            })?;
        // 硬边界（领域规则）：未确认或仍有冲突 → 拒绝，不触碰任何文件。
        ensure_original_deletion_authorized(&plan, request.ownership_confirmed)?;
        let result = self.commit_original_migration_flow(&plan);
        match result.as_ref() {
            Ok(_) => self.journal_advance(
                plan.operation_id,
                "migrate_original",
                skillhub_core::OperationPhase::Committed,
                None,
            ),
            Err(error) => self.journal_advance(
                plan.operation_id,
                "migrate_original",
                skillhub_core::OperationPhase::NeedsRecovery,
                Some(error.code),
            ),
        }
        if result.is_ok() {
            self.prepared_migrations
                .lock()
                .map_err(|_| internal("execute.commit_original_migration.cleanup"))?
                .remove(&request.prepared_migration_id);
        }
        result.map(AppCommandResult::OriginalMigrationResult)
    }

    /// 迁移执行（计划 8.3/8.4/8.5/8.13）：备份 → checkpoint → 删除 →
    /// 单事务原子归档（关系 Cleaned + 历史 migrated + 记录 Migrated）。
    /// 任何失败立即中止并保留现场：备份与审计绝不删除；能确认原目录
    /// 仍在时标 Failed（关系 OperationFailed + 历史 failed），不能确认
    /// 时标 NeedsRecovery 交启动恢复推进，绝不假装原文件仍在。
    fn commit_original_migration_flow(
        &self,
        plan: &skillhub_core::OriginalMigrationPlan,
    ) -> AppResult<skillhub_core::OriginalMigrationResult> {
        let library = self.library_runtime.snapshot()?;
        let original = PathBuf::from(&plan.original_path);
        // 提交前用最新事实复核一遍准备结论（准备与提交之间现场可能变化）：
        // 重读来源关系并按 Full 校验后的事实重算冲突（计划 8.12）。
        self.with_database("execute.commit_original_migration.verify", |database| {
            let relation = database
                .relationship_repository()
                .list_source_copy_relations(false)?
                .into_iter()
                .find(|relation| relation.relation_id == plan.relation_id)
                .ok_or_else(|| {
                    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                        .with_param("source_relation_id", plan.relation_id.clone())
                        .with_action(RecoveryAction::ChooseAnotherName)
                })?;
            let facts = self.collect_migration_facts(database, &relation)?;
            let fresh = plan_original_migration(plan.operation_id, plan.skill_id, &facts);
            ensure_original_deletion_authorized(&fresh, true)
        })?;
        // 8.13：备份根 = safe-key(relation_id)/operation_id，绝不把任意
        // 关系字符串直接当路径。
        let backup_root = library
            .root
            .join(".skillhub")
            .join("original-migrations")
            .join(original_migration_backup_key(&plan.relation_id));
        std::fs::create_dir_all(&backup_root).map_err(|error| {
            AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("io_kind", format!("{:?}", error.kind()))
                .with_action(RecoveryAction::Retry)
        })?;
        let backup = backup_root.join(plan.operation_id.to_string());
        // 备份失败：checkpoint 尚未写入，原目录未动，直接中止。
        copy_directory_tree(&original, &backup)?;
        let confirmed_at = now_epoch_seconds();
        let result = skillhub_core::OriginalMigrationResult {
            migration_id: plan.operation_id,
            skill_id: plan.skill_id,
            relation_id: plan.relation_id.clone(),
            agent: plan.agent.clone(),
            target_context: plan.target_context.clone(),
            relationship_revision: plan.relationship_revision,
            original_path: plan.original_path.clone(),
            backup_path: backup.to_string_lossy().into_owned(),
            content_fingerprint: plan.content_fingerprint.clone(),
            state: skillhub_core::OriginalMigrationState::BackedUp,
            confirmed_at,
            rolled_back_at: None,
            restored_relation_id: None,
        };
        // checkpoint #1：备份完成。此后任何中断都由启动恢复按事实推进。
        self.with_database("execute.commit_original_migration.checkpoint", |database| {
            database
                .provenance_repository()
                .insert_original_migration(&result)
        })?;
        // checkpoint #2：进入删除。
        self.with_database("execute.commit_original_migration.deleting", |database| {
            database
                .provenance_repository()
                .update_original_migration_state(
                    plan.operation_id,
                    skillhub_core::OriginalMigrationState::Deleting,
                )
        })?;
        // 删除前的最后防线：必须是真实目录（绝不跟随链接）。
        let metadata = std::fs::symlink_metadata(&original).map_err(|error| {
            AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("path", plan.original_path.clone())
                .with_param("io_kind", format!("{:?}", error.kind()))
                .with_action(RecoveryAction::InspectTarget)
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("path", plan.original_path.clone())
                .with_param("detail", "original path is not a real directory")
                .with_action(RecoveryAction::InspectTarget));
        }
        let deletion = self
            .original_migration_deletion
            .lock()
            .map_err(|_| internal("execute.commit_original_migration.deletion"))?
            .clone();
        if let Err(error) = deletion.delete_dir_all(&original) {
            // 8.5：审计与备份绝不删除。能确认原目录仍在 → Failed（关系
            // OperationFailed + 历史 failed）；不能确认 → NeedsRecovery。
            let still_there = std::fs::symlink_metadata(&original).is_ok();
            let state = if still_there {
                skillhub_core::OriginalMigrationState::Failed
            } else {
                skillhub_core::OriginalMigrationState::NeedsRecovery
            };
            let aborted = self.with_database("execute.commit_original_migration.abort", |database| {
                database
                    .provenance_repository()
                    .update_original_migration_state(plan.operation_id, state)?;
                if still_there {
                    if let Some(mut relation) = database
                        .relationship_repository()
                        .list_source_copy_relations(false)?
                        .into_iter()
                        .find(|relation| relation.relation_id == plan.relation_id)
                    {
                        relation.health =
                            skillhub_core::relationship::SourceCopyHealth::OperationFailed;
                        let transaction = database.begin_transaction()?;
                        skillhub_storage::RelationshipRepository::upsert_source_copy_relation_tx(
                            &transaction,
                            &relation,
                            "fs",
                            1,
                        )?;
                        Database::commit_transaction(transaction)?;
                    }
                }
                Ok(())
            });
            if let Err(abort_error) = aborted {
                eprintln!("migration abort bookkeeping failed: {abort_error}");
            }
            self.record_migration_history(
                plan.relation_id.clone(),
                plan.skill_id,
                if still_there {
                    "failed"
                } else {
                    "needs_recovery"
                },
            );
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("path", plan.original_path.clone())
                .with_param(
                    "detail",
                    "original directory deletion failed; scene preserved",
                )
                .with_param("source", error.to_string())
                .with_action(RecoveryAction::Retry));
        }
        // 8.4：删除成功后单事务原子归档：关系 Cleaned + 历史 migrated +
        // 记录 Migrated。事务失败 → NeedsRecovery（不假装原文件仍在）。
        let archive = self.with_database("execute.commit_original_migration.archive", |database| {
            let relation = database
                .relationship_repository()
                .list_source_copy_relations(false)?
                .into_iter()
                .find(|relation| relation.relation_id == plan.relation_id)
                .ok_or_else(|| {
                    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                        .with_param("source_relation_id", plan.relation_id.clone())
                        .with_action(RecoveryAction::ChooseAnotherName)
                })?;
            let transaction = database.begin_transaction()?;
            let changed =
                skillhub_storage::RelationshipRepository::archive_source_copy_relation_tx(
                    &transaction,
                    &plan.relation_id,
                    skillhub_core::relationship::SourceCopyArchiveReason::Cleaned,
                    now_epoch_seconds(),
                )?;
            if changed {
                skillhub_storage::GovernanceHistoryRepository::append_tx(
                    &transaction,
                    &migration_history_event(
                        database,
                        &relation,
                        plan.skill_id,
                        "migrate",
                        "migrated",
                        Some("cleaned_by_skill_hub"),
                        Some(plan.operation_id.to_string()),
                    ),
                )?;
            }
            skillhub_storage::ProvenanceRepository::update_original_migration_state_in_tx(
                &transaction,
                plan.operation_id,
                skillhub_core::OriginalMigrationState::Migrated,
            )?;
            Database::commit_transaction(transaction)
        });
        if let Err(error) = archive {
            self.with_database(
                "execute.commit_original_migration.needs_recovery",
                |database| {
                    database
                        .provenance_repository()
                        .update_original_migration_state(
                            plan.operation_id,
                            skillhub_core::OriginalMigrationState::NeedsRecovery,
                        )
                },
            )
            .ok();
            self.record_migration_history(
                plan.relation_id.clone(),
                plan.skill_id,
                "needs_recovery",
            );
            return Err(AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("detail", "cleanup archive failed; marked needs_recovery")
                .with_param("source", error.to_string())
                .with_action(RecoveryAction::Retry));
        }
        let mut migrated = result;
        migrated.state = skillhub_core::OriginalMigrationState::Migrated;
        Ok(migrated)
    }

    /// 迁移历史事件统一落点（migrate 前缀全部经此写入；事务提交后调用）。
    fn record_migration_history(
        &self,
        relation_id: String,
        skill_id: skillhub_core::SkillId,
        result: &str,
    ) {
        let outcome = self.with_database("record.migration_history", |database| {
            let Some(relation) = database
                .relationship_repository()
                .list_source_copy_relations(false)?
                .into_iter()
                .find(|relation| relation.relation_id == relation_id)
            else {
                return Ok(());
            };
            let transaction = database.begin_transaction()?;
            skillhub_storage::GovernanceHistoryRepository::append_tx(
                &transaction,
                &migration_history_event(
                    database, &relation, skill_id, "migrate", result, None, None,
                ),
            )?;
            Database::commit_transaction(transaction)
        });
        if let Err(error) = outcome {
            eprintln!("migration history write failed: {error}");
        }
    }

    /// 回滚：用备份恢复原目录。原路径已存在时拒绝（绝不覆盖用户文件）；
    /// 备份目录保留，审计行翻转为 RolledBack。
    fn rollback_original_migration(
        &self,
        request: skillhub_core::api::RollbackOriginalMigration,
    ) -> AppResult<AppCommandResult> {
        let record =
            self.with_database("execute.rollback_original_migration.load", |database| {
                database
                    .provenance_repository()
                    .original_migration(request.migration_id)?
                    .ok_or_else(|| {
                        AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                            .with_param("migration_id", request.migration_id.to_string())
                            .with_action(RecoveryAction::ChooseAnotherName)
                    })
            })?;
        if record.state != skillhub_core::OriginalMigrationState::Migrated {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("detail", "migration is not in a migrated state")
                .with_action(RecoveryAction::Acknowledge));
        }
        let original = PathBuf::from(&record.original_path);
        if original.exists() {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("path", record.original_path.clone())
                .with_param(
                    "detail",
                    "original path already exists; rollback would overwrite",
                )
                .with_action(RecoveryAction::Acknowledge));
        }
        let backup = PathBuf::from(&record.backup_path);
        copy_directory_tree(&backup, &original)?;
        // 8.7：旧关系保持 archived；按旧关系事实新建活动关系（新
        // relation_id），决策沿用，健康交 Full 校验裁决；绝不改写旧
        // provenance/历史事件。同 (Skill, 路径) 的活动槽位唯一：新行
        // 入库前该槽位必须空着（清理后旧关系已归档）。
        let restored_relation_id =
            self.with_database("execute.rollback_original_migration.relation", |database| {
                let old_relation = database
                    .relationship_repository()
                    .list_source_copy_relations(false)?
                    .into_iter()
                    .find(|relation| relation.relation_id == record.relation_id)
                    .ok_or_else(|| {
                        AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                            .with_param("source_relation_id", record.relation_id.clone())
                            .with_action(RecoveryAction::ChooseAnotherName)
                    })?;
                let mut relation = old_relation.clone();
                relation.relation_id = format!("rel-{}", OperationId::new());
                relation.active = true;
                relation.archived_at = None;
                relation.archive_reason = None;
                relation.health = skillhub_core::relationship::SourceCopyHealth::NeedsValidation;
                relation.current_fingerprint = None;
                relation.last_verified_at = None;
                // 恢复出的目录是新的物理目录（dev+ino 已变）：以恢复后
                // 重算的物理身份作为新关系身份，再交 Full 校验核对内容。
                if let Some(identity) = physical_id_for_path(&original) {
                    relation.physical_source_id = identity;
                }
                let existing = database
                    .relationship_repository()
                    .list_source_copy_relations(true)?;
                if skillhub_core::relationship::SourceCopyRelationFact::active_physical_conflict(
                    &existing, &relation,
                ) || existing
                    .iter()
                    .any(|candidate| candidate.source_path_key == relation.source_path_key)
                {
                    return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                        .with_param("path", relation.source_path.clone())
                        .with_param(
                            "detail",
                            "another active source relation occupies this slot",
                        )
                        .with_action(RecoveryAction::InspectTarget));
                }
                let transaction = database.begin_transaction()?;
                skillhub_storage::RelationshipRepository::upsert_source_copy_relation_tx(
                    &transaction,
                    &relation,
                    "fs",
                    1,
                )?;
                Database::commit_transaction(transaction)?;
                Ok(relation.relation_id)
            })?;
        // 恢复后 Full 校验：确认 Skill 身份与内容（结果如实落库；校验
        // 失败不否定文件恢复本身）。
        let _ = self.run_relationship_check(skillhub_core::api::RunRelationshipCheck {
            level: skillhub_core::relationship::RelationshipCheckLevel::Full,
            scope: skillhub_core::relationship::RelationshipCheckScope::RelationIds {
                relation_ids: vec![restored_relation_id.clone()],
            },
        });
        let rolled_back_at = now_epoch_seconds();
        let rollback_event =
            self.with_database("execute.rollback_original_migration.record", |database| {
                let old_relation = database
                    .relationship_repository()
                    .list_source_copy_relations(false)?
                    .into_iter()
                    .find(|relation| relation.relation_id == record.relation_id);
                let transaction = database.begin_transaction()?;
                if let Some(relation) = old_relation.as_ref() {
                    skillhub_storage::GovernanceHistoryRepository::append_tx(
                        &transaction,
                        &migration_history_event(
                            database,
                            relation,
                            record.skill_id,
                            "rollback",
                            "rolled_back",
                            None,
                            Some(request.migration_id.to_string()),
                        ),
                    )?;
                }
                skillhub_storage::ProvenanceRepository::mark_original_migration_rolled_back_in_tx(
                    &transaction,
                    request.migration_id,
                    rolled_back_at,
                    &restored_relation_id,
                )?;
                Database::commit_transaction(transaction)
            });
        if let Err(error) = rollback_event {
            eprintln!("rollback bookkeeping failed: {error}");
            return Err(error);
        }
        let mut rolled_back = record.clone();
        rolled_back.state = skillhub_core::OriginalMigrationState::RolledBack;
        rolled_back.rolled_back_at = Some(rolled_back_at);
        rolled_back.restored_relation_id = Some(restored_relation_id);
        Ok(AppCommandResult::OriginalMigrationResult(rolled_back))
    }

    /// 计划 8.14：启动恢复。扫描所有未到终态的迁移记录，按"原路径/
    /// 备份/活动关系"三方事实推进（core 纯判定），不通过删除审计做
    /// 补偿。返回推进的记录数。
    pub fn recover_original_migrations(&self) -> AppResult<usize> {
        let pending = self.with_database("recover.original_migrations.list", |database| {
            database
                .provenance_repository()
                .list_pending_original_migrations()
        })?;
        let mut advanced = 0usize;
        for record in pending {
            let original = PathBuf::from(&record.original_path);
            let backup = PathBuf::from(&record.backup_path);
            let original_exists = original.symlink_metadata().is_ok();
            let backup_exists = backup.symlink_metadata().is_ok();
            match resolve_original_migration_recovery(original_exists, backup_exists) {
                skillhub_core::import::OriginalMigrationRecoveryAdvancement::RollForward => {
                    // 删除已发生：前滚为 Migrated（补归档与历史）。
                    let rolled = self.with_database(
                        "recover.original_migrations.roll_forward",
                        |database| {
                            let transaction = database.begin_transaction()?;
                            let changed =
                                skillhub_storage::RelationshipRepository::archive_source_copy_relation_tx(
                                    &transaction,
                                    &record.relation_id,
                                    skillhub_core::relationship::SourceCopyArchiveReason::Cleaned,
                                    now_epoch_seconds(),
                                )?;
                            if changed {
                                if let Some(relation) = database
                                    .relationship_repository()
                                    .list_source_copy_relations(false)?
                                    .into_iter()
                                    .find(|relation| {
                                        relation.relation_id == record.relation_id
                                    })
                                {
                                    skillhub_storage::GovernanceHistoryRepository::append_tx(
                                        &transaction,
                                        &migration_history_event(
                                            database,
                                            &relation,
                                            record.skill_id,
                                            "migrate",
                                            "migrated",
                                            Some("cleaned_by_skill_hub"),
                                            Some(record.migration_id.to_string()),
                                        ),
                                    )?;
                                }
                            }
                            skillhub_storage::ProvenanceRepository::update_original_migration_state_in_tx(
                                &transaction,
                                record.migration_id,
                                skillhub_core::OriginalMigrationState::Migrated,
                            )?;
                            Database::commit_transaction(transaction)
                        },
                    );
                    advanced += rolled.is_ok() as usize;
                }
                skillhub_core::import::OriginalMigrationRecoveryAdvancement::RollBackToFailed => {
                    // 删除未发生：标 Failed，关系 OperationFailed，历史 failed。
                    let failed = self.with_database(
                        "recover.original_migrations.roll_back",
                        |database| {
                            database
                                .provenance_repository()
                                .update_original_migration_state(
                                    record.migration_id,
                                    skillhub_core::OriginalMigrationState::Failed,
                                )?;
                            if let Some(mut relation) = database
                                .relationship_repository()
                                .list_source_copy_relations(false)?
                                .into_iter()
                                .find(|relation| relation.relation_id == record.relation_id)
                            {
                                relation.health =
                                    skillhub_core::relationship::SourceCopyHealth::OperationFailed;
                                let transaction = database.begin_transaction()?;
                                skillhub_storage::RelationshipRepository::upsert_source_copy_relation_tx(
                                    &transaction,
                                    &relation,
                                    "fs",
                                    1,
                                )?;
                                skillhub_storage::GovernanceHistoryRepository::append_tx(
                                    &transaction,
                                    &migration_history_event(
                                        database,
                                        &relation,
                                        record.skill_id,
                                        "migrate",
                                        "failed",
                                        None,
                                        Some(record.migration_id.to_string()),
                                    ),
                                )?;
                                Database::commit_transaction(transaction)?;
                            }
                            Ok(())
                        },
                    );
                    advanced += failed.is_ok() as usize;
                }
                skillhub_core::import::OriginalMigrationRecoveryAdvancement::NeedsRecovery => {
                    // 备份缺失：只能如实转 NeedsRecovery 并记录历史。
                    let marked = self.with_database(
                        "recover.original_migrations.needs_recovery",
                        |database| {
                            database
                                .provenance_repository()
                                .update_original_migration_state(
                                    record.migration_id,
                                    skillhub_core::OriginalMigrationState::NeedsRecovery,
                                )?;
                            if let Some(relation) = database
                                .relationship_repository()
                                .list_source_copy_relations(false)?
                                .into_iter()
                                .find(|relation| relation.relation_id == record.relation_id)
                            {
                                let transaction = database.begin_transaction()?;
                                skillhub_storage::GovernanceHistoryRepository::append_tx(
                                    &transaction,
                                    &migration_history_event(
                                        database,
                                        &relation,
                                        record.skill_id,
                                        "migrate",
                                        "needs_recovery",
                                        None,
                                        Some(record.migration_id.to_string()),
                                    ),
                                )?;
                                Database::commit_transaction(transaction)?;
                            }
                            Ok(())
                        },
                    );
                    advanced += marked.is_ok() as usize;
                }
            }
        }
        Ok(advanced)
    }
}

/// 迁移/回滚的治理历史事件构造：展示名与 Agent 呈现按写时快照固化。
fn migration_history_event(
    database: &Database,
    relation: &SourceCopyRelationFact,
    skill_id: skillhub_core::SkillId,
    action: &str,
    result: &str,
    reason: Option<&str>,
    operation_id: Option<String>,
) -> GovernanceHistoryEvent {
    let skill_display_name = database
        .catalog_repository()
        .and_then(|repository| repository.get_sync(skill_id))
        .ok()
        .flatten()
        .map(|skill| skill.runtime_name().to_owned())
        .unwrap_or_else(|| "unknown-skill".to_owned());
    GovernanceHistoryEvent {
        event_id: format!("hist-{}", OperationId::new()),
        relation_id: relation.relation_id.clone(),
        skill_id: Some(skill_id.to_string()),
        skill_display_name,
        agent_presentation: serde_json::json!({
            "client_id": relation.agent_client_id,
        }),
        path: relation.source_path.clone(),
        scope: "source_copy".to_owned(),
        project_id: relation.source_container_id.clone(),
        action: action.to_owned(),
        result: result.to_owned(),
        reason: reason.map(str::to_owned),
        operation_id,
        occurred_at: now_epoch_seconds(),
    }
}

/// 备份/恢复用的保守目录复制：遇到符号链接立即失败（不跟随、不复制
/// 链接本身），保证备份要么完整、要么不存在。
fn copy_directory_tree(source: &Path, destination: &Path) -> AppResult<()> {
    let metadata = std::fs::symlink_metadata(source).map_err(|error| {
        AppError::new(ErrorCode::OperationConflict, Severity::Error)
            .with_param("path", source.to_string_lossy().into_owned())
            .with_param("source", error.to_string())
            .with_action(RecoveryAction::InspectTarget)
    })?;
    if metadata.file_type().is_symlink() {
        return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
            .with_param("path", source.to_string_lossy().into_owned())
            .with_param("detail", "refusing to copy through a symbolic link")
            .with_action(RecoveryAction::InspectTarget));
    }
    if !metadata.is_dir() {
        return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
            .with_param("path", source.to_string_lossy().into_owned())
            .with_param("detail", "expected a directory")
            .with_action(RecoveryAction::InspectTarget));
    }
    std::fs::create_dir_all(destination).map_err(io_conflict(source))?;
    for entry in std::fs::read_dir(source).map_err(io_conflict(source))? {
        let entry = entry.map_err(io_conflict(source))?;
        let entry_path = entry.path();
        let entry_metadata =
            std::fs::symlink_metadata(&entry_path).map_err(io_conflict(&entry_path))?;
        if entry_metadata.file_type().is_symlink() {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("path", entry_path.to_string_lossy().into_owned())
                .with_param("detail", "refusing to copy a symbolic link entry")
                .with_action(RecoveryAction::InspectTarget));
        }
        if entry_metadata.is_dir() {
            copy_directory_tree(&entry_path, &destination.join(entry.file_name()))?;
        } else {
            let entry_destination = destination.join(entry.file_name());
            std::fs::copy(&entry_path, &entry_destination).map_err(io_conflict(&entry_path))?;
        }
    }
    Ok(())
}

fn io_conflict(path: &Path) -> impl Fn(std::io::Error) -> AppError + '_ {
    move |error| {
        AppError::new(ErrorCode::OperationConflict, Severity::Error)
            .with_param("path", path.to_string_lossy().into_owned())
            .with_param("source", error.to_string())
            .with_action(RecoveryAction::Retry)
    }
}

impl LocalApplicationFacade {
    async fn prepare_undeploy(
        &self,
        deployment_id: skillhub_core::DeploymentId,
    ) -> AppResult<AppCommandResult> {
        let result = self.removal_service.prepare_undeploy(deployment_id).await;
        match result.as_ref() {
            Ok(impact) => self.journal_prepared(impact.operation_id, "undeploy_skill"),
            Err(error) => self.journal_advance(
                OperationId::new(),
                "undeploy_skill",
                skillhub_core::OperationPhase::RolledBack,
                Some(error.code),
            ),
        }
        result.map(AppCommandResult::RemovalImpact)
    }

    async fn prepare_delete_skill(
        &self,
        skill_id: skillhub_core::SkillId,
    ) -> AppResult<AppCommandResult> {
        let result = self.removal_service.prepare_delete(skill_id).await;
        match result.as_ref() {
            Ok(impact) => self.journal_prepared(impact.operation_id, "delete_skill"),
            Err(error) => self.journal_advance(
                OperationId::new(),
                "delete_skill",
                skillhub_core::OperationPhase::RolledBack,
                Some(error.code),
            ),
        }
        result.map(AppCommandResult::RemovalImpact)
    }

    async fn commit_undeploy(
        &self,
        operation_id: OperationId,
        decision: skillhub_core::RemovalDecision,
    ) -> AppResult<AppCommandResult> {
        let result = self
            .removal_service
            .commit_undeploy(operation_id, decision)
            .await;
        self.journal_removal_outcome(operation_id, "undeploy_skill", result.as_ref().err());
        result.map(AppCommandResult::RemovalResult)
    }

    async fn commit_delete_skill(
        &self,
        operation_id: OperationId,
        decisions: Vec<(skillhub_core::DeploymentId, skillhub_core::RemovalDecision)>,
    ) -> AppResult<AppCommandResult> {
        let result = self
            .removal_service
            .commit_delete(operation_id, decisions)
            .await;
        self.journal_removal_outcome(operation_id, "delete_skill", result.as_ref().err());
        result.map(AppCommandResult::RemovalResult)
    }

    async fn detach_management(
        &self,
        deployment_id: skillhub_core::DeploymentId,
    ) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "detach_management");
        let result = self
            .removal_service
            .undeploy(
                deployment_id,
                skillhub_core::RemovalDecision::DetachManagement,
            )
            .await;
        self.journal_settle(operation_id, "detach_management", result.as_ref().err());
        result.map(AppCommandResult::RemovalResult)
    }

    async fn remove_ignore_rule(&self, rule_id: String) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "remove_ignore_rule");
        let result = self.ignore_service.remove(rule_id).await;
        self.journal_settle(operation_id, "remove_ignore_rule", result.as_ref().err());
        result.map(|()| {
            AppCommandResult::OperationSummary(skillhub_core::OperationSummary {
                operation_id,
                phase: skillhub_core::OperationPhase::Committed,
                message_code: "ignore.removed".to_owned(),
                error_code: None,
            })
        })
    }

    async fn reconcile_collect_changes(
        &self,
        deployment_id: skillhub_core::DeploymentId,
    ) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "reconcile_collect_changes");
        let result = self
            .reconcile_service
            .collect_changes(deployment_id)
            .await
            .map(AppCommandResult::ReconcileResult);
        self.journal_settle(
            operation_id,
            "reconcile_collect_changes",
            result.as_ref().err(),
        );
        result
    }

    async fn reconcile_restore(
        &self,
        deployment_id: skillhub_core::DeploymentId,
    ) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "reconcile_restore_deployment");
        let result = self
            .reconcile_service
            .restore(deployment_id)
            .await
            .map(AppCommandResult::ReconcileResult);
        self.journal_settle(
            operation_id,
            "reconcile_restore_deployment",
            result.as_ref().err(),
        );
        result
    }

    async fn reconcile_keep_independent(
        &self,
        deployment_id: skillhub_core::DeploymentId,
    ) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "reconcile_keep_independent");
        let result = self
            .reconcile_service
            .keep_independent(deployment_id)
            .await
            .map(AppCommandResult::ReconcileResult);
        self.journal_settle(
            operation_id,
            "reconcile_keep_independent",
            result.as_ref().err(),
        );
        result
    }

    async fn reconcile_ignore_external_change(
        &self,
        deployment_id: skillhub_core::DeploymentId,
    ) -> AppResult<AppCommandResult> {
        let operation_id = OperationId::new();
        self.journal_begin(operation_id, "reconcile_ignore_external_change");
        let result = self
            .reconcile_service
            .ignore_external_change(deployment_id)
            .await
            .map(AppCommandResult::ReconcileResult);
        self.journal_settle(
            operation_id,
            "reconcile_ignore_external_change",
            result.as_ref().err(),
        );
        result
    }

    /// Settles a removal commit. Unknown prepared ids are terminal validation
    /// failures (`rolled_back`); every other failure keeps the prepared impact
    /// retryable, so the record stays available through the recovery entry.
    fn journal_removal_outcome(
        &self,
        operation_id: OperationId,
        kind: &'static str,
        error: Option<&AppError>,
    ) {
        match error {
            None => self.journal_advance(
                operation_id,
                kind,
                skillhub_core::OperationPhase::Committed,
                None,
            ),
            Some(error) if error.code == ErrorCode::ObjectNotFound => self.journal_advance(
                operation_id,
                kind,
                skillhub_core::OperationPhase::RolledBack,
                Some(error.code),
            ),
            Some(error) => self.journal_advance(
                operation_id,
                kind,
                skillhub_core::OperationPhase::NeedsRecovery,
                Some(error.code),
            ),
        }
    }

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

    /// AR-021：为版本设置用户可读名称。名称去首尾空白、非空且不超过
    /// 64 字符；内容哈希（version_id）不变。
    async fn set_version_label(
        &self,
        request: skillhub_core::api::SetVersionLabel,
    ) -> AppResult<AppCommandResult> {
        let label = request.label.trim();
        if label.is_empty() {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning)
                .with_param("field", "label")
                .with_action(RecoveryAction::Retry));
        }
        if label.chars().count() > 64 {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning)
                .with_param("field", "label")
                .with_param("reason", "label_too_long")
                .with_action(RecoveryAction::Retry));
        }
        self.with_database("execute.set_version_label", |database| {
            database.bootstrap_repository().set_version_label(
                &request.skill_id.to_string(),
                &request.version_id.to_string(),
                label,
            )
        })?;
        Ok(AppCommandResult::OperationSummary(operation_summary(
            "version.label_set",
        )))
    }

    /// QA-010：当前版本的可读标签——用户命名优先，其次按捕获顺序的
    /// vN 序号；两者都不可得时返回 None，绝不把内容哈希当展示标签。
    fn readable_current_version_label(
        &self,
        skill_id: skillhub_core::SkillId,
        version_id: &skillhub_core::VersionId,
    ) -> AppResult<Option<String>> {
        let named = self
            .with_database("query.current_version_label", |database| {
                database
                    .bootstrap_repository()
                    .version_labels(&[version_id.to_string()])
            })?
            .into_iter()
            .next()
            .map(|(_, label)| label)
            .filter(|label| !label.trim().is_empty());
        if named.is_some() {
            return Ok(named);
        }
        let library = self.library_runtime.snapshot()?;
        let records = library.list(skill_id)?;
        let (sequence_by_id, _) = version_timeline(&library, skill_id, &records);
        Ok(sequence_by_id
            .get(version_id)
            .map(|sequence| format!("v{sequence}")))
    }

    fn list_versions(&self, skill_id: skillhub_core::SkillId) -> AppResult<AppQueryResult> {
        let library = self.library_runtime.snapshot()?;
        let current = library.current(skill_id)?;
        let records = library.list(skill_id)?;
        // AR-021：以清单文件修改时间推导捕获顺序，生成用户可读的版本序号；
        // 时间不可得的版本诚实标为无序号。
        let (sequence_by_id, epoch_by_id) = version_timeline(&library, skill_id, &records);
        let label_by_id: HashMap<String, String> = {
            let ids: Vec<String> = records.iter().map(|record| record.id.to_string()).collect();
            self.with_database("query.list_version_labels", |database| {
                database.bootstrap_repository().version_labels(&ids)
            })?
            .into_iter()
            .collect()
        };
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
                created_at_epoch: epoch_by_id.get(&record.id).cloned(),
                sequence: sequence_by_id.get(&record.id).copied(),
                label: label_by_id.get(&record.id.to_string()).cloned(),
            });
        }
        results.sort_by(|left, right| {
            right
                .current
                .cmp(&left.current)
                .then_with(|| right.created_at_epoch.cmp(&left.created_at_epoch))
                .then_with(|| right.sequence.cmp(&left.sequence))
                .then_with(|| right.version_id.as_str().cmp(left.version_id.as_str()))
        });
        Ok(AppQueryResult::Versions(results))
    }

    fn diff_versions(
        &self,
        left: &skillhub_core::VersionId,
        right: &skillhub_core::VersionId,
    ) -> AppResult<AppQueryResult> {
        let library = self.library_runtime.snapshot()?;
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
        let library = self.library_runtime.snapshot()?;
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
        let library = self.library_runtime.snapshot()?;
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
        let (editable, read_only_reason) = {
            // QA-013：可编辑性来自领域所有权矩阵。v0.2.0 里能进入中央库
            // 版本记录的内容只有复制导入形成的托管副本（用户自有）；
            // 内置/插件/未接管外部内容没有进入库的通道。
            let editability = skillhub_core::catalog::markdown_editability(
                skillhub_core::catalog::ContentProvenance::ManagedCopy,
            );
            (editability.editable, editability.read_only_reason)
        };
        Ok(AppQueryResult::MarkdownFile(
            skillhub_core::api::MarkdownFileContent {
                content_identity: identity,
                editable,
                markdown,
                path: path.to_owned(),
                read_only_reason,
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

/// QA-001：删除影响矩阵的确定性扫描结果（US-051）。
struct DeletionImpactMatrix {
    dependencies: Vec<String>,
    project_configs: Vec<String>,
    pinned_versions: Vec<skillhub_core::ProjectVersionPin>,
    combinations: Vec<String>,
    related_skills: Vec<String>,
    unknown_external_references: Vec<String>,
}

/// QA-001：删除前重新扫描项目配置、固定版本、组合、声明依赖、
/// 相关 Skill 和未知外部引用；未知外部内容只提示、不修改。
fn deletion_impact_matrix(
    database: &Database,
    skill_id: skillhub_core::SkillId,
    managed_target_ids: &std::collections::HashSet<String>,
) -> AppResult<DeletionImpactMatrix> {
    let catalog = database.catalog_repository()?;
    let own = catalog.get_sync(skill_id)?;
    let runtime_name = own
        .as_ref()
        .map(|skill| skill.runtime_name().to_ascii_lowercase());
    // 声明依赖：被删 Skill 自己声明的运行要求原文。
    let dependencies = own
        .as_ref()
        .map(|skill| {
            skill
                .requirements()
                .iter()
                .map(|req| req.name.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // 相关 Skill：声明依赖名字与该 Skill 运行名一致的其他 Skill。
    let mut related_skills = Vec::new();
    if let Some(runtime_name) = &runtime_name {
        for other_id in catalog.list_ids_sync()? {
            if other_id == skill_id {
                continue;
            }
            if let Some(other) = catalog.get_sync(other_id)? {
                if other
                    .requirements()
                    .iter()
                    .any(|req| req.name.to_ascii_lowercase() == *runtime_name)
                {
                    related_skills.push(other.display_name().to_owned());
                }
            }
        }
    }
    related_skills.sort();
    // 轻量组合：成员包含该 Skill 的组合名。
    let combinations = database
        .combination_repository()
        .list()?
        .into_iter()
        .filter(|combo| combo.members.contains(&skill_id))
        .map(|combo| combo.name)
        .collect();
    // 项目配置与固定版本。
    let projects = database.project_repository();
    let mut project_configs = Vec::new();
    for project in projects.list()? {
        // 未写共享配置的项目是常态（读取返回 NotFound），跳过即可。
        if let Ok(config) = projects.read_shared_config(project.id) {
            if config
                .required_skills
                .iter()
                .any(|req| req.skill_id == skill_id)
            {
                project_configs.push(project.name);
            }
        }
    }
    project_configs.sort();
    let pinned_versions = projects
        .list_version_pins()?
        .into_iter()
        .filter(|pin| pin.skill_id == skill_id)
        .map(|pin| skillhub_core::ProjectVersionPin {
            project_id: pin.project_id,
            version_id: pin.version_id,
        })
        .collect();
    // 未知外部引用：未由本 Skill 部署托管的已注册目标根下，
    // 与运行名同名的目录（最多向下两层）。只提示、不修改。
    let mut unknown_external_references = Vec::new();
    if let Some(runtime_name) = &runtime_name {
        if let Some(snapshot) = database.agent_repository().load()? {
            for target in &snapshot.physical_targets {
                if managed_target_ids.contains(&target.id) {
                    continue;
                }
                collect_unmanaged_name_matches(
                    Path::new(&target.path),
                    runtime_name,
                    2,
                    &mut unknown_external_references,
                );
            }
        }
    }
    unknown_external_references.sort();
    Ok(DeletionImpactMatrix {
        dependencies,
        project_configs,
        pinned_versions,
        combinations,
        related_skills,
        unknown_external_references,
    })
}

/// QA-001：在目录树中收集与运行名同名的目录路径（大小写不敏感）；
/// 读取失败的子树按不可见处理，不阻塞影响预览。
fn collect_unmanaged_name_matches(
    directory: &Path,
    runtime_name: &str,
    remaining_depth: u8,
    matches: &mut Vec<String>,
) {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let is_match = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(runtime_name));
        if is_match {
            matches.push(path.to_string_lossy().into_owned());
        } else if remaining_depth > 0 {
            collect_unmanaged_name_matches(&path, runtime_name, remaining_depth - 1, matches);
        }
    }
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

/// D-9：一个部署方式必须同时被宿主文件系统与 Agent profile 声明允许。
/// 未收录的客户端保持宿主能力（fail-open），已有 profile 的客户端以
/// profile 为准（例如 Claude Code 声明 junction 未确认，即使宿主能建也
/// 不自动选择）。
fn effective_target_capabilities(
    client_id: &str,
    host: &skillhub_core::DeploymentCapability,
) -> skillhub_core::DeploymentCapability {
    skillhub_core::ProfileCatalog::builtin()
        .deployment_capability_for_client(client_id)
        .map(|declared| host.intersect(declared))
        .unwrap_or_else(|| host.clone())
}

/// 计划界面可提供的部署方式（顺序即规划器偏好：链接 → 联接 → 复制）。
fn offered_modes(
    capabilities: &skillhub_core::DeploymentCapability,
) -> Vec<skillhub_core::DeploymentMode> {
    [
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
    .collect()
}

/// 读取 SKILL.md frontmatter 中的 name 字段（各 Agent 的 Skill 识别依据）。
fn read_frontmatter_name(markdown: &str) -> Option<String> {
    let mut lines = markdown.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    lines
        .take_while(|line| line.trim() != "---")
        .find_map(|line| {
            let (key, value) = line.trim().split_once(':')?;
            (key.trim() == "name").then(|| value.trim().trim_matches('"').to_owned())
        })
        .filter(|value| !value.is_empty())
}

/// QA-009：读取 SKILL.md frontmatter 中的 description 字段。
fn read_frontmatter_description(source: &Path) -> Option<String> {
    let markdown = std::fs::read_to_string(source.join("SKILL.md")).ok()?;
    let mut lines = markdown.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    lines
        .take_while(|line| line.trim() != "---")
        .find_map(|line| {
            let (key, value) = line.trim().split_once(':')?;
            (key.trim() == "description").then(|| value.trim().trim_matches('"').to_owned())
        })
        .filter(|value| !value.is_empty())
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
        let library = self.facade.library_runtime.snapshot()?;
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
        let library = self.facade.library_runtime.snapshot()?;
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
                    let source = library
                        .root
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
                database
                    .deployment_repository()
                    .insert_sync(&record)
                    .map(|_| ())
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

/// 与桌面宿主 normalize_grant_path / 前端 normalizeWindowsPath 同口径：
/// 剥掉 Windows 扩展长度前缀，得到 grant 注册与比较用的路径字符串。
fn normalize_windows_path(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        return rest.to_owned();
    }
    raw.to_owned()
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

/// Builds a journal row for the `operations` table. Rows never carry skill
/// content, credentials or raw error payloads: only the stable kind, the
/// phase and a whitelisted error code. The request fingerprint stays empty —
/// there is no stable per-request digest yet, and unsanitized request
/// parameters must not reach the durable history.
/// Recovery data for a deployment whose failure left something behind:
/// recovery deletes exactly these paths when the user rolls the operation
/// back.  That is what makes 「恢复」 mean "undo what this operation wrote"
/// instead of "settle a row while the half-written tree stays on disk".
///
/// Only targets that reported residue are recorded — a target the backend
/// already undid must never be deleted a second time.
fn pending_recovery_targets(
    summary: &skillhub_core::application::DeploymentSummary,
) -> serde_json::Value {
    let pending: Vec<serde_json::Value> = summary
        .targets
        .iter()
        .filter(|target| target.residue)
        .filter_map(|target| {
            let error = target.error.as_ref()?;
            Some(serde_json::json!({
                "path": error.params.get("path"),
                "runtime_name": error.params.get("runtime_name"),
                "mode": error.params.get("requested_mode"),
                "physical_target_id": target.physical_target_id,
            }))
        })
        .collect();
    serde_json::json!({ "pending_targets": pending })
}

/// Runtime-name comparison for occupancy facts, matching the planner's own
/// per-target case rule (Windows destinations compare case-insensitively).
fn occupancy_names_equal(left: &str, right: &str, case_sensitive: bool) -> bool {
    if case_sensitive {
        left == right
    } else {
        left.eq_ignore_ascii_case(right)
    }
}

/// A runtime name the planner will accept as one safe path component.
/// Anything else is rejected by the planner anyway, and probing it could read
/// outside the verified target root.
fn is_single_path_component(value: &str) -> bool {
    !value.is_empty() && value != "." && value != ".." && !value.contains(['\0', '/', '\\', ':'])
}

/// Builds the registered-target index from database facts only.  Shared by
/// the facade query path and the deployment backend's commit-time
/// revalidation so both see exactly the same registered reality.
fn registered_target_index(
    database: &skillhub_storage::Database,
    host_capabilities: &skillhub_core::DeploymentCapability,
) -> AppResult<RegisteredTargetIndex> {
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
                effective_target_capabilities(&target.client_id, host_capabilities),
            ));
        }
    }
    for project in database.project_repository().list()? {
        let path = PathBuf::from(project.path());
        let Ok(root) = AllowedRoot::new(&path) else {
            continue;
        };
        roots.push(root);
        facts.push(TargetFact::from_project(
            &project,
            host_capabilities.clone(),
        ));
    }
    let policy = PathPolicy::from_roots(roots)?;
    RegisteredTargetIndex::from_facts(facts, policy)
}

/// Database-backed occupancy attachment over already-verified targets; see
/// [`LocalApplicationFacade::attach_target_occupancy`] for the semantics.
fn attach_target_occupancy_with(
    database: &skillhub_storage::Database,
    runtime_name: &str,
    targets: &mut [VerifiedTarget],
) -> AppResult<()> {
    let rows = database.deployment_repository().list_all()?;
    for target in targets.iter_mut() {
        let mut existing = Vec::new();
        for row in &rows {
            if row.target_id != target.physical_target_id()
                || !row.managed
                || !matches!(
                    row.state,
                    DeploymentState::Deployed | DeploymentState::NeedsRecovery
                )
                || !occupancy_names_equal(&row.runtime_name, runtime_name, target.case_sensitive())
            {
                continue;
            }
            existing.push(ExistingDeployment::managed(
                row.runtime_name.clone(),
                row.id,
                row.skill_id,
                row.version_id.clone(),
            ));
        }
        if existing.is_empty()
            && is_single_path_component(runtime_name)
            && std::fs::symlink_metadata(Path::new(target.path()).join(runtime_name)).is_ok()
        {
            existing.push(ExistingDeployment::new(
                runtime_name,
                ExistingOwnership::Unknown,
            ));
        }
        for entry in existing {
            *target = target.clone().with_existing(entry);
        }
    }
    Ok(())
}

/// How long a stored deployment preview stays committable.  Short by design:
/// a preview is a snapshot of facts, not a standing permission.
const DEPLOYMENT_PREVIEW_TTL_SECONDS: i64 = 900;

/// Merged capabilities over one physical-target group; the planner applies
/// the same all-targets rule when it selects a mode.
fn merged_capabilities_of(targets: &[VerifiedTarget]) -> skillhub_core::DeploymentCapability {
    skillhub_core::DeploymentCapability::new(
        targets.iter().all(|target| target.capabilities().symlink),
        targets.iter().all(|target| target.capabilities().junction),
        targets.iter().all(|target| target.capabilities().copy),
    )
}

/// Best-effort user-facing target label: the discovery snapshot's Agent
/// client for agent targets, the project name for project targets, and the
/// logical id only as a last resort for targets that never resolved.
fn batch_target_label(
    discovery_targets: &[skillhub_core::LogicalTarget],
    projects: &[skillhub_core::Project],
    logical_id: &str,
) -> String {
    if let Some(target) = discovery_targets
        .iter()
        .find(|target| target.id == logical_id)
    {
        return target.client_id.clone();
    }
    if let Some(project) = projects
        .iter()
        .find(|project| project.id.to_string() == logical_id)
    {
        return project.name.clone();
    }
    logical_id.to_owned()
}

fn pair_result(
    pair: &skillhub_core::api::DeploymentPairPreview,
    outcome: skillhub_core::api::DeploymentPairCommitOutcome,
    operation_id: Option<OperationId>,
    error: Option<skillhub_core::TargetOperationError>,
) -> skillhub_core::api::DeploymentPairCommitResult {
    skillhub_core::api::DeploymentPairCommitResult {
        pair_id: pair.pair_id.clone(),
        outcome,
        operation_id,
        error,
    }
}

/// Deterministic idempotency key for one preview commit: the preview id plus
/// the sorted per-pair decision set.  Text, not a hash, so a recorded key
/// stays readable in diagnostics.
fn preview_commit_key(request: &skillhub_core::api::CommitDeploymentPreview) -> String {
    let mut entries = request
        .pairs
        .iter()
        .map(|pair| {
            format!(
                "{}|confirm:{}|exclude:{}",
                pair.pair_id, pair.confirm_fallback, pair.exclude
            )
        })
        .collect::<Vec<_>>();
    entries.sort();
    format!("{}\n{}", request.preview_id, entries.join("\n"))
}

fn target_changed_error(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::TargetChanged, Severity::Error)
        .with_param("detail", detail.into())
        .with_action(RecoveryAction::Retry)
}

fn journal_record(
    operation_id: OperationId,
    kind: &str,
    phase: skillhub_core::OperationPhase,
    error_code: Option<ErrorCode>,
) -> skillhub_core::OperationRecord {
    let phase_name = match phase {
        skillhub_core::OperationPhase::Planned => "planned",
        skillhub_core::OperationPhase::Prepared => "prepared",
        skillhub_core::OperationPhase::Applying => "applying",
        skillhub_core::OperationPhase::Verifying => "verifying",
        skillhub_core::OperationPhase::Committed => "committed",
        skillhub_core::OperationPhase::NeedsRecovery => "needs_recovery",
        skillhub_core::OperationPhase::RolledBack => "rolled_back",
    };
    let mut record = skillhub_core::OperationRecord::planned(operation_id, kind, "");
    record.phase = phase;
    record.progress.phase = phase;
    record.progress.message_code = format!("operation.{kind}.{phase_name}");
    record.error_code = error_code;
    record
}

fn unsupported(operation: &'static str) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("operation", operation)
        .with_action(RecoveryAction::Retry)
}

/// AR-021：以清单文件修改时间推导捕获顺序；时间不可得的版本没有序号。
/// 返回（版本序号表，捕获时间表）。
fn version_timeline<'a>(
    library: &VersionStore,
    skill_id: skillhub_core::SkillId,
    records: &'a [skillhub_core::VersionRecord],
) -> (
    HashMap<&'a skillhub_core::VersionId, u32>,
    HashMap<skillhub_core::VersionId, String>,
) {
    let mut timed: Vec<(i64, &skillhub_core::VersionRecord)> = Vec::new();
    for record in records {
        if let Some(epoch) = library.manifest_modified_epoch(skill_id, &record.id) {
            timed.push((epoch, record));
        }
    }
    timed.sort_by_key(|(epoch, _)| *epoch);
    let mut sequence_by_id: HashMap<&skillhub_core::VersionId, u32> = HashMap::new();
    let mut epoch_by_id: HashMap<skillhub_core::VersionId, String> = HashMap::new();
    for (index, (epoch, record)) in timed.into_iter().enumerate() {
        sequence_by_id.insert(&record.id, (index + 1) as u32);
        epoch_by_id.insert(record.id.clone(), epoch.to_string());
    }
    (sequence_by_id, epoch_by_id)
}

/// 从 https://github.com/{owner}/{repo} 形态的 URL 提取 owner/repo。
/// 非 github.com 或路径段不足时返回 None（上游坐标由 N7a 只写入该形态）。
fn parse_github_repo_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("https://github.com/")?;
    let mut segments = rest.trim_end_matches('/').split('/');
    let owner = segments.next()?;
    let name = segments.next()?;
    if owner.is_empty() || name.is_empty() || segments.next().is_some() {
        return None;
    }
    Some((owner.to_string(), name.to_string()))
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

/// Deterministic markdown evidence list for an import candidate: sorted,
/// depth-bounded relative paths under the candidate root.
fn import_markdown_files(root: &str) -> Vec<String> {
    let base = std::path::Path::new(root);
    let mut files = Vec::new();
    let mut stack = vec![std::path::PathBuf::new()];
    while let Some(relative) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(base.join(&relative)) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = relative.join(entry.file_name());
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                stack.push(path);
            } else if path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
            {
                files.push(path.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    files.sort();
    files.truncate(32);
    files
}

fn is_supported_remote_archive(url: &str) -> bool {
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    [".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2"]
        .iter()
        .any(|suffix| path.ends_with(suffix))
}

fn read_import_evidence(root: &str, files: &[String]) -> AppResult<String> {
    let base = std::path::Path::new(root);
    let mut evidence = String::new();
    for file in files {
        let bytes = std::fs::read(base.join(file)).map_err(|error| {
            AppError::new(ErrorCode::LlmEvidenceReferenceInvalid, Severity::Error)
                .with_param("source", error.to_string())
        })?;
        let bytes = if bytes.len() > 256 * 1024 {
            &bytes[..256 * 1024]
        } else {
            &bytes[..]
        };
        let text = String::from_utf8(bytes.to_vec())
            .map_err(|_| AppError::new(ErrorCode::LlmEvidenceReferenceInvalid, Severity::Error))?;
        evidence.push_str("FILE: ");
        evidence.push_str(file);
        evidence.push('\n');
        evidence.push_str(&text);
        evidence.push_str("\n\n");
    }
    Ok(evidence)
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
    use super::{civil_date_from_days, format_rfc3339_utc, LocalApplicationFacade};
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

    #[test]
    fn formats_epoch_seconds_as_rfc3339_utc_including_leap_day() {
        assert_eq!(format_rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_rfc3339_utc(1_789_000_000), "2026-09-10T00:26:40Z");
        assert_eq!(format_rfc3339_utc(1_767_225_599), "2025-12-31T23:59:59Z");
        assert_eq!(format_rfc3339_utc(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn import_conflict_decision_merge_follows_the_user_ruling() {
        use skillhub_core::relationship::{ConflictClassification, ConflictEvidence, ConflictKind};
        let fact = skillhub_core::ConflictCaseFact {
            conflict_id: "import-conflict:same_name_different_content:notes".into(),
            kind: ConflictKind::SameNameDifferentContent,
            classification: ConflictClassification::Uncertain,
            member_skill_ids: Vec::new(),
            members: Vec::new(),
            evidence: ConflictEvidence::default(),
            user_decision: None,
            decided_at: None,
        };

        // 两者皆无裁决：维持未裁决状态。
        let merged =
            LocalApplicationFacade::merge_import_conflict_decision(fact.clone(), None, 1_000);
        assert_eq!(merged.user_decision, None);
        assert_eq!(merged.decided_at, None);

        // 本次有显式裁决：以其更新并刷新 decided_at。
        let mut explicit = fact.clone();
        explicit.user_decision = Some(ConflictClassification::DistinctSkill);
        let merged = LocalApplicationFacade::merge_import_conflict_decision(explicit, None, 1_000);
        assert_eq!(
            merged.user_decision,
            Some(ConflictClassification::DistinctSkill)
        );
        assert_eq!(merged.decided_at, Some(1_000));

        // 本次推导为 None 且既有裁决非 None：保留既有裁决与 decided_at，
        // 绝不拿 NULL 覆盖用户已有裁决。
        let mut existing = fact.clone();
        existing.user_decision = Some(ConflictClassification::SameSkillVersion);
        existing.decided_at = Some(42);
        let merged =
            LocalApplicationFacade::merge_import_conflict_decision(fact, Some(&existing), 1_000);
        assert_eq!(
            merged.user_decision,
            Some(ConflictClassification::SameSkillVersion)
        );
        assert_eq!(merged.decided_at, Some(42));
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

    #[test]
    fn production_llm_runtime_installs_runner_credentials_and_admin() {
        let facade = LocalApplicationFacade::new(Database::open_in_memory().unwrap())
            .with_production_llm_runtime();

        assert!(facade.llm_runner.is_some());
        assert!(facade.llm_admin.is_some());
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
        let (phase, state, rolls_back) = match action {
            RecoveryAction::CompleteOperation => ("committed", "completed", false),
            RecoveryAction::RollbackOperation => ("rolled_back", "rolled_back", true),
            _ => return Err(unsupported("recovery.resolve")),
        };
        // Undo the disk first: once the row is settled the user has no second
        // chance to clean up, so a failed removal must keep the candidate in
        // the recovery entry instead of recording a rollback that never
        // happened.
        if rolls_back {
            self.roll_back_pending_targets(operation_id)?;
        }
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
                    phase, state, operation_id
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

impl LocalRecoveryBackend {
    /// Deletes the targets an interrupted operation recorded in its
    /// `recovery_data`.  Rolling a candidate back has to undo what the
    /// operation wrote, not only settle its accounting row.
    fn roll_back_pending_targets(&self, operation_id: OperationId) -> AppResult<()> {
        let record = self
            .database
            .lock()
            .map_err(|_| internal("recovery.resolve"))?
            .operation_repository()
            .get_sync(operation_id)?;
        let Some(record) = record else {
            return Ok(());
        };
        let Some(pending) = record
            .recovery_data
            .get("pending_targets")
            .and_then(serde_json::Value::as_array)
        else {
            return Ok(());
        };
        let filesystem = DeploymentFilesystem::new();
        for target in pending {
            let Some(path) = target.get("path").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let mode = match target.get("mode").and_then(serde_json::Value::as_str) {
                Some("symbolic_link") => DeploymentMode::SymbolicLink,
                Some("directory_junction") => DeploymentMode::DirectoryJunction,
                _ => DeploymentMode::ManagedCopy,
            };
            filesystem.remove_residue(Path::new(path), mode)?;
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
            skill.user_purpose().map(str::to_owned),
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
            skill.user_purpose().map(str::to_owned),
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
    async fn create(&self, rule: IgnoreRule) -> AppResult<IgnoreRule> {
        let database = self
            .database
            .lock()
            .map_err(|_| internal("ignore.create"))?;
        database.ignore_rule_repository().create(rule)
    }

    async fn remove(&self, id: String) -> AppResult<()> {
        let database = self
            .database
            .lock()
            .map_err(|_| internal("ignore.remove"))?;
        database.ignore_rule_repository().remove(&id)
    }

    async fn list(&self) -> AppResult<Vec<IgnoreRule>> {
        let database = self.database.lock().map_err(|_| internal("ignore.list"))?;
        database.ignore_rule_repository().list()
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
    database: Arc<Mutex<Database>>,
}

fn filter_pending_items(
    items: Vec<skillhub_core::pending::PendingItem>,
    rules: &[IgnoreRule],
    today: (i32, u8, u8),
) -> Vec<skillhub_core::pending::PendingItem> {
    let today = format!("{:04}-{:02}-{:02}", today.0, today.1, today.2);
    items
        .into_iter()
        .filter(|item| {
            let kind = match item.kind {
                skillhub_core::pending::PendingKind::TrialDue => "trial_due",
                skillhub_core::pending::PendingKind::SecurityFinding => "security_finding",
                skillhub_core::pending::PendingKind::Recovery => "recovery",
            };
            let pending_id = format!("{kind}:{}:{}", item.subject, item.code);
            !rules.iter().any(|rule| {
                let active = rule
                    .defer_until
                    .as_deref()
                    .is_none_or(|until| today.as_str() < until);
                active
                    && match &rule.subject {
                        skillhub_core::IgnoreSubject::ExactPending(value) => value == &pending_id,
                        skillhub_core::IgnoreSubject::ExactSkill(value) => value == &item.subject,
                        skillhub_core::IgnoreSubject::ExactPath(_) => false,
                    }
            })
        })
        .collect()
}
