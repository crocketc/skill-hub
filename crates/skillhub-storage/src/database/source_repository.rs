use super::Database;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use skillhub_core::source::{
    IgnoredSourceUpdate, SourceDescriptor, SourceKind, SourceLocator, SourceRecord, SourceRole,
    SourceState, UpstreamCheckResult,
};
use skillhub_core::{AppError, AppResult, ErrorCode, Severity, SkillId};

/// Persistence boundary for a Skill's active source relation.
///
/// P1-05 角色语义：本地目录 relink = `local_only`；relink 到远端 URL 与
/// `record_upstream` 都是用户显式确认（导入向导提交/手动绑定），
/// 一律落为 `verified_upstream`。搜索候选永远不进入本仓库。
pub struct SourceRepository<'a> {
    database: &'a Database,
}

impl<'a> SourceRepository<'a> {
    pub fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn relink(&self, skill_id: SkillId, source: SourceDescriptor) -> AppResult<()> {
        let source_id = source_id(&source)?;
        let (kind, locator) = encode_source(&source)?;
        let role = role_for_kind(kind).to_string();
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(error)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO sources (id, kind, locator, role, created_at) VALUES (?1, ?2, ?3, ?4, strftime('%s','now'))",
                rusqlite::params![source_id, kind, locator, role],
            )
            .map_err(error)?;
        transaction
            .execute(
                "DELETE FROM skill_sources WHERE skill_id=?1",
                [skill_id.to_string()],
            )
            .map_err(error)?;
        transaction
            .execute(
                "INSERT INTO skill_sources (skill_id, source_id, relation) VALUES (?1, ?2, 'origin')",
                rusqlite::params![skill_id.to_string(), source_id],
            )
            .map_err(error)?;
        transaction.commit().map_err(error)
    }

    /// 将仓库导入的长期上游坐标写入 sources（kind=git，metadata_json 记 branch/directory）
    /// 并挂到 skill_sources（relation=origin）。幂等：重复导入同一来源不会产生重复行，
    /// 已存在的行只补写坐标元数据。与 relink 不同，这里不删除既有来源行。
    /// 角色固定为 verified_upstream（导入提交 = 用户已确认）。
    pub fn record_upstream(
        &self,
        skill_id: SkillId,
        upstream: &skillhub_core::UpstreamOrigin,
    ) -> AppResult<()> {
        let descriptor = SourceDescriptor::new(
            SourceKind::Git,
            SourceLocator::git_url(upstream.url.clone()),
        );
        let source_id = source_id(&descriptor)?;
        let metadata = serde_json::json!({
            "branch": upstream.branch,
            "directory": upstream.directory,
        });
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(error)?;
        transaction
            .execute(
                // 行可能已由 relink 建好（metadata='{}'）：冲突时补写坐标元数据，
                // 并把角色升级为 verified_upstream。
                "INSERT INTO sources (id, kind, locator, role, metadata_json, created_at) VALUES (?1, 'git', ?2, 'verified_upstream', ?3, strftime('%s','now')) ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json, role='verified_upstream'",
                rusqlite::params![source_id, upstream.url, metadata.to_string()],
            )
            .map_err(error)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO skill_sources (skill_id, source_id, relation) VALUES (?1, ?2, 'origin')",
                rusqlite::params![skill_id.to_string(), source_id],
            )
            .map_err(error)?;
        transaction.commit().map_err(error)
    }

    /// 读取 Skill 的长期上游坐标；无记录返回 None（本地导入）。
    /// 只认 verified_upstream 角色：候选/local_only 来源绝不参与更新检测。
    pub fn upstream_for_skill(
        &self,
        skill_id: SkillId,
    ) -> AppResult<Option<skillhub_core::UpstreamOrigin>> {
        let row: Option<(String, String)> = self
            .database
            .connection
            .query_row(
                "SELECT s.locator, s.metadata_json FROM sources s JOIN skill_sources ss ON ss.source_id=s.id WHERE ss.skill_id=?1 AND s.kind='git' AND s.role='verified_upstream' ORDER BY s.id ASC LIMIT 1",
                [skill_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(error)?;
        let Some((locator, metadata_json)) = row else {
            return Ok(None);
        };
        let metadata: serde_json::Value = serde_json::from_str(&metadata_json).map_err(|err| {
            AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("source", err.to_string())
        })?;
        let branch = metadata["branch"].as_str().unwrap_or_default().to_string();
        let directory = metadata["directory"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if branch.is_empty() || directory.is_empty() {
            // 只有 URL 没有 branch/directory 坐标（如手动 relink 的 git 来源）
            // 无法在远端定位 Skill 目录，视为无上游记录。
            return Ok(None);
        }
        Ok(Some(skillhub_core::UpstreamOrigin {
            url: locator,
            branch,
            directory,
        }))
    }

    /// Skill 来源的角色；无来源记录视为 local_only（诚实缺省）。
    pub fn role_for_skill(&self, skill_id: SkillId) -> AppResult<SourceRole> {
        let row: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT s.role FROM sources s JOIN skill_sources ss ON ss.source_id=s.id WHERE ss.skill_id=?1 ORDER BY s.id ASC LIMIT 1",
                [skill_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        Ok(match row.as_deref() {
            Some("verified_upstream") => SourceRole::VerifiedUpstream,
            _ => SourceRole::LocalOnly,
        })
    }

    /// 来源投影（描述符 + 角色 + 可选上游坐标）；无来源记录返回 None。
    pub fn source_record_for_skill(&self, skill_id: SkillId) -> AppResult<Option<SourceRecord>> {
        let row: Option<(String, String, String, Option<String>)> = self
            .database
            .connection
            .query_row(
                "SELECT s.kind, s.locator, s.role, CAST(s.created_at AS TEXT) FROM sources s JOIN skill_sources ss ON ss.source_id=s.id WHERE ss.skill_id=?1 ORDER BY s.id ASC LIMIT 1",
                [skill_id.to_string()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                    ))
                },
            )
            .optional()
            .map_err(error)?;
        let Some((kind, locator, role, created_at)) = row else {
            return Ok(None);
        };
        let source = decode_source(&kind, &locator)?;
        let role = match role.as_str() {
            "verified_upstream" => SourceRole::VerifiedUpstream,
            _ => SourceRole::LocalOnly,
        };
        let upstream = if role == SourceRole::VerifiedUpstream {
            self.upstream_for_skill(skill_id)?
        } else {
            None
        };
        Ok(Some(SourceRecord {
            skill_id,
            source,
            role,
            upstream,
            created_at: created_at.unwrap_or_default(),
        }))
    }

    pub fn for_skill(&self, skill_id: SkillId) -> AppResult<Option<SourceDescriptor>> {
        let row: Option<(String, String)> = self
            .database
            .connection
            .query_row(
                "SELECT s.kind, s.locator FROM sources s JOIN skill_sources ss ON ss.source_id=s.id WHERE ss.skill_id=?1 ORDER BY s.id ASC LIMIT 1",
                [skill_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(error)?;
        row.map(|(kind, locator)| decode_source(&kind, &locator))
            .transpose()
    }

    pub fn revision_for_skill(&self, skill_id: SkillId) -> AppResult<Option<String>> {
        self.database
            .connection
            .query_row(
                "SELECT s.revision FROM sources s JOIN skill_sources ss ON ss.source_id=s.id WHERE ss.skill_id=?1 ORDER BY s.id ASC LIMIT 1",
                [skill_id.to_string()],
                // revision 列可为 NULL（git 来源无 revision），必须按 Option 读取。
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(error)
            .map(|row| row.flatten())
    }

    pub fn set_revision(&self, skill_id: SkillId, revision: Option<&str>) -> AppResult<()> {
        self.database
            .connection
            .execute(
                "UPDATE sources SET revision=?1 WHERE id=(SELECT source_id FROM skill_sources WHERE skill_id=?2 ORDER BY source_id ASC LIMIT 1)",
                rusqlite::params![revision, skill_id.to_string()],
            )
            .map(|_| ())
            .map_err(error)
    }

    pub fn record_update_check(&self, check: &UpstreamCheckResult) -> AppResult<()> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(error)?;
        let snapshot = serde_json::to_string(check)
            .map_err(|_| AppError::new(ErrorCode::InternalError, Severity::Error))?;
        transaction.execute(
            "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
            rusqlite::params![format!("source.observation.{}", check.skill_id), snapshot],
        ).map_err(error)?;
        self.database
            .connection
            .execute(
                "INSERT INTO source_update_checks(skill_id,state,upstream_label,checked_at) VALUES (?1,?2,?3,strftime('%s','now')) ON CONFLICT(skill_id) DO UPDATE SET state=excluded.state,upstream_label=excluded.upstream_label,checked_at=excluded.checked_at",
                rusqlite::params![
                    check.skill_id.to_string(),
                    source_state_code(check.state),
                    check.upstream_label,
                ],
            )
            .map_err(error)?;
        transaction.commit().map_err(error)
    }

    pub fn last_update_check(&self, skill_id: SkillId) -> AppResult<Option<UpstreamCheckResult>> {
        let raw: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [format!("source.observation.{skill_id}")],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        raw.map(|value| {
            serde_json::from_str(&value)
                .map_err(|_| AppError::new(ErrorCode::InternalError, Severity::Error))
        })
        .transpose()
    }

    /// K6：最近一次来源更新检查的落库时刻（Unix 秒）。读自
    /// source_update_checks 表（record_update_check 与观察快照同事务写入）；
    /// 从未检查过时为 None，调用方诚实缺省。
    pub fn last_update_checked_at(&self, skill_id: SkillId) -> AppResult<Option<i64>> {
        self.database
            .connection
            .query_row(
                "SELECT checked_at FROM source_update_checks WHERE skill_id=?1",
                [skill_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)
    }

    /// K6/D3：按候选身份读取 Skill 的忽略记录（持久化于 settings KV，
    /// `source.ignored_updates.{skill_id}`）。「关闭窗口」不产生记录；
    /// 采纳或来源身份变更后由调用方整体清除。
    pub fn ignored_updates(&self, skill_id: SkillId) -> AppResult<Vec<IgnoredSourceUpdate>> {
        let raw: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [format!("source.ignored_updates.{skill_id}")],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        let Some(raw) = raw else {
            return Ok(Vec::new());
        };
        serde_json::from_str(&raw)
            .map_err(|_| AppError::new(ErrorCode::InternalError, Severity::Error))
    }

    /// K6/D3：按 skill+来源+候选身份持久化一条忽略记录。幂等：同一候选
    /// 重复忽略只保留首次记录。
    pub fn ignore_update(
        &self,
        skill_id: SkillId,
        candidate_identity: &str,
        upstream_url: &str,
    ) -> AppResult<()> {
        let mut ignored = self.ignored_updates(skill_id)?;
        if ignored
            .iter()
            .any(|record| record.candidate_identity == candidate_identity)
        {
            return Ok(());
        }
        ignored.push(IgnoredSourceUpdate {
            candidate_identity: candidate_identity.to_owned(),
            upstream_url: upstream_url.to_owned(),
            ignored_at_epoch: chrono_epoch_seconds(),
        });
        let snapshot = serde_json::to_string(&ignored)
            .map_err(|_| AppError::new(ErrorCode::InternalError, Severity::Error))?;
        self.database
            .connection
            .execute(
                "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                rusqlite::params![format!("source.ignored_updates.{skill_id}"), snapshot],
            )
            .map(|_| ())
            .map_err(error)
    }

    /// K6/D3：清除 Skill 的全部忽略记录（候选被采纳或来源身份变更后自动
    /// 失效）。幂等：没有记录时同样视为已清理。
    pub fn clear_ignored_updates(&self, skill_id: SkillId) -> AppResult<()> {
        self.database
            .connection
            .execute(
                "DELETE FROM settings WHERE key=?1",
                [format!("source.ignored_updates.{skill_id}")],
            )
            .map(|_| ())
            .map_err(error)
    }
}

/// Unix 秒（忽略记录的落库时刻；与仓库其他 epoch 时间戳同一口径）。
fn chrono_epoch_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn source_state_code(state: SourceState) -> &'static str {
    match state {
        SourceState::UpToDate => "up_to_date",
        SourceState::UpdateAvailable => "update_available",
        SourceState::UpdateAvailableWithLocalChanges => "update_available_with_local_changes",
        SourceState::SourceUnavailable => "source_unavailable",
        SourceState::AuthenticationRequired => "authentication_required",
        SourceState::NoUpstream => "no_upstream",
    }
}

fn source_id(source: &SourceDescriptor) -> AppResult<String> {
    let (kind, locator) = encode_source(source)?;
    let mut hasher = Sha256::new();
    hasher.update(kind.as_bytes());
    hasher.update([0]);
    hasher.update(locator.as_bytes());
    Ok(format!("source:{:x}", hasher.finalize()))
}

/// P1-05：存储层的来源 kind → 来源角色。本地目录 = local_only；
/// 远端 https/git = verified_upstream（写入方都是显式确认动作）。
pub(crate) fn role_for_kind(kind: &str) -> &'static str {
    if kind == "local" {
        "local_only"
    } else {
        "verified_upstream"
    }
}

pub(crate) fn encode_source(source: &SourceDescriptor) -> AppResult<(&'static str, String)> {
    match (&source.kind, &source.locator) {
        (SourceKind::Local, SourceLocator::LocalPath(path)) => {
            Ok(("local", path.to_string_lossy().into_owned()))
        }
        (SourceKind::Https, SourceLocator::HttpsUrl(url)) => Ok(("https", url.clone())),
        (SourceKind::Git, SourceLocator::GitUrl(url)) => Ok(("git", url.clone())),
        _ => Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)),
    }
}

pub(crate) fn decode_source(kind: &str, locator: &str) -> AppResult<SourceDescriptor> {
    let (kind, locator) = match kind {
        "local" => (SourceKind::Local, SourceLocator::local_path(locator)),
        "https" => (SourceKind::Https, SourceLocator::https_url(locator)),
        "git" => (SourceKind::Git, SourceLocator::git_url(locator)),
        _ => return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)),
    };
    Ok(SourceDescriptor::new(kind, locator))
}

fn error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("source", error.to_string())
}
