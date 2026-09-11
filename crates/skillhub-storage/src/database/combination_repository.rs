use super::Database;
use rusqlite::params;
use skillhub_core::api::CombinationResult;
use skillhub_core::{
    AppError, AppResult, CombinationId, ErrorCode, RecoveryAction, Severity, SkillId,
};

/// SQLite persistence for non-nested Skill combinations.
///
/// A combination name is the user-facing identity used by the public
/// commands, so the repository enforces two invariants: names are unique
/// (create/rename reject duplicates with `TargetExists`), and a name that
/// matches several legacy rows is never silently narrowed to one of them —
/// update/delete/rename report `OperationConflict` with the colliding count.
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
        reject_duplicate_name(&tx, name)?;
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
        insert_members(&tx, &id.to_string(), members)?;
        tx.commit().map_err(error)
    }

    pub fn update_members(&self, name: &str, members: &[SkillId]) -> AppResult<()> {
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
        let id = resolve_single_id(&tx, name)?;
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
        replace_members(&tx, &id, members)?;
        tx.execute(
            "UPDATE combinations SET updated_at=strftime('%s','now') WHERE id=?1",
            [&id],
        )
        .map_err(error)?;
        tx.commit().map_err(error)
    }

    /// Renames a combination and returns its updated view. Validation mirrors
    /// `create`: the new name must be non-empty after trimming and must not
    /// collide with another combination.
    pub fn rename(&self, from: &str, to: &str) -> AppResult<CombinationResult> {
        let from = from.trim();
        let to = to.trim();
        if from.is_empty() || to.is_empty() {
            return Err(invalid("combination names are required"));
        }
        let tx = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(error)?;
        let id = resolve_single_id(&tx, from)?;
        reject_duplicate_name_except(&tx, to, &id)?;
        tx.execute(
            "UPDATE combinations SET name=?1, updated_at=strftime('%s','now') WHERE id=?2",
            params![to, id],
        )
        .map_err(error)?;
        let members = load_members(&tx, &id)?;
        tx.commit().map_err(error)?;
        Ok(CombinationResult {
            name: to.to_owned(),
            members,
        })
    }

    pub fn delete(&self, name: &str) -> AppResult<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(invalid("combination name is required"));
        }
        let id = resolve_single_id(&self.database.connection, name)?;
        // combination_skills rows are removed by ON DELETE CASCADE.
        self.database
            .connection
            .execute("DELETE FROM combinations WHERE id=?1", [&id])
            .map_err(error)?;
        Ok(())
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
            let members = load_members(&self.database.connection, &id)?;
            result.push(CombinationResult { name, members });
        }
        Ok(result)
    }
}

/// Loads the ordered member ids of one combination.
fn load_members(connection: &rusqlite::Connection, id: &str) -> AppResult<Vec<SkillId>> {
    connection
        .prepare(
            "SELECT skill_id FROM combination_skills WHERE combination_id=?1 ORDER BY position",
        )
        .map_err(error)?
        .query_map([id], |row| row.get::<_, String>(0))
        .map_err(error)?
        .map(|row| {
            row.map_err(error)?
                .parse()
                .map_err(|_| invalid("combination skill id"))
        })
        .collect()
}

fn insert_members(
    connection: &rusqlite::Connection,
    id: &str,
    members: &[SkillId],
) -> AppResult<()> {
    for (position, member) in members.iter().enumerate() {
        connection
            .execute(
                "INSERT INTO combination_skills(combination_id,skill_id,position) VALUES(?1,?2,?3)",
                params![id, member.to_string(), position as i64],
            )
            .map_err(error)?;
    }
    Ok(())
}

/// Replaces the member rows of one combination, preserving the given order.
fn replace_members(
    connection: &rusqlite::Connection,
    id: &str,
    members: &[SkillId],
) -> AppResult<()> {
    connection
        .execute(
            "DELETE FROM combination_skills WHERE combination_id=?1",
            [id],
        )
        .map_err(error)?;
    insert_members(connection, id, members)
}

/// Returns every combination id that carries the given (already trimmed) name.
fn ids_for_name(connection: &rusqlite::Connection, name: &str) -> AppResult<Vec<String>> {
    let mut statement = connection
        .prepare("SELECT id FROM combinations WHERE name=?1 ORDER BY created_at,id")
        .map_err(error)?;
    let ids = statement
        .query_map([name], |row| row.get::<_, String>(0))
        .map_err(error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error)?;
    Ok(ids)
}

/// Resolves a name to the single row it addresses. Several rows with the same
/// name (legacy data created before duplicate defense) must fail loudly with
/// `OperationConflict` instead of being narrowed by insertion time.
fn resolve_single_id(connection: &rusqlite::Connection, name: &str) -> AppResult<String> {
    let ids = ids_for_name(connection, name)?;
    match ids.as_slice() {
        [id] => Ok(id.clone()),
        [] => Err(object_not_found(name)),
        _ => Err(ambiguous_name(name, ids.len())),
    }
}

fn reject_duplicate_name(connection: &rusqlite::Connection, name: &str) -> AppResult<()> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM combinations WHERE name=?1)",
            [name],
            |row| row.get(0),
        )
        .map_err(error)?;
    if exists {
        return Err(duplicate_name(name));
    }
    Ok(())
}

fn reject_duplicate_name_except(
    connection: &rusqlite::Connection,
    name: &str,
    id: &str,
) -> AppResult<()> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM combinations WHERE name=?1 AND id<>?2)",
            params![name, id],
            |row| row.get(0),
        )
        .map_err(error)?;
    if exists {
        return Err(duplicate_name(name));
    }
    Ok(())
}

fn duplicate_name(name: &str) -> AppError {
    AppError::new(ErrorCode::TargetExists, Severity::Error)
        .with_param("combination", name.to_string())
        .with_action(RecoveryAction::ChooseAnotherName)
}

fn ambiguous_name(name: &str, matches: usize) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("combination", name.to_string())
        .with_param("matches", matches as i64)
        .with_action(RecoveryAction::Acknowledge)
}

fn object_not_found(name: &str) -> AppError {
    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
        .with_param("combination", name.to_string())
        .with_action(RecoveryAction::ChooseAnotherName)
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
