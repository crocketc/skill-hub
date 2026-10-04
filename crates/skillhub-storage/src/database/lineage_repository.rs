//! K5/MS-04：复用修改血缘的持久化。「来源 skill+version → 新 skill 首版本」
//! 的有向事实；每主体至多一条（仅首版本的来源）。只登记事实，不承载任何
//! 网络来源，也不改变原主体的来源、版本或关系。

use super::Database;
use rusqlite::OptionalExtension;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity, SkillLineageFact};

pub struct LineageRepository<'a> {
    database: &'a Database,
}

impl<'a> LineageRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    /// 登记血缘。重复登记按事实冲突拒绝：血缘产生于复制的那一刻，
    /// 事后改写会伪造历史。
    pub fn record(&self, fact: &SkillLineageFact) -> AppResult<()> {
        let inserted = self
            .database
            .connection
            .execute(
                "INSERT INTO skill_lineage (skill_id,version_id,origin_skill_id,origin_version_id,created_at) VALUES (?1,?2,?3,?4,?5)",
                rusqlite::params![
                    fact.skill_id.to_string(),
                    fact.version_id.to_string(),
                    fact.origin_skill_id.to_string(),
                    fact.origin_version_id.to_string(),
                    fact.created_at,
                ],
            )
            .map_err(database_error)?;
        if inserted == 0 {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "skill_lineage_already_recorded")
                .with_action(RecoveryAction::Acknowledge));
        }
        Ok(())
    }

    /// 读取主体的上游谱系；无登记时返回 None（诚实缺省）。
    pub fn for_skill(
        &self,
        skill_id: skillhub_core::SkillId,
    ) -> AppResult<Option<SkillLineageFact>> {
        let row = self
            .database
            .connection
            .query_row(
                "SELECT skill_id,version_id,origin_skill_id,origin_version_id,created_at FROM skill_lineage WHERE skill_id=?1",
                [skill_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?;
        let Some((skill_id, version_id, origin_skill_id, origin_version_id, created_at)) = row
        else {
            return Ok(None);
        };
        Ok(Some(SkillLineageFact {
            skill_id: parse_id(&skill_id, "skill_id")?,
            version_id: parse_id(&version_id, "version_id")?,
            origin_skill_id: parse_id(&origin_skill_id, "origin_skill_id")?,
            origin_version_id: parse_id(&origin_version_id, "origin_version_id")?,
            created_at,
        }))
    }
}

fn parse_id<T: std::str::FromStr>(raw: &str, field: &str) -> AppResult<T> {
    raw.parse::<T>().map_err(|_| {
        AppError::new(ErrorCode::InternalError, Severity::Error)
            .with_param("field", field)
            .with_action(RecoveryAction::Retry)
    })
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
