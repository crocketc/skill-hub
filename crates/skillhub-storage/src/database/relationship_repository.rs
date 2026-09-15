use super::Database;
use rusqlite::{params, OptionalExtension, Transaction};
use skillhub_core::agent::DirectoryPrecedence;
use skillhub_core::deployment::{
    observed_path_key, DeploymentMode, DeploymentRecord, DeploymentState, ObservedMatchState,
    ObservedOrigin,
};
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, ConflictCaseFact, ConflictClassification, ConflictEvidence,
    ConflictKind, ConflictMemberFact, DeploymentRelationFact, DirectoryRecognition,
    FileRepresentation, GovernanceTaskFact, GovernanceTaskKind, OwnershipState, RelationshipType,
    SourceRelationFact,
};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity, SkillId};
use std::collections::BTreeSet;

pub struct RelationshipRepository<'a> {
    pub(crate) database: &'a Database,
}

/// Complete relationship impact for a skill, directory, Agent, path, or
/// relationship identifier.  AI analysis records are intentionally deferred
/// to Task 8; this snapshot contains only deterministic storage facts.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RelationshipImpactSnapshot {
    pub deployments: Vec<DeploymentRelationFact>,
    pub source_relations: Vec<SourceRelationFact>,
    pub directory_capabilities: Vec<AgentDirectoryCapabilityFact>,
    pub directory_nodes: Vec<skillhub_core::relationship::DirectoryNodeFact>,
}

impl<'a> RelationshipRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn upsert_capability(&self, capability: &AgentDirectoryCapabilityFact) -> AppResult<()> {
        let platforms = serde_json::to_string(&capability.applicable_platforms)
            .map_err(|error| serialization_error(error.to_string()))?;
        self.database
            .connection
            .execute(
                "INSERT INTO agent_directory_capabilities
                 (agent_client_id, directory_node_id, recognition, precedence, evidence_reference, researched_at, applicable_platforms_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(agent_client_id, directory_node_id) DO UPDATE SET
                 recognition=excluded.recognition, precedence=excluded.precedence,
                 evidence_reference=excluded.evidence_reference, researched_at=excluded.researched_at,
                 applicable_platforms_json=excluded.applicable_platforms_json",
                params![
                    capability.agent_client_id,
                    capability.directory_node_id,
                    recognition_code(capability.recognition),
                    precedence_code(&capability.precedence),
                    capability.evidence_reference,
                    capability.researched_at,
                    platforms,
                ],
            )
            .map(|_| ())
            .map_err(database_error)
    }

    pub fn list_capabilities(&self) -> AppResult<Vec<AgentDirectoryCapabilityFact>> {
        let mut statement = self
            .database
            .connection
            .prepare(
                "SELECT agent_client_id, directory_node_id, recognition, precedence, evidence_reference, researched_at, applicable_platforms_json
                 FROM agent_directory_capabilities ORDER BY agent_client_id, directory_node_id",
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
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(database_error)?;
        rows.map(|row| {
            let row = row.map_err(database_error)?;
            decode_capability(row).ok_or_else(invalid_record)
        })
        .collect()
    }

    pub fn upsert_deployment_relation(&self, relation: &DeploymentRelationFact) -> AppResult<()> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        upsert_deployment_relation_tx(&transaction, relation)?;
        transaction.commit().map_err(database_error)
    }

    fn list_deployment_relations(&self) -> AppResult<Vec<DeploymentRelationFact>> {
        let mut statement = self
            .database
            .connection
            .prepare(DEPLOYMENT_SELECT)
            .map_err(database_error)?;
        let rows = statement
            .query_map([], deployment_row)
            .map_err(database_error)?;
        rows.map(|row| decode_deployment(row.map_err(database_error)?).ok_or_else(invalid_record))
            .collect()
    }

    pub fn list_relations(&self) -> AppResult<Vec<DeploymentRelationFact>> {
        self.list_deployment_relations()
    }

    /// Returns all deterministic facts that can be affected by a relationship
    /// subject, including shared-directory consumers and their source facts.
    pub fn list_relation_impact(&self, subject_id: &str) -> AppResult<RelationshipImpactSnapshot> {
        let all_deployments = self.list_deployment_relations()?;
        let all_sources = self.list_source_relations()?;
        let all_capabilities = self.list_capabilities()?;
        let all_nodes = self.database.directory_repository().list_nodes()?;

        let direct_deployments = all_deployments.iter().filter(|relation| {
            relation.skill_id.map(|id| id.to_string()).as_deref() == Some(subject_id)
                || relation.directory_node_id.as_deref() == Some(subject_id)
                || relation.agent_client_id == subject_id
                || relation.relation_id == subject_id
                || relation.path_key == subject_id
        });
        let direct_sources = all_sources.iter().filter(|relation| {
            relation.skill_id.to_string() == subject_id
                || relation.directory_node_id.as_deref() == Some(subject_id)
                || relation.agent_client_id.as_deref() == Some(subject_id)
                || relation.provenance_id == subject_id
                || relation.source_path_key == subject_id
        });

        let mut skills = BTreeSet::new();
        let mut agents = BTreeSet::new();
        let mut directories = BTreeSet::new();
        for relation in direct_deployments {
            if let Some(skill_id) = relation.skill_id {
                skills.insert(skill_id.to_string());
            }
            agents.insert(relation.agent_client_id.clone());
            if let Some(directory_id) = &relation.directory_node_id {
                directories.insert(directory_id.clone());
            }
        }
        for relation in direct_sources {
            skills.insert(relation.skill_id.to_string());
            if let Some(agent) = &relation.agent_client_id {
                agents.insert(agent.clone());
            }
            if let Some(directory_id) = &relation.directory_node_id {
                directories.insert(directory_id.clone());
            }
        }
        if all_capabilities
            .iter()
            .any(|capability| capability.agent_client_id == subject_id)
        {
            agents.insert(subject_id.to_owned());
        }
        if all_nodes.iter().any(|node| node.node_id == subject_id) {
            directories.insert(subject_id.to_owned());
        }

        let deployments = all_deployments
            .into_iter()
            .filter(|relation| {
                relation
                    .skill_id
                    .map(|id| skills.contains(&id.to_string()))
                    .unwrap_or(false)
                    || agents.contains(&relation.agent_client_id)
                    || relation
                        .directory_node_id
                        .as_ref()
                        .map(|id| directories.contains(id))
                        .unwrap_or(false)
                    || relation.relation_id == subject_id
                    || relation.path_key == subject_id
            })
            .collect();
        let source_relations = all_sources
            .into_iter()
            .filter(|relation| {
                skills.contains(&relation.skill_id.to_string())
                    || relation
                        .agent_client_id
                        .as_ref()
                        .map(|agent| agents.contains(agent))
                        .unwrap_or(false)
                    || relation
                        .directory_node_id
                        .as_ref()
                        .map(|id| directories.contains(id))
                        .unwrap_or(false)
                    || relation.provenance_id == subject_id
                    || relation.source_path_key == subject_id
            })
            .collect();
        let directory_capabilities = all_capabilities
            .into_iter()
            .filter(|capability| {
                agents.contains(&capability.agent_client_id)
                    || directories.contains(&capability.directory_node_id)
            })
            .collect::<Vec<_>>();
        let capability_directory_ids = directory_capabilities
            .iter()
            .map(|capability| capability.directory_node_id.as_str())
            .collect::<BTreeSet<_>>();
        let directory_nodes = all_nodes
            .into_iter()
            .filter(|node| {
                directories.contains(&node.node_id)
                    || capability_directory_ids.contains(node.node_id.as_str())
            })
            .collect();

        Ok(RelationshipImpactSnapshot {
            deployments,
            source_relations,
            directory_capabilities,
            directory_nodes,
        })
    }

    pub fn upsert_source_relation(&self, relation: &SourceRelationFact) -> AppResult<()> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        upsert_source_relation_tx(&transaction, relation)?;
        transaction.commit().map_err(database_error)
    }

    pub fn list_source_relations(&self) -> AppResult<Vec<SourceRelationFact>> {
        let mut statement = self
            .database
            .connection
            .prepare(SOURCE_SELECT)
            .map_err(database_error)?;
        let rows = statement
            .query_map([], source_row)
            .map_err(database_error)?;
        rows.map(|row| decode_source(row.map_err(database_error)?).ok_or_else(invalid_record))
            .collect()
    }

    pub fn list_source_relations_for_skill(
        &self,
        skill_id: SkillId,
    ) -> AppResult<Vec<SourceRelationFact>> {
        Ok(self
            .list_source_relations()?
            .into_iter()
            .filter(|relation| relation.skill_id == skill_id)
            .collect())
    }

    pub(crate) fn sync_managed_deployment_tx(
        &self,
        transaction: &Transaction<'_>,
        deployment: &DeploymentRecord,
    ) -> AppResult<()> {
        let target = transaction
            .query_row(
                "SELECT agent_id, path FROM targets WHERE id=?1",
                [deployment.target_id.as_str()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(database_error)?;
        let Some((agent_client_id, target_path)) = target else {
            return Ok(());
        };
        let (relationship, representation) = match deployment.mode {
            DeploymentMode::SymbolicLink => (
                RelationshipType::ManagedLink,
                FileRepresentation::SymbolicLink,
            ),
            DeploymentMode::DirectoryJunction => (
                RelationshipType::ManagedLink,
                FileRepresentation::DirectoryJunction,
            ),
            DeploymentMode::ManagedCopy => {
                (RelationshipType::ManagedCopy, FileRepresentation::Copy)
            }
        };
        let path = deployment_entry_path(&target_path, &deployment.runtime_name);
        upsert_deployment_relation_tx(
            transaction,
            &DeploymentRelationFact {
                relation_id: format!("managed:{}", deployment.id),
                skill_id: Some(deployment.skill_id),
                agent_client_id,
                path,
                path_key: String::new(),
                directory_node_id: None,
                relationship,
                file_representation: representation,
                ownership: if deployment.managed {
                    OwnershipState::SkillhubManaged
                } else {
                    OwnershipState::ObservedUnmanaged
                },
                link_target_path: None,
                link_target_path_key: None,
                link_target_directory_id: None,
                content_fingerprint: deployment.expected_hash.clone(),
                origin: ObservedOrigin::Import,
                match_state: ObservedMatchState::ContentVerified,
                active: matches!(deployment.state, DeploymentState::Deployed),
                observed_at: now(),
                released_at: None,
            },
        )
    }

    pub(crate) fn mark_managed_deployment_removed_tx(
        &self,
        transaction: &Transaction<'_>,
        id: &str,
        at: i64,
    ) -> AppResult<()> {
        transaction
            .execute(
                "UPDATE deployment_relations SET active=0, released_at=?1 WHERE relation_id=?2",
                params![at, format!("managed:{id}")],
            )
            .map(|_| ())
            .map_err(database_error)
    }

    pub(crate) fn detach_managed_deployment_tx(
        &self,
        transaction: &Transaction<'_>,
        id: &str,
    ) -> AppResult<()> {
        transaction
            .execute(
                "UPDATE deployment_relations SET ownership='observed_unmanaged' WHERE relation_id=?1",
                [format!("managed:{id}")],
            )
            .map(|_| ())
            .map_err(database_error)
    }
}

pub(crate) fn deployment_entry_path(target_path: &str, runtime_name: &str) -> String {
    if runtime_name.is_empty() {
        target_path.to_owned()
    } else {
        let separator = if cfg!(windows) || target_path.contains('\\') {
            '\\'
        } else {
            '/'
        };
        format!(
            "{}{}{}",
            target_path.trim_end_matches(['/', '\\']),
            separator,
            runtime_name.trim_start_matches(['/', '\\'])
        )
    }
}

fn directory_node_id_for_path_tx(
    transaction: &Transaction<'_>,
    path: &str,
) -> AppResult<Option<String>> {
    let candidate = comparable_path(path);
    let mut statement = transaction
        .prepare("SELECT node_id, path FROM directory_nodes")
        .map_err(database_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(database_error)?;
    let mut best: Option<(usize, String)> = None;
    for row in rows {
        let (node_id, node_path) = row.map_err(database_error)?;
        let root = comparable_path(&node_path);
        let is_match = candidate == root
            || candidate
                .strip_prefix(root.trim_end_matches('/'))
                .is_some_and(|rest| rest.starts_with('/'));
        if is_match && best.as_ref().is_none_or(|current| root.len() > current.0) {
            best = Some((root.len(), node_id));
        }
    }
    Ok(best.map(|(_, node_id)| node_id))
}

fn comparable_path(path: &str) -> String {
    observed_path_key(&path.replace('\\', "/"))
}

pub(crate) fn upsert_deployment_relation_tx(
    transaction: &Transaction<'_>,
    relation: &DeploymentRelationFact,
) -> AppResult<()> {
    let path_key = observed_path_key(&relation.path);
    let link_target_path_key = relation.link_target_path.as_deref().map(observed_path_key);
    let directory_node_id = directory_node_id_for_path_tx(transaction, &relation.path)?;
    transaction
        .execute(
            "INSERT INTO deployment_relations
             (relation_id, skill_id, agent_client_id, path, path_key, directory_node_id,
              relationship, file_representation, ownership, link_target_path,
              link_target_path_key, link_target_directory_id, content_fingerprint,
              origin, match_state, active, observed_at, released_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
             ON CONFLICT(agent_client_id, path_key) DO UPDATE SET
             relation_id=excluded.relation_id, skill_id=excluded.skill_id, path=excluded.path,
             directory_node_id=excluded.directory_node_id, relationship=excluded.relationship,
             file_representation=excluded.file_representation, ownership=excluded.ownership,
             link_target_path=excluded.link_target_path, link_target_path_key=excluded.link_target_path_key,
             link_target_directory_id=excluded.link_target_directory_id,
             content_fingerprint=excluded.content_fingerprint, origin=excluded.origin,
             match_state=excluded.match_state, active=excluded.active,
             observed_at=excluded.observed_at, released_at=excluded.released_at
             WHERE excluded.ownership='skillhub_managed'
                OR deployment_relations.ownership<>'skillhub_managed'",
            params![
                relation.relation_id,
                relation.skill_id.map(|id| id.to_string()),
                relation.agent_client_id,
                relation.path,
                path_key,
                directory_node_id,
                relationship_code(relation.relationship),
                representation_code(relation.file_representation),
                ownership_code(relation.ownership),
                relation.link_target_path,
                link_target_path_key,
                relation.link_target_directory_id,
                relation.content_fingerprint,
                origin_code(relation.origin),
                match_state_code(relation.match_state),
                i64::from(relation.active),
                relation.observed_at,
                relation.released_at,
            ],
    )
        .map(|_| ())
        .map_err(database_error)
}

pub(crate) fn sync_reconciled_deployment_tx(
    transaction: &Transaction<'_>,
    id: &str,
    expected_hash: &str,
    observed_hash: Option<&str>,
    observed_at: i64,
) -> AppResult<()> {
    let (content_fingerprint, match_state) = match observed_hash {
        Some(hash) if hash != expected_hash => (hash, "diverged"),
        Some(hash) => (hash, "content_verified"),
        None => (expected_hash, "content_verified"),
    };
    transaction
        .execute(
            "UPDATE deployment_relations
             SET content_fingerprint=?1, match_state=?2, active=1,
                 observed_at=?3, released_at=NULL
             WHERE relation_id=?4 AND ownership='skillhub_managed'",
            params![
                content_fingerprint,
                match_state,
                observed_at,
                format!("managed:{id}")
            ],
        )
        .map(|_| ())
        .map_err(database_error)
}

pub(crate) fn upsert_source_relation_tx(
    transaction: &Transaction<'_>,
    relation: &SourceRelationFact,
) -> AppResult<()> {
    let source_path_key = observed_path_key(&relation.source_path);
    let directory_node_id = directory_node_id_for_path_tx(transaction, &relation.source_path)?;
    transaction
        .execute(
            "INSERT INTO source_relations
             (provenance_id, skill_id, directory_node_id, agent_client_id, source_path,
              source_path_key, relationship, file_representation, ownership, link_target_path,
              link_target_directory_id, content_fingerprint, source_kind, source_locator, imported_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(provenance_id) DO UPDATE SET
             skill_id=excluded.skill_id, directory_node_id=excluded.directory_node_id,
             agent_client_id=excluded.agent_client_id, source_path=excluded.source_path,
             source_path_key=excluded.source_path_key, relationship=excluded.relationship,
             file_representation=excluded.file_representation, ownership=excluded.ownership,
             link_target_path=excluded.link_target_path, link_target_directory_id=excluded.link_target_directory_id,
             content_fingerprint=excluded.content_fingerprint, source_kind=excluded.source_kind,
             source_locator=excluded.source_locator, imported_at=excluded.imported_at",
            params![
                relation.provenance_id,
                relation.skill_id.to_string(),
                directory_node_id,
                relation.agent_client_id,
                relation.source_path,
                source_path_key,
                relationship_code(relation.relationship),
                representation_code(relation.file_representation),
                ownership_code(relation.ownership),
                relation.link_target_path,
                relation.link_target_directory_id,
                relation.content_fingerprint,
                source_kind_code(&relation.source.kind),
                source_locator_text(&relation.source.locator),
                relation.imported_at,
            ],
        )
        .map(|_| ())
        .map_err(database_error)
}

pub struct ConflictRepository<'a> {
    database: &'a Database,
}

impl<'a> ConflictRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn create_case(&self, case: &ConflictCaseFact) -> AppResult<()> {
        let member_skill_ids = serde_json::to_string(&case.member_skill_ids)
            .map_err(|error| serialization_error(error.to_string()))?;
        let evidence = serde_json::to_string(&case.evidence)
            .map_err(|error| serialization_error(error.to_string()))?;
        let tx = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        tx.execute(
            "INSERT INTO conflict_cases (conflict_id, kind, classification, member_skill_ids_json, evidence_json, user_decision, decided_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(conflict_id) DO UPDATE SET kind=excluded.kind, classification=excluded.classification,
             member_skill_ids_json=excluded.member_skill_ids_json, evidence_json=excluded.evidence_json,
             user_decision=excluded.user_decision, decided_at=excluded.decided_at",
            params![
                case.conflict_id,
                conflict_kind_code(case.kind),
                conflict_classification_code(case.classification),
                member_skill_ids,
                evidence,
                case.user_decision.map(conflict_classification_code),
                case.decided_at,
            ],
        ).map_err(database_error)?;
        tx.execute(
            "DELETE FROM conflict_case_members WHERE conflict_id=?1",
            [&case.conflict_id],
        )
        .map_err(database_error)?;
        for (index, member) in case.members.iter().enumerate() {
            tx.execute(
                "INSERT INTO conflict_case_members (member_id, conflict_id, skill_id, version_id, provenance_id, directory_node_id, path, fingerprint)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    format!("{}:{index}", case.conflict_id),
                    case.conflict_id,
                    member.skill_id.map(|id| id.to_string()),
                    member.version_id.as_ref().map(ToString::to_string),
                    member.provenance_id,
                    member.directory_node_id,
                    member.path,
                    member.fingerprint,
                ],
            ).map_err(database_error)?;
        }
        tx.commit().map_err(database_error)
    }

    pub fn list_cases(&self) -> AppResult<Vec<ConflictCaseFact>> {
        let mut statement = self
            .database
            .connection
            .prepare(
                "SELECT conflict_id, kind, classification, member_skill_ids_json, evidence_json, user_decision, decided_at
                 FROM conflict_cases ORDER BY conflict_id",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                ))
            })
            .map_err(database_error)?;
        rows.map(|row| {
            let row = row.map_err(database_error)?;
            self.decode_case(row)
        })
        .collect()
    }

    pub fn record_decision(
        &self,
        conflict_id: &str,
        decision: ConflictClassification,
        decided_at: i64,
    ) -> AppResult<()> {
        let changed = self
            .database
            .connection
            .execute(
                "UPDATE conflict_cases SET classification=?1, user_decision=?1, decided_at=?2 WHERE conflict_id=?3",
                params![conflict_classification_code(decision), decided_at, conflict_id],
            )
            .map_err(database_error)?;
        if changed == 0 {
            return Err(not_found("conflict_case"));
        }
        Ok(())
    }

    fn decode_case(&self, row: StoredCase) -> AppResult<ConflictCaseFact> {
        let member_skill_ids: Vec<SkillId> =
            serde_json::from_str(&row.3).map_err(|_| invalid_record())?;
        let evidence: ConflictEvidence =
            serde_json::from_str(&row.4).map_err(|_| invalid_record())?;
        let mut members_statement = self
            .database
            .connection
            .prepare(
                "SELECT skill_id, version_id, provenance_id, directory_node_id, path, fingerprint
                 FROM conflict_case_members WHERE conflict_id=?1 ORDER BY member_id",
            )
            .map_err(database_error)?;
        let members = members_statement
            .query_map([&row.0], |member| {
                Ok((
                    member.get::<_, Option<String>>(0)?,
                    member.get::<_, Option<String>>(1)?,
                    member.get::<_, Option<String>>(2)?,
                    member.get::<_, Option<String>>(3)?,
                    member.get::<_, Option<String>>(4)?,
                    member.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(database_error)?
            .map(decode_member)
            .collect::<AppResult<Vec<_>>>()?;
        Ok(ConflictCaseFact {
            conflict_id: row.0,
            kind: parse_conflict_kind(&row.1).ok_or_else(invalid_record)?,
            classification: parse_conflict_classification(&row.2).ok_or_else(invalid_record)?,
            member_skill_ids,
            members,
            evidence,
            user_decision: row
                .5
                .as_deref()
                .map(|value| parse_conflict_classification(value).ok_or_else(invalid_record))
                .transpose()?,
            decided_at: row.6,
        })
    }
}

pub struct GovernanceTaskRepository<'a> {
    database: &'a Database,
}

impl<'a> GovernanceTaskRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn create(&self, task: &GovernanceTaskFact) -> AppResult<()> {
        self.database
            .connection
            .execute(
                "INSERT INTO governance_tasks (task_id, kind, subject_id, detail, resolved, created_at, resolved_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(task_id) DO UPDATE SET kind=excluded.kind, subject_id=excluded.subject_id,
                 detail=excluded.detail, resolved=excluded.resolved, created_at=excluded.created_at,
                 resolved_at=excluded.resolved_at",
                params![
                    task.task_id,
                    governance_task_kind_code(task.kind),
                    task.subject_id,
                    task.detail,
                    i64::from(task.resolved),
                    task.created_at,
                    task.resolved_at,
                ],
            )
            .map(|_| ())
            .map_err(database_error)
    }

    pub fn list_pending(&self) -> AppResult<Vec<GovernanceTaskFact>> {
        let mut statement = self
            .database
            .connection
            .prepare(
                "SELECT task_id, kind, subject_id, detail, resolved, created_at, resolved_at
                 FROM governance_tasks WHERE resolved=0 ORDER BY created_at, task_id",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                ))
            })
            .map_err(database_error)?;
        rows.map(|row| decode_task(row.map_err(database_error)?).ok_or_else(invalid_record))
            .collect()
    }

    pub fn resolve(&self, task_id: &str, resolved_at: i64) -> AppResult<()> {
        let changed = self
            .database
            .connection
            .execute(
                "UPDATE governance_tasks SET resolved=1, resolved_at=?1 WHERE task_id=?2",
                params![resolved_at, task_id],
            )
            .map_err(database_error)?;
        if changed == 0 {
            return Err(not_found("governance_task"));
        }
        Ok(())
    }
}

const DEPLOYMENT_SELECT: &str =
    "SELECT relation_id, skill_id, agent_client_id, path, path_key, directory_node_id,
     relationship, file_representation, ownership, link_target_path, link_target_path_key,
     link_target_directory_id, content_fingerprint, origin, match_state, active, observed_at, released_at
     FROM deployment_relations";

const SOURCE_SELECT: &str =
    "SELECT provenance_id, skill_id, directory_node_id, agent_client_id, source_path,
     source_path_key, relationship, file_representation, ownership, link_target_path,
     link_target_directory_id, content_fingerprint, source_kind, source_locator, imported_at
     FROM source_relations ORDER BY imported_at, provenance_id";

type StoredCapability = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
);

type StoredDeployment = (
    String,
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    i64,
    i64,
    Option<i64>,
);

type StoredSource = (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    i64,
);

type StoredCase = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<i64>,
);

type StoredMember = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn deployment_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredDeployment> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
        row.get(12)?,
        row.get(13)?,
        row.get(14)?,
        row.get(15)?,
        row.get(16)?,
        row.get(17)?,
    ))
}

fn source_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredSource> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
        row.get(12)?,
        row.get(13)?,
        row.get(14)?,
    ))
}

fn decode_capability(row: StoredCapability) -> Option<AgentDirectoryCapabilityFact> {
    Some(AgentDirectoryCapabilityFact {
        agent_client_id: row.0,
        directory_node_id: row.1,
        recognition: parse_recognition(&row.2)?,
        precedence: parse_precedence(&row.3)?,
        evidence_reference: row.4,
        researched_at: row.5,
        applicable_platforms: serde_json::from_str(&row.6).ok()?,
    })
}

fn decode_deployment(row: StoredDeployment) -> Option<DeploymentRelationFact> {
    Some(DeploymentRelationFact {
        relation_id: row.0,
        skill_id: row.1.and_then(|value| value.parse().ok()),
        agent_client_id: row.2,
        path: row.3,
        path_key: row.4,
        directory_node_id: row.5,
        relationship: parse_relationship(&row.6)?,
        file_representation: parse_representation(&row.7)?,
        ownership: parse_ownership(&row.8)?,
        link_target_path: row.9,
        link_target_path_key: row.10,
        link_target_directory_id: row.11,
        content_fingerprint: row.12,
        origin: parse_origin(&row.13)?,
        match_state: parse_match_state(&row.14)?,
        active: row.15 != 0,
        observed_at: row.16,
        released_at: row.17,
    })
}

fn decode_source(row: StoredSource) -> Option<SourceRelationFact> {
    let source_kind = parse_source_kind(&row.12)?;
    let source_locator = match source_kind {
        SourceKind::Local => SourceLocator::local_path(row.13.clone()),
        SourceKind::Https => SourceLocator::https_url(row.13.clone()),
        SourceKind::Git => SourceLocator::git_url(row.13.clone()),
    };
    Some(SourceRelationFact {
        provenance_id: row.0,
        skill_id: row.1.parse().ok()?,
        directory_node_id: row.2,
        agent_client_id: row.3,
        source_path: row.4,
        source_path_key: row.5,
        relationship: parse_relationship(&row.6)?,
        file_representation: parse_representation(&row.7)?,
        ownership: parse_ownership(&row.8)?,
        link_target_path: row.9,
        link_target_directory_id: row.10,
        content_fingerprint: row.11,
        source: SourceDescriptor::new(source_kind, source_locator),
        imported_at: row.14,
    })
}

fn decode_member(row: rusqlite::Result<StoredMember>) -> AppResult<ConflictMemberFact> {
    let row = row.map_err(database_error)?;
    Ok(ConflictMemberFact {
        skill_id: row
            .0
            .map(|value| value.parse())
            .transpose()
            .map_err(|_| invalid_record())?,
        version_id: row
            .1
            .map(|value| value.parse())
            .transpose()
            .map_err(|_| invalid_record())?,
        provenance_id: row.2,
        directory_node_id: row.3,
        path: row.4,
        fingerprint: row.5,
    })
}

fn decode_task(
    row: (String, String, String, String, i64, i64, Option<i64>),
) -> Option<GovernanceTaskFact> {
    Some(GovernanceTaskFact {
        task_id: row.0,
        kind: parse_governance_task_kind(&row.1)?,
        subject_id: row.2,
        detail: row.3,
        resolved: row.4 != 0,
        created_at: row.5,
        resolved_at: row.6,
    })
}

fn recognition_code(value: DirectoryRecognition) -> &'static str {
    match value {
        DirectoryRecognition::Supported => "supported",
        DirectoryRecognition::Unknown => "unknown",
        DirectoryRecognition::Unsupported => "unsupported",
    }
}

fn parse_recognition(value: &str) -> Option<DirectoryRecognition> {
    match value {
        "supported" => Some(DirectoryRecognition::Supported),
        "unknown" => Some(DirectoryRecognition::Unknown),
        "unsupported" => Some(DirectoryRecognition::Unsupported),
        _ => None,
    }
}

fn precedence_code(value: &DirectoryPrecedence) -> &'static str {
    match value {
        DirectoryPrecedence::Preferred => "preferred",
        DirectoryPrecedence::LowerPriorityCopy => "lower_priority_copy",
        DirectoryPrecedence::MayCoexist => "may_coexist",
        DirectoryPrecedence::Unknown => "unknown",
    }
}

fn parse_precedence(value: &str) -> Option<DirectoryPrecedence> {
    match value {
        "preferred" => Some(DirectoryPrecedence::Preferred),
        "lower_priority_copy" => Some(DirectoryPrecedence::LowerPriorityCopy),
        "may_coexist" => Some(DirectoryPrecedence::MayCoexist),
        "unknown" => Some(DirectoryPrecedence::Unknown),
        _ => None,
    }
}

fn relationship_code(value: RelationshipType) -> &'static str {
    match value {
        RelationshipType::ImportCopy => "import_copy",
        RelationshipType::SharedDirectoryRead => "shared_directory_read",
        RelationshipType::SharedDirectoryReference => "shared_directory_reference",
        RelationshipType::ManagedCopy => "managed_copy",
        RelationshipType::ManagedLink => "managed_link",
        RelationshipType::ObservedCopy => "observed_copy",
        RelationshipType::ObservedLink => "observed_link",
        RelationshipType::Unknown => "unknown",
    }
}

fn parse_relationship(value: &str) -> Option<RelationshipType> {
    match value {
        "import_copy" => Some(RelationshipType::ImportCopy),
        "shared_directory_read" => Some(RelationshipType::SharedDirectoryRead),
        "shared_directory_reference" => Some(RelationshipType::SharedDirectoryReference),
        "managed_copy" => Some(RelationshipType::ManagedCopy),
        "managed_link" => Some(RelationshipType::ManagedLink),
        "observed_copy" => Some(RelationshipType::ObservedCopy),
        "observed_link" => Some(RelationshipType::ObservedLink),
        "unknown" => Some(RelationshipType::Unknown),
        _ => None,
    }
}

fn representation_code(value: FileRepresentation) -> &'static str {
    match value {
        FileRepresentation::Directory => "directory",
        FileRepresentation::SymbolicLink => "symbolic_link",
        FileRepresentation::DirectoryJunction => "directory_junction",
        FileRepresentation::Copy => "copy",
        FileRepresentation::Unknown => "unknown",
    }
}

fn parse_representation(value: &str) -> Option<FileRepresentation> {
    match value {
        "directory" => Some(FileRepresentation::Directory),
        "symbolic_link" => Some(FileRepresentation::SymbolicLink),
        "directory_junction" => Some(FileRepresentation::DirectoryJunction),
        "copy" => Some(FileRepresentation::Copy),
        "unknown" => Some(FileRepresentation::Unknown),
        _ => None,
    }
}

fn ownership_code(value: OwnershipState) -> &'static str {
    match value {
        OwnershipState::SkillhubManaged => "skillhub_managed",
        OwnershipState::ObservedUnmanaged => "observed_unmanaged",
        OwnershipState::SharedReference => "shared_reference",
    }
}

fn parse_ownership(value: &str) -> Option<OwnershipState> {
    match value {
        "skillhub_managed" => Some(OwnershipState::SkillhubManaged),
        "observed_unmanaged" => Some(OwnershipState::ObservedUnmanaged),
        "shared_reference" => Some(OwnershipState::SharedReference),
        _ => None,
    }
}

fn source_kind_code(value: &SourceKind) -> &'static str {
    match value {
        SourceKind::Local => "local",
        SourceKind::Https => "https",
        SourceKind::Git => "git",
    }
}

fn parse_source_kind(value: &str) -> Option<SourceKind> {
    match value {
        "local" => Some(SourceKind::Local),
        "https" => Some(SourceKind::Https),
        "git" => Some(SourceKind::Git),
        _ => None,
    }
}

fn source_locator_text(locator: &SourceLocator) -> String {
    match locator {
        SourceLocator::LocalPath(path) => path.to_string_lossy().into_owned(),
        SourceLocator::HttpsUrl(url) | SourceLocator::GitUrl(url) => url.clone(),
    }
}

fn origin_code(value: ObservedOrigin) -> &'static str {
    match value {
        ObservedOrigin::Scan => "scan",
        ObservedOrigin::Import => "import",
    }
}

fn parse_origin(value: &str) -> Option<ObservedOrigin> {
    match value {
        "scan" => Some(ObservedOrigin::Scan),
        "import" => Some(ObservedOrigin::Import),
        _ => None,
    }
}

fn match_state_code(value: ObservedMatchState) -> &'static str {
    match value {
        ObservedMatchState::ContentVerified => "content_verified",
        ObservedMatchState::NameOnly => "name_only",
        ObservedMatchState::Diverged => "diverged",
    }
}

fn parse_match_state(value: &str) -> Option<ObservedMatchState> {
    match value {
        "content_verified" => Some(ObservedMatchState::ContentVerified),
        "name_only" => Some(ObservedMatchState::NameOnly),
        "diverged" => Some(ObservedMatchState::Diverged),
        _ => None,
    }
}

fn conflict_kind_code(value: ConflictKind) -> &'static str {
    match value {
        ConflictKind::Unknown => "unknown",
        ConflictKind::DuplicateSameContent => "duplicate_same_content",
        ConflictKind::SameNameDifferentContent => "same_name_different_content",
        ConflictKind::SameSourceFork => "same_source_fork",
        ConflictKind::SharedDirectoryDuplicate => "shared_directory_duplicate",
        ConflictKind::UnknownDirectoryRecognition => "unknown_directory_recognition",
    }
}

fn parse_conflict_kind(value: &str) -> Option<ConflictKind> {
    match value {
        "unknown" => Some(ConflictKind::Unknown),
        "duplicate_same_content" => Some(ConflictKind::DuplicateSameContent),
        "same_name_different_content" => Some(ConflictKind::SameNameDifferentContent),
        "same_source_fork" => Some(ConflictKind::SameSourceFork),
        "shared_directory_duplicate" => Some(ConflictKind::SharedDirectoryDuplicate),
        "unknown_directory_recognition" => Some(ConflictKind::UnknownDirectoryRecognition),
        _ => None,
    }
}

fn conflict_classification_code(value: ConflictClassification) -> &'static str {
    match value {
        ConflictClassification::SameSkillVersion => "same_skill_version",
        ConflictClassification::DistinctSkill => "distinct_skill",
        ConflictClassification::Uncertain => "uncertain",
    }
}

fn parse_conflict_classification(value: &str) -> Option<ConflictClassification> {
    match value {
        "same_skill_version" => Some(ConflictClassification::SameSkillVersion),
        "distinct_skill" => Some(ConflictClassification::DistinctSkill),
        "uncertain" => Some(ConflictClassification::Uncertain),
        _ => None,
    }
}

fn governance_task_kind_code(value: GovernanceTaskKind) -> &'static str {
    match value {
        GovernanceTaskKind::SelectAuthoritativeVersion => "select_authoritative_version",
        GovernanceTaskKind::ClassifySameNameSkill => "classify_same_name_skill",
        GovernanceTaskKind::ConfirmSharedDirectoryImpact => "confirm_shared_directory_impact",
        GovernanceTaskKind::ConvertCopyToManagedLink => "convert_copy_to_managed_link",
        GovernanceTaskKind::ConvertSharedReferenceToManagedLink => {
            "convert_shared_reference_to_managed_link"
        }
        GovernanceTaskKind::UnknownDirectoryRecognition => "unknown_directory_recognition",
        GovernanceTaskKind::OperationFailureRecovery => "operation_failure_recovery",
    }
}

fn parse_governance_task_kind(value: &str) -> Option<GovernanceTaskKind> {
    match value {
        "select_authoritative_version" => Some(GovernanceTaskKind::SelectAuthoritativeVersion),
        "classify_same_name_skill" => Some(GovernanceTaskKind::ClassifySameNameSkill),
        "confirm_shared_directory_impact" => Some(GovernanceTaskKind::ConfirmSharedDirectoryImpact),
        "convert_copy_to_managed_link" => Some(GovernanceTaskKind::ConvertCopyToManagedLink),
        "convert_shared_reference_to_managed_link" => {
            Some(GovernanceTaskKind::ConvertSharedReferenceToManagedLink)
        }
        "unknown_directory_recognition" => Some(GovernanceTaskKind::UnknownDirectoryRecognition),
        "operation_failure_recovery" => Some(GovernanceTaskKind::OperationFailureRecovery),
        _ => None,
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn invalid_record() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("reason", "relationship_record_corrupt")
        .with_action(RecoveryAction::Retry)
}

fn not_found(field: &'static str) -> AppError {
    AppError::new(ErrorCode::ObjectNotFound, Severity::Error).with_param("field", field)
}

fn serialization_error(source: String) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", source)
        .with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
