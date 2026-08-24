use super::Database;
use rusqlite::{params, OptionalExtension};
use skillhub_core::project::{Project, ProjectTag, SavedProjectView, SharedProjectConfig};
use skillhub_core::{AppError, AppResult, ErrorCode, ProjectId, RecoveryAction, Severity};
use std::path::Path;

const PROJECTS_KEY: &str = "projects";
const VIEWS_KEY: &str = "saved_project_views";

pub struct ProjectRepository<'a> {
    database: &'a Database,
}

impl<'a> ProjectRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn list(&self) -> AppResult<Vec<Project>> {
        load_value(&self.database.connection, PROJECTS_KEY)
    }

    pub fn get(&self, id: ProjectId) -> AppResult<Project> {
        self.list()?
            .into_iter()
            .find(|project| project.id == id)
            .ok_or_else(|| not_found("project"))
    }

    pub fn register(&self, mut project: Project) -> AppResult<Project> {
        validate_project(&project)?;
        let mut projects = self.list()?;
        if projects.iter().any(|candidate| candidate.id == project.id) {
            return Err(invalid_input("duplicate project id"));
        }
        if projects
            .iter()
            .any(|candidate| candidate.device_path == project.device_path)
        {
            return Err(invalid_input("project path is already registered"));
        }
        project.set_tags(project.tags.clone());
        projects.push(project.clone());
        self.write_projects(&projects)?;
        Ok(project)
    }

    pub fn update(&self, project: Project) -> AppResult<Project> {
        validate_project(&project)?;
        let mut projects = self.list()?;
        if projects.iter().any(|candidate| {
            candidate.id != project.id && candidate.device_path == project.device_path
        }) {
            return Err(invalid_input("project path is already registered"));
        }
        let Some(existing) = projects
            .iter_mut()
            .find(|candidate| candidate.id == project.id)
        else {
            return Err(not_found("project"));
        };
        *existing = project.clone();
        self.write_projects(&projects)?;
        Ok(project)
    }

    pub fn set_tags<T, I>(&self, id: ProjectId, tags: I) -> AppResult<Project>
    where
        T: Into<ProjectTag>,
        I: IntoIterator<Item = T>,
    {
        let mut project = self.get(id)?;
        project.set_tags(tags);
        self.update(project.clone())
    }

    pub fn save_view(&self, view: SavedProjectView) -> AppResult<SavedProjectView> {
        if view.id.trim().is_empty() || view.name.trim().is_empty() {
            return Err(invalid_input("saved project view needs an id and name"));
        }
        let mut views: Vec<SavedProjectView> = load_value(&self.database.connection, VIEWS_KEY)?;
        if let Some(existing) = views.iter_mut().find(|candidate| candidate.id == view.id) {
            *existing = view.clone();
        } else {
            views.push(view.clone());
        }
        self.write_value(VIEWS_KEY, &views)?;
        Ok(view)
    }

    pub fn list_views(&self) -> AppResult<Vec<SavedProjectView>> {
        load_value(&self.database.connection, VIEWS_KEY)
    }

    pub fn matching_view(&self, id: &str) -> AppResult<Vec<ProjectId>> {
        let view = self
            .list_views()?
            .into_iter()
            .find(|candidate| candidate.id == id)
            .ok_or_else(|| not_found("saved project view"))?;
        Ok(self
            .list()?
            .into_iter()
            .filter(|project| view.matches(project))
            .map(|project| project.id)
            .collect())
    }

    pub fn matching_all<I, S>(&self, tags: I) -> AppResult<Vec<ProjectId>>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let view = SavedProjectView::all_tags("__ephemeral__", tags);
        Ok(self
            .list()?
            .into_iter()
            .filter(|project| view.matches(project))
            .map(|project| project.id)
            .collect())
    }

    pub fn write_shared_config(
        &self,
        id: ProjectId,
        config: &SharedProjectConfig,
    ) -> AppResult<()> {
        config.validate().map_err(invalid_input)?;
        let project = self.get(id)?;
        let directory = Path::new(&project.device_path).join(".skillhub");
        std::fs::create_dir_all(&directory).map_err(io_error)?;
        let path = directory.join("project.json");
        let bytes =
            serde_json::to_vec_pretty(config).map_err(|error| internal(error.to_string()))?;
        std::fs::write(path, bytes).map_err(io_error)
    }

    pub fn read_shared_config(&self, id: ProjectId) -> AppResult<SharedProjectConfig> {
        let project = self.get(id)?;
        let path = Path::new(&project.device_path)
            .join(".skillhub")
            .join("project.json");
        let bytes = std::fs::read(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                not_found("shared project config")
            } else {
                io_error(error)
            }
        })?;
        let config: SharedProjectConfig = serde_json::from_slice(&bytes)
            .map_err(|error| invalid_input(format!("invalid shared project config: {error}")))?;
        config.validate().map_err(invalid_input)?;
        Ok(config)
    }

    fn write_projects(&self, projects: &[Project]) -> AppResult<()> {
        self.write_value(PROJECTS_KEY, projects)
    }

    fn write_value<T: serde::Serialize + ?Sized>(&self, key: &str, value: &T) -> AppResult<()> {
        let json = serde_json::to_string(value).map_err(|error| internal(error.to_string()))?;
        self.database
            .connection
            .execute(
                "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                params![key, json, now()],
            )
            .map(|_| ())
            .map_err(database_error)
    }
}

fn validate_project(project: &Project) -> AppResult<()> {
    if project.name.trim().is_empty() {
        return Err(invalid_input("project name is required"));
    }
    if project.device_path.trim().is_empty() {
        return Err(invalid_input("project device path is required"));
    }
    Ok(())
}

fn load_value<T: serde::de::DeserializeOwned>(
    connection: &rusqlite::Connection,
    key: &str,
) -> AppResult<Vec<T>> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value_json FROM settings WHERE key=?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(database_error)?;
    value
        .map(|json| serde_json::from_str(&json).map_err(|error| internal(error.to_string())))
        .transpose()
        .map(|value| value.unwrap_or_default())
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn invalid_input(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, Severity::Error)
        .with_param("detail", detail.into())
        .with_action(RecoveryAction::Acknowledge)
}

fn not_found(kind: &str) -> AppError {
    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
        .with_param("kind", kind)
        .with_action(RecoveryAction::Acknowledge)
}

fn internal(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", detail.into())
        .with_action(RecoveryAction::Retry)
}

fn io_error(error: std::io::Error) -> AppError {
    internal(error.to_string())
}

fn database_error(error: rusqlite::Error) -> AppError {
    internal(error.to_string())
}
