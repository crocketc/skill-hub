use super::Database;
use async_trait::async_trait;
use rusqlite::params;
use skillhub_core::catalog::{CallPolicy, CatalogRepository, Skill, SkillLifecycle};
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity, SkillId};
use std::collections::BTreeSet;

pub struct CatalogRepositorySqlite<'a> {
    database: &'a Database,
}
impl<'a> CatalogRepositorySqlite<'a> {
    pub fn new(database: &'a Database) -> AppResult<Self> {
        if !database.has_table("catalog_skill_metadata")? {
            return Err(AppError::new(ErrorCode::MigrationRequired, Severity::Error));
        }
        Ok(Self { database })
    }
}

#[async_trait(?Send)]
impl CatalogRepository for CatalogRepositorySqlite<'_> {
    async fn insert(&self, skill: &Skill) -> AppResult<()> {
        skill.validate()?;
        let conn = &self.database.connection;
        let tx = conn.unchecked_transaction().map_err(error)?;
        let timestamp = now();
        tx.execute("INSERT INTO skills (id,display_name,runtime_name,original_description,translated_description,user_note,author,license,call_policy,lifecycle,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,runtime_name=excluded.runtime_name,original_description=excluded.original_description,translated_description=excluded.translated_description,user_note=excluded.user_note,author=excluded.author,license=excluded.license,call_policy=excluded.call_policy,lifecycle=excluded.lifecycle,updated_at=excluded.updated_at", params![skill.id().to_string(), skill.display_name(), skill.runtime_name(), skill.original_description(), skill.translated_description(), skill.note().unwrap_or_default(), skill.author(), skill.license(), policy_code(skill.call_policy()), lifecycle_code(skill.lifecycle()), timestamp]).map_err(error)?;
        tx.execute(
            "DELETE FROM skill_tags WHERE skill_id=?1",
            [skill.id().to_string()],
        )
        .map_err(error)?;
        for tag in skill.tags() {
            tx.execute("INSERT OR IGNORE INTO tags (id,name) VALUES (?1,?1)", [tag])
                .map_err(error)?;
            tx.execute(
                "INSERT INTO skill_tags (skill_id,tag_id) SELECT ?1,id FROM tags WHERE name=?2",
                params![skill.id().to_string(), tag],
            )
            .map_err(error)?;
        }
        let req = serde_json::to_string(skill.requirements())
            .map_err(|_| error(rusqlite::Error::InvalidQuery))?;
        let due = skill
            .trial_due()
            .map(|(y, m, d)| format!("{y:04}-{m:02}-{d:02}"));
        tx.execute("INSERT OR REPLACE INTO catalog_skill_metadata(skill_id,requirements_json,trial_due) VALUES (?1,?2,?3)", params![skill.id().to_string(), req, due]).map_err(error)?;
        tx.commit().map_err(error)
    }

    async fn get(&self, id: SkillId) -> AppResult<Option<Skill>> {
        let conn = &self.database.connection;
        let mut stmt = conn.prepare("SELECT display_name,runtime_name,original_description,translated_description,user_note,author,license,call_policy,lifecycle FROM skills WHERE id=?1").map_err(error)?;
        let row = stmt
            .query_row([id.to_string()], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?,
                ))
            })
            .optional()
            .map_err(error)?;
        let Some((display, runtime, desc, translated, note, author, license, policy, lifecycle)) =
            row
        else {
            return Ok(None);
        };
        let mut tags = BTreeSet::new();
        let mut tags_stmt = conn.prepare("SELECT t.name FROM tags t JOIN skill_tags st ON st.tag_id=t.id WHERE st.skill_id=?1").map_err(error)?;
        for tag in tags_stmt
            .query_map([id.to_string()], |r| r.get(0))
            .map_err(error)?
        {
            tags.insert(tag.map_err(error)?);
        }
        let metadata: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT requirements_json,trial_due FROM catalog_skill_metadata WHERE skill_id=?1",
                [id.to_string()],
                |r| Ok((r.get::<_, String>(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(error)?;
        let (requirements, due) = if let Some((json, due)) = metadata {
            (
                serde_json::from_str(&json).map_err(|_| {
                    AppError::new(ErrorCode::RequirementsInvalidDeclaration, Severity::Error)
                })?,
                due,
            )
        } else {
            (Vec::new(), None)
        };
        Ok(Some(Skill::from_parts(
            id,
            display,
            runtime,
            desc,
            translated,
            if note.is_empty() { None } else { Some(note) },
            tags,
            author,
            license,
            parse_policy(&policy)?,
            parse_lifecycle(&lifecycle)?,
            requirements,
            due.and_then(parse_date),
        )?))
    }

    async fn remove(&self, id: SkillId) -> AppResult<()> {
        self.database
            .connection
            .execute("DELETE FROM skills WHERE id=?1", [id.to_string()])
            .map_err(error)?;
        Ok(())
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn policy_code(v: CallPolicy) -> &'static str {
    match v {
        CallPolicy::AutomaticAndManual => "automatic_and_manual",
        CallPolicy::ManualOnly => "manual_only",
    }
}
fn lifecycle_code(v: SkillLifecycle) -> &'static str {
    match v {
        SkillLifecycle::Normal => "normal",
        SkillLifecycle::Deprecated => "deprecated",
        SkillLifecycle::Archived => "archived",
    }
}
fn parse_policy(v: &str) -> AppResult<CallPolicy> {
    match v {
        "manual_only" => Ok(CallPolicy::ManualOnly),
        "automatic_and_manual" => Ok(CallPolicy::AutomaticAndManual),
        _ => Err(AppError::new(
            ErrorCode::CatalogInvalidMetadata,
            Severity::Error,
        )),
    }
}
fn parse_lifecycle(v: &str) -> AppResult<SkillLifecycle> {
    match v {
        "normal" => Ok(SkillLifecycle::Normal),
        "deprecated" => Ok(SkillLifecycle::Deprecated),
        "archived" => Ok(SkillLifecycle::Archived),
        _ => Err(AppError::new(
            ErrorCode::CatalogInvalidMetadata,
            Severity::Error,
        )),
    }
}
fn parse_date(v: String) -> Option<(i32, u8, u8)> {
    let p: Vec<_> = v.split('-').collect();
    if p.len() == 3 {
        Some((p[0].parse().ok()?, p[1].parse().ok()?, p[2].parse().ok()?))
    } else {
        None
    }
}
fn error(e: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", e.to_string())
        .with_action(RecoveryAction::Retry)
}
use rusqlite::OptionalExtension;
