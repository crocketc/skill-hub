use super::Database;
use rusqlite::{params, Transaction};
use skillhub_core::api::CombinationResult;
use skillhub_core::{
    AppError, AppResult, CombinationId, ErrorCode, OperationId, OperationPhase, OperationRecord,
    RecoveryAction, Severity, SkillId,
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
        let tx = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(error)?;
        create_tx(&tx, name, members)?;
        tx.commit().map_err(error)
    }

    pub fn create_with_operation(
        &self,
        name: &str,
        members: &[SkillId],
        operation_id: OperationId,
    ) -> AppResult<((), OperationRecord)> {
        self.with_planned_operation(operation_id, "create_combination", |transaction| {
            create_tx(transaction, name, members)
        })
    }

    pub fn update_members(&self, name: &str, members: &[SkillId]) -> AppResult<()> {
        let tx = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(error)?;
        update_members_tx(&tx, name, members)?;
        tx.commit().map_err(error)
    }

    pub fn update_members_with_operation(
        &self,
        name: &str,
        members: &[SkillId],
        operation_id: OperationId,
    ) -> AppResult<((), OperationRecord)> {
        self.with_planned_operation(operation_id, "update_combination", |transaction| {
            update_members_tx(transaction, name, members)
        })
    }

    /// Renames a combination and returns its updated view. Validation mirrors
    /// `create`: the new name must be non-empty after trimming and must not
    /// collide with another combination.
    pub fn rename(&self, from: &str, to: &str) -> AppResult<CombinationResult> {
        let tx = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(error)?;
        let result = rename_tx(&tx, from, to)?;
        tx.commit().map_err(error)?;
        Ok(result)
    }

    pub fn rename_with_operation(
        &self,
        from: &str,
        to: &str,
        operation_id: OperationId,
    ) -> AppResult<(CombinationResult, OperationRecord)> {
        self.with_planned_operation(operation_id, "rename_combination", |transaction| {
            rename_tx(transaction, from, to)
        })
    }

    pub fn delete(&self, name: &str) -> AppResult<()> {
        let tx = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(error)?;
        delete_tx(&tx, name)?;
        tx.commit().map_err(error)
    }

    pub fn delete_with_operation(
        &self,
        name: &str,
        operation_id: OperationId,
    ) -> AppResult<((), OperationRecord)> {
        self.with_planned_operation(operation_id, "delete_combination", |transaction| {
            delete_tx(transaction, name)
        })
    }

    fn with_planned_operation<T>(
        &self,
        operation_id: OperationId,
        expected_kind: &str,
        execute: impl FnOnce(&Transaction<'_>) -> AppResult<T>,
    ) -> AppResult<(T, OperationRecord)> {
        let mut operation = self
            .database
            .operation_repository()
            .get_sync(operation_id)?
            .ok_or_else(|| operation_conflict(operation_id))?;
        if operation.kind != expected_kind || operation.phase != OperationPhase::Planned {
            return Err(operation_conflict(operation_id));
        }
        operation.phase = OperationPhase::Committed;
        operation.progress.phase = OperationPhase::Committed;
        operation.progress.message_code = format!("operation.{expected_kind}.committed");
        operation.error_code = None;

        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(error)?;
        let result = execute(&transaction)?;
        super::operation_repository::OperationRepositorySqlite::commit_planned_tx(
            &transaction,
            &operation,
        )?;
        transaction.commit().map_err(error)?;
        Ok((result, operation))
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

fn create_tx(transaction: &Transaction<'_>, name: &str, members: &[SkillId]) -> AppResult<()> {
    let name = name.trim();
    validate_members(name, members)?;
    reject_duplicate_name(transaction, name)?;
    for member in members {
        ensure_skill_exists(transaction, *member)?;
    }
    let id = CombinationId::new();
    transaction
        .execute(
            "INSERT INTO combinations(id,name,created_at,updated_at) VALUES(?1,?2,strftime('%s','now'),strftime('%s','now'))",
            params![id.to_string(), name],
        )
        .map_err(error)?;
    insert_members(transaction, &id.to_string(), members)
}

fn update_members_tx(
    transaction: &Transaction<'_>,
    name: &str,
    members: &[SkillId],
) -> AppResult<()> {
    let name = name.trim();
    validate_members(name, members)?;
    let id = resolve_single_id(transaction, name)?;
    for member in members {
        ensure_skill_exists(transaction, *member)?;
    }
    replace_members(transaction, &id, members)?;
    transaction
        .execute(
            "UPDATE combinations SET updated_at=strftime('%s','now') WHERE id=?1",
            [&id],
        )
        .map_err(error)?;
    Ok(())
}

fn rename_tx(transaction: &Transaction<'_>, from: &str, to: &str) -> AppResult<CombinationResult> {
    let from = from.trim();
    let to = to.trim();
    if from.is_empty() || to.is_empty() {
        return Err(invalid("combination names are required"));
    }
    let id = resolve_single_id(transaction, from)?;
    reject_duplicate_name_except(transaction, to, &id)?;
    transaction
        .execute(
            "UPDATE combinations SET name=?1, updated_at=strftime('%s','now') WHERE id=?2",
            params![to, id],
        )
        .map_err(error)?;
    let members = load_members(transaction, &id)?;
    Ok(CombinationResult {
        name: to.to_owned(),
        members,
    })
}

fn delete_tx(transaction: &Transaction<'_>, name: &str) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(invalid("combination name is required"));
    }
    let id = resolve_single_id(transaction, name)?;
    // combination_skills rows are removed by ON DELETE CASCADE.
    transaction
        .execute("DELETE FROM combinations WHERE id=?1", [&id])
        .map_err(error)?;
    Ok(())
}

fn validate_members(name: &str, members: &[SkillId]) -> AppResult<()> {
    if name.is_empty() || members.is_empty() {
        return Err(invalid("combination name and members are required"));
    }
    let mut unique = std::collections::HashSet::new();
    if members.iter().any(|member| !unique.insert(*member)) {
        return Err(invalid("combination members must be unique"));
    }
    Ok(())
}

fn ensure_skill_exists(transaction: &Transaction<'_>, skill_id: SkillId) -> AppResult<()> {
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM skills WHERE id=?1)",
            [skill_id.to_string()],
            |row| row.get(0),
        )
        .map_err(error)?;
    if !exists {
        return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
            .with_param("skill_id", skill_id.to_string())
            .with_action(RecoveryAction::ChooseAnotherName));
    }
    Ok(())
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

fn operation_conflict(operation_id: OperationId) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("operation_id", operation_id.to_string())
        .with_action(RecoveryAction::Retry)
}

fn error(error: rusqlite::Error) -> AppError {
    super::classify_database_error(error)
}
