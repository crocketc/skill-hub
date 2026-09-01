use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use skillhub_application::ApplicationUpdateInstaller;
use skillhub_core::{AppError, ErrorCode, RecoveryAction, Severity};
use tauri_plugin_updater::UpdaterExt;

pub type UpdateInstallError = AppError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StartupProbeResult {
    Starting,
    Healthy,
    Failed,
    TimedOut,
}

/// Failure detail reported by [`UpdaterPlugin`]: a stable machine reason plus
/// the display form of the underlying error for diagnostics.
#[derive(Debug, Eq, PartialEq)]
pub struct UpdaterPluginFailure {
    pub reason: &'static str,
    pub source: String,
}

/// Drives the Tauri updater plugin for one verified staging package. Split
/// from [`TauriUpdateInstaller`] so tests can fake the plugin without booting
/// a Tauri runtime; the real implementation is [`PluginBackedUpdater`].
#[async_trait::async_trait]
pub trait UpdaterPlugin: Send + Sync {
    /// Checks the configured official endpoint and installs the given package
    /// bytes. On success the process exits (Windows NSIS) or is restarted
    /// (macOS), so a normal return usually means the process is being torn
    /// down by the plugin.
    async fn check_and_install(&self, bytes: Vec<u8>) -> Result<(), UpdaterPluginFailure>;
}

#[async_trait::async_trait]
impl<P: UpdaterPlugin + ?Sized> UpdaterPlugin for &P {
    async fn check_and_install(&self, bytes: Vec<u8>) -> Result<(), UpdaterPluginFailure> {
        (**self).check_and_install(bytes).await
    }
}

/// Real [`UpdaterPlugin`] backed by a Tauri app handle. The plugin reads the
/// static endpoint and public key from `tauri.conf.json`, re-verifies the
/// minisign signature, and runs the per-platform installer; this type never
/// spawns a command or opens a URL on its own.
pub struct PluginBackedUpdater<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> PluginBackedUpdater<R> {
    pub fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
    }
}

#[async_trait::async_trait]
impl<R: tauri::Runtime> UpdaterPlugin for PluginBackedUpdater<R> {
    async fn check_and_install(&self, bytes: Vec<u8>) -> Result<(), UpdaterPluginFailure> {
        let fail = |reason: &'static str, source: String| UpdaterPluginFailure { reason, source };
        let update = self
            .app
            .updater()
            .map_err(|error| fail("updater_unavailable", error.to_string()))?
            .check()
            .await
            .map_err(|error| fail("update_check_failed", error.to_string()))?
            .ok_or_else(|| fail("update_no_longer_available", String::new()))?;
        update
            .install(bytes)
            .map_err(|error| fail("update_install_failed", error.to_string()))?;
        // Windows NSIS updates exit the process inside the plugin; macOS
        // replaces the bundle and must be relaunched explicitly.
        #[cfg(target_os = "macos")]
        {
            self.app.restart()
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(())
        }
    }
}

/// Hands the verified staging package to the Tauri updater plugin. Only paths
/// inside the application update staging directory with the platform updater
/// artifact suffix reach the plugin.
pub struct TauriUpdateInstaller<P> {
    plugin: P,
}

impl<P> TauriUpdateInstaller<P> {
    pub fn new(plugin: P) -> Self {
        Self { plugin }
    }
}

impl TauriUpdateInstaller<PluginBackedUpdater<tauri::Wry>> {
    pub fn for_app(app: tauri::AppHandle<tauri::Wry>) -> Self {
        Self::new(PluginBackedUpdater::new(app))
    }
}

#[async_trait::async_trait]
impl<P: UpdaterPlugin> ApplicationUpdateInstaller for TauriUpdateInstaller<P> {
    async fn install(&self, package_path: &Path) -> Result<(), UpdateInstallError> {
        validate_update_package(package_path)?;
        let bytes = std::fs::read(package_path)
            .map_err(|error| io_error("update_package_unreadable", error))?;
        self.plugin
            .check_and_install(bytes)
            .await
            .map_err(|failure| updater_error(failure.reason, failure.source))
    }
}

pub fn validate_update_package(path: &Path) -> Result<(), UpdateInstallError> {
    validate_update_package_in(path, &default_update_staging_directory()).map(|_| ())
}

pub fn startup_probe() -> StartupProbeResult {
    read_startup_probe(
        &default_startup_probe_directory(),
        SystemTime::now(),
        default_startup_probe_timeout(),
    )
}

pub fn write_starting_probe(
    probe_directory: &Path,
    started_at: SystemTime,
) -> Result<(), UpdateInstallError> {
    write_probe(
        probe_directory,
        &format!("starting\n{}\n", unix_timestamp(started_at)),
    )
}

pub fn read_startup_probe(
    probe_directory: &Path,
    now: SystemTime,
    timeout: Duration,
) -> StartupProbeResult {
    let path = startup_probe_path(probe_directory);
    let Ok(contents) = std::fs::read_to_string(path) else {
        return StartupProbeResult::Healthy;
    };
    let mut lines = contents.lines();
    match lines.next() {
        Some("healthy") => StartupProbeResult::Healthy,
        Some("failed") => StartupProbeResult::Failed,
        Some("starting") => {
            let Some(started_at) = lines.next().and_then(|value| value.parse::<u64>().ok()) else {
                return StartupProbeResult::Failed;
            };
            if unix_timestamp(now).saturating_sub(started_at) > timeout.as_secs() {
                StartupProbeResult::TimedOut
            } else {
                StartupProbeResult::Starting
            }
        }
        _ => StartupProbeResult::Failed,
    }
}

pub fn write_failed_probe(probe_directory: &Path) -> Result<(), UpdateInstallError> {
    write_probe(probe_directory, "failed\n")
}

pub fn write_healthy_probe(probe_directory: &Path) -> Result<(), UpdateInstallError> {
    write_probe(probe_directory, "healthy\n")
}

fn validate_update_package_in(
    path: &Path,
    staging_directory: &Path,
) -> Result<PathBuf, UpdateInstallError> {
    let staging_directory = std::fs::canonicalize(staging_directory)
        .map_err(|_| blocked("update_staging_directory_unavailable"))?;
    let package_path =
        std::fs::canonicalize(path).map_err(|_| blocked("update_package_unavailable"))?;
    if !package_path.starts_with(&staging_directory) {
        return Err(blocked("update_package_outside_staging_directory"));
    }
    if !package_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_supported_updater_artifact)
    {
        return Err(blocked("unsupported_update_artifact"));
    }
    Ok(package_path)
}

fn default_update_staging_directory() -> PathBuf {
    std::env::temp_dir()
        .join("skillhub")
        .join("application-updates")
}

fn blocked(reason: &'static str) -> AppError {
    AppError::new(ErrorCode::ApplicationUpdateInstallBlocked, Severity::Info)
        .with_param("reason", reason)
        .with_action(RecoveryAction::Acknowledge)
}

fn io_error(reason: &'static str, error: std::io::Error) -> AppError {
    AppError::new(
        ErrorCode::ApplicationUpdateInstallBlocked,
        Severity::Warning,
    )
    .with_param("reason", reason)
    .with_param("source", error.to_string())
    .with_action(RecoveryAction::Retry)
}

fn updater_error(reason: &'static str, error: impl std::fmt::Display) -> AppError {
    AppError::new(
        ErrorCode::ApplicationUpdateInstallBlocked,
        Severity::Warning,
    )
    .with_param("reason", reason)
    .with_param("source", error.to_string())
    .with_action(RecoveryAction::Retry)
}

#[cfg(windows)]
fn is_supported_updater_artifact(file_name: &str) -> bool {
    // Tauri's Windows updater consumes the signed NSIS archive, not the
    // first-install setup executable.
    file_name.ends_with(".nsis.zip")
}

#[cfg(target_os = "macos")]
fn is_supported_updater_artifact(file_name: &str) -> bool {
    file_name.ends_with(".app.tar.gz")
}

#[cfg(not(any(windows, target_os = "macos")))]
fn is_supported_updater_artifact(_file_name: &str) -> bool {
    false
}

pub(crate) fn default_startup_probe_directory() -> PathBuf {
    std::env::temp_dir().join("skillhub").join("startup-probe")
}

fn default_startup_probe_timeout() -> Duration {
    Duration::from_secs(60)
}

fn startup_probe_path(probe_directory: &Path) -> PathBuf {
    probe_directory.join("state")
}

fn write_probe(probe_directory: &Path, contents: &str) -> Result<(), UpdateInstallError> {
    std::fs::create_dir_all(probe_directory)
        .map_err(|error| io_error("startup_probe_directory_unavailable", error))?;
    std::fs::write(startup_probe_path(probe_directory), contents)
        .map_err(|error| io_error("startup_probe_write_failed", error))
}

fn unix_timestamp(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_rejects_package_outside_update_staging_directory() {
        let outside = tempfile::tempdir().unwrap();
        let package = outside.path().join("update-package");
        std::fs::write(&package, b"not an updater package").unwrap();

        let error = validate_update_package(&package).unwrap_err();

        assert_eq!(error.code, ErrorCode::ApplicationUpdateInstallBlocked);
    }

    #[test]
    fn install_rejects_arbitrary_path_inside_update_staging_directory() {
        let staging = tempfile::tempdir().unwrap();
        let package = staging.path().join("update-package");
        std::fs::write(&package, b"not an updater package").unwrap();

        let error = validate_update_package_in(&package, staging.path()).unwrap_err();

        assert_eq!(error.code, ErrorCode::ApplicationUpdateInstallBlocked);
    }

    #[cfg(windows)]
    #[test]
    fn windows_accepts_only_current_user_nsis_updater_artifact() {
        let staging = tempfile::tempdir().unwrap();
        let package = staging.path().join("SkillHub_0.2.0_x64.nsis.zip");
        let setup = staging.path().join("SkillHub_0.2.0_x64-setup.exe");
        std::fs::write(&package, b"nsis updater archive").unwrap();
        std::fs::write(&setup, b"first-install setup").unwrap();

        validate_update_package_in(&package, staging.path()).unwrap();
        let error = validate_update_package_in(&setup, staging.path()).unwrap_err();

        assert_eq!(error.code, ErrorCode::ApplicationUpdateInstallBlocked);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_accepts_app_tar_gz_updater_artifact() {
        let staging = tempfile::tempdir().unwrap();
        let package = staging.path().join("SkillHub.app.tar.gz");
        let dmg = staging.path().join("SkillHub.dmg");
        std::fs::write(&package, b"app archive").unwrap();
        std::fs::write(&dmg, b"disk image").unwrap();

        validate_update_package_in(&package, staging.path()).unwrap();
        let error = validate_update_package_in(&dmg, staging.path()).unwrap_err();

        assert_eq!(error.code, ErrorCode::ApplicationUpdateInstallBlocked);
    }

    #[test]
    fn startup_probe_reports_timeout_deterministically() {
        let probe_dir = tempfile::tempdir().unwrap();
        let timeout = std::time::Duration::from_secs(5);
        let now = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(10);
        let started_at = now - std::time::Duration::from_secs(6);

        write_starting_probe(probe_dir.path(), started_at).unwrap();

        assert_eq!(
            read_startup_probe(probe_dir.path(), now, timeout),
            StartupProbeResult::TimedOut
        );
    }

    #[test]
    fn startup_probe_reports_failure_deterministically() {
        let probe_dir = tempfile::tempdir().unwrap();
        let now = std::time::SystemTime::UNIX_EPOCH;

        write_failed_probe(probe_dir.path()).unwrap();

        assert_eq!(
            read_startup_probe(probe_dir.path(), now, std::time::Duration::from_secs(5)),
            StartupProbeResult::Failed
        );
    }

    #[test]
    fn tauri_installer_refuses_package_outside_staging_without_checking_plugin() {
        struct UnusedPlugin {
            calls: std::sync::Mutex<u32>,
        }

        #[async_trait::async_trait]
        impl UpdaterPlugin for UnusedPlugin {
            async fn check_and_install(&self, _bytes: Vec<u8>) -> Result<(), UpdaterPluginFailure> {
                *self.calls.lock().expect("calls mutex") += 1;
                Ok(())
            }
        }

        let plugin = UnusedPlugin {
            calls: std::sync::Mutex::new(0),
        };
        let installer = TauriUpdateInstaller::new(&plugin);
        let outside = tempfile::tempdir().unwrap();
        let package = outside.path().join("update-package");
        std::fs::write(&package, b"package").unwrap();

        let error = tauri::async_runtime::block_on(installer.install(&package)).unwrap_err();

        assert_eq!(error.code, ErrorCode::ApplicationUpdateInstallBlocked);
        assert_eq!(
            error
                .params
                .get("reason")
                .and_then(serde_json::Value::as_str),
            Some("update_package_outside_staging_directory")
        );
        assert_eq!(*plugin.calls.lock().expect("calls mutex"), 0);
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn tauri_installer_passes_staged_package_bytes_to_plugin() {
        use std::sync::Mutex;

        struct RecordingPlugin {
            packages: Mutex<Vec<Vec<u8>>>,
        }

        #[async_trait::async_trait]
        impl UpdaterPlugin for RecordingPlugin {
            async fn check_and_install(&self, bytes: Vec<u8>) -> Result<(), UpdaterPluginFailure> {
                self.packages.lock().expect("packages mutex").push(bytes);
                Ok(())
            }
        }

        // The installer validates against the production staging root, so the
        // fixture package is created there and cleaned up afterwards. Keep
        // this name distinct from the failure-path fixture because Rust runs
        // unit tests in parallel and both otherwise share the staging root.
        let staging = default_update_staging_directory();
        std::fs::create_dir_all(&staging).unwrap();
        let package = staging.join(valid_update_artifact_name("passes-bytes"));
        std::fs::write(&package, b"signed updater package").unwrap();
        let plugin = RecordingPlugin {
            packages: Mutex::new(Vec::new()),
        };
        let installer = TauriUpdateInstaller::new(&plugin);

        let result = tauri::async_runtime::block_on(installer.install(&package));

        let _ = std::fs::remove_file(&package);
        result.unwrap();

        assert_eq!(
            plugin.packages.lock().expect("packages mutex").as_slice(),
            &[b"signed updater package".to_vec()]
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn tauri_installer_maps_plugin_failure_to_install_blocked() {
        use std::sync::Mutex;

        struct FailingPlugin {
            calls: Mutex<u32>,
        }

        #[async_trait::async_trait]
        impl UpdaterPlugin for FailingPlugin {
            async fn check_and_install(&self, _bytes: Vec<u8>) -> Result<(), UpdaterPluginFailure> {
                *self.calls.lock().expect("calls mutex") += 1;
                Err(UpdaterPluginFailure {
                    reason: "update_install_failed",
                    source: "boom".to_owned(),
                })
            }
        }

        // The installer validates against the production staging root, so the
        // fixture package is created there and cleaned up afterwards.
        let staging = default_update_staging_directory();
        std::fs::create_dir_all(&staging).unwrap();
        let package = staging.join(valid_update_artifact_name("maps-failure"));
        std::fs::write(&package, b"signed updater package").unwrap();
        let plugin = FailingPlugin {
            calls: Mutex::new(0),
        };
        let installer = TauriUpdateInstaller::new(&plugin);

        let error = tauri::async_runtime::block_on(installer.install(&package)).unwrap_err();

        let _ = std::fs::remove_file(&package);
        assert_eq!(*plugin.calls.lock().expect("calls mutex"), 1);
        assert_eq!(error.code, ErrorCode::ApplicationUpdateInstallBlocked);
        assert_eq!(
            error
                .params
                .get("reason")
                .and_then(serde_json::Value::as_str),
            Some("update_install_failed")
        );
        assert_eq!(
            error
                .params
                .get("source")
                .and_then(serde_json::Value::as_str),
            Some("boom")
        );
    }

    #[test]
    fn tauri_installer_type_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<TauriUpdateInstaller<PluginBackedUpdater<tauri::Wry>>>();
    }

    #[cfg(windows)]
    fn valid_update_artifact_name(label: &str) -> String {
        format!("SkillHub_test_{label}.nsis.zip")
    }

    #[cfg(target_os = "macos")]
    fn valid_update_artifact_name(label: &str) -> String {
        format!("SkillHub_test_{label}.app.tar.gz")
    }
}
