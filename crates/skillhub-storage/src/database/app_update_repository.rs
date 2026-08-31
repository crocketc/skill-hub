use super::Database;
use rusqlite::OptionalExtension;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use skillhub_core::{
    AppError, AppResult, ApplicationUpdate, ApplicationUpdatePolicy, CheckApplicationUpdate,
    ErrorCode, RecoveryAction, Severity, UpdateArtifact, UpdateManifest, UpdateState,
};

const POLICY_KEY: &str = "application_update_policy";
const CHECK_KEY: &str = "application_update_last_check";
const PENDING_KEY: &str = "application_update_pending";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PendingApplicationUpdate {
    pub current_version: String,
    pub target_version: String,
    pub manifest: UpdateManifest,
    pub artifact: UpdateArtifact,
    pub staging_path: Option<String>,
    pub rollback_point: Option<String>,
    pub state: UpdateState,
    pub attempts: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CachedApplicationUpdate {
    request: CheckApplicationUpdate,
    update: ApplicationUpdate,
    checked_at: i64,
}

pub struct ApplicationUpdateRepository<'a> {
    database: &'a Database,
}

impl<'a> ApplicationUpdateRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn get_policy(&self) -> AppResult<ApplicationUpdatePolicy> {
        Ok(self.get_json(POLICY_KEY)?.unwrap_or_default())
    }

    pub fn save_policy(
        &self,
        policy: &ApplicationUpdatePolicy,
    ) -> AppResult<ApplicationUpdatePolicy> {
        self.put_json(POLICY_KEY, policy, now())?;
        Ok(policy.clone())
    }

    pub fn fresh_check(
        &self,
        request: &CheckApplicationUpdate,
        now_seconds: i64,
        max_age_seconds: i64,
    ) -> AppResult<Option<ApplicationUpdate>> {
        let Some(cached) = self.get_json::<CachedApplicationUpdate>(CHECK_KEY)? else {
            return Ok(None);
        };
        if cached.request == *request
            && now_seconds.saturating_sub(cached.checked_at) < max_age_seconds
        {
            Ok(Some(cached.update))
        } else {
            Ok(None)
        }
    }

    pub fn save_check(
        &self,
        request: &CheckApplicationUpdate,
        update: &ApplicationUpdate,
        checked_at: i64,
    ) -> AppResult<()> {
        self.put_json(
            CHECK_KEY,
            &CachedApplicationUpdate {
                request: request.clone(),
                update: update.clone(),
                checked_at,
            },
            checked_at,
        )
    }

    pub fn record_ready(
        &self,
        current_version: &str,
        manifest: &UpdateManifest,
        artifact: &UpdateArtifact,
        staging_path: impl Into<String>,
        rollback_point: Option<&str>,
        now_seconds: i64,
    ) -> AppResult<PendingApplicationUpdate> {
        let existing = self.get_json::<PendingApplicationUpdate>(PENDING_KEY)?;
        let attempts = existing
            .as_ref()
            .filter(|pending| {
                pending.current_version == current_version
                    && pending.target_version == manifest.version
                    && pending.artifact == *artifact
            })
            .map(|pending| pending.attempts)
            .unwrap_or_default();
        let created_at = existing
            .as_ref()
            .filter(|pending| {
                pending.current_version == current_version
                    && pending.target_version == manifest.version
                    && pending.artifact == *artifact
            })
            .map(|pending| pending.created_at)
            .unwrap_or(now_seconds);
        let pending = PendingApplicationUpdate {
            current_version: current_version.to_owned(),
            target_version: manifest.version.clone(),
            manifest: manifest.clone(),
            artifact: artifact.clone(),
            staging_path: Some(staging_path.into()),
            rollback_point: rollback_point.map(str::to_owned),
            state: UpdateState::ReadyToInstall,
            attempts,
            created_at,
            updated_at: now_seconds,
        };
        self.put_json(PENDING_KEY, &pending, now_seconds)?;
        Ok(pending)
    }

    pub fn mark_downloaded(
        &self,
        artifact: &UpdateArtifact,
        staging_path: impl Into<String>,
        now_seconds: i64,
    ) -> AppResult<PendingApplicationUpdate> {
        let mut pending = self.get_pending()?;
        if pending.artifact != *artifact {
            return Err(
                AppError::new(ErrorCode::ApplicationUpdateUnavailable, Severity::Warning)
                    .with_action(RecoveryAction::Retry),
            );
        }
        pending.staging_path = Some(staging_path.into());
        pending.state = UpdateState::ReadyToInstall;
        pending.updated_at = now_seconds;
        self.put_json(PENDING_KEY, &pending, now_seconds)?;
        Ok(pending)
    }

    pub fn mark_failed(&self, now_seconds: i64) -> AppResult<Option<PendingApplicationUpdate>> {
        let Some(mut pending) = self.get_json::<PendingApplicationUpdate>(PENDING_KEY)? else {
            return Ok(None);
        };
        pending.state = UpdateState::Failed;
        pending.updated_at = now_seconds;
        self.put_json(PENDING_KEY, &pending, now_seconds)?;
        Ok(Some(pending))
    }

    pub fn mark_launched(&self, version: &str) -> AppResult<()> {
        let Some(pending) = self.get_json::<PendingApplicationUpdate>(PENDING_KEY)? else {
            return Ok(());
        };
        if pending.target_version == version {
            self.database
                .connection
                .execute("DELETE FROM settings WHERE key=?1", [PENDING_KEY])
                .map_err(database_error)?;
        }
        Ok(())
    }

    pub fn get_pending(&self) -> AppResult<PendingApplicationUpdate> {
        self.get_json(PENDING_KEY)?.ok_or_else(|| {
            AppError::new(ErrorCode::ObjectNotFound, Severity::Warning)
                .with_param("field", "application_update_pending")
                .with_action(RecoveryAction::Retry)
        })
    }

    pub fn consume_rollback_marker(
        &self,
        now_seconds: i64,
    ) -> AppResult<Option<PendingApplicationUpdate>> {
        let Some(mut pending) = self.get_json::<PendingApplicationUpdate>(PENDING_KEY)? else {
            return Ok(None);
        };
        if pending.rollback_point.is_none() {
            return Ok(None);
        }
        pending.attempts = pending.attempts.saturating_add(1);
        pending.state = UpdateState::RolledBack;
        pending.updated_at = now_seconds;
        let rolled_back = pending.clone();
        pending.rollback_point = None;
        self.put_json(PENDING_KEY, &pending, now_seconds)?;
        Ok(Some(rolled_back))
    }

    fn get_json<T: DeserializeOwned>(&self, key: &str) -> AppResult<Option<T>> {
        let value: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        value
            .map(|json| serde_json::from_str(&json).map_err(|_| invalid_record()))
            .transpose()
    }

    fn put_json<T: Serialize>(&self, key: &str, value: &T, updated_at: i64) -> AppResult<()> {
        let json = serde_json::to_string(value).map_err(|_| invalid_record())?;
        self.database
            .connection
            .execute(
                "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                rusqlite::params![key, json, updated_at],
            )
            .map_err(database_error)?;
        Ok(())
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn invalid_record() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}

#[cfg(test)]
mod tests {
    use crate::Database;
    use skillhub_core::{ApplicationUpdatePolicy, UpdateArtifact, UpdateManifest, UpdateState};

    #[test]
    fn policy_defaults_and_round_trips_through_settings() {
        let database = Database::open_in_memory().unwrap();
        let repository = database.application_update_repository();
        assert_eq!(
            repository.get_policy().unwrap(),
            ApplicationUpdatePolicy::default()
        );
        let policy = ApplicationUpdatePolicy {
            enabled: false,
            check_on_startup: true,
        };
        assert_eq!(repository.save_policy(&policy).unwrap(), policy);
        assert_eq!(repository.get_policy().unwrap(), policy);
    }

    #[test]
    fn pending_update_defaults_attempts_and_keeps_rollback_marker_separate_from_package() {
        let database = Database::open_in_memory().unwrap();
        let repository = database.application_update_repository();
        let artifact = UpdateArtifact {
            target: "windows-x86_64".to_owned(),
            url: "https://github.com/crocketc/skill-hub/releases/download/v0.2.0/skillhub.zip"
                .to_owned(),
            size: 42,
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_owned(),
            signature: "signature".to_owned(),
        };
        let manifest = UpdateManifest {
            version: "0.2.0".to_owned(),
            notes: String::new(),
            published_at: None,
            artifacts: vec![artifact.clone()],
        };

        let pending = repository
            .record_ready(
                "0.1.0",
                &manifest,
                &artifact,
                "C:/staging/skillhub.zip",
                Some("0.1.0"),
                1,
            )
            .unwrap();

        assert_eq!(pending.state, UpdateState::ReadyToInstall);
        assert_eq!(pending.attempts, 0);
        assert_eq!(repository.get_pending().unwrap(), pending);
    }
}
