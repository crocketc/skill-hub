use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use skillhub_core::{AppError, ErrorCode, RecoveryAction, Severity};

pub type UpdateInstallError = AppError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallStarted {
    pub package_path: PathBuf,
    pub restart_requested: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StartupProbeResult {
    Starting,
    Healthy,
    Failed,
    TimedOut,
}

pub fn validate_update_package(path: &Path) -> Result<(), UpdateInstallError> {
    validate_update_package_in(path, &default_update_staging_directory()).map(|_| ())
}

pub fn install_update(path: &Path) -> Result<InstallStarted, UpdateInstallError> {
    let updater = ValidatedPlatformUpdater;
    let relauncher = DeferredRelaunchRequester;
    install_update_with(
        path,
        &default_update_staging_directory(),
        &updater,
        &relauncher,
    )
}

pub fn restart_after_install() -> Result<(), UpdateInstallError> {
    DeferredRelaunchRequester.request_relaunch()
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

pub trait PlatformUpdater {
    fn install_package(&self, path: &Path) -> Result<(), UpdateInstallError>;
}

pub trait RelaunchRequester {
    fn request_relaunch(&self) -> Result<(), UpdateInstallError>;
}

pub fn install_update_with(
    path: &Path,
    staging_directory: &Path,
    updater: &dyn PlatformUpdater,
    relauncher: &dyn RelaunchRequester,
) -> Result<InstallStarted, UpdateInstallError> {
    let package_path = validate_update_package_in(path, staging_directory)?;
    updater.install_package(&package_path)?;
    relauncher.request_relaunch()?;
    Ok(InstallStarted {
        package_path,
        restart_requested: true,
    })
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

struct ValidatedPlatformUpdater;

impl PlatformUpdater for ValidatedPlatformUpdater {
    fn install_package(&self, _path: &Path) -> Result<(), UpdateInstallError> {
        // The signed platform install is exposed through the Tauri updater plugin.
        // This boundary only accepts packages that already passed app-layer checks.
        Ok(())
    }
}

struct DeferredRelaunchRequester;

impl RelaunchRequester for DeferredRelaunchRequester {
    fn request_relaunch(&self) -> Result<(), UpdateInstallError> {
        Ok(())
    }
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

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn install_hands_validated_package_to_platform_updater_and_requests_relaunch() {
        use std::sync::Mutex;

        struct RecordingUpdater {
            paths: Mutex<Vec<PathBuf>>,
        }

        impl PlatformUpdater for RecordingUpdater {
            fn install_package(&self, path: &Path) -> Result<(), UpdateInstallError> {
                self.paths
                    .lock()
                    .expect("paths mutex")
                    .push(path.to_path_buf());
                Ok(())
            }
        }

        struct RecordingRelauncher {
            count: Mutex<u32>,
        }

        impl RelaunchRequester for RecordingRelauncher {
            fn request_relaunch(&self) -> Result<(), UpdateInstallError> {
                let mut count = self.count.lock().expect("count mutex");
                *count += 1;
                Ok(())
            }
        }

        let staging = tempfile::tempdir().unwrap();
        let package = staging.path().join(valid_update_artifact_name());
        std::fs::write(&package, b"updater package").unwrap();
        let updater = RecordingUpdater {
            paths: Mutex::new(Vec::new()),
        };
        let relauncher = RecordingRelauncher {
            count: Mutex::new(0),
        };

        let result = install_update_with(&package, staging.path(), &updater, &relauncher).unwrap();

        assert_eq!(
            updater.paths.lock().expect("paths mutex").as_slice(),
            &[std::fs::canonicalize(&package).unwrap()]
        );
        assert_eq!(*relauncher.count.lock().expect("count mutex"), 1);
        assert_eq!(
            result.package_path,
            std::fs::canonicalize(&package).unwrap()
        );
        assert!(result.restart_requested);
    }

    #[cfg(windows)]
    fn valid_update_artifact_name() -> &'static str {
        "SkillHub_0.2.0_x64.nsis.zip"
    }

    #[cfg(target_os = "macos")]
    fn valid_update_artifact_name() -> &'static str {
        "SkillHub.app.tar.gz"
    }
}
