use super::Database;
use rusqlite::params;
use skillhub_core::api::CombinationResult;
use skillhub_core::{
    AppError, AppResult, CombinationId, ErrorCode, RecoveryAction, Severity, SkillId,
};

/// SQLite persistence for non-nested Skill combinations.
pub struct CombinationRepository<'a> {
    database: &'a Database,
}

impl<'a> CombinationRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn create(&self, name: &str, members: &[SkillId]) -> AppResult<()> {
        let name = name.trim();
        if name.is_empty() || members.is_empty() {
            return Err(invalid("combination name and members are required"));
        }
        let mut unique = std::collections::HashSet::new();
        if members.iter().any(|member| !unique.insert(*member)) {
            return Err(invalid("combination members must be unique"));
        }
        let tx = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(error)?;
        for member in members {
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM skills WHERE id=?1)",
                    [member.to_string()],
                    |row| row.get(0),
                )
                .map_err(error)?;
            if !exists {
                return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("skill_id", member.to_string())
                    .with_action(RecoveryAction::ChooseAnotherName));
            }
        }
        let id = CombinationId::new();
        tx.execute(
            "INSERT INTO combinations(id,name,created_at,updated_at) VALUES(?1,?2,strftime('%s','now'),strftime('%s','now'))",
            params![id.to_string(), name],
        )
        .map_err(error)?;
        for (position, member) in members.iter().enumerate() {
            tx.execute(
                "INSERT INTO combination_skills(combination_id,skill_id,position) VALUES(?1,?2,?3)",
                params![id.to_string(), member.to_string(), position as i64],
            )
            .map_err(error)?;
        }
        tx.commit().map_err(error)
    }

    pub fn list(&self) -> AppResult<Vec<CombinationResult>> {
        let mut statement = self
            .database
            .connection
            .prepare("SELECT id,name FROM combinations ORDER BY name COLLATE NOCASE,id")
            .map_err(error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?;
        let mut result = Vec::with_capacity(rows.len());
        for (id, name) in rows {
            let members = self
                .database
                .connection
                .prepare("SELECT skill_id FROM combination_skills WHERE combination_id=?1 ORDER BY position")
                .map_err(error)?
                .query_map([&id], |row| row.get::<_, String>(0))
                .map_err(error)?
                .map(|row| {
                    row.map_err(error)?.parse().map_err(|_| invalid("combination skill id"))
                })
                .collect::<AppResult<Vec<_>>>()?;
            result.push(CombinationResult { name, members });
        }
        Ok(result)
    }
}

fn invalid(detail: &str) -> AppError {
    AppError::new(ErrorCode::InvalidInput, Severity::Error)
        .with_param("detail", detail)
        .with_action(RecoveryAction::ChooseAnotherName)
}

fn error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
