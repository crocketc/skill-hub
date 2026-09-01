use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use skillhub_adapters::app_update::download::UpdateDownloadProvider;
use skillhub_adapters::app_update::github_releases::GithubReleaseProvider;
use skillhub_core::{
    select_artifact, verify_downloaded_artifact, version_is_newer, AppError, AppResult,
    CheckApplicationUpdate, DownloadedApplicationUpdate, ErrorCode, PrepareApplicationUpdate,
    PreparedApplicationUpdate, RecoveryAction, Severity, UpdateArtifact, UpdateManifest,
    UpdatePlatform, UpdateSignaturePublicKey, UpdateState, DEFAULT_UPDATE_SIGNATURE_PUBLIC_KEY,
};
use skillhub_storage::Database;

/// Hands a verified update package to the platform installer. The desktop
/// shell provides the real implementation; tests inject a fake so the facade
/// never launches a real installer.
#[async_trait::async_trait]
pub trait ApplicationUpdateInstaller: Send + Sync {
    async fn install(&self, package_path: &Path) -> AppResult<()>;
}

const CHECK_CACHE_SECONDS: i64 = 24 * 60 * 60;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateDownloadPlan {
    pub current_version: String,
    pub manifest: UpdateManifest,
    pub artifact: UpdateArtifact,
    pub staging_path: PathBuf,
    pub state: UpdateState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RollbackState {
    NoRollback,
    RolledBack,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RollbackResult {
    pub state: RollbackState,
    pub version: Option<String>,
    pub attempts: u32,
}

pub struct UpdateService {
    database: Arc<Mutex<Database>>,
    provider: Arc<GithubReleaseProvider>,
    installer: Arc<Mutex<Option<Arc<dyn ApplicationUpdateInstaller>>>>,
    staging_root: PathBuf,
    public_key: UpdateSignaturePublicKey,
}

impl UpdateService {
    pub fn new(database: Arc<Mutex<Database>>, provider: Arc<GithubReleaseProvider>) -> Self {
        Self::with_public_key(
            database,
            provider,
            UpdateSignaturePublicKey {
                value: DEFAULT_UPDATE_SIGNATURE_PUBLIC_KEY.to_owned(),
            },
        )
    }

    /// Creates an update service with an explicit verification key.
    ///
    /// Production callers should use [`Self::new`]. This constructor exists
    /// so isolated tests can verify fixtures signed by a dedicated test key
    /// without ever shipping that key as the application default.
    pub fn with_public_key(
        database: Arc<Mutex<Database>>,
        provider: Arc<GithubReleaseProvider>,
        public_key: UpdateSignaturePublicKey,
    ) -> Self {
        Self {
            database,
            provider,
            installer: Arc::new(Mutex::new(None)),
            staging_root: std::env::temp_dir()
                .join("skillhub")
                .join("application-updates"),
            public_key,
        }
    }

    /// Replaces the platform installer used by `install`. Production injects
    /// the desktop shell's installer; without one, installs stay blocked.
    pub fn set_installer(&self, installer: Arc<dyn ApplicationUpdateInstaller>) {
        if let Ok(mut slot) = self.installer.lock() {
            *slot = Some(installer);
        }
    }

    pub async fn check(
        &self,
        request: CheckApplicationUpdate,
    ) -> AppResult<skillhub_core::ApplicationUpdate> {
        let policy = self.with_database("update.check.policy", |database| {
            database.application_update_repository().get_policy()
        })?;
        if !policy.enabled {
            return Ok(skillhub_core::ApplicationUpdate::none(
                request.current_version,
            ));
        }

        let now = now_seconds();
        if let Some(mut update) = self.with_database("update.check.cache", |database| {
            database
                .application_update_repository()
                .fresh_check(&request, now, CHECK_CACHE_SECONDS)
        })? {
            if update.available && update.manifest.is_none() {
                update = self.attach_manifest(&request, update).await;
                self.with_database("update.check.cache_manifest", |database| {
                    database
                        .application_update_repository()
                        .save_check(&request, &update, now)
                })?;
            }
            return Ok(update);
        }

        let mut update = self
            .provider
            .latest(
                &request.repository,
                &request.current_version,
                request.build_trust,
            )
            .await?;
        update = self.attach_manifest(&request, update).await;
        self.with_database("update.check.save", |database| {
            database
                .application_update_repository()
                .save_check(&request, &update, now)
        })?;
        Ok(update)
    }

    async fn attach_manifest(
        &self,
        request: &CheckApplicationUpdate,
        mut update: skillhub_core::ApplicationUpdate,
    ) -> skillhub_core::ApplicationUpdate {
        if !update.available {
            return update;
        }
        let platform = current_update_platform();
        if let Ok(manifest) = self
            .provider
            .fetch_manifest(&request.repository, &platform)
            .await
        {
            if manifest.version == update.latest_version {
                update.manifest = Some(manifest);
                update.platform = Some(platform);
                update.install_action = skillhub_core::InstallAction::InstallVerifiedAsset;
            }
        }
        update
    }

    pub fn prepare_download(
        &self,
        request: PrepareApplicationUpdate,
    ) -> AppResult<UpdateDownloadPlan> {
        if version_is_newer(&request.current_version, &request.manifest.version) != Some(true) {
            return Err(
                AppError::new(ErrorCode::ApplicationUpdateUnavailable, Severity::Warning)
                    .with_action(RecoveryAction::Retry),
            );
        }
        let artifact = select_artifact(&request.manifest, &request.platform)?;
        let staging_path = self
            .staging_root
            .join(safe_path_part(&request.manifest.version))
            .join(safe_artifact_name(&artifact.url));
        Ok(UpdateDownloadPlan {
            current_version: request.current_version,
            manifest: request.manifest,
            artifact,
            staging_path,
            state: UpdateState::Downloading,
        })
    }

    pub fn record_ready(
        &self,
        plan: &UpdateDownloadPlan,
        rollback_point: Option<&str>,
    ) -> AppResult<PreparedApplicationUpdate> {
        let staging_path = plan.staging_path.to_string_lossy().into_owned();
        self.with_database("update.record_ready", |database| {
            database.application_update_repository().record_ready(
                &plan.current_version,
                &plan.manifest,
                &plan.artifact,
                staging_path,
                rollback_point,
                now_seconds(),
            )
        })?;
        Ok(PreparedApplicationUpdate {
            manifest: plan.manifest.clone(),
            artifact: plan.artifact.clone(),
            state: UpdateState::ReadyToInstall,
        })
    }

    pub async fn download(
        &self,
        artifact: &UpdateArtifact,
    ) -> AppResult<DownloadedApplicationUpdate> {
        let pending = self.with_database("update.download.pending", |database| {
            database.application_update_repository().get_pending()
        })?;
        if pending.artifact != *artifact {
            return Err(
                AppError::new(ErrorCode::ApplicationUpdateUnavailable, Severity::Warning)
                    .with_action(RecoveryAction::Retry),
            );
        }
        let staging_path = PathBuf::from(pending.staging_path.clone().ok_or_else(|| {
            AppError::new(ErrorCode::ApplicationUpdateUnavailable, Severity::Warning)
                .with_param("detail", "update staging path is missing")
                .with_action(RecoveryAction::Retry)
        })?);

        // The downloader refuses to overwrite an existing destination, so a
        // failed or cancelled attempt must clear its own staging file first.
        if staging_path.is_file() {
            std::fs::remove_file(&staging_path).map_err(|_| {
                AppError::new(
                    ErrorCode::ApplicationUpdateInstallBlocked,
                    Severity::Warning,
                )
                .with_param("reason", "cannot replace previous download")
                .with_action(RecoveryAction::Retry)
            })?;
        }

        let cancel = Arc::new(AtomicBool::new(false));
        let downloaded = self
            .provider
            .download(artifact, &staging_path, |_| {}, cancel)
            .await;

        let verified = downloaded.and_then(|downloaded| {
            let bytes = std::fs::read(&downloaded.path).map_err(|_| {
                AppError::new(ErrorCode::ApplicationUpdateIntegrityFailed, Severity::Error)
            })?;
            verify_downloaded_artifact(&bytes, artifact, &self.public_key)?;
            Ok(downloaded)
        });

        match verified {
            Ok(downloaded) => {
                self.with_database("update.download.save", |database| {
                    database.application_update_repository().mark_downloaded(
                        artifact,
                        downloaded.path.to_string_lossy().into_owned(),
                        now_seconds(),
                    )
                })?;
                Ok(DownloadedApplicationUpdate {
                    artifact: artifact.clone(),
                    state: UpdateState::ReadyToInstall,
                })
            }
            Err(error) => {
                let _ = std::fs::remove_file(&staging_path);
                self.with_database("update.download.failed", |database| {
                    database
                        .application_update_repository()
                        .mark_failed(now_seconds())
                        .map(|_| ())
                })?;
                Err(error)
            }
        }
    }

    pub async fn install(&self) -> AppResult<()> {
        let installer = self
            .installer
            .lock()
            .map_err(|_| internal_mutex("update.installer.locked"))?
            .clone()
            .ok_or_else(|| {
                AppError::new(ErrorCode::ApplicationUpdateInstallBlocked, Severity::Info)
                    .with_param("reason", "platform installer is not available")
                    .with_action(RecoveryAction::Acknowledge)
            })?;

        let pending = self.with_database("update.install.pending", |database| {
            database.application_update_repository().get_pending()
        })?;
        if pending.state != UpdateState::ReadyToInstall {
            return Err(AppError::new(
                ErrorCode::ApplicationUpdateInstallBlocked,
                Severity::Warning,
            )
            .with_param("reason", "no verified update package is ready to install")
            .with_action(RecoveryAction::Retry));
        }
        let staging_path = pending.staging_path.clone().ok_or_else(|| {
            AppError::new(
                ErrorCode::ApplicationUpdateInstallBlocked,
                Severity::Warning,
            )
            .with_param("reason", "update staging path is missing")
            .with_action(RecoveryAction::Retry)
        })?;
        let package_path = PathBuf::from(staging_path);
        if !package_path.is_file() {
            return Err(AppError::new(
                ErrorCode::ApplicationUpdateInstallBlocked,
                Severity::Warning,
            )
            .with_param("reason", "downloaded update package is missing")
            .with_action(RecoveryAction::Retry));
        }

        // The pending record stays ReadyToInstall after a successful launch:
        // it is the rollback marker consumed on the next unhealthy startup,
        // and mark_launched clears it after the new version probes healthy.
        installer.install(&package_path).await
    }

    pub fn mark_launched(&self, version: &str) -> AppResult<()> {
        self.with_database("update.mark_launched", |database| {
            database
                .application_update_repository()
                .mark_launched(version)
        })
    }

    pub async fn rollback_if_unhealthy(&self) -> AppResult<RollbackResult> {
        let rolled_back = self.with_database("update.rollback", |database| {
            database
                .application_update_repository()
                .consume_rollback_marker(now_seconds())
        })?;
        Ok(match rolled_back {
            Some(pending) => RollbackResult {
                state: RollbackState::RolledBack,
                version: pending.rollback_point,
                attempts: pending.attempts,
            },
            None => RollbackResult {
                state: RollbackState::NoRollback,
                version: None,
                attempts: 0,
            },
        })
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
}

fn current_update_platform() -> UpdatePlatform {
    let target = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "unknown"
    };
    UpdatePlatform {
        target: target.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
    }
}

fn safe_path_part(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '-' | '_' => character,
            _ => '_',
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "unknown".to_owned()
    } else {
        sanitized
    }
}

fn safe_artifact_name(url: &str) -> String {
    url.rsplit('/')
        .next()
        .map(safe_path_part)
        .filter(|part| part != "unknown")
        .unwrap_or_else(|| "update-package".to_owned())
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn internal_mutex(operation: &'static str) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("operation", operation)
        .with_action(RecoveryAction::Retry)
}
