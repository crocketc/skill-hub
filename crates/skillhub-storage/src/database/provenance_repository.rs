use super::Database;
use rusqlite::{params, OptionalExtension};
use skillhub_core::deployment::observed_path_key;
use skillhub_core::deployment::{
    ObservedDeployment, ObservedMatchState, ObservedOrigin, ObservedRowAction, ObservedStatus,
};
use skillhub_core::import::{
    CandidateOwnership, ImportProvenance, OriginalMigrationResult, OriginalMigrationState,
};
use skillhub_core::relationship::{
    DeploymentRelationFact, FileRepresentation, OwnershipState, RelationshipType,
    SourceRelationFact,
};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{
    AppError, AppResult, ErrorCode, ObservedDeploymentId, OperationId, RecoveryAction, Severity,
    SkillId,
};

/// OPT-20260914-08 的持久化边界：导入存证、已观察部署关系与原始文件
/// 迁移审计。所有写入都是显式 upsert/状态迁移；同一路径重复导入或重复
/// 扫描不会产生重复行。
pub struct ProvenanceRepository<'a> {
    database: &'a Database,
}

impl<'a> ProvenanceRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    /// 导入即存证。0014 规范化关系表以独立 provenance ID 保存每次事实；
    /// 旧 import_provenance 表只继续承担最新兼容投影，确保既有调用不破坏。
    pub fn upsert_provenance(&self, provenance: &ImportProvenance) -> AppResult<()> {
        let relation = provenance.to_source_relation_fact();
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        super::relationship_repository::upsert_source_relation_tx(&transaction, &relation)?;
        transaction
            .execute(
                "INSERT INTO import_provenance \
                 (skill_id, agent_client_id, original_path, source_kind, source_locator, ownership, content_fingerprint, imported_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                 ON CONFLICT(skill_id) DO UPDATE SET \
                 agent_client_id=excluded.agent_client_id, original_path=excluded.original_path, \
                 source_kind=excluded.source_kind, source_locator=excluded.source_locator, \
                 ownership=excluded.ownership, content_fingerprint=excluded.content_fingerprint, \
                 imported_at=excluded.imported_at",
                params![
                    provenance.skill_id.to_string(),
                    provenance.agent_client_id,
                    provenance.original_path,
                    source_kind_code(&provenance.source.kind),
                    source_locator_text(&provenance.source.locator),
                    ownership_code(provenance.ownership),
                    provenance.content_fingerprint,
                    provenance.imported_at,
                ],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)
    }

    pub fn provenance_for_skill(&self, skill_id: SkillId) -> AppResult<Option<ImportProvenance>> {
        let row = self
            .database
            .connection
            .query_row(
                "SELECT skill_id, agent_client_id, original_path, source_kind, source_locator, ownership, content_fingerprint, imported_at \
                 FROM import_provenance WHERE skill_id=?1",
                [skill_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, i64>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?;
        if let Some(value) = row {
            return decode_provenance(value)
                .ok_or_else(invalid_record)
                .map(Some);
        }
        Ok(self
            .database
            .relationship_repository()
            .list_source_relations_for_skill(skill_id)?
            .into_iter()
            .last()
            .map(provenance_from_relation))
    }

    /// Returns immutable provenance facts in chronological order.  Re-imports
    /// with a different imported_at or source path remain separate rows.
    pub fn list_provenance_for_skill(&self, skill_id: SkillId) -> AppResult<Vec<ImportProvenance>> {
        Ok(self
            .database
            .relationship_repository()
            .list_source_relations_for_skill(skill_id)?
            .into_iter()
            .map(provenance_from_relation)
            .collect())
    }

    pub fn list_observed(&self) -> AppResult<Vec<ObservedDeployment>> {
        let mut statement = self
            .database
            .connection
            .prepare(
                "SELECT id, skill_id, client_id, original_path, content_fingerprint, match_state, origin, status, observed_at, released_at \
                 FROM observed_deployments ORDER BY original_path, id",
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
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                ))
            })
            .map_err(database_error)?;
        rows.map(|row| {
            let value = row.map_err(database_error)?;
            decode_observed(value).ok_or_else(invalid_record)
        })
        .collect()
    }

    pub fn list_observed_for_skill(&self, skill_id: SkillId) -> AppResult<Vec<ObservedDeployment>> {
        Ok(self
            .list_observed()?
            .into_iter()
            .filter(|row| row.skill_id == skill_id)
            .collect())
    }

    /// 按纯判定结果落库。`observed_at` 是本次观察时间；Release 用它作为
    /// 收回时间。`origin` 记录这条关系由扫描比对还是导入存证建立。路径键
    /// 在写入时计算（Windows 形态折叠、POSIX 精确）。
    pub fn apply_observed_row_action(
        &self,
        client_id: &str,
        original_path: &str,
        action: &ObservedRowAction,
        origin: ObservedOrigin,
        observed_at: i64,
    ) -> AppResult<()> {
        let origin_code = match origin {
            ObservedOrigin::Scan => "scan",
            ObservedOrigin::Import => "import",
        };
        match action {
            ObservedRowAction::Unchanged => Ok(()),
            ObservedRowAction::EstablishVerified {
                skill_id,
                fingerprint,
            } => {
                let id = ObservedDeploymentId::new().to_string();
                let transaction = self
                    .database
                    .connection
                    .unchecked_transaction()
                    .map_err(database_error)?;
                transaction
                    .execute(
                        "INSERT INTO observed_deployments \
                         (id, skill_id, client_id, original_path, path_key, content_fingerprint, match_state, origin, status, observed_at, released_at) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'content_verified', ?7, 'active', ?8, NULL) \
                         ON CONFLICT(path_key) DO UPDATE SET \
                         skill_id=excluded.skill_id, client_id=excluded.client_id, \
                         content_fingerprint=excluded.content_fingerprint, match_state='content_verified', \
                         status='active', observed_at=excluded.observed_at, released_at=NULL",
                        params![
                            id.clone(),
                            skill_id.to_string(),
                            client_id,
                            original_path,
                            observed_path_key(original_path),
                            fingerprint,
                            origin_code,
                            observed_at,
                        ],
                    )
                    .map_err(database_error)?;
                let relation_id: String = transaction
                    .query_row(
                        "SELECT id FROM observed_deployments WHERE path_key=?1",
                        [observed_path_key(original_path)],
                        |row| row.get(0),
                    )
                    .map_err(database_error)?;
                super::relationship_repository::upsert_deployment_relation_tx(
                    &transaction,
                    &DeploymentRelationFact {
                        relation_id,
                        skill_id: Some(*skill_id),
                        agent_client_id: client_id.to_owned(),
                        path: original_path.to_owned(),
                        path_key: String::new(),
                        directory_node_id: None,
                        relationship: RelationshipType::Unknown,
                        file_representation: FileRepresentation::Unknown,
                        ownership: OwnershipState::ObservedUnmanaged,
                        link_target_path: None,
                        link_target_path_key: None,
                        link_target_directory_id: None,
                        content_fingerprint: fingerprint.clone(),
                        origin,
                        match_state: ObservedMatchState::ContentVerified,
                        active: true,
                        observed_at,
                        released_at: None,
                    },
                )?;
                transaction.commit().map_err(database_error)
            }
            ObservedRowAction::MarkUnreliable {
                match_state,
                fingerprint,
            } => {
                let transaction = self
                    .database
                    .connection
                    .unchecked_transaction()
                    .map_err(database_error)?;
                transaction
                    .execute(
                    "UPDATE observed_deployments SET match_state=?1, content_fingerprint=?2, observed_at=?3 \
                     WHERE path_key=?4 AND status='active'",
                    params![
                        match_state_code(*match_state),
                        fingerprint,
                        observed_at,
                        observed_path_key(original_path),
                    ],
                    )
                    .map_err(database_error)?;
                transaction
                        .execute(
                        "UPDATE deployment_relations SET skill_id=NULL, content_fingerprint=?1, match_state=?2, active=1, observed_at=?3, released_at=NULL WHERE agent_client_id=?4 AND path_key=?5 AND ownership<>'skillhub_managed'",
                        params![
                            fingerprint,
                            match_state_code(*match_state),
                            observed_at,
                            client_id,
                            observed_path_key(original_path),
                        ],
                    )
                    .map_err(database_error)?;
                transaction.commit().map_err(database_error)
            }
            ObservedRowAction::Release => {
                let transaction = self
                    .database
                    .connection
                    .unchecked_transaction()
                    .map_err(database_error)?;
                transaction
                    .execute(
                        "UPDATE observed_deployments SET status='released', released_at=?1 \
                     WHERE path_key=?2 AND status='active'",
                        params![observed_at, observed_path_key(original_path)],
                    )
                    .map_err(database_error)?;
                transaction
                        .execute(
                        "UPDATE deployment_relations SET active=0, released_at=?1 WHERE agent_client_id=?2 AND path_key=?3 AND active=1 AND ownership<>'skillhub_managed'",
                        params![observed_at, client_id, observed_path_key(original_path)],
                    )
                    .map_err(database_error)?;
                transaction.commit().map_err(database_error)
            }
        }
    }

    pub fn insert_original_migration(&self, result: &OriginalMigrationResult) -> AppResult<()> {
        self.database
            .connection
            .execute(
                "INSERT INTO original_migrations \
                 (id, skill_id, original_path, backup_path, content_fingerprint, state, confirmed_at, rolled_back_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    result.migration_id.to_string(),
                    result.skill_id.to_string(),
                    result.original_path,
                    result.backup_path,
                    result.content_fingerprint,
                    migration_state_code(result.state),
                    result.confirmed_at,
                    result.rolled_back_at,
                ],
            )
            .map(|_| ())
            .map_err(database_error)
    }

    /// 补偿性删除：仅用于"记录已写入但随后删除原目录失败"的中止路径，
    /// 让失败现场回到干净状态（原文件仍在、无迁移记录）。回滚不走这里，
    /// 回滚必须保留审计行。
    pub fn remove_original_migration(&self, migration_id: OperationId) -> AppResult<()> {
        self.database
            .connection
            .execute(
                "DELETE FROM original_migrations WHERE id=?1",
                [migration_id.to_string()],
            )
            .map(|_| ())
            .map_err(database_error)
    }

    pub fn original_migration(
        &self,
        migration_id: OperationId,
    ) -> AppResult<Option<OriginalMigrationResult>> {
        let row = self
            .database
            .connection
            .query_row(
                "SELECT id, skill_id, original_path, backup_path, content_fingerprint, state, confirmed_at, rolled_back_at \
                 FROM original_migrations WHERE id=?1",
                [migration_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?;
        row.map(|value| decode_migration(value).ok_or_else(invalid_record))
            .transpose()
    }

    /// 回滚后追加审计状态：备份保留、原路径恢复，标记 RolledBack。
    /// 记录本身永不删除（历史证据）。
    pub fn mark_original_migration_rolled_back(
        &self,
        migration_id: OperationId,
        rolled_back_at: i64,
    ) -> AppResult<()> {
        let changed = self
            .database
            .connection
            .execute(
                "UPDATE original_migrations SET state='rolled_back', rolled_back_at=?1 WHERE id=?2",
                params![rolled_back_at, migration_id.to_string()],
            )
            .map_err(database_error)?;
        if changed == 0 {
            return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("field", "original_migration"));
        }
        Ok(())
    }
}

type ProvenanceRow = (
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    String,
    i64,
);

fn decode_provenance(value: ProvenanceRow) -> Option<ImportProvenance> {
    let skill_id = value.0.parse().ok()?;
    let source_kind = match value.3.as_str() {
        "local" => SourceKind::Local,
        "https" => SourceKind::Https,
        "git" => SourceKind::Git,
        _ => return None,
    };
    let source_locator = match value.4.clone() {
        locator if value.3 == "local" => SourceLocator::local_path(locator),
        locator if value.3 == "https" => SourceLocator::https_url(locator),
        locator => SourceLocator::git_url(locator),
    };
    Some(ImportProvenance {
        skill_id,
        agent_client_id: value.1,
        original_path: value.2,
        source: SourceDescriptor::new(source_kind, source_locator),
        ownership: parse_ownership(&value.5)?,
        content_fingerprint: value.6,
        imported_at: value.7,
    })
}

fn provenance_from_relation(relation: SourceRelationFact) -> ImportProvenance {
    ImportProvenance {
        skill_id: relation.skill_id,
        agent_client_id: relation.agent_client_id,
        original_path: relation.source_path,
        source: relation.source,
        ownership: match relation.ownership {
            skillhub_core::relationship::OwnershipState::SkillhubManaged => {
                CandidateOwnership::CentralLibrary
            }
            skillhub_core::relationship::OwnershipState::ObservedUnmanaged
            | skillhub_core::relationship::OwnershipState::SharedReference => {
                CandidateOwnership::KnownAgentTarget
            }
        },
        content_fingerprint: relation.content_fingerprint,
        imported_at: relation.imported_at,
    }
}

fn parse_ownership(value: &str) -> Option<CandidateOwnership> {
    let ownership = match value {
        "unclassified" => CandidateOwnership::Unclassified,
        "central_library" => CandidateOwnership::CentralLibrary,
        "known_agent_target" => CandidateOwnership::KnownAgentTarget,
        "registered_project" => CandidateOwnership::RegisteredProject,
        "read_only_builtin_or_plugin" => CandidateOwnership::ReadOnlyBuiltinOrPlugin,
        "arbitrary_local_directory" => CandidateOwnership::ArbitraryLocalDirectory,
        "downloaded_source" => CandidateOwnership::DownloadedSource,
        _ => return None,
    };
    Some(ownership)
}

fn ownership_code(value: CandidateOwnership) -> &'static str {
    match value {
        CandidateOwnership::Unclassified => "unclassified",
        CandidateOwnership::CentralLibrary => "central_library",
        CandidateOwnership::KnownAgentTarget => "known_agent_target",
        CandidateOwnership::RegisteredProject => "registered_project",
        CandidateOwnership::ReadOnlyBuiltinOrPlugin => "read_only_builtin_or_plugin",
        CandidateOwnership::ArbitraryLocalDirectory => "arbitrary_local_directory",
        CandidateOwnership::DownloadedSource => "downloaded_source",
    }
}

fn source_kind_code(value: &SourceKind) -> &'static str {
    match value {
        SourceKind::Local => "local",
        SourceKind::Https => "https",
        SourceKind::Git => "git",
    }
}

fn source_locator_text(locator: &SourceLocator) -> String {
    match locator {
        SourceLocator::LocalPath(path) => path.to_string_lossy().into_owned(),
        SourceLocator::HttpsUrl(url) => url.clone(),
        SourceLocator::GitUrl(url) => url.clone(),
    }
}

type ObservedRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    Option<i64>,
);

#[allow(clippy::type_complexity)]
fn decode_observed(value: ObservedRow) -> Option<ObservedDeployment> {
    let match_state = match value.5.as_str() {
        "content_verified" => ObservedMatchState::ContentVerified,
        "name_only" => ObservedMatchState::NameOnly,
        "diverged" => ObservedMatchState::Diverged,
        _ => return None,
    };
    let origin = match value.6.as_str() {
        "scan" => ObservedOrigin::Scan,
        "import" => ObservedOrigin::Import,
        _ => return None,
    };
    let status = match value.7.as_str() {
        "active" => ObservedStatus::Active,
        "released" => ObservedStatus::Released,
        _ => return None,
    };
    Some(ObservedDeployment {
        id: value.0.parse().ok()?,
        skill_id: value.1.parse().ok()?,
        client_id: value.2,
        original_path: value.3,
        content_fingerprint: value.4,
        match_state,
        origin,
        status,
        observed_at: value.8,
        released_at: value.9,
    })
}

fn match_state_code(value: ObservedMatchState) -> &'static str {
    match value {
        ObservedMatchState::ContentVerified => "content_verified",
        ObservedMatchState::NameOnly => "name_only",
        ObservedMatchState::Diverged => "diverged",
    }
}

type MigrationRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    Option<i64>,
);

fn decode_migration(value: MigrationRow) -> Option<OriginalMigrationResult> {
    let state = match value.5.as_str() {
        "migrated" => OriginalMigrationState::Migrated,
        "rolled_back" => OriginalMigrationState::RolledBack,
        _ => return None,
    };
    Some(OriginalMigrationResult {
        migration_id: value.0.parse().ok()?,
        skill_id: value.1.parse().ok()?,
        original_path: value.2,
        backup_path: value.3,
        content_fingerprint: value.4,
        state,
        confirmed_at: value.6,
        rolled_back_at: value.7,
    })
}

fn migration_state_code(value: OriginalMigrationState) -> &'static str {
    match value {
        OriginalMigrationState::Migrated => "migrated",
        OriginalMigrationState::RolledBack => "rolled_back",
    }
}

fn invalid_record() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("reason", "provenance_record_corrupt")
        .with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("source", error.to_string())
}
