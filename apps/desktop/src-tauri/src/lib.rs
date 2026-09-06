use std::path::PathBuf;
use std::sync::Arc;

use skillhub_application::{ExternalUrlOpener, LocalApplicationFacade, SystemExternalUrlOpener};
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
    /// 具体门面句柄：仅桌面宿主注入，供目录选择器签发路径 grant。
    local: Option<Arc<LocalApplicationFacade>>,
}

impl CommandBridge {
    pub fn new(facade: Arc<dyn ApplicationFacade>) -> Self {
        Self {
            facade,
            local: None,
        }
    }

    /// 桌面宿主注入具体门面；测试替身（RecordingFacade）保持 None。
    pub fn with_local(mut self, local: Arc<LocalApplicationFacade>) -> Self {
        self.local = Some(local);
        self
    }

    /// 注册一个路径 grant（grant_id 即规范化路径）。
    pub fn register_path_grant(
        &self,
        grant: skillhub_core::agent::ResolvedPathGrant,
    ) -> AppResult<()> {
        let Some(local) = &self.local else {
            return Err(skillhub_core::AppError::new(
                skillhub_core::ErrorCode::InternalError,
                skillhub_core::Severity::Error,
            )
            .with_param("detail", "local facade is not attached to this bridge"));
        };
        local.register_path_grant(grant)
    }

    /// 规范化目录并签发路径 grant，返回 grant_id（即规范化路径字符串）。
    pub fn issue_grant_for_path(&self, path: &std::path::Path) -> AppResult<String> {
        let canonical = std::fs::canonicalize(path).map_err(|error| {
            skillhub_core::AppError::new(
                skillhub_core::ErrorCode::InvalidInput,
                skillhub_core::Severity::Warning,
            )
            .with_param("source", error.to_string())
        })?;
        if !canonical.is_dir() {
            return Err(skillhub_core::AppError::new(
                skillhub_core::ErrorCode::InvalidInput,
                skillhub_core::Severity::Warning,
            )
            .with_param("field", "path"));
        }
        // grant_id 即规范化路径；与前端展示口径一致（剥掉扩展长度前缀）。
        let grant_id = normalize_grant_path(&canonical);
        self.register_path_grant(skillhub_core::agent::ResolvedPathGrant {
            grant_id: grant_id.clone(),
            path: grant_id.clone(),
            operating_system: host_operating_system(),
        })?;
        Ok(grant_id)
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

/// 规范化用户选取的目录并校验其为目录；路径本身的问题必须让选择器报错。
fn canonicalize_picked_directory(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("directory_picker.canonicalize_failed: {error}"))?;
    if !canonical.is_dir() {
        return Err("directory_picker.not_a_directory".to_owned());
    }
    Ok(canonical)
}

/// 组装选择器载荷：grant 签发是尽力而为（AR-007）。签发失败只降级为
/// `grant_id: null`（自定义 Agent 表单随后不可引用该路径），绝不能让整个
/// 选择器失败、掩盖用户实际选中的目录；路径本身的问题仍由调用方报错。
fn picker_payload_with_lenient_grant(
    bridge: &CommandBridge,
    canonical: &std::path::Path,
) -> Result<String, String> {
    let grant_id = match bridge.issue_grant_for_path(canonical) {
        Ok(grant_id) => Some(grant_id),
        Err(error) => {
            eprintln!("directory_picker.grant_failed: {error}");
            None
        }
    };
    Ok(serde_json::json!({
        "path": canonical.to_string_lossy(),
        "grant_id": grant_id,
    })
    .to_string())
}

/// N11：打开目录前的路径校验——必须是真实存在的目录。
fn validate_openable_directory(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("open_directory.canonicalize_failed: {error}"))?;
    if !canonical.is_dir() {
        return Err("open_directory.not_a_directory".to_owned());
    }
    Ok(canonical)
}

/// N11：用系统文件管理器打开本地目录（当前为集中库目录）。只读操作。
#[tauri::command]
fn open_local_directory(path: String) -> Result<(), String> {
    let canonical = validate_openable_directory(std::path::Path::new(&path))?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&canonical)
            .spawn()
            .map_err(|error| format!("open_directory.spawn_failed: {error}"))?;
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&canonical)
            .spawn()
            .map_err(|error| format!("open_directory.spawn_failed: {error}"))?;
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = &canonical;
    }
    Ok(())
}

#[tauri::command]
async fn pick_local_directory(bridge: State<'_, CommandBridge>) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        let Some(path) = rfd::FileDialog::new().pick_folder() else {
            return Ok(None);
        };
        canonicalize_picked_directory(&path).map(Some)
    })
    .await
    .map_err(|error| format!("directory_picker.join_failed: {error}"))??;
    let Some(canonical) = picked else {
        return Ok(None);
    };
    Ok(Some(picker_payload_with_lenient_grant(
        &bridge, &canonical,
    )?))
}

/// 启动时为已存储的自定义 Agent 重新签发路径 grant：
/// grant 注册表在内存中，重启后需按记录里的目录路径恢复，编辑才可用。
fn re_register_custom_agent_grants(facade: &LocalApplicationFacade) {
    let query = AppQuery::ListCustomAgents(skillhub_core::api::ListCustomAgents);
    let Ok(AppQueryResult::CustomAgents(agents)) =
        tauri::async_runtime::block_on(facade.query(query))
    else {
        return;
    };
    for agent in agents {
        let path = agent.directory.path;
        if path.trim().is_empty() {
            continue;
        }
        let path = normalize_grant_path(std::path::Path::new(&path));
        if let Err(error) = facade.register_path_grant(skillhub_core::agent::ResolvedPathGrant {
            grant_id: path.clone(),
            path,
            operating_system: host_operating_system(),
        }) {
            eprintln!("re_register_custom_agent_grants failed: {error:?}");
        }
    }
}

/// 与前端 normalizeWindowsPath 一致：剥掉 Windows 扩展长度前缀。
fn normalize_grant_path(path: &std::path::Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\?\UNC\") {
        return format!(r"\{rest}");
    }
    if let Some(rest) = raw.strip_prefix(r"\?\") {
        return rest.to_string();
    }
    raw.into_owned()
}

fn host_operating_system() -> skillhub_core::agent::OperatingSystem {
    if cfg!(windows) {
        skillhub_core::agent::OperatingSystem::Windows
    } else {
        skillhub_core::agent::OperatingSystem::Macos
    }
}

/// Restarts the application so a persisted library-root change takes effect.
#[tauri::command]
fn restart_application(app: AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    std::process::Command::new(exe)
        .spawn()
        .map_err(|error| format!("restart_application.spawn_failed: {error}"))?;
    app.exit(0);
    Ok(())
}

pub fn emit_app_event<R: tauri::Runtime>(app: &AppHandle<R>, event: AppEvent) -> tauri::Result<()> {
    app.emit("app_event", event)
}

/// Hands the platform browser to the facade. Without it every external link
/// (README links, the official release page) is refused by the facade, so the
/// registration is part of the startup contract rather than an optimization.
fn register_external_url_opener(
    facade: &LocalApplicationFacade,
    opener: Arc<dyn ExternalUrlOpener>,
) {
    facade.set_external_url_opener(opener);
}

pub fn run_with_facade(facade: Arc<LocalApplicationFacade>) -> tauri::Result<()> {
    re_register_custom_agent_grants(&facade);
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup({
            let facade = facade.clone();
            move |app| {
                facade.set_application_update_installer(Arc::new(
                    updater::TauriUpdateInstaller::for_app(app.handle().clone()),
                ));
                register_external_url_opener(&facade, Arc::new(SystemExternalUrlOpener::default()));
                Ok(())
            }
        })
        .manage(CommandBridge::new(facade))
        .invoke_handler(tauri::generate_handler![
            execute_command,
            query_application,
            pick_local_directory,
            open_local_directory,
            restart_application
        ])
        .run(tauri::generate_context!())
}

pub fn run() -> tauri::Result<()> {
    let previous_probe = updater::startup_probe();
    let probe_directory = updater::default_startup_probe_directory();
    let _ = updater::write_starting_probe(&probe_directory, std::time::SystemTime::now());

    let facade = match LocalApplicationFacade::open_with_library(
        default_database_path(),
        persisted_or_default_library_root(),
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

/// A library root chosen during onboarding persists in the database and wins
/// over the platform default. Reading it before the facade is constructed
/// lets a restarted application resume with the chosen root.
fn persisted_or_default_library_root() -> PathBuf {
    LocalApplicationFacade::persisted_library_root(default_database_path())
        .unwrap_or_else(default_library_root)
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

#[cfg(test)]
mod external_link_tests {
    use super::*;
    use std::sync::Mutex;

    struct RecordingOpener {
        opened: Mutex<Vec<String>>,
    }

    impl ExternalUrlOpener for RecordingOpener {
        fn open(&self, url: &str) -> AppResult<()> {
            self.opened
                .lock()
                .expect("recorder mutex")
                .push(url.to_owned());
            Ok(())
        }
    }

    fn open_command(url: &str) -> AppCommand {
        AppCommand::OpenExternalUrl(skillhub_core::OpenExternalUrl {
            url: url.to_owned(),
        })
    }

    #[test]
    fn host_registration_lets_validated_links_reach_the_platform_browser() {
        let dir = tempfile::tempdir().expect("tempdir");
        let facade =
            Arc::new(LocalApplicationFacade::open(dir.path().join("app.sqlite")).expect("facade"));
        let opener = Arc::new(RecordingOpener {
            opened: Mutex::new(Vec::new()),
        });
        register_external_url_opener(&facade, opener.clone());

        let bridge = CommandBridge::new(facade.clone()).with_local(facade);
        let result = tauri::async_runtime::block_on(
            bridge.execute(open_command("https://github.com/anthropics/skills")),
        );

        assert!(matches!(result, Ok(AppCommandResult::OperationSummary(_))));
        assert_eq!(
            opener.opened.lock().expect("recorder mutex").clone(),
            vec!["https://github.com/anthropics/skills".to_owned()]
        );
    }

    #[test]
    fn without_host_registration_the_facade_refuses_to_open_links() {
        let dir = tempfile::tempdir().expect("tempdir");
        let facade =
            Arc::new(LocalApplicationFacade::open(dir.path().join("app.sqlite")).expect("facade"));
        let bridge = CommandBridge::new(facade.clone()).with_local(facade);

        let error = tauri::async_runtime::block_on(
            bridge.execute(open_command("https://github.com/anthropics/skills")),
        )
        .expect_err("links stay blocked until the shell registers an opener");

        assert_eq!(
            error.code.as_str(),
            skillhub_core::ErrorCode::ExternalLinkOpenerUnavailable.as_str()
        );
    }

    #[test]
    fn startup_registers_the_system_opener() {
        let source =
            std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"))
                .expect("desktop shell source");
        assert!(
            source.contains("register_external_url_opener(&facade, Arc::new(SystemExternalUrlOpener::default()))"),
            "the desktop shell must register the system opener during setup"
        );
    }
}

#[cfg(test)]
mod path_grant_tests {
    use super::*;

    fn custom_agent_draft(
        grant_id: &str,
        candidate_path: &str,
    ) -> skillhub_core::api::CreateCustomAgent {
        skillhub_core::api::CreateCustomAgent {
            agent: skillhub_core::agent::CustomAgentDraft {
                id: "custom-test-agent".into(),
                display_name: "Test Agent".into(),
                directory: skillhub_core::agent::PathGrant::from_file_picker(grant_id),
                profile: skillhub_core::AgentProfile {
                    profile_version: 1,
                    research_date: "2026-09-06".into(),
                    official_references: vec!["https://example.com/agent".into()],
                    brand: "Test".into(),
                    clients: vec![skillhub_core::agent::AgentClient {
                        id: "custom-test-agent-client".into(),
                        kind: skillhub_core::agent::ClientKind::Cli,
                        supported_os: vec![skillhub_core::agent::OperatingSystem::Windows],
                        path_candidates: vec![skillhub_core::PathCandidate {
                            path: candidate_path.into(),
                            scope: skillhub_core::TargetScope::Global,
                            precedence: skillhub_core::DirectoryPrecedence::Preferred,
                            marker: "SKILL.md".into(),
                        }],
                        skill_marker: "SKILL.md".into(),
                        deployment: skillhub_core::DeploymentCapability {
                            copy: true,
                            symlink: true,
                            junction: true,
                            limitations: Vec::new(),
                        },
                        call_policy: skillhub_core::CallPolicy::Unknown,
                    }],
                },
            },
        }
    }

    #[test]
    fn issue_grant_registers_canonical_path_and_unlocks_custom_agent_creation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let facade =
            Arc::new(LocalApplicationFacade::open(dir.path().join("app.sqlite")).expect("facade"));
        let bridge = CommandBridge::new(facade.clone()).with_local(facade.clone());
        let picked = dir.path().join("my-agent");
        std::fs::create_dir_all(&picked).expect("create picked dir");
        let canonical = std::fs::canonicalize(&picked).expect("canonicalize");

        let grant_id = bridge
            .issue_grant_for_path(&picked)
            .expect("issue grant for path");
        assert_eq!(grant_id, canonical.to_string_lossy());

        let result = tauri::async_runtime::block_on(bridge.execute(AppCommand::CreateCustomAgent(
            custom_agent_draft(&grant_id, canonical.to_string_lossy().as_ref()),
        )));
        let created = result.expect("custom agent creation must succeed with a registered grant");
        assert!(matches!(created, AppCommandResult::CustomAgent(_)));
    }

    #[test]
    fn custom_agent_creation_fails_while_the_grant_is_unregistered() {
        let dir = tempfile::tempdir().expect("tempdir");
        let facade =
            Arc::new(LocalApplicationFacade::open(dir.path().join("app.sqlite")).expect("facade"));
        let bridge = CommandBridge::new(facade.clone()).with_local(facade.clone());
        let picked = dir.path().join("never-registered");
        let canonical =
            std::fs::canonicalize(&picked.parent().expect("parent")).expect("canonicalize parent");
        let candidate = canonical
            .join("never-registered")
            .to_string_lossy()
            .into_owned();

        let result = tauri::async_runtime::block_on(bridge.execute(AppCommand::CreateCustomAgent(
            custom_agent_draft(&candidate, candidate.as_str()),
        )));
        match result {
            Ok(AppCommandResult::CustomAgent(_)) => {
                panic!("creation must fail while the grant is unregistered");
            }
            other => {
                let error = other.expect_err("expected structured error");
                // grant 未注册时从草稿解析失败，归入 profile 无效错误码（含原因参数）
                assert_eq!(
                    error.code.as_str(),
                    skillhub_core::ErrorCode::AgentProfileInvalidCapability.as_str()
                );
            }
        }
    }

    #[test]
    fn startup_re_registration_restores_grants_for_stored_custom_agents() {
        let dir = tempfile::tempdir().expect("tempdir");
        let facade =
            Arc::new(LocalApplicationFacade::open(dir.path().join("app.sqlite")).expect("facade"));
        let picked = dir.path().join("stored-agent");
        std::fs::create_dir_all(&picked).expect("create stored dir");
        let canonical = std::fs::canonicalize(&picked).expect("canonicalize");
        let grant_id = canonical.to_string_lossy().into_owned();
        bridge_setup_register(
            facade.clone(),
            &grant_id,
            canonical.to_string_lossy().as_ref(),
        );

        // 模拟重启：新 facade、无会话 grant，仅启动重注册。
        let facade_after_restart =
            Arc::new(LocalApplicationFacade::open(dir.path().join("app.sqlite")).expect("facade"));
        re_register_custom_agent_grants(&facade_after_restart);

        let bridge = CommandBridge::new(facade_after_restart.clone())
            .with_local(facade_after_restart.clone());
        let mut edited = custom_agent_draft(&grant_id, canonical.to_string_lossy().as_ref());
        edited.agent.display_name = "Renamed after restart".into();
        let result = tauri::async_runtime::block_on(bridge.execute(AppCommand::UpdateCustomAgent(
            skillhub_core::api::UpdateCustomAgent {
                agent: edited.agent,
            },
        )));
        if let Err(ref error) = result {
            eprintln!("restart edit failed: {error:?}");
        }
        assert!(
            matches!(result, Ok(AppCommandResult::CustomAgent(_))),
            "stored custom agents must stay editable after a restart"
        );
    }

    #[test]
    fn picker_canonicalization_keeps_rejecting_invalid_paths() {
        // 路径本身的问题（不存在 / 非目录）必须继续让选择器报错。
        let missing = std::env::temp_dir().join("skillhub-picker-missing-dir-should-not-exist");
        let error = super::canonicalize_picked_directory(&missing)
            .expect_err("a missing path must keep failing the picker");
        assert!(
            error.contains("canonicalize_failed"),
            "unexpected error: {error}"
        );

        let file_dir = tempfile::tempdir().expect("tempdir");
        let file_path = file_dir.path().join("plain-file.txt");
        std::fs::write(&file_path, b"x").expect("write plain file");
        let error = super::canonicalize_picked_directory(&file_path)
            .expect_err("a plain file must keep failing the picker");
        assert_eq!(error, "directory_picker.not_a_directory");
    }

    #[test]
    fn open_directory_validation_keeps_rejecting_non_directories() {
        // N11：打开目录是只读操作，但路径必须是真实存在的目录。
        let dir = tempfile::tempdir().expect("tempdir");
        let file_path = dir.path().join("plain-file.txt");
        std::fs::write(&file_path, b"x").expect("write file");
        let file_error = super::validate_openable_directory(&file_path)
            .expect_err("a plain file must be rejected");
        assert_eq!(file_error, "open_directory.not_a_directory");

        let missing = dir.path().join("missing-dir");
        assert!(super::validate_openable_directory(&missing).is_err());
    }

    #[test]
    fn picker_payload_survives_grant_issuance_failure() {
        let dir = tempfile::tempdir().expect("tempdir");
        let facade =
            Arc::new(LocalApplicationFacade::open(dir.path().join("app.sqlite")).expect("facade"));
        // 不附加 local facade：grant 注册必然失败（AR-007），
        // 但选择器仍须返回用户所选目录，grant_id 置空即可。
        let bridge = CommandBridge::new(facade);
        let canonical = std::fs::canonicalize(dir.path()).expect("canonicalize tempdir");

        let payload = super::picker_payload_with_lenient_grant(&bridge, &canonical)
            .expect("grant failure must not fail the picker payload");
        let parsed: serde_json::Value = serde_json::from_str(&payload).expect("json payload");
        assert_eq!(parsed["path"], canonical.to_string_lossy().as_ref());
        assert!(
            parsed["grant_id"].is_null(),
            "grant_id must be null when issuance failed, got: {parsed}"
        );
    }

    fn bridge_setup_register(facade: Arc<LocalApplicationFacade>, grant_id: &str, path: &str) {
        use skillhub_core::agent::OperatingSystem;
        let _ = facade.register_path_grant(skillhub_core::agent::ResolvedPathGrant {
            grant_id: grant_id.to_string(),
            path: path.to_string(),
            operating_system: if cfg!(windows) {
                OperatingSystem::Windows
            } else {
                OperatingSystem::Macos
            },
        });
        // 同时真实创建一个自定义 Agent，让"重启后"有已存储对象可重注册。
        let bridge = CommandBridge::new(facade.clone()).with_local(facade);
        let draft = custom_agent_draft(grant_id, path);
        tauri::async_runtime::block_on(bridge.execute(AppCommand::CreateCustomAgent(draft)))
            .expect("seed custom agent");
    }
}
