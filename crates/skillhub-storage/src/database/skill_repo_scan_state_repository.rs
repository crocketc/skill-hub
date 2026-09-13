use std::collections::BTreeMap;

use rusqlite::OptionalExtension;
use skillhub_core::source::RepoScanState;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

use super::Database;

const KEY: &str = "skill_repo_scan_state";

/// Persistence for the most recent per-repository scan outcome. A single
/// settings KV row holds the whole `"owner/name" -> RepoScanState` map,
/// mirroring the single-row JSON pattern used by the skill repo repository.
///
/// 缓存性质的数据：JSON 损坏或形状不符一律按空映射处理，绝不阻塞读取方；
/// 下一次写入会重建合法 JSON。移除仓库时应同步移除其条目，避免陈旧状态
/// 在重新添加同名仓库后被误读为“最近一次扫描”。
pub struct SkillRepoScanStateRepository<'a> {
    database: &'a Database,
}

impl<'a> SkillRepoScanStateRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    /// 读取整张分条映射；行缺失或 JSON 损坏/形状不符时返回空映射。
    pub fn load(&self) -> AppResult<BTreeMap<String, RepoScanState>> {
        let value: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        match value {
            // 容错：缓存性质的记录不因历史脏数据而失败。
            Some(json) => Ok(serde_json::from_str(&json).unwrap_or_default()),
            None => Ok(BTreeMap::new()),
        }
    }

    /// 读取单个仓库的最近一次扫描状态。
    pub fn get(&self, owner: &str, name: &str) -> AppResult<Option<RepoScanState>> {
        Ok(self.load()?.remove(&map_key(owner, name)))
    }

    /// 写入或覆盖一个仓库的最近一次扫描状态，保留其他仓库的条目。
    pub fn put(&self, owner: &str, name: &str, state: &RepoScanState) -> AppResult<()> {
        let mut entries = self.load()?;
        entries.insert(map_key(owner, name), state.clone());
        let json = serde_json::to_string(&entries).map_err(|_| invalid_record())?;
        self.database
            .connection
            .execute(
                "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                rusqlite::params![KEY, json],
            )
            .map_err(database_error)?;
        Ok(())
    }

    /// 移除一个仓库的条目；移除不存在的条目保持幂等。
    pub fn remove(&self, owner: &str, name: &str) -> AppResult<()> {
        let mut entries = self.load()?;
        entries.remove(&map_key(owner, name));
        let json = serde_json::to_string(&entries).map_err(|_| invalid_record())?;
        self.database
            .connection
            .execute(
                "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                rusqlite::params![KEY, json],
            )
            .map_err(database_error)?;
        Ok(())
    }
}

/// 映射键："owner/name"（与 UI 中的仓库标识一致）。
fn map_key(owner: &str, name: &str) -> String {
    format!("{owner}/{name}")
}

fn invalid_record() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}

#[cfg(test)]
mod tests {
    use super::Database;
    use skillhub_core::source::RepoScanState;

    fn state(ok: bool, candidates: u32, error: Option<&str>) -> RepoScanState {
        RepoScanState {
            scanned_at: "2026-09-14T08:30:00Z".into(),
            ok,
            candidate_count: candidates,
            error: error.map(str::to_owned),
        }
    }

    #[test]
    fn scan_state_round_trips_and_upsert_overwrites() {
        let database = Database::open_in_memory().unwrap();
        let repository = database.skill_repo_scan_state_repository();

        // 未写入前是空映射，单仓读取是 None。
        assert!(repository.load().unwrap().is_empty());
        assert_eq!(repository.get("anthropics", "skills").unwrap(), None);

        repository
            .put("anthropics", "skills", &state(true, 3, None))
            .unwrap();
        repository
            .put(
                "cexll",
                "myclaude",
                &state(false, 0, Some("DOWNLOAD_FAILED status=404")),
            )
            .unwrap();

        let loaded = repository.load().unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(
            repository.get("anthropics", "skills").unwrap(),
            Some(state(true, 3, None))
        );
        assert_eq!(
            repository.get("cexll", "myclaude").unwrap(),
            Some(state(false, 0, Some("DOWNLOAD_FAILED status=404")))
        );

        // 同仓覆盖：条目数不变，内容被替换，其他仓库不受影响。
        repository
            .put("anthropics", "skills", &state(true, 5, None))
            .unwrap();
        assert_eq!(repository.load().unwrap().len(), 2);
        assert_eq!(
            repository.get("anthropics", "skills").unwrap(),
            Some(state(true, 5, None))
        );
    }

    #[test]
    fn corrupt_scan_state_json_is_treated_as_empty_and_self_heals() {
        let database = Database::open_in_memory().unwrap();
        database
            .connection_for_test()
            .execute(
                "INSERT INTO settings(key,value_json,updated_at) VALUES('skill_repo_scan_state','{not json',0)",
                [],
            )
            .unwrap();
        let repository = database.skill_repo_scan_state_repository();

        // 损坏 JSON 按空处理，读取方不被历史脏数据阻塞。
        assert!(repository.load().unwrap().is_empty());
        assert_eq!(repository.get("anthropics", "skills").unwrap(), None);

        // 下一次写入重建合法 JSON。
        repository
            .put("anthropics", "skills", &state(true, 1, None))
            .unwrap();
        assert_eq!(
            repository.get("anthropics", "skills").unwrap(),
            Some(state(true, 1, None))
        );
    }

    #[test]
    fn remove_prunes_only_the_target_entry_and_stays_idempotent() {
        let database = Database::open_in_memory().unwrap();
        let repository = database.skill_repo_scan_state_repository();
        repository
            .put("anthropics", "skills", &state(true, 3, None))
            .unwrap();
        repository
            .put("cexll", "myclaude", &state(true, 1, None))
            .unwrap();

        repository.remove("anthropics", "skills").unwrap();
        assert_eq!(repository.get("anthropics", "skills").unwrap(), None);
        assert_eq!(
            repository.get("cexll", "myclaude").unwrap(),
            Some(state(true, 1, None))
        );

        // 再移除不存在的条目：幂等成功。
        repository.remove("anthropics", "skills").unwrap();
        assert_eq!(repository.load().unwrap().len(), 1);
    }
}
