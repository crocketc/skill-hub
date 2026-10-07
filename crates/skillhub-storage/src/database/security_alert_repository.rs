use super::Database;
use rusqlite::{params, OptionalExtension};
use skillhub_core::check::ProductLevel;
use skillhub_core::{AppError, AppResult, ErrorCode, Severity, SkillId, VersionId};

/// W3-1（FB-003 裁决第 1 节）：预警状态行的持久化形态。
///
/// 预警与信任留痕都绑定内容版本；`state` 取
/// `alert | trusted | dismissed_later`，`decision_source` 取
/// `import | trust`。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SecurityAlertRecord {
    pub skill_id: String,
    pub version_id: String,
    pub level: ProductLevel,
    pub state: SecurityAlertState,
    pub decided_at: i64,
    pub source: SecurityAlertSource,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecurityAlertState {
    Alert,
    Trusted,
    DismissedLater,
}

impl SecurityAlertState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Alert => "alert",
            Self::Trusted => "trusted",
            Self::DismissedLater => "dismissed_later",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "alert" => Some(Self::Alert),
            "trusted" => Some(Self::Trusted),
            "dismissed_later" => Some(Self::DismissedLater),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecurityAlertSource {
    Import,
    Trust,
}

impl SecurityAlertSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Import => "import",
            Self::Trust => "trust",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "import" => Some(Self::Import),
            "trust" => Some(Self::Trust),
            _ => None,
        }
    }
}

fn level_code(level: ProductLevel) -> &'static str {
    match level {
        ProductLevel::Danger => "danger",
        ProductLevel::Warning => "warning",
    }
}

fn parse_level(value: &str) -> Option<ProductLevel> {
    match value {
        "danger" => Some(ProductLevel::Danger),
        "warning" => Some(ProductLevel::Warning),
        _ => None,
    }
}

/// 预警状态仓库。裁决第 1 节的唯一性设计：同一
/// (skill, version, decision_source) 至多一行，由表主键保证。
pub struct SecurityAlertRepository<'a> {
    database: &'a Database,
}

impl<'a> SecurityAlertRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    /// 导入落账的预警：危险级"仍要导入"与全部警告级导入后写入。
    ///
    /// 同版本不重复提示：已有导入预警行时保持原状态（含稍后处理），
    /// 不重置 decided_at；同版本已存在信任留痕时不再复活预警。
    pub fn record_import_alert(
        &self,
        skill_id: SkillId,
        version_id: &VersionId,
        level: ProductLevel,
    ) -> AppResult<()> {
        let trusted: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT version_id FROM security_alerts \
                 WHERE skill_id=?1 AND version_id=?2 AND decision_source='trust' AND state='trusted'",
                params![skill_id.to_string(), version_id.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        if trusted.is_some() {
            return Ok(());
        }
        self.database
            .connection
            .execute(
                "INSERT INTO security_alerts(skill_id,version_id,level,state,decided_at,decision_source) \
                 VALUES(?1,?2,?3,'alert',?4,'import') \
                 ON CONFLICT(skill_id,version_id,decision_source) DO NOTHING",
                params![skill_id.to_string(), version_id.as_str(), level_code(level), now()],
            )
            .map_err(database_error)?;
        Ok(())
    }

    /// 待办"完全信任"的留痕：解除预警、恢复可派发，记录来源/时间/绑定
    /// 版本。留痕级别取它所关闭的导入预警级别；主动信任（无预警）按
    /// 警告级记录。同版本重复信任幂等（仍只有一行）。
    pub fn record_trust(&self, skill_id: SkillId, version_id: &VersionId) -> AppResult<()> {
        let level: String = self
            .database
            .connection
            .query_row(
                "SELECT level FROM security_alerts \
                 WHERE skill_id=?1 AND version_id=?2 AND decision_source='import' LIMIT 1",
                params![skill_id.to_string(), version_id.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?
            .unwrap_or_else(|| "warning".to_owned());
        self.database
            .connection
            .execute(
                "INSERT INTO security_alerts(skill_id,version_id,level,state,decided_at,decision_source) \
                 VALUES(?1,?2,?3,'trusted',?4,'trust') \
                 ON CONFLICT(skill_id,version_id,decision_source) DO UPDATE SET \
                 state='trusted',decided_at=excluded.decided_at",
                params![skill_id.to_string(), version_id.as_str(), level, now()],
            )
            .map_err(database_error)?;
        Ok(())
    }

    /// "稍后处理"：留在待办，期间持续不可派发；只标记导入预警行本身。
    pub fn mark_dismissed_later(&self, skill_id: SkillId, version_id: &VersionId) -> AppResult<()> {
        self.database
            .connection
            .execute(
                "UPDATE security_alerts SET state='dismissed_later',decided_at=?3 \
                 WHERE skill_id=?1 AND version_id=?2 AND decision_source='import'",
                params![skill_id.to_string(), version_id.as_str(), now()],
            )
            .map_err(database_error)?;
        Ok(())
    }

    /// 派发门禁判据：该内容版本当前是否处于预警状态。信任留痕存在 →
    /// 无预警；否则导入预警行（alert 或 dismissed_later）即预警。
    pub fn active_alert_level(
        &self,
        skill_id: SkillId,
        version_id: &VersionId,
    ) -> AppResult<Option<ProductLevel>> {
        let trusted: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT version_id FROM security_alerts \
                 WHERE skill_id=?1 AND version_id=?2 AND decision_source='trust' AND state='trusted'",
                params![skill_id.to_string(), version_id.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        if trusted.is_some() {
            return Ok(None);
        }
        let level: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT level FROM security_alerts \
                 WHERE skill_id=?1 AND version_id=?2 AND decision_source='import' \
                 AND state IN ('alert','dismissed_later') LIMIT 1",
                params![skill_id.to_string(), version_id.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        level
            .map(|value| parse_level(&value).ok_or_else(|| unknown_alert_value("level", &value)))
            .transpose()
    }

    /// 该 Skill 的全部预警与信任留痕（安全页/追溯用）。
    pub fn alerts_for_skill(&self, skill_id: SkillId) -> AppResult<Vec<SecurityAlertRecord>> {
        let mut statement = self
            .database
            .connection
            .prepare(
                "SELECT skill_id,version_id,level,state,decided_at,decision_source \
                 FROM security_alerts WHERE skill_id=?1 ORDER BY decided_at ASC,version_id ASC",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map(params![skill_id.to_string()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(database_error)?;
        let mut records = Vec::new();
        for row in rows {
            let (skill_id, version_id, level, state, decided_at, source) =
                row.map_err(database_error)?;
            let level = parse_level(&level).ok_or_else(|| unknown_alert_value("level", &level))?;
            let state = SecurityAlertState::from_str(&state)
                .ok_or_else(|| unknown_alert_value("state", &state))?;
            let source = SecurityAlertSource::from_str(&source)
                .ok_or_else(|| unknown_alert_value("decision_source", &source))?;
            records.push(SecurityAlertRecord {
                skill_id,
                version_id,
                level,
                state,
                decided_at,
                source,
            });
        }
        Ok(records)
    }
}

fn unknown_alert_value(field: &str, value: &str) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("field", field.to_owned())
        .with_param("value", value.to_owned())
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or_default()
}

fn database_error(error: rusqlite::Error) -> AppError {
    super::classify_database_error(error)
}
