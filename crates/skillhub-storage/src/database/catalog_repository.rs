use super::Database;
use async_trait::async_trait;
use rusqlite::{params, OptionalExtension};
use skillhub_core::api::{
    ListSkills, SkillDeploymentFilter, SkillLifecycleFilter, SkillListItem, SkillListPage,
    SkillSortColumn, SkillSortDirection,
};
use skillhub_core::catalog::{CallPolicy, CatalogRepository, Skill, SkillLifecycle};
use skillhub_core::check::CheckState;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity, SkillId, VersionId};
use std::collections::{BTreeSet, HashMap, HashSet};

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

    /// Synchronous insert for local facade commands that hold the database
    /// mutex while applying one atomic catalog update.
    pub fn insert_sync(&self, skill: &Skill) -> AppResult<()> {
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

    pub fn remove_sync(&self, id: SkillId) -> AppResult<()> {
        let tx = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(error)?;
        let id = id.to_string();
        tx.execute("DELETE FROM skill_sources WHERE skill_id=?1", [&id])
            .map_err(error)?;
        tx.execute("DELETE FROM skill_tags WHERE skill_id=?1", [&id])
            .map_err(error)?;
        tx.execute(
            "DELETE FROM catalog_skill_metadata WHERE skill_id=?1",
            [&id],
        )
        .map_err(error)?;
        tx.execute("DELETE FROM skills WHERE id=?1", [&id])
            .map_err(error)?;
        tx.commit().map_err(error)
    }

    /// Reads the stable identity fields without crossing the async repository
    /// boundary. The application facade uses this for synchronous SQLite
    /// query dispatch while richer catalog reads remain on the trait.
    pub fn get_identity(&self, id: SkillId) -> AppResult<Option<(String, String)>> {
        self.database
            .connection
            .query_row(
                "SELECT display_name, runtime_name FROM skills WHERE id=?1",
                [id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(error)
    }

    /// Returns all catalog Skill IDs in a stable order for read-only exports
    /// and backup preparation.
    pub fn list_ids_sync(&self) -> AppResult<Vec<SkillId>> {
        let mut statement = self
            .database
            .connection
            .prepare("SELECT id FROM skills ORDER BY id")
            .map_err(error)?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(error)?
            .map(|row| row.map_err(error)?.parse().map_err(|_| bad_id()))
            .collect();
        ids
    }

    /// Reads the persisted, user-visible detail projection without loading
    /// version contents or deployment files.
    pub fn get_detail(&self, id: SkillId) -> AppResult<Option<SkillListItem>> {
        let id_text = id.to_string();
        let sql = format!(
            "SELECT s.id,{} FROM skills s {STATUS_JOINS} WHERE s.id=?1",
            status_columns()
        );
        let mut statement = self.database.connection.prepare(&sql).map_err(error)?;
        let row = statement
            .query_row([&id_text], map_status_row)
            .optional()
            .map_err(error)?;
        let Some((row_id, row)) = row else {
            return Ok(None);
        };
        let skill_id = row_id.parse().map_err(|_| bad_id())?;
        let mut item = read_status_row(skill_id, row)?;
        self.attach_tags(&mut item)?;
        Ok(Some(item))
    }

    /// Returns a deterministic, paged catalog projection for the desktop
    /// library. Text matching is literal and covers the user-visible catalog
    /// fields; facets are calculated from the complete catalog, not just the
    /// current page.
    pub fn list_page(&self, request: &ListSkills) -> AppResult<SkillListPage> {
        let page = request.page.max(1);
        let page_size = request.page_size.clamp(1, 100);
        let text = request.text.trim();
        let agent_targets = self.load_agent_target_ids()?;
        let project_targets = self.load_project_target_ids()?;

        let mut conditions: Vec<String> = Vec::new();
        let mut bind: Vec<String> = Vec::new();
        if text.is_empty() {
            conditions.push("1=1".into());
        } else {
            conditions.push(
                "(s.display_name LIKE ? ESCAPE '\\' OR s.runtime_name LIKE ? ESCAPE '\\' OR s.original_description LIKE ? ESCAPE '\\' OR s.translated_description LIKE ? ESCAPE '\\' OR s.user_note LIKE ? ESCAPE '\\')"
                    .into(),
            );
            let pattern = format!("%{}%", escape_like(text));
            for _ in 0..5 {
                bind.push(pattern.clone());
            }
        }
        if !request.filters.tags.is_empty() {
            let list = sql_string_list(&request.filters.tags);
            conditions.push(format!(
                "EXISTS (SELECT 1 FROM skill_tags st JOIN tags t ON st.tag_id=t.id WHERE st.skill_id=s.id AND t.name IN ({list}))"
            ));
        }
        if !request.filters.lifecycle.is_empty() {
            let buckets: Vec<&str> = request
                .filters
                .lifecycle
                .iter()
                .map(|bucket| match bucket {
                    SkillLifecycleFilter::Active => {
                        "(s.lifecycle='normal' AND m.trial_due IS NULL)"
                    }
                    SkillLifecycleFilter::Trial => "m.trial_due IS NOT NULL",
                    SkillLifecycleFilter::Archived => {
                        "(s.lifecycle<>'normal' AND m.trial_due IS NULL)"
                    }
                })
                .collect();
            conditions.push(format!("({})", buckets.join(" OR ")));
        }
        match request.filters.deployment {
            SkillDeploymentFilter::Any => {}
            SkillDeploymentFilter::Deployed | SkillDeploymentFilter::NotDeployed => {
                let mut classified = agent_targets
                    .iter()
                    .chain(project_targets.iter())
                    .cloned()
                    .collect::<Vec<_>>();
                classified.sort();
                classified.dedup();
                let list = sql_string_list(&classified);
                let negation = matches!(
                    request.filters.deployment,
                    SkillDeploymentFilter::NotDeployed
                )
                .then_some("NOT ")
                .unwrap_or_default();
                conditions.push(format!(
                    "{negation}EXISTS (SELECT 1 FROM deployments d WHERE d.skill_id=s.id AND d.state IN ('deployed','needs_recovery') AND d.target_id IN ({list}))"
                ));
            }
        }
        for (column, states) in [
            ("basic", &request.filters.basic_check),
            ("llm", &request.filters.ai_check),
        ] {
            if states.is_empty() {
                continue;
            }
            let list = states
                .iter()
                .map(|state| format!("'{}'", check_state_code(*state)))
                .collect::<Vec<_>>()
                .join(",");
            conditions.push(format!(
                "COALESCE({},{}) IN ({list})",
                latest_check_run_expr("s.id", "cp.version_id", column),
                "'not_checked'"
            ));
        }
        let where_sql = conditions.join(" AND ");

        let total_sql = format!(
            "SELECT COUNT(*) FROM skills s LEFT JOIN catalog_skill_metadata m ON m.skill_id=s.id LEFT JOIN current_pointers cp ON cp.skill_id=s.id WHERE {where_sql}"
        );
        let total: u32 = self
            .database
            .connection
            .query_row(&total_sql, rusqlite::params_from_iter(bind.iter()), |row| {
                row.get::<_, i64>(0)
            })
            .map_err(error)?
            .try_into()
            .unwrap_or(u32::MAX);
        let offset = u64::from(page.saturating_sub(1))
            .saturating_mul(u64::from(page_size))
            .min(i64::MAX as u64) as i64;
        let order_sql = order_expression(&request.sort, &agent_targets, &project_targets);
        let list_sql = format!(
            "SELECT s.id,{} FROM skills s {STATUS_JOINS} WHERE {where_sql} ORDER BY {order_sql}, s.id ASC LIMIT ? OFFSET ?",
            status_columns()
        );
        bind.push(page_size.to_string());
        bind.push(offset.to_string());
        let mut statement = self.database.connection.prepare(&list_sql).map_err(error)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(bind.iter()), map_status_row)
            .map_err(error)?;
        let mut items = Vec::new();
        for row in rows {
            let (row_id, row) = row.map_err(error)?;
            let skill_id = row_id.parse().map_err(|_| bad_id())?;
            items.push(read_status_row(skill_id, row)?);
        }
        self.attach_deployment_facts(&mut items, &agent_targets, &project_targets)?;
        let mut facets = self
            .database
            .connection
            .prepare("SELECT name FROM tags ORDER BY name")
            .map_err(error)?
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(error)?
            .map(|tag| tag.map_err(error))
            .collect::<AppResult<Vec<_>>>()?;
        facets.dedup();
        Ok(SkillListPage {
            items,
            total,
            page,
            page_size,
            tags: facets,
        })
    }

    fn attach_tags(&self, item: &mut SkillListItem) -> AppResult<()> {
        let mut tags_statement = self.database.connection.prepare(
            "SELECT t.name FROM tags t JOIN skill_tags st ON st.tag_id=t.id WHERE st.skill_id=?1 ORDER BY t.name",
        ).map_err(error)?;
        item.tags = tags_statement
            .query_map([item.skill_id.to_string()], |tag| tag.get::<_, String>(0))
            .map_err(error)?
            .map(|tag| tag.map_err(error))
            .collect::<AppResult<Vec<_>>>()?;
        Ok(())
    }

    /// Classifies the page's active deployments into agent and project counts
    /// using the discovery snapshot and the registered project targets.
    fn attach_deployment_facts(
        &self,
        items: &mut [SkillListItem],
        agent_targets: &HashSet<String>,
        project_targets: &HashSet<String>,
    ) -> AppResult<()> {
        if items.is_empty() {
            return Ok(());
        }
        let ids = items
            .iter()
            .map(|item| format!("'{}'", item.skill_id.to_string().replace('\'', "''")))
            .collect::<Vec<_>>()
            .join(",");
        let mut statement = self.database.connection.prepare(&format!(
            "SELECT DISTINCT skill_id,target_id FROM deployments WHERE skill_id IN ({ids}) AND state IN ('deployed','needs_recovery')"
        )).map_err(error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(error)?;
        let mut agent_ids: HashMap<String, BTreeSet<String>> = HashMap::new();
        let mut project_counts: HashMap<String, u32> = HashMap::new();
        for row in rows {
            let (skill_id, target_id) = row.map_err(error)?;
            if agent_targets.contains(&target_id) {
                agent_ids.entry(skill_id).or_default().insert(target_id);
            } else if project_targets.contains(&target_id) {
                *project_counts.entry(skill_id).or_insert(0) += 1;
            }
        }
        for item in items.iter_mut() {
            let key = item.skill_id.to_string();
            if let Some(targets) = agent_ids.get(&key) {
                item.agent_deployment_target_ids = targets.iter().cloned().collect();
            }
            item.agent_deployment_count = item.agent_deployment_target_ids.len() as u32;
            item.project_deployment_count = project_counts.get(&key).copied().unwrap_or_default();
        }
        Ok(())
    }

    fn load_agent_target_ids(&self) -> AppResult<HashSet<String>> {
        let mut ids: HashSet<String> = self
            .database
            .agent_repository()
            .load()?
            .map(|snapshot| {
                snapshot
                    .logical_targets
                    .into_iter()
                    .map(|target| target.id)
                    .collect()
            })
            .unwrap_or_default();
        let mut statement = self
            .database
            .connection
            .prepare("SELECT id FROM targets WHERE project_id IS NULL")
            .map_err(error)?;
        let registered = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(error)?;
        for id in registered {
            ids.insert(id.map_err(error)?);
        }
        Ok(ids)
    }

    fn load_project_target_ids(&self) -> AppResult<HashSet<String>> {
        let mut statement = self
            .database
            .connection
            .prepare("SELECT id FROM targets WHERE project_id IS NOT NULL")
            .map_err(error)?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(error)?
            .map(|id| id.map_err(error))
            .collect::<AppResult<HashSet<_>>>()?;
        Ok(ids)
    }
}

/// Column list shared by the detail and list projections. Every column is a
/// scalar or correlated subquery so no join multiplies catalog rows.
fn status_columns() -> String {
    let latest_basic = latest_check_run_expr("s.id", "cp.version_id", "basic");
    let latest_llm = latest_check_run_expr("s.id", "cp.version_id", "llm");
    let latest_basic_id = latest_check_run_id_expr("s.id", "cp.version_id", "basic");
    let latest_llm_id = latest_check_run_id_expr("s.id", "cp.version_id", "llm");
    format!(
        "s.display_name,s.runtime_name,s.original_description,s.translated_description,s.user_note,s.license,s.lifecycle,m.trial_due,s.author,\
         (SELECT src.kind FROM skill_sources ss JOIN sources src ON src.id=ss.source_id WHERE ss.skill_id=s.id ORDER BY src.id ASC LIMIT 1),\
         (SELECT src.locator FROM skill_sources ss JOIN sources src ON src.id=ss.source_id WHERE ss.skill_id=s.id ORDER BY src.id ASC LIMIT 1),\
         cp.version_id,v.source_version,\
         COALESCE({latest_basic},'not_checked'),\
         COALESCE({latest_llm},'not_checked'),\
         (SELECT COUNT(*) FROM check_findings f WHERE f.run_id IN ({latest_basic_id},{latest_llm_id}) AND f.severity IN ('error','critical') AND f.disposition='actionable')"
    )
}

const STATUS_JOINS: &str = "LEFT JOIN catalog_skill_metadata m ON m.skill_id=s.id \
     LEFT JOIN current_pointers cp ON cp.skill_id=s.id \
     LEFT JOIN versions v ON v.id=cp.version_id";

/// Raw row shape of `STATUS_COLUMNS`; domain parsing happens outside the
/// rusqlite mapper so errors keep the repository error type.
#[derive(Debug)]
struct StatusRow {
    display_name: String,
    runtime_name: String,
    original_description: String,
    translated_description: Option<String>,
    user_note: String,
    license: Option<String>,
    lifecycle: String,
    trial_due: Option<String>,
    author: Option<String>,
    source_kind: Option<String>,
    source_locator: Option<String>,
    current_version: Option<String>,
    version_label: Option<String>,
    basic_check: Option<String>,
    ai_check: Option<String>,
    high_risk_count: i64,
}

fn read_status_row(id: SkillId, row: StatusRow) -> AppResult<SkillListItem> {
    Ok(SkillListItem {
        skill_id: id,
        display_name: row.display_name,
        runtime_name: row.runtime_name,
        original_description: row.original_description,
        translated_description: row.translated_description,
        user_note: (!row.user_note.is_empty()).then_some(row.user_note),
        tags: Vec::new(),
        license: row.license,
        lifecycle: parse_lifecycle(&row.lifecycle)?,
        trial_due: row.trial_due,
        author: row.author,
        source_kind: row.source_kind,
        source_locator: row.source_locator,
        current_version: row
            .current_version
            .map(|value| VersionId::parse(&value))
            .transpose()
            .map_err(|_| bad_id())?,
        current_version_label: row.version_label.filter(|label| !label.is_empty()),
        agent_deployment_count: 0,
        agent_deployment_target_ids: Vec::new(),
        project_deployment_count: 0,
        basic_check: parse_check_state(row.basic_check)?,
        ai_check: parse_check_state(row.ai_check)?,
        high_risk_count: row.high_risk_count.max(0) as u32,
    })
}

fn latest_check_run_expr(skill: &str, version: &str, kind: &str) -> String {
    format!(
        "(SELECT cr.state FROM check_runs cr WHERE cr.skill_id={skill} AND cr.version_id={version} AND cr.kind='{kind}' ORDER BY cr.generation DESC,cr.started_at DESC,COALESCE(cr.ended_at,-1) DESC,cr.id DESC LIMIT 1)"
    )
}

fn latest_check_run_id_expr(skill: &str, version: &str, kind: &str) -> String {
    format!(
        "(SELECT cr.id FROM check_runs cr WHERE cr.skill_id={skill} AND cr.version_id={version} AND cr.kind='{kind}' ORDER BY cr.generation DESC,cr.started_at DESC,COALESCE(cr.ended_at,-1) DESC,cr.id DESC LIMIT 1)"
    )
}

fn deployment_count_expr(skill: &str, targets: &HashSet<String>) -> String {
    if targets.is_empty() {
        return "(SELECT 0)".into();
    }
    let list = sql_string_list(&targets.iter().cloned().collect::<Vec<_>>());
    format!(
        "(SELECT COUNT(DISTINCT d.target_id) FROM deployments d WHERE d.skill_id={skill} AND d.state IN ('deployed','needs_recovery') AND d.target_id IN ({list}))"
    )
}

fn order_expression(
    sort: &skillhub_core::api::SkillListSort,
    agent_targets: &HashSet<String>,
    project_targets: &HashSet<String>,
) -> String {
    let column = match sort.column {
        SkillSortColumn::Name => "s.display_name COLLATE NOCASE".to_owned(),
        SkillSortColumn::Lifecycle => "s.lifecycle,m.trial_due".to_owned(),
        SkillSortColumn::AgentDeployments => deployment_count_expr("s.id", agent_targets),
        SkillSortColumn::ProjectDeployments => deployment_count_expr("s.id", project_targets),
        SkillSortColumn::Version => "COALESCE(v.source_version,'')".to_owned(),
        SkillSortColumn::Updated => "s.updated_at".to_owned(),
    };
    let direction = match sort.direction {
        SkillSortDirection::Asc => "ASC",
        SkillSortDirection::Desc => "DESC",
    };
    format!("{column} {direction}")
}

fn check_state_code(state: CheckState) -> &'static str {
    match state {
        CheckState::NotChecked => "not_checked",
        CheckState::Running => "running",
        CheckState::Passed => "passed",
        CheckState::Failed => "failed",
    }
}

fn parse_check_state(value: Option<String>) -> AppResult<CheckState> {
    match value.as_deref() {
        None | Some("not_checked") => Ok(CheckState::NotChecked),
        Some("running") => Ok(CheckState::Running),
        Some("passed") => Ok(CheckState::Passed),
        Some("failed") => Ok(CheckState::Failed),
        _ => Err(AppError::new(ErrorCode::InternalError, Severity::Error)
            .with_param("source", "invalid persisted check state")),
    }
}

fn sql_string_list(values: &[String]) -> String {
    values
        .iter()
        .map(|value| format!("'{}'", value.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",")
}

fn map_status_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, StatusRow)> {
    Ok((
        row.get::<_, String>(0)?,
        StatusRow {
            display_name: row.get(1)?,
            runtime_name: row.get(2)?,
            original_description: row.get(3)?,
            translated_description: row.get(4)?,
            user_note: row.get(5)?,
            license: row.get(6)?,
            lifecycle: row.get(7)?,
            trial_due: row.get(8)?,
            author: row.get(9)?,
            source_kind: row.get(10)?,
            source_locator: row.get(11)?,
            current_version: row.get(12)?,
            version_label: row.get(13)?,
            basic_check: row.get(14)?,
            ai_check: row.get(15)?,
            high_risk_count: row.get(16)?,
        },
    ))
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
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

    /// Synchronous full skill read for application-facade mutations that hold
    /// the database mutex while applying one atomic update.
    fn get_sync(&self, id: SkillId) -> AppResult<Option<Skill>> {
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

    async fn get(&self, id: SkillId) -> AppResult<Option<Skill>> {
        self.get_sync(id)
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
        CallPolicy::ModelOnly => "model_only",
        CallPolicy::Disabled => "disabled",
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
        "model_only" => Ok(CallPolicy::ModelOnly),
        "disabled" => Ok(CallPolicy::Disabled),
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

fn bad_id() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", "invalid persisted skill id")
        .with_action(RecoveryAction::Retry)
}
