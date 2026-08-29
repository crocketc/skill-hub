//! Shared application boundary implementations.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use skillhub_core::{
    AppCommand, AppCommandResult, AppError, AppQuery, AppQueryResult, AppResult, ApplicationFacade,
    ErrorCode, RecoveryAction, Severity,
};
use skillhub_storage::{Database, LibraryPaths, VersionStore};

/// The date provider is kept on the facade so all date-sensitive projections
/// in one request use the same day boundary. Production uses the current UTC
/// date; tests can inject a fixed value with [`LocalApplicationFacade::new_with_today`].
pub struct LocalApplicationFacade {
    database: Mutex<Database>,
    today: (i32, u8, u8),
    library: Option<VersionStore>,
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
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("source", error.to_string())
                    .with_action(RecoveryAction::Retry)
            })?;
        }
        Database::open(path).map(|database| Self::new_with_library(database, library_root))
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
            library: None,
        }
    }

    /// Creates a facade with read-only access to a central library root.
    pub fn new_with_library(database: Database, library_root: impl AsRef<Path>) -> Self {
        Self {
            database: Mutex::new(database),
            today: current_utc_date(),
            library: Some(VersionStore::new(LibraryPaths::from_root(
                library_root.as_ref(),
            ))),
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
                editable: false,
                markdown,
                path: path.to_owned(),
            },
        ))
    }
}

fn unsupported(operation: &'static str) -> AppError {
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
