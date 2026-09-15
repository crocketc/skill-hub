use std::collections::BTreeMap;

use rusqlite::{params, Connection, Transaction};
use skillhub_core::deployment::observed_path_key;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

use super::relationship_repository::deployment_entry_path;

pub const CURRENT_SCHEMA_VERSION: u32 = 15;

#[derive(Clone, Copy)]
struct Migration<'a> {
    version: u32,
    sql: &'a str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        sql: include_str!("../../migrations/0001_initial.sql"),
    },
    Migration {
        version: 2,
        sql: include_str!("../../migrations/0002_fts.sql"),
    },
    Migration {
        version: 3,
        sql: include_str!("../../migrations/0003_catalog_metadata.sql"),
    },
    Migration {
        version: 4,
        sql: include_str!("../../migrations/0004_search_tokenizer.sql"),
    },
    Migration {
        version: 5,
        sql: include_str!("../../migrations/0005_check_run_metadata.sql"),
    },
    Migration {
        version: 6,
        sql: include_str!("../../migrations/0006_llm_profiles.sql"),
    },
    Migration {
        version: 7,
        sql: include_str!("../../migrations/0007_ui_preferences.sql"),
    },
    Migration {
        version: 8,
        sql: include_str!("../../migrations/0008_version_labels.sql"),
    },
    Migration {
        version: 9,
        sql: include_str!("../../migrations/0009_skill_user_purpose.sql"),
    },
    Migration {
        version: 10,
        sql: include_str!("../../migrations/0010_llm_providers_translations.sql"),
    },
    Migration {
        version: 11,
        sql: include_str!("../../migrations/0011_source_roles.sql"),
    },
    Migration {
        version: 12,
        sql: include_str!("../../migrations/0012_combination_name_unique.sql"),
    },
    Migration {
        version: 13,
        sql: include_str!("../../migrations/0013_observed_deployments.sql"),
    },
    Migration {
        version: 14,
        sql: include_str!("../../migrations/0014_skill_relationships.sql"),
    },
    Migration {
        version: 15,
        sql: include_str!("../../migrations/0015_conflict_analysis.sql"),
    },
];

/// The result of applying zero or more schema migrations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationReport {
    pub from_version: u32,
    pub to_version: u32,
    pub applied_versions: Vec<u32>,
}

pub fn run(connection: &mut Connection) -> AppResult<MigrationReport> {
    run_with_migrations(connection, MIGRATIONS)
}

fn run_with_migrations(
    connection: &mut Connection,
    migrations: &[Migration<'_>],
) -> AppResult<MigrationReport> {
    let from_version = read_schema_version(connection)?;
    if from_version > CURRENT_SCHEMA_VERSION {
        return Err(
            AppError::new(ErrorCode::DatabaseNewerSchema, Severity::Error)
                .with_param("database_version", from_version)
                .with_param("application_version", CURRENT_SCHEMA_VERSION)
                .with_action(RecoveryAction::OpenReadOnly),
        );
    }

    let mut applied_versions = Vec::new();
    for migration in migrations
        .iter()
        .filter(|migration| migration.version > from_version)
    {
        let transaction = connection.transaction().map_err(database_error)?;
        transaction
            .execute_batch(migration.sql)
            .map_err(database_error)?;
        if migration.version == 14 {
            repair_relationship_paths(&transaction)?;
        }
        transaction
            .pragma_update(None, "user_version", migration.version)
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
        applied_versions.push(migration.version);
    }

    let to_version = read_schema_version(connection)?;
    Ok(MigrationReport {
        from_version,
        to_version,
        applied_versions,
    })
}

fn repair_relationship_paths(transaction: &Transaction<'_>) -> AppResult<()> {
    let managed_paths = {
        let mut statement = transaction
            .prepare(
                "SELECT dr.relation_id, t.agent_id, t.path, d.runtime_name
                 FROM deployment_relations dr
                 JOIN deployments d ON dr.relation_id='legacy-managed:' || d.id
                 JOIN targets t ON t.id=d.target_id",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        rows
    };
    for (managed_relation_id, agent_client_id, target_path, runtime_name) in managed_paths {
        let path = deployment_entry_path(&target_path, &runtime_name);
        let identity_key = relationship_path_identity_key(&path);
        let conflicting_rows = {
            let mut statement = transaction
                .prepare(
                    "SELECT rowid, relation_id, path FROM deployment_relations
                     WHERE agent_client_id=?1 AND relation_id<>?2",
                )
                .map_err(database_error)?;
            let rows = statement
                .query_map(params![agent_client_id, managed_relation_id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(database_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(database_error)?;
            rows
        };
        for (rowid, _relation_id, conflicting_path) in conflicting_rows {
            if relationship_path_identity_key(&conflicting_path) == identity_key {
                transaction
                    .execute("DELETE FROM deployment_relations WHERE rowid=?1", [rowid])
                    .map_err(database_error)?;
            }
        }
        transaction
            .execute(
                "UPDATE deployment_relations SET path=?1, path_key=?2 WHERE relation_id=?3",
                params![path, observed_path_key(&path), managed_relation_id],
            )
            .map_err(database_error)?;
    }

    let deployment_paths = {
        let mut statement = transaction
            .prepare("SELECT rowid, path, link_target_path FROM deployment_relations")
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        rows
    };
    for (rowid, path, link_target_path) in deployment_paths {
        transaction
            .execute(
                "UPDATE deployment_relations SET path_key=?1, link_target_path_key=?2 WHERE rowid=?3",
                params![
                    observed_path_key(&path),
                    link_target_path.as_deref().map(observed_path_key),
                    rowid,
                ],
            )
            .map_err(database_error)?;
    }

    let source_paths = {
        let mut statement = transaction
            .prepare("SELECT rowid, source_path FROM source_relations")
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        rows
    };
    for (rowid, path) in source_paths {
        transaction
            .execute(
                "UPDATE source_relations SET source_path_key=?1 WHERE rowid=?2",
                params![observed_path_key(&path), rowid],
            )
            .map_err(database_error)?;
    }
    Ok(())
}

fn relationship_path_identity_key(path: &str) -> String {
    observed_path_key(&path.replace('\\', "/"))
}

fn read_schema_version(connection: &Connection) -> AppResult<u32> {
    connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
        .map_err(database_error)
}

fn database_error(error: rusqlite::Error) -> AppError {
    let mut params = BTreeMap::new();
    params.insert(
        "source".to_owned(),
        serde_json::Value::String(error.to_string()),
    );
    AppError {
        code: ErrorCode::InternalError,
        severity: Severity::Error,
        params,
        actions: vec![RecoveryAction::Retry],
    }
}

#[cfg(test)]
mod tests {
    use super::{run_with_migrations, Migration};
    use rusqlite::Connection;

    #[test]
    fn failed_migration_rolls_back_its_schema_and_user_version() {
        let mut connection = Connection::open_in_memory().unwrap();
        let migrations = [Migration {
            version: 1,
            sql: "CREATE TABLE should_rollback (id INTEGER); THIS IS NOT SQL;",
        }];

        assert!(run_with_migrations(&mut connection, &migrations).is_err());

        let table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let user_version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(table_count, 0);
        assert_eq!(user_version, 0);
    }
}
