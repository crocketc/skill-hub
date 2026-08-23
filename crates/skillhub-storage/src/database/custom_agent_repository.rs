use super::Database;
use rusqlite::{params, OptionalExtension};
use skillhub_core::agent::{CustomAgent, CustomAgentOverride};
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

const AGENTS_KEY: &str = "custom_agents";
const OVERRIDES_KEY: &str = "custom_agent_profile_overrides";

pub struct CustomAgentRepository<'a> {
    database: &'a Database,
}

impl<'a> CustomAgentRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn list(&self) -> AppResult<Vec<CustomAgent>> {
        let records = self.load_agents()?;
        Ok(records)
    }

    pub fn create(&self, agent: CustomAgent) -> AppResult<CustomAgent> {
        agent
            .validate()
            .map_err(|error| invalid_agent(format!("{error:?}")))?;
        let mut agents = self.load_agents()?;
        if agents.iter().any(|candidate| candidate.id == agent.id) {
            return Err(invalid_agent("duplicate custom Agent id"));
        }
        agents.push(agent.clone());
        self.write_agents(&agents)?;
        Ok(agent)
    }

    pub fn update(&self, agent: CustomAgent) -> AppResult<CustomAgent> {
        agent
            .validate()
            .map_err(|error| invalid_agent(format!("{error:?}")))?;
        let mut agents = self.load_agents()?;
        let Some(existing) = agents.iter_mut().find(|candidate| candidate.id == agent.id) else {
            return Err(not_found("custom Agent"));
        };
        *existing = agent.clone();
        self.write_agents(&agents)?;
        Ok(agent)
    }

    pub fn remove(&self, id: &str) -> AppResult<()> {
        let mut agents = self.load_agents()?;
        let original_len = agents.len();
        agents.retain(|candidate| candidate.id != id);
        if agents.len() == original_len {
            return Err(not_found("custom Agent"));
        }
        let mut overrides = self.load_overrides()?;
        overrides.retain(|candidate| candidate.profile_id != id);
        self.write_agents_and_overrides(&agents, &overrides)
    }

    pub fn set_override(
        &self,
        override_profile: CustomAgentOverride,
    ) -> AppResult<CustomAgentOverride> {
        if override_profile.profile_id.trim().is_empty() {
            return Err(invalid_agent("missing profile id"));
        }
        skillhub_core::agent::validate_profile_strict(&override_profile.profile)
            .map_err(invalid_agent)?;
        let mut overrides = self.load_overrides()?;
        if let Some(existing) = overrides
            .iter_mut()
            .find(|candidate| candidate.profile_id == override_profile.profile_id)
        {
            *existing = override_profile.clone();
        } else {
            overrides.push(override_profile.clone());
        }
        self.write_overrides(&overrides)?;
        Ok(override_profile)
    }

    pub fn list_overrides(&self) -> AppResult<Vec<CustomAgentOverride>> {
        self.load_overrides()
    }

    pub fn reset_override(&self, profile_id: &str) -> AppResult<()> {
        let mut overrides = self.load_overrides()?;
        let original_len = overrides.len();
        overrides.retain(|candidate| candidate.profile_id != profile_id);
        if overrides.len() == original_len {
            return Err(not_found("profile override"));
        }
        self.write_overrides(&overrides)
    }

    fn load_agents(&self) -> AppResult<Vec<CustomAgent>> {
        load_value(&self.database.connection, AGENTS_KEY)
    }

    fn load_overrides(&self) -> AppResult<Vec<CustomAgentOverride>> {
        load_value(&self.database.connection, OVERRIDES_KEY)
    }

    fn write_agents(&self, agents: &[CustomAgent]) -> AppResult<()> {
        let overrides = self.load_overrides()?;
        self.write_agents_and_overrides(agents, &overrides)
    }

    fn write_overrides(&self, overrides: &[CustomAgentOverride]) -> AppResult<()> {
        let agents = self.load_agents()?;
        self.write_agents_and_overrides(&agents, overrides)
    }

    fn write_agents_and_overrides(
        &self,
        agents: &[CustomAgent],
        overrides: &[CustomAgentOverride],
    ) -> AppResult<()> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        let agents_json = serde_json::to_string(agents).map_err(|_| invalid_agent("serialize"))?;
        let overrides_json =
            serde_json::to_string(overrides).map_err(|_| invalid_agent("serialize"))?;
        let timestamp = now();
        transaction
            .execute(
                "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                params![AGENTS_KEY, agents_json, timestamp],
            )
            .map_err(database_error)?;
        transaction
            .execute(
                "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                params![OVERRIDES_KEY, overrides_json, timestamp],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)
    }
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
        .map(|json| serde_json::from_str(&json).map_err(|_| invalid_agent("invalid stored data")))
        .transpose()
        .map(|value| value.unwrap_or_default())
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn invalid_agent(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::AgentProfileInvalidCapability, Severity::Error)
        .with_param("detail", detail.into())
        .with_action(RecoveryAction::Acknowledge)
}

fn not_found(kind: &str) -> AppError {
    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
        .with_param("kind", kind)
        .with_action(RecoveryAction::Acknowledge)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
