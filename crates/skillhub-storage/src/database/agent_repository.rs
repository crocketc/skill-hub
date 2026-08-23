use super::Database;
use rusqlite::{params, OptionalExtension};
use skillhub_core::agent::{AgentRepository as AgentRepositoryPort, DiscoverySnapshot};
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

const SNAPSHOT_KEY: &str = "agent_discovery_snapshot";

pub struct AgentRepository<'a> {
    database: &'a Database,
}

impl<'a> AgentRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn load(&self) -> AppResult<Option<DiscoverySnapshot>> {
        let value: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [SNAPSHOT_KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        value
            .map(|json| serde_json::from_str(&json).map_err(|_| invalid_snapshot()))
            .transpose()
    }

    pub fn replace(&self, snapshot: &DiscoverySnapshot) -> AppResult<DiscoverySnapshot> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        let previous = transaction
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [SNAPSHOT_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?
            .map(|json| {
                serde_json::from_str::<DiscoverySnapshot>(&json).map_err(|_| invalid_snapshot())
            })
            .transpose()?;
        let merged = merge_history(previous.as_ref(), snapshot);
        let json = serde_json::to_string(&merged).map_err(|_| invalid_snapshot())?;
        transaction
            .execute(
                "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                params![SNAPSHOT_KEY, json, now()],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
        Ok(merged)
    }
}

impl<'a> AgentRepositoryPort for AgentRepository<'a> {
    fn load_discovery(&self) -> AppResult<Option<DiscoverySnapshot>> {
        self.load()
    }

    fn replace_discovery(&self, snapshot: &DiscoverySnapshot) -> AppResult<DiscoverySnapshot> {
        self.replace(snapshot)
    }
}

fn merge_history(
    previous: Option<&DiscoverySnapshot>,
    current: &DiscoverySnapshot,
) -> DiscoverySnapshot {
    let Some(previous) = previous else {
        return current.clone();
    };
    let mut merged = current.clone();
    merged.generation = current
        .generation
        .max(previous.generation.saturating_add(1));
    for instance in &previous.instances {
        if !merged.instances.iter().any(|candidate| {
            candidate.profile_id == instance.profile_id && candidate.client_id == instance.client_id
        }) {
            let mut unavailable = instance.clone();
            unavailable.available = false;
            merged.instances.push(unavailable);
        }
    }
    for target in &previous.logical_targets {
        if !merged
            .logical_targets
            .iter()
            .any(|candidate| candidate.id == target.id)
        {
            let mut unavailable = target.clone();
            unavailable.exists = false;
            unavailable.readable = false;
            unavailable.writable = false;
            unavailable.available = false;
            merged.logical_targets.push(unavailable);
        }
    }
    for target in &previous.physical_targets {
        if !merged
            .physical_targets
            .iter()
            .any(|candidate| candidate.id == target.id)
        {
            let mut unavailable = target.clone();
            unavailable.exists = false;
            unavailable.readable = false;
            unavailable.writable = false;
            merged.physical_targets.push(unavailable);
        }
    }
    merged
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn invalid_snapshot() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
