use crate::args::{BackupAction, CliArgs, CliCommand};
use crate::output::JsonEnvelope;
use crate::runtime::{app_result_error, CliRuntimeError};
use serde::Serialize;
use serde_json::Value;
use skillhub_core::api::{
    AppCommand, AppQuery, GetBasicCheckResult, ListPendingItems, ListSkills, VerifyBackup,
};
use skillhub_core::search::SearchQuery;
use skillhub_core::{
    AppError, AppResult, ApplicationFacade, ErrorCode, RecoveryAction, Severity, SkillId, VersionId,
};

/// The CLI deliberately delegates business execution to the same facade used by the desktop app.
/// Until a concrete runtime facade is wired, commands return a stable structured status.
pub trait CommandFacade {
    fn execute(&self, command: &CliCommand) -> JsonEnvelope;
}

/// Executes only commands that are safe for unattended local automation.
/// This list intentionally excludes source/network, LLM and arbitrary process
/// execution paths, even when those capabilities are present in the facade.
pub async fn run(args: &CliArgs, facade: &dyn ApplicationFacade) -> Result<Value, CliRuntimeError> {
    match &args.command {
        CliCommand::List => serialize_result(
            facade
                .query(AppQuery::ListSkills(ListSkills {
                    text: args.query.clone().unwrap_or_default(),
                    page: args.page,
                    page_size: args.page_size,
                }))
                .await,
        ),
        CliCommand::Search => {
            let text = args.query.clone().ok_or_else(|| invalid_input("query"))?;
            serialize_result(facade.query(AppQuery::Search(SearchQuery::new(text))).await)
        }
        CliCommand::Status => serialize_result(facade.query(AppQuery::GetBootstrapSnapshot).await),
        CliCommand::Pending => serialize_result(
            facade
                .query(AppQuery::ListPendingItems(ListPendingItems))
                .await,
        ),
        CliCommand::Check => {
            let skill_id = parse_id::<SkillId>(args.skill.as_deref(), "skill")?;
            let version_id = parse_id::<VersionId>(args.version.as_deref(), "version")?;
            serialize_result(
                facade
                    .query(AppQuery::GetBasicCheckResult(GetBasicCheckResult {
                        skill_id,
                        version_id,
                    }))
                    .await,
            )
        }
        CliCommand::Backup => {
            if !matches!(args.backup_action, Some(BackupAction::Verify)) {
                return Err(invalid_input("backup_action"));
            }
            let path = args
                .path
                .as_ref()
                .ok_or_else(|| invalid_input("path"))?
                .to_string_lossy()
                .into_owned();
            serialize_result(
                facade
                    .execute(AppCommand::VerifyBackup(VerifyBackup { path }))
                    .await,
            )
        }
        _ => Err(not_connected(args.command.name())),
    }
}

fn serialize_result<T: Serialize>(result: AppResult<T>) -> Result<Value, CliRuntimeError> {
    // All frozen API result types derive Serialize. Keeping this conversion in
    // one place makes the command boundary explicit and avoids exposing a
    // second, CLI-specific result model.
    let result = result.map_err(app_result_error)?;
    serde_json::to_value(result).map_err(|error| CliRuntimeError {
        code: "cli.output_error".into(),
        detail: error.to_string(),
        params: Default::default(),
        actions: vec!["retry".into()],
    })
}

fn parse_id<T>(value: Option<&str>, field: &'static str) -> Result<T, CliRuntimeError>
where
    T: std::str::FromStr,
{
    value
        .ok_or_else(|| invalid_input(field))?
        .parse()
        .map_err(|_| invalid_input(field))
}

fn invalid_input(field: &'static str) -> CliRuntimeError {
    app_result_error(
        AppError::new(ErrorCode::InvalidInput, Severity::Error)
            .with_param("field", field)
            .with_action(RecoveryAction::ChooseAnotherName),
    )
}

fn not_connected(command: &'static str) -> CliRuntimeError {
    let mut error = invalid_input("command");
    error.code = "cli.command_not_connected".into();
    error.detail = format!("command `{command}` is not available in the safe CLI surface");
    error.actions = vec!["use_desktop_app_for_this_operation".into()];
    error
}

pub struct UnconfiguredFacade;

pub fn is_safe(command: &CliCommand) -> bool {
    matches!(
        command,
        CliCommand::List
            | CliCommand::Search
            | CliCommand::Status
            | CliCommand::Pending
            | CliCommand::Check
            | CliCommand::Backup
    )
}

impl CommandFacade for UnconfiguredFacade {
    fn execute(&self, command: &CliCommand) -> JsonEnvelope {
        JsonEnvelope::pending(command.name())
    }
}
