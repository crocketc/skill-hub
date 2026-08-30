mod agent_repository;
mod app_update_repository;
mod bootstrap_repository;
mod catalog_repository;
mod check_repository;
mod combination_repository;
mod custom_agent_repository;
mod deployment_repository;
pub mod evidence_repository;
mod import_repository;
mod llm_profile_repository;
mod migrations;
mod operation_repository;
mod project_repository;
pub mod recovery_point;
mod scan_repository;
mod search_repository;
mod source_repository;
mod source_search_cache;

use std::fmt;
use std::path::Path;
use std::sync::Arc;

use rusqlite::Connection;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};
use tokio::sync::Mutex;

pub use agent_repository::AgentRepository;
pub use app_update_repository::ApplicationUpdateRepository;
pub use bootstrap_repository::BootstrapRepository;
pub use catalog_repository::CatalogRepositorySqlite;
pub use check_repository::CheckRepositorySqlite;
pub use combination_repository::CombinationRepository;
pub use custom_agent_repository::CustomAgentRepository;
pub use deployment_repository::{DeploymentRepository, DeploymentRepositorySqlite};
pub use evidence_repository::UsageEvidenceRepository;
pub use import_repository::ImportRepository;
pub use llm_profile_repository::LlmProfileRepository;
pub use migrations::MigrationReport;
pub use operation_repository::OperationRepositorySqlite;
pub use project_repository::ProjectRepository;
pub use recovery_point::RecoveryPoint;
pub use scan_repository::ScanRepository;
pub use search_repository::SearchRepository;
pub use source_repository::SourceRepository;
pub use source_search_cache::SourceSearchCache;

/// An application database backed by SQLite.
pub struct Database {
    connection: Connection,
    migration_report: MigrationReport,
    operation_writer: Arc<Mutex<()>>,
}

impl fmt::Debug for Database {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Database")
            .field("connection", &"<sqlite connection>")
            .finish()
    }
}

impl Database {
    pub fn check_repository(&self) -> CheckRepositorySqlite<'_> {
        CheckRepositorySqlite::new(self)
    }
    pub fn catalog_repository(&self) -> AppResult<CatalogRepositorySqlite<'_>> {
        CatalogRepositorySqlite::new(self)
    }

    pub fn search_repository(&self) -> SearchRepository<'_> {
        SearchRepository::new(self)
    }

    pub fn combination_repository(&self) -> CombinationRepository<'_> {
        CombinationRepository::new(self)
    }

    pub fn bootstrap_repository(&self) -> BootstrapRepository<'_> {
        BootstrapRepository::new(self)
    }

    pub fn agent_repository(&self) -> AgentRepository<'_> {
        AgentRepository::new(self)
    }

    pub fn application_update_repository(&self) -> ApplicationUpdateRepository<'_> {
        ApplicationUpdateRepository::new(self)
    }

    pub fn custom_agent_repository(&self) -> CustomAgentRepository<'_> {
        CustomAgentRepository::new(self)
    }

    pub fn project_repository(&self) -> ProjectRepository<'_> {
        ProjectRepository::new(self)
    }

    pub fn import_repository(&self) -> ImportRepository<'_> {
        ImportRepository::new(self)
    }

    pub fn source_repository(&self) -> SourceRepository<'_> {
        SourceRepository::new(self)
    }

    pub fn source_search_cache(&self) -> SourceSearchCache<'_> {
        SourceSearchCache::new(self)
    }

    pub fn llm_profile_repository(&self) -> LlmProfileRepository<'_> {
        LlmProfileRepository::new(self)
    }

    pub fn scan_repository(&self) -> ScanRepository<'_> {
        ScanRepository::new(self)
    }

    pub fn operation_repository(&self) -> OperationRepositorySqlite<'_> {
        OperationRepositorySqlite::new(self)
    }

    pub fn deployment_repository(&self) -> DeploymentRepositorySqlite<'_> {
        DeploymentRepositorySqlite::new(self)
    }

    pub(crate) fn operation_writer(&self) -> Arc<Mutex<()>> {
        self.operation_writer.clone()
    }

    #[doc(hidden)]
    pub fn connection_for_test(&self) -> &Connection {
        &self.connection
    }
    /// Opens a database file and applies all migrations required by this build.
    pub fn open(path: impl AsRef<Path>) -> AppResult<Self> {
        let path = path.as_ref();
        let recovery = recovery_point::RecoveryPoint::create(path)?;
        let mut connection = match Connection::open(path) {
            Ok(connection) => connection,
            Err(error) => {
                if let Some(point) = recovery {
                    point.restore()?;
                    point.discard()?;
                }
                return Err(database_error(error));
            }
        };
        if let Err(error) = enable_foreign_keys(&connection) {
            drop(connection);
            if let Some(point) = recovery {
                point.restore()?;
                point.discard()?;
            }
            return Err(error);
        }
        let migration_report = match migrations::run(&mut connection) {
            Ok(report) => report,
            Err(error) => {
                drop(connection);
                if let Some(point) = recovery {
                    point.restore()?;
                    point.discard()?;
                }
                return Err(error);
            }
        };
        let database = Self {
            connection,
            migration_report,
            operation_writer: Arc::new(Mutex::new(())),
        };
        if let Some(point) = recovery {
            point.discard()?;
        }
        Ok(database)
    }

    /// Opens an isolated in-memory database and applies all migrations.
    pub fn open_in_memory() -> AppResult<Self> {
        let mut connection = Connection::open_in_memory().map_err(database_error)?;
        enable_foreign_keys(&connection)?;
        let migration_report = migrations::run(&mut connection)?;
        Ok(Self {
            connection,
            migration_report,
            operation_writer: Arc::new(Mutex::new(())),
        })
    }

    /// Returns the SQLite schema version stored in `PRAGMA user_version`.
    pub fn schema_version(&self) -> AppResult<u32> {
        self.connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
            .map_err(database_error)
    }

    /// Returns the report produced while opening this database.
    pub fn migration_report(&self) -> &MigrationReport {
        &self.migration_report
    }

    /// Reports whether a table or virtual table exists in this database.
    pub fn has_table(&self, name: &str) -> AppResult<bool> {
        self.connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?1)",
                [name],
                |row| row.get(0),
            )
            .map_err(database_error)
    }
}

fn enable_foreign_keys(connection: &Connection) -> AppResult<()> {
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(database_error)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}

#[cfg(test)]
mod tests {
    use super::Database;

    #[test]
    fn foreign_keys_are_enabled_for_cascade_and_restrict_behavior() {
        let db = Database::open_in_memory().unwrap();
        db.connection
            .execute_batch(
                "INSERT INTO skills (id, display_name, runtime_name, created_at, updated_at) VALUES ('skill', 'Skill', 'skill', 0, 0);\
                 INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES ('version', 'skill', 'hash', '{}', 0);\
                 INSERT INTO current_pointers (skill_id, version_id, updated_at) VALUES ('skill', 'version', 0);\
                 INSERT INTO sources (id, kind, locator, created_at) VALUES ('source', 'local', 'fixture', 0);\
                 INSERT INTO skill_sources (skill_id, source_id) VALUES ('skill', 'source');",
            )
            .unwrap();

        let restricted_delete = db
            .connection
            .execute("DELETE FROM versions WHERE id = 'version'", []);
        assert!(restricted_delete.is_err());

        db.connection
            .execute("DELETE FROM current_pointers WHERE skill_id = 'skill'", [])
            .unwrap();
        db.connection
            .execute("DELETE FROM versions WHERE id = 'version'", [])
            .unwrap();
        db.connection
            .execute("DELETE FROM skills WHERE id = 'skill'", [])
            .unwrap();
        let remaining_relations: i64 = db
            .connection
            .query_row(
                "SELECT COUNT(*) FROM skill_sources WHERE skill_id = 'skill'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining_relations, 0);
    }
}
