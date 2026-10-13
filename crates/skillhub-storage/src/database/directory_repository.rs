use super::relationship_repository::{bump_relationship_revision_tx, upsert_capability_tx};
use super::Database;
use rusqlite::{params, OptionalExtension, Transaction};
use skillhub_core::deployment::observed_path_key;
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, DirectoryNodeFact, DirectoryRecognition, DirectoryRole,
};
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};
use std::collections::BTreeSet;

pub struct DirectoryRepository<'a> {
    database: &'a Database,
}

impl<'a> DirectoryRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn upsert_node(&self, node: &DirectoryNodeFact) -> AppResult<()> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        if upsert_node_tx(&transaction, node)? {
            bump_relationship_revision_tx(&transaction)?;
        }
        transaction.commit().map_err(database_error)
    }

    /// Replaces the current verified roots produced by Agent discovery. Older
    /// discovery roots remain as historical facts but are made unavailable so
    /// relation path matching cannot silently keep using a stale physical ID.
    pub fn replace_agent_discovery_facts(
        &self,
        nodes: &[DirectoryNodeFact],
        capabilities: &[AgentDirectoryCapabilityFact],
    ) -> AppResult<()> {
        let node_ids = nodes
            .iter()
            .map(|node| node.node_id.as_str())
            .collect::<BTreeSet<_>>();
        if node_ids.len() != nodes.len()
            || nodes
                .iter()
                .any(|node| node.scan_source.as_deref() != Some("agent_discovery") || !node.exists)
        {
            return Err(invalid_record());
        }
        let capability_keys = capabilities
            .iter()
            .map(|capability| {
                (
                    capability.agent_client_id.as_str(),
                    capability.directory_node_id.as_str(),
                )
            })
            .collect::<BTreeSet<_>>();
        if capability_keys.len() != capabilities.len()
            || capabilities.iter().any(|capability| {
                !node_ids.contains(capability.directory_node_id.as_str())
                    || capability.recognition != DirectoryRecognition::Supported
            })
        {
            return Err(invalid_record());
        }

        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        let mut changed = transaction
            .execute(
                "UPDATE directory_nodes SET exists_flag=0
                 WHERE scan_source='agent_discovery' AND exists_flag<>0",
                [],
            )
            .map_err(database_error)?
            != 0;
        for node in nodes {
            if upsert_node_tx(&transaction, node)? {
                changed = true;
            }
        }

        // Discovery capability facts must stop claiming support when an Agent
        // no longer declares that physical directory. Explicit researched
        // capabilities use a different evidence reference and remain intact.
        let stale_discovery_capabilities = {
            let mut statement = transaction
                .prepare(
                    "SELECT agent_client_id, directory_node_id
                     FROM agent_directory_capabilities
                     WHERE evidence_reference='agent_discovery' AND recognition='supported'",
                )
                .map_err(database_error)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(database_error)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(database_error)?
        };
        for (agent_client_id, directory_node_id) in stale_discovery_capabilities {
            if capability_keys.contains(&(agent_client_id.as_str(), directory_node_id.as_str())) {
                continue;
            }
            let updated = transaction
                .execute(
                    "UPDATE agent_directory_capabilities SET recognition='unknown'
                     WHERE agent_client_id=?1 AND directory_node_id=?2
                       AND evidence_reference='agent_discovery' AND recognition='supported'",
                    params![agent_client_id, directory_node_id],
                )
                .map_err(database_error)?;
            changed |= updated != 0;
        }

        for capability in capabilities {
            let stored_capability: Option<(String, Option<String>)> = transaction
                .query_row(
                    "SELECT recognition, evidence_reference FROM agent_directory_capabilities
                     WHERE agent_client_id=?1 AND directory_node_id=?2",
                    params![capability.agent_client_id, capability.directory_node_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(database_error)?;
            if stored_capability
                .as_ref()
                .is_some_and(|(recognition, evidence)| {
                    recognition == "unsupported"
                        || (recognition == "supported"
                            && evidence.as_deref() != Some("agent_discovery"))
                })
            {
                continue;
            }
            changed |= upsert_capability_tx(&transaction, capability)?;
        }

        if changed {
            bump_relationship_revision_tx(&transaction)?;
        }
        transaction.commit().map_err(database_error)
    }

    pub fn list_nodes(&self) -> AppResult<Vec<DirectoryNodeFact>> {
        let mut statement = self
            .database
            .connection
            .prepare(
                "SELECT node_id, path, path_key, role, profile_id, agent_client_id, exists_flag, observed_at, scan_source
                 FROM directory_nodes ORDER BY path_key, node_id",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            })
            .map_err(database_error)?;
        rows.map(|row| {
            let row = row.map_err(database_error)?;
            decode_node(row).ok_or_else(invalid_record)
        })
        .collect()
    }

    pub fn get_node(&self, node_id: &str) -> AppResult<Option<DirectoryNodeFact>> {
        self.database
            .connection
            .query_row(
                "SELECT node_id, path, path_key, role, profile_id, agent_client_id, exists_flag, observed_at, scan_source
                 FROM directory_nodes WHERE node_id=?1",
                [node_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?
            .map(|row| decode_node(row).ok_or_else(invalid_record))
            .transpose()
    }
}

fn upsert_node_tx(transaction: &Transaction<'_>, node: &DirectoryNodeFact) -> AppResult<bool> {
    let path_key = observed_path_key(&node.path);
    let changed = transaction
        .execute(
            "INSERT INTO directory_nodes
             (node_id, path, path_key, role, profile_id, agent_client_id, exists_flag, observed_at, scan_source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(node_id) DO UPDATE SET
             path=excluded.path, path_key=excluded.path_key, role=excluded.role,
             profile_id=excluded.profile_id, agent_client_id=excluded.agent_client_id,
             exists_flag=excluded.exists_flag, observed_at=excluded.observed_at,
             scan_source=excluded.scan_source
             WHERE directory_nodes.path IS NOT excluded.path
                OR directory_nodes.path_key IS NOT excluded.path_key
                OR directory_nodes.role IS NOT excluded.role
                OR directory_nodes.profile_id IS NOT excluded.profile_id
                OR directory_nodes.agent_client_id IS NOT excluded.agent_client_id
                OR directory_nodes.exists_flag IS NOT excluded.exists_flag
                OR directory_nodes.scan_source IS NOT excluded.scan_source",
            params![
                node.node_id,
                node.path,
                path_key,
                role_code(node.role),
                node.profile_id,
                node.agent_client_id,
                i64::from(node.exists),
                node.observed_at,
                node.scan_source,
            ],
        )
        .map_err(database_error)?
        != 0;
    transaction
        .execute(
            "UPDATE directory_nodes SET observed_at=?1
             WHERE node_id=?2 AND observed_at IS NOT ?1",
            params![node.observed_at, node.node_id],
        )
        .map_err(database_error)?;
    Ok(changed)
}

type StoredNode = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    i64,
    i64,
    Option<String>,
);

fn decode_node(row: StoredNode) -> Option<DirectoryNodeFact> {
    Some(DirectoryNodeFact {
        node_id: row.0,
        path: row.1,
        path_key: row.2,
        role: parse_role(&row.3)?,
        profile_id: row.4,
        agent_client_id: row.5,
        exists: row.6 != 0,
        observed_at: row.7,
        scan_source: row.8,
    })
}

fn role_code(value: DirectoryRole) -> &'static str {
    match value {
        DirectoryRole::CentralLibrary => "central_library",
        DirectoryRole::AgentNative => "agent_native",
        DirectoryRole::SharedDirectory => "shared_directory",
        DirectoryRole::Project => "project",
    }
}

fn parse_role(value: &str) -> Option<DirectoryRole> {
    match value {
        "central_library" => Some(DirectoryRole::CentralLibrary),
        "agent_native" => Some(DirectoryRole::AgentNative),
        "shared_directory" => Some(DirectoryRole::SharedDirectory),
        "project" => Some(DirectoryRole::Project),
        _ => None,
    }
}

fn invalid_record() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("reason", "directory_node_record_corrupt")
        .with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    super::classify_database_error(error)
}
