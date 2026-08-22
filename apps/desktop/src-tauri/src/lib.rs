use std::sync::Arc;

#[cfg(test)]
use std::path::PathBuf;

use skillhub_core::{
    AppCommand, AppCommandResult, AppError, AppEvent, AppQuery, AppQueryResult, AppResult,
    ApplicationFacade, ErrorCode, Severity,
};
use tauri::{AppHandle, Emitter, State};

/// The only state exposed to Tauri commands. It deliberately accepts domain
/// envelopes instead of stringly-typed command names or ad-hoc payloads.
pub struct CommandBridge {
    facade: Arc<dyn ApplicationFacade>,
}

impl CommandBridge {
    pub fn new(facade: Arc<dyn ApplicationFacade>) -> Self {
        Self { facade }
    }

    pub async fn execute(&self, command: AppCommand) -> AppResult<AppCommandResult> {
        self.facade.execute(command).await
    }

    pub async fn query(&self, query: AppQuery) -> AppResult<AppQueryResult> {
        self.facade.query(query).await
    }
}

#[tauri::command]
async fn execute_command(
    bridge: State<'_, CommandBridge>,
    command: AppCommand,
) -> AppResult<AppCommandResult> {
    bridge.execute(command).await
}

#[tauri::command]
async fn query_application(
    bridge: State<'_, CommandBridge>,
    query: AppQuery,
) -> AppResult<AppQueryResult> {
    bridge.query(query).await
}

pub fn emit_app_event<R: tauri::Runtime>(app: &AppHandle<R>, event: AppEvent) -> tauri::Result<()> {
    app.emit("app_event", event)
}

pub fn run_with_facade(facade: Arc<dyn ApplicationFacade>) -> tauri::Result<()> {
    tauri::Builder::default()
        .manage(CommandBridge::new(facade))
        .invoke_handler(tauri::generate_handler![execute_command, query_application])
        .run(tauri::generate_context!())
}

struct UnconfiguredFacade;

#[async_trait::async_trait]
impl ApplicationFacade for UnconfiguredFacade {
    async fn execute(&self, _command: AppCommand) -> AppResult<AppCommandResult> {
        Err(AppError::new(ErrorCode::InternalError, Severity::Error))
    }

    async fn query(&self, _query: AppQuery) -> AppResult<AppQueryResult> {
        Err(AppError::new(ErrorCode::InternalError, Severity::Error))
    }
}

pub fn run() -> tauri::Result<()> {
    run_with_facade(Arc::new(UnconfiguredFacade))
}

#[cfg(test)]
const GENERATED_BINDINGS: &str = include_str!("../../src/api/bindings.ts");

#[test]
fn generate_bindings() {
    let destination = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/api/bindings.ts");
    std::fs::write(&destination, GENERATED_BINDINGS).expect("generated bindings destination");
    let generated = std::fs::read_to_string(destination).expect("generated bindings output");
    assert!(generated.contains("export type AppCommand"));
    assert!(generated.contains("export type AppQuery"));
    assert!(generated.contains("export type AppEvent"));
}
