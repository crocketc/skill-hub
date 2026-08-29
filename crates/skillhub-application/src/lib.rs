//! Shared application boundary implementations.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use skillhub_core::{
    AppCommand, AppCommandResult, AppError, AppQuery, AppQueryResult, AppResult, ApplicationFacade,
    ErrorCode, RecoveryAction, Severity,
};
use skillhub_storage::Database;

/// The date provider is kept on the facade so all date-sensitive projections
/// in one request use the same day boundary. Production uses the current UTC
/// date; tests can inject a fixed value with [`LocalApplicationFacade::new_with_today`].
pub struct LocalApplicationFacade {
    database: Mutex<Database>,
    today: (i32, u8, u8),
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

    /// Creates a facade backed by the supplied SQLite database.
    pub fn new(database: Database) -> Self {
        Self::new_with_today(database, current_utc_date())
    }

    /// Creates a facade with an explicit date boundary for deterministic tests.
    pub fn new_with_today(database: Database, today: (i32, u8, u8)) -> Self {
        Self {
            database: Mutex::new(database),
            today,
        }
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

#[async_trait]
impl ApplicationFacade for LocalApplicationFacade {
    async fn execute(&self, command: AppCommand) -> AppResult<AppCommandResult> {
        let operation = match command {
            AppCommand::CancelOperation { .. } => "execute.cancel_operation",
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
            AppQuery::GetSkill(request) => self.with_database("query.get_skill", |database| {
                let skill = database
                    .catalog_repository()?
                    .get_identity(request.skill_id)?
                    .ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))?;
                Ok(AppQueryResult::Skill(skillhub_core::api::SkillResult {
                    skill_id: request.skill_id,
                    display_name: skill.0,
                    runtime_name: skill.1,
                }))
            }),
            AppQuery::Search(request) => self.with_database("query.search", |database| {
                database
                    .search_repository()
                    .search(request)
                    .map(AppQueryResult::SearchResults)
            }),
            _ => Err(AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("operation", "query.unsupported")
                .with_action(RecoveryAction::Retry)),
        }
    }
}

fn current_utc_date() -> (i32, u8, u8) {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 86_400;
    civil_date_from_days(days as i64)
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
