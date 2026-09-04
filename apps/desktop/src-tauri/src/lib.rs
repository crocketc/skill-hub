use std::path::PathBuf;
use std::sync::Arc;

use skillhub_application::LocalApplicationFacade;
use skillhub_core::{
    AppCommand, AppCommandResult, AppEvent, AppQuery, AppQueryResult, AppResult, ApplicationFacade,
};
#[cfg(test)]
use skillhub_core::{DEFAULT_UPDATE_SIGNATURE_PUBLIC_KEY, TAURI_UPDATE_SIGNATURE_PUBLIC_KEY};
use tauri::{AppHandle, Emitter, State};

pub mod updater;

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

#[tauri::command]
async fn pick_local_directory() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(path) = rfd::FileDialog::new().pick_folder() else {
            return Ok(None);
        };
        let canonical = std::fs::canonicalize(&path)
            .map_err(|error| format!("directory_picker.canonicalize_failed: {error}"))?;
        if !canonical.is_dir() {
            return Err("directory_picker.not_a_directory".to_owned());
        }
        Ok(Some(canonical.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| format!("directory_picker.join_failed: {error}"))?
}

pub fn emit_app_event<R: tauri::Runtime>(app: &AppHandle<R>, event: AppEvent) -> tauri::Result<()> {
    app.emit("app_event", event)
}

pub fn run_with_facade(facade: Arc<LocalApplicationFacade>) -> tauri::Result<()> {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup({
            let facade = facade.clone();
            move |app| {
                facade.set_application_update_installer(Arc::new(
                    updater::TauriUpdateInstaller::for_app(app.handle().clone()),
                ));
                Ok(())
            }
        })
        .manage(CommandBridge::new(facade))
        .invoke_handler(tauri::generate_handler![
            execute_command,
            query_application,
            pick_local_directory
        ])
        .run(tauri::generate_context!())
}

pub fn run() -> tauri::Result<()> {
    let previous_probe = updater::startup_probe();
    let probe_directory = updater::default_startup_probe_directory();
    let _ = updater::write_starting_probe(&probe_directory, std::time::SystemTime::now());

    let facade = match LocalApplicationFacade::open_with_library(
        default_database_path(),
        default_library_root(),
    ) {
        Ok(facade) => facade,
        Err(error) => {
            let _ = updater::write_failed_probe(&probe_directory);
            panic!("failed to open SkillHub application database: {error}");
        }
    };

    if matches!(
        previous_probe,
        updater::StartupProbeResult::Failed | updater::StartupProbeResult::TimedOut
    ) {
        let _ = tauri::async_runtime::block_on(facade.rollback_if_unhealthy());
    }

    match tauri::async_runtime::block_on(facade.query(AppQuery::GetBootstrapSnapshot)) {
        Ok(_) => {
            let _ = updater::write_healthy_probe(&probe_directory);
        }
        Err(error) => {
            let _ = updater::write_failed_probe(&probe_directory);
            panic!("failed to initialize SkillHub application facade: {error}");
        }
    }
    run_with_facade(Arc::new(facade))
}

#[cfg(windows)]
fn default_library_root() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("SkillHub")
}

#[cfg(target_os = "macos")]
fn default_library_root() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("SkillHub")
}

#[cfg(not(any(windows, target_os = "macos")))]
fn default_library_root() -> PathBuf {
    PathBuf::from("SkillHub")
}

#[cfg(windows)]
fn default_database_path() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
        })
        .join("SkillHub")
        .join("skillhub.sqlite")
}

#[cfg(target_os = "macos")]
fn default_database_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library")
        .join("Application Support")
        .join("SkillHub")
        .join("skillhub.sqlite")
}

#[cfg(not(any(windows, target_os = "macos")))]
fn default_database_path() -> PathBuf {
    PathBuf::from("skillhub.sqlite")
}

#[cfg(test)]
fn generated_bindings_source() -> Result<String, Box<dyn std::error::Error>> {
    use skillhub_core::{
        AppCommand, AppCommandResult, AppEvent, AppQuery, AppQueryResult, ErrorCode,
        OperationPhase, OperationProgress, OperationSummary,
    };

    let types = specta::Types::default()
        .register::<AppCommand>()
        .register::<AppCommandResult>()
        .register::<AppQuery>()
        .register::<AppQueryResult>()
        .register::<AppEvent>()
        .register::<OperationPhase>()
        .register::<OperationProgress>()
        .register::<OperationSummary>()
        .register::<ErrorCode>();
    let contracts = specta_typescript::Typescript::default()
        .export(&types, specta_serde::Format)?
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");

    Ok(format!(
        r#"// This file is generated by `cargo test -p skillhub-desktop generate_bindings`.
// Rust contracts in skillhub-core are the source of truth.

import {{ invoke }} from "@tauri-apps/api/core";
import {{ listen, type UnlistenFn }} from "@tauri-apps/api/event";

{contracts}
export const appEventName = "app_event" as const;

export function executeCommand(command: AppCommand): Promise<AppCommandResult> {{
  return invoke<AppCommandResult>("execute_command", {{ command }});
}}

export function queryApplication(query: AppQuery): Promise<AppQueryResult> {{
  return invoke<AppQueryResult>("query_application", {{ query }});
}}

export function onAppEvent(handler: (event: AppEvent) => void): Promise<UnlistenFn> {{
  return listen<AppEvent>(appEventName, ({{ payload }}) => handler(payload));
}}
"#
    ))
}

#[test]
fn generate_bindings() {
    let generated = generated_bindings_source().expect("generate TypeScript from Rust contracts");
    let destination = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/api/bindings.ts");
    if std::env::var_os("SKILLHUB_WRITE_BINDINGS").is_some() {
        std::fs::write(&destination, &generated).expect("write generated bindings output");
    }
    let committed = std::fs::read_to_string(destination).expect("committed bindings output");
    assert_eq!(
        committed.replace("\r\n", "\n"),
        generated,
        "bindings.ts drifted from the Rust/Specta contracts; regenerate it before committing"
    );
}

#[test]
fn command_bridge_forwards_typed_envelopes_to_injected_facade() {
    use std::sync::Mutex;

    use skillhub_core::{
        AppQueryResult, BootstrapSnapshot, OperationId, OperationPhase, OperationSummary,
    };

    struct RecordingFacade {
        commands: Mutex<Vec<AppCommand>>,
        queries: Mutex<Vec<AppQuery>>,
    }

    #[async_trait::async_trait]
    impl ApplicationFacade for RecordingFacade {
        async fn execute(&self, command: AppCommand) -> AppResult<AppCommandResult> {
            self.commands.lock().expect("commands mutex").push(command);
            Ok(AppCommandResult::OperationSummary(OperationSummary {
                operation_id: OperationId::new(),
                phase: OperationPhase::Prepared,
                message_code: "test.forwarded".into(),
                error_code: None,
            }))
        }

        async fn query(&self, query: AppQuery) -> AppResult<AppQueryResult> {
            self.queries.lock().expect("queries mutex").push(query);
            Ok(AppQueryResult::BootstrapSnapshot(BootstrapSnapshot::empty()))
        }
    }

    let facade = Arc::new(RecordingFacade {
        commands: Mutex::new(Vec::new()),
        queries: Mutex::new(Vec::new()),
    });
    let bridge = CommandBridge::new(facade.clone());
    let command = AppCommand::CancelOperation {
        operation_id: OperationId::new(),
    };

    tauri::async_runtime::block_on(async {
        bridge
            .execute(command.clone())
            .await
            .expect("command result");
        bridge
            .query(AppQuery::GetBootstrapSnapshot)
            .await
            .expect("query result");
    });

    assert_eq!(
        facade.commands.lock().expect("commands mutex").as_slice(),
        &[command]
    );
    assert_eq!(
        facade.queries.lock().expect("queries mutex").as_slice(),
        &[AppQuery::GetBootstrapSnapshot]
    );
}

#[test]
fn capabilities_allow_only_typed_ipc_and_event_subscription() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("capabilities/default.json");
    let capabilities = std::fs::read_to_string(path).expect("desktop capability manifest");
    assert!(!capabilities.contains("core:default"));
    assert!(capabilities.contains("core:event:allow-listen"));
    assert!(capabilities.contains("core:event:allow-unlisten"));
    assert!(capabilities.contains("allow-execute-command"));
    assert!(capabilities.contains("allow-query-application"));
    assert!(capabilities.contains("updater:default"));
}

#[test]
fn tauri_config_enables_signed_static_updater_artifacts() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let config = std::fs::read_to_string(path).expect("desktop Tauri config");
    let config: serde_json::Value = serde_json::from_str(&config).expect("valid Tauri config");

    assert_eq!(config["bundle"]["createUpdaterArtifacts"], true);
    assert_eq!(
        config["bundle"]["windows"]["nsis"]["installMode"],
        "currentUser"
    );
    assert_eq!(
        config["plugins"]["updater"]["pubkey"],
        TAURI_UPDATE_SIGNATURE_PUBLIC_KEY
    );
    assert_ne!(
        config["plugins"]["updater"]["pubkey"],
        DEFAULT_UPDATE_SIGNATURE_PUBLIC_KEY
    );
    assert_eq!(
        config["plugins"]["updater"]["endpoints"][0],
        "https://github.com/crocketc/skill-hub/releases/latest/download/latest.json"
    );
    assert_eq!(
        config["plugins"]["updater"]["windows"]["installMode"],
        "passive"
    );
}
