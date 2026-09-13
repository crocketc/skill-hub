use std::collections::BTreeMap;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use super::Database;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

const KEY: &str = "llm_connection_test_state";

/// 最近一次三级连接测试的持久化摘要，按 provider id 分条存于 settings KV。
///
/// 这是缓存性质的数据：记录的是"当时那次实测"，由调用方用配置身份指纹
/// （`skillhub_core::llm::LlmConnectionIdentity`）判断是否仍然适用；损坏的
/// JSON 一律按无记录处理，绝不阻塞读取方，下一次写入会重建合法 JSON。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PersistedConnectionTest {
    /// 第一级：服务端点可达。
    pub service_ok: bool,
    /// 第二级：凭据有效且模型可调用。
    pub model_ok: bool,
    /// 第三级：结构化输出兼容；未执行到该级时为 `None`。
    pub structured_ok: Option<bool>,
    /// 测试时刻（epoch 秒字符串，与搜索候选时间戳格式一致）。
    pub tested_at: String,
    /// 测试时的配置身份指纹。
    pub fingerprint: String,
}

/// Persistence for the most recent three-level connection test per provider.
/// A single settings KV row holds the whole map, mirroring the single-row JSON
/// pattern used by the skill repo repository.
pub struct LlmConnectionTestRepository<'a> {
    database: &'a Database,
}

impl<'a> LlmConnectionTestRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    /// 读取整张分条映射；行缺失或 JSON 损坏/形状不符时返回空映射。
    fn load_map(&self) -> AppResult<BTreeMap<String, PersistedConnectionTest>> {
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

    fn store_map(&self, entries: &BTreeMap<String, PersistedConnectionTest>) -> AppResult<()> {
        let json = serde_json::to_string(entries).map_err(|_| invalid_record())?;
        self.database
            .connection
            .execute(
                "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                rusqlite::params![KEY, json],
            )
            .map_err(database_error)?;
        Ok(())
    }

    /// 读取整张映射，供调用方按 provider id 逐条核对指纹。
    pub fn load(&self) -> AppResult<BTreeMap<String, PersistedConnectionTest>> {
        self.load_map()
    }

    pub fn get(&self, provider_id: &str) -> AppResult<Option<PersistedConnectionTest>> {
        Ok(self.load_map()?.get(provider_id).cloned())
    }

    /// 写入或覆盖一个 provider 的最近一次测试结果，保留其他 provider 的条目。
    pub fn put(&self, provider_id: &str, entry: &PersistedConnectionTest) -> AppResult<()> {
        let mut entries = self.load_map()?;
        entries.insert(provider_id.to_owned(), entry.clone());
        self.store_map(&entries)
    }

    /// 移除一个 provider 的条目；移除不存在的条目保持幂等。
    pub fn remove(&self, provider_id: &str) -> AppResult<()> {
        let mut entries = self.load_map()?;
        entries.remove(provider_id);
        self.store_map(&entries)
    }
}

fn invalid_record() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
