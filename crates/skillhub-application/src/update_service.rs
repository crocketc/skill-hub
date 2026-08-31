use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use skillhub_adapters::app_update::github_releases::GithubReleaseProvider;
use skillhub_core::{
    select_artifact, version_is_newer, AppError, AppResult, CheckApplicationUpdate,
    DownloadedApplicationUpdate, ErrorCode, PrepareApplicationUpdate, PreparedApplicationUpdate,
    RecoveryAction, Severity, UpdateArtifact, UpdateManifest, UpdateState,
};
use skillhub_storage::Database;

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
    staging_root: PathBuf,
}

impl UpdateService {
    pub fn new(database: Arc<Mutex<Database>>, provider: Arc<GithubReleaseProvider>) -> Self {
        Self {
            database,
            provider,
            staging_root: std::env::temp_dir()
                .join("skillhub")
                .join("application-updates"),
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
        if let Some(update) = self.with_database("update.check.cache", |database| {
            database
                .application_update_repository()
                .fresh_check(&request, now, CHECK_CACHE_SECONDS)
        })? {
            return Ok(update);
        }

        let update = self
            .provider
            .latest(
                &request.repository,
                &request.current_version,
                request.build_trust,
            )
            .await?;
        self.with_database("update.check.save", |database| {
            database
                .application_update_repository()
                .save_check(&request, &update, now)
        })?;
        Ok(update)
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
        pending.staging_path.as_ref().ok_or_else(|| {
            AppError::new(ErrorCode::ApplicationUpdateUnavailable, Severity::Warning)
                .with_param("detail", "update staging path is missing")
                .with_action(RecoveryAction::Retry)
        })?;
        Err(
            AppError::new(ErrorCode::ApplicationUpdateInstallBlocked, Severity::Info)
                .with_param("reason", "package download is not implemented in this task")
                .with_action(RecoveryAction::Acknowledge),
        )
    }

    pub async fn install(&self) -> AppResult<()> {
        self.with_database("update.install.failed", |database| {
            database
                .application_update_repository()
                .mark_failed(now_seconds())
                .map(|_| ())
        })?;
        Err(
            AppError::new(ErrorCode::ApplicationUpdateInstallBlocked, Severity::Info)
                .with_param("reason", "platform installer is not implemented")
                .with_action(RecoveryAction::Acknowledge),
        )
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
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}
