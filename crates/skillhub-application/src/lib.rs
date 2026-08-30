//! Shared application boundary implementations.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use skillhub_core::application::PreparedImport;
use skillhub_core::catalog::Skill;
use skillhub_core::{
    AppCommand, AppCommandResult, AppError, AppQuery, AppQueryResult, AppResult, ApplicationFacade,
    ErrorCode, OperationId, RecoveryAction, Severity,
};
use skillhub_storage::{CentralLibrary, Database, LibraryPaths, VersionStore};

/// The date provider is kept on the facade so all date-sensitive projections
/// in one request use the same day boundary. Production uses the current UTC
/// date; tests can inject a fixed value with [`LocalApplicationFacade::new_with_today`].
pub struct LocalApplicationFacade {
    database: Mutex<Database>,
    today: (i32, u8, u8),
    library: Option<VersionStore>,
    library_root: Option<PathBuf>,
    prepared_imports: Mutex<HashMap<OperationId, PreparedImport>>,
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
        Self {
            database: Mutex::new(database),
            today,
            library: None,
            library_root: None,
            prepared_imports: Mutex::new(HashMap::new()),
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
            library_root: Some(library_root.as_ref().to_path_buf()),
            prepared_imports: Mutex::new(HashMap::new()),
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
            AppCommand::PrepareImport(request) => return self.prepare_import(request),
            AppCommand::CommitImport(request) => return self.commit_import(request),
            AppCommand::CancelImport { prepared_import_id } => {
                return self.cancel_import(prepared_import_id)
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
                editable: false,
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
