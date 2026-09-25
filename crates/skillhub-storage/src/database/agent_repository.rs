use super::Database;
use rusqlite::{params, OptionalExtension};
use skillhub_core::agent::{AgentRepository as AgentRepositoryPort, DiscoverySnapshot};
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

const SNAPSHOT_KEY: &str = "agent_discovery_snapshot";

pub struct AgentRepository<'a> {
    database: &'a Database,
}

impl<'a> AgentRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn load(&self) -> AppResult<Option<DiscoverySnapshot>> {
        let value: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [SNAPSHOT_KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        value
            .map(|json| serde_json::from_str(&json).map_err(|_| invalid_snapshot()))
            .transpose()
    }

    pub fn replace(&self, snapshot: &DiscoverySnapshot) -> AppResult<DiscoverySnapshot> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        let previous = transaction
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [SNAPSHOT_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?
            .map(|json| {
                serde_json::from_str::<DiscoverySnapshot>(&json).map_err(|_| invalid_snapshot())
            })
            .transpose()?;
        let merged = merge_history(previous.as_ref(), snapshot);
        let json = serde_json::to_string(&merged).map_err(|_| invalid_snapshot())?;
        transaction
            .execute(
                "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                params![SNAPSHOT_KEY, json, now()],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
        Ok(merged)
    }
}

impl<'a> AgentRepositoryPort for AgentRepository<'a> {
    fn load_discovery(&self) -> AppResult<Option<DiscoverySnapshot>> {
        self.load()
    }

    fn replace_discovery(&self, snapshot: &DiscoverySnapshot) -> AppResult<DiscoverySnapshot> {
        self.replace(snapshot)
    }
}

fn merge_history(
    previous: Option<&DiscoverySnapshot>,
    current: &DiscoverySnapshot,
) -> DiscoverySnapshot {
    let Some(previous) = previous else {
        return current.clone();
    };
    let mut merged = current.clone();
    let previous_generation = previous.generation.parse::<u64>().unwrap_or_default();
    let current_generation = current.generation.parse::<u64>().unwrap_or_default();
    merged.generation = current_generation
        .max(previous_generation.saturating_add(1))
        .to_string();
    for instance in &previous.instances {
        if !merged.instances.iter().any(|candidate| {
            candidate.profile_id == instance.profile_id && candidate.client_id == instance.client_id
        }) {
            merged.instances.push(instance.clone());
        }
    }
    for target in &previous.logical_targets {
        if !merged
            .logical_targets
            .iter()
            .any(|candidate| candidate.id == target.id)
        {
            // 验收反馈（2026-09-25）：仅斜杠拼写不同的同 (profile, client,
            // scope) 旧条目是同一物理目录的历史拼写（如旧版本把共享目录末段
            // 写成 `/`），不是真实消失的目录；保留它们会让前端渲染出「品牌 +
            // 不可用」的幽灵共享目录卡。这里按文件系统路径身份（分隔符统一，
            // 大小写保持以兼容 POSIX）吸收进当前目标。
            if merged.logical_targets.iter().any(|candidate| {
                candidate.profile_id == target.profile_id
                    && candidate.client_id == target.client_id
                    && candidate.scope == target.scope
                    && normalize_separator(&candidate.path) == normalize_separator(&target.path)
            }) {
                continue;
            }
            let mut unavailable = target.clone();
            unavailable.exists = false;
            unavailable.readable = false;
            unavailable.writable = false;
            unavailable.available = false;
            merged.logical_targets.push(unavailable);
        }
    }
    for target in &previous.physical_targets {
        if !merged
            .physical_targets
            .iter()
            .any(|candidate| candidate.id == target.id)
        {
            let mut unavailable = target.clone();
            unavailable.exists = false;
            unavailable.readable = false;
            unavailable.writable = false;
            merged.physical_targets.push(unavailable);
        }
    }
    merged
}

/// DEV-5：路径的文件系统身份 = 分隔符统一为 `\`。只做分隔符归一，
/// 不折叠大小写（POSIX 大小写敏感，此处无法感知目标平台）。
fn normalize_separator(path: &str) -> String {
    path.replace('/', "\\")
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn invalid_snapshot() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use skillhub_core::agent::{
        ClientInstance, ClientKind, ClientPresence, DirectoryPrecedence, DiscoverySnapshot,
        LogicalTarget, OperatingSystem, PhysicalTarget, TargetScope,
    };

    fn target(id: &str, client: &str, path: &str, shared: bool) -> LogicalTarget {
        LogicalTarget {
            id: id.to_string(),
            profile_id: "codex".to_string(),
            client_id: client.to_string(),
            scope: TargetScope::Global,
            path: path.to_string(),
            marker: "SKILL.md".to_string(),
            precedence: DirectoryPrecedence::Preferred,
            shared_reference: shared,
            exists: true,
            readable: true,
            writable: true,
            available: true,
            physical_id: format!("phys-{id}"),
        }
    }

    fn snapshot(targets: Vec<LogicalTarget>) -> DiscoverySnapshot {
        DiscoverySnapshot {
            generation: "1".to_string(),
            observed_at: "1789829830".to_string(),
            instances: vec![ClientInstance {
                profile_id: "codex".to_string(),
                client_id: "codex-cli".to_string(),
                kind: ClientKind::Cli,
                display_name: "Codex CLI".to_string(),
                supported_os: vec![OperatingSystem::Windows],
                client_presence: ClientPresence::Unknown,
            }],
            logical_targets: targets,
            physical_targets: vec![PhysicalTarget {
                id: "phys-current".to_string(),
                path: "C:\\u\\.agents\\skills".to_string(),
                exists: true,
                readable: true,
                writable: true,
                case_behavior: "insensitive".to_string(),
                logical_target_ids: Vec::new(),
            }],
        }
    }

    #[test]
    fn merge_history_drops_separator_spelled_legacy_duplicates() {
        // 验收反馈（2026-09-25）：旧版本扫描把共享目录末段分隔符写成 `/`，
        // 这些条目被 merge_history 永久保留且可用性被清零，前端据此渲染出
        // 「品牌 + 不可用」的幽灵共享目录卡。同 (profile, client, scope) 下
        // 仅斜杠拼写不同的旧条目必须被当前目标吸收，不再跨扫描残留。
        let previous = snapshot(vec![target(
            "codex:codex-cli:global:legacy",
            "codex-cli",
            "C:\\u\\.agents/skills",
            false,
        )]);
        let current = snapshot(vec![target(
            "codex:codex-cli:global:current",
            "codex-cli",
            "C:\\u\\.agents\\skills",
            true,
        )]);

        let merged = merge_history(Some(&previous), &current);

        assert_eq!(merged.logical_targets.len(), 1);
        assert_eq!(
            merged.logical_targets[0].id,
            "codex:codex-cli:global:current"
        );
        assert!(merged.logical_targets[0].shared_reference);
        assert!(merged.logical_targets[0].available);
    }

    #[test]
    fn merge_history_still_keeps_genuinely_gone_directories_as_unavailable() {
        // 去重只针对同路径异体拼写；真实消失的目录仍保留为不可用事实。
        let previous = snapshot(vec![target(
            "codex:codex-cli:global:gone",
            "codex-cli",
            "C:\\u\\.gone\\skills",
            false,
        )]);
        let current = snapshot(vec![target(
            "codex:codex-cli:global:current",
            "codex-cli",
            "C:\\u\\.agents\\skills",
            true,
        )]);

        let merged = merge_history(Some(&previous), &current);

        assert_eq!(merged.logical_targets.len(), 2);
        let gone = merged
            .logical_targets
            .iter()
            .find(|candidate| candidate.id == "codex:codex-cli:global:gone")
            .expect("gone directory stays as an unavailable fact");
        assert!(!gone.available);
    }
}
