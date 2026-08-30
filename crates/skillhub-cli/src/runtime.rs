use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;

use serde_json::Value;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::AppError;

use crate::args::CliArgs;

#[derive(Clone, Debug)]
pub struct CliRuntimeError {
    pub code: String,
    pub detail: String,
    pub params: BTreeMap<String, Value>,
    pub actions: Vec<String>,
}

impl CliRuntimeError {
    pub fn not_configured(database: PathBuf, library: PathBuf, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        let mut params = BTreeMap::new();
        params.insert("detail".into(), Value::String(detail.clone()));
        params.insert(
            "database".into(),
            Value::String(database.to_string_lossy().into_owned()),
        );
        params.insert(
            "library".into(),
            Value::String(library.to_string_lossy().into_owned()),
        );
        Self {
            code: "cli.not_configured".into(),
            detail,
            params,
            actions: vec![
                "run_desktop_initialization".into(),
                "provide_explicit_paths".into(),
            ],
        }
    }

    pub fn from_app_error(error: AppError) -> Self {
        Self {
            code: error.code.as_str().into(),
            detail: "failed to open the local SkillHub application".into(),
            params: error.params,
            actions: error
                .actions
                .into_iter()
                .map(|action| action.as_str().into())
                .collect(),
        }
    }
}

impl fmt::Display for CliRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for CliRuntimeError {}

pub fn open(args: &CliArgs) -> Result<LocalApplicationFacade, CliRuntimeError> {
    let database = args.database.clone().unwrap_or_else(default_database_path);
    let library = args.library.clone().unwrap_or_else(default_library_root);
    if !database.is_file() || !library.is_dir() {
        let missing = match (database.is_file(), library.is_dir()) {
            (false, false) => "database and library",
            (false, true) => "database",
            (true, false) => "library",
            (true, true) => "configured paths",
        };
        return Err(CliRuntimeError::not_configured(
            database,
            library,
            format!("{missing} is missing or unavailable; initialize SkillHub first or pass --database and --library"),
        ));
    }
    LocalApplicationFacade::open_with_library(&database, &library)
        .map_err(CliRuntimeError::from_app_error)
}

pub fn app_result_error(error: AppError) -> CliRuntimeError {
    CliRuntimeError {
        code: error.code.as_str().into(),
        detail: "the local SkillHub operation failed".into(),
        params: error.params,
        actions: error
            .actions
            .into_iter()
            .map(|action| action.as_str().into())
            .collect(),
    }
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
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
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
