use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity, SkillId, VersionId};

use super::layout::CentralLibrary;

/// K4：一条 Markdown 草稿的落库记录。草稿是用户内容：只驻留库内
/// `drafts/<skill_id>/`，不进版本库、不进 journal/日志。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MarkdownDraftRecord {
    /// 草稿对应的库内相对 markdown 路径（如 `SKILL.md`）。
    pub path: String,
    /// 草稿基准版本（读取文件时未指定版本则为 None）。
    pub base_version_id: Option<VersionId>,
    /// 草稿基准内容身份（版本内文件 object_id），供陈旧判定。
    pub base_content_identity: String,
    /// 草稿正文。
    pub markdown: String,
    /// 最后保存时刻（epoch 秒，UTC）。
    pub updated_at_epoch_seconds: i64,
}

/// K4：Markdown 草稿存储。每条草稿是 `<sha256(path)>.json` 单文件，
/// 临时文件加原子替换写入；写入失败不产生部分状态，旧草稿保持原样。
pub struct MarkdownDraftStore {
    root: PathBuf,
}

impl MarkdownDraftStore {
    pub fn from_library(library: &CentralLibrary) -> Self {
        Self {
            root: library.paths().drafts_dir.clone(),
        }
    }

    /// 保存（覆盖）一条草稿。失败时命令报错且不产生部分写入。
    pub fn save(
        &self,
        skill_id: SkillId,
        path: &str,
        markdown: &str,
        base_version_id: Option<&VersionId>,
        base_content_identity: &str,
        updated_at_epoch_seconds: i64,
    ) -> AppResult<()> {
        let record = MarkdownDraftRecord {
            path: path.to_owned(),
            base_version_id: base_version_id.cloned(),
            base_content_identity: base_content_identity.to_owned(),
            markdown: markdown.to_owned(),
            updated_at_epoch_seconds,
        };
        let bytes = serde_json::to_vec_pretty(&record).map_err(json_error)?;
        let destination = self.draft_file(skill_id, path)?;
        fs::create_dir_all(destination.parent().ok_or_else(internal_shape)?).map_err(io_error)?;
        write_atomic(&destination, &bytes)
    }

    /// 读取一条草稿；无草稿返回 None。
    pub fn load(&self, skill_id: SkillId, path: &str) -> AppResult<Option<MarkdownDraftRecord>> {
        let destination = self.draft_file(skill_id, path)?;
        let bytes = match fs::read(&destination) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error(error)),
        };
        let record: MarkdownDraftRecord = serde_json::from_slice(&bytes).map_err(json_error)?;
        Ok(Some(record))
    }

    /// 丢弃一条草稿；不存在时同样成功（幂等）。
    pub fn discard(&self, skill_id: SkillId, path: &str) -> AppResult<()> {
        let destination = self.draft_file(skill_id, path)?;
        match fs::remove_file(&destination) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_error(error)),
        }
    }

    /// 草稿文件路径：`drafts/<skill_id>/<sha256(path)>.json`。安全哈希
    /// 防路径穿越与非法文件名；调用方负责先校验 path 形状。
    fn draft_file(&self, skill_id: SkillId, path: &str) -> AppResult<PathBuf> {
        let mut hasher = Sha256::new();
        hasher.update(path.as_bytes());
        let digest = hasher.finalize();
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(self
            .root
            .join(skill_id.to_string())
            .join(format!("{hex}.json")))
    }
}

fn write_atomic(destination: &Path, bytes: &[u8]) -> AppResult<()> {
    let parent = destination.parent().ok_or_else(internal_shape)?;
    let temporary = temporary_path(parent, destination);
    let result = (|| {
        fs::write(&temporary, bytes).map_err(io_error)?;
        // 复用 portable 的原子替换原语：失败或中断时旧草稿保持原样。
        super::portable::replace_file(&temporary, destination).map_err(io_error)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn temporary_path(parent: &Path, destination: &Path) -> PathBuf {
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("draft.json");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    parent.join(format!(".{name}.{timestamp}.tmp"))
}

fn internal_shape() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_action(RecoveryAction::Retry)
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}

fn json_error(error: serde_json::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_in(root: &Path) -> MarkdownDraftStore {
        MarkdownDraftStore {
            root: root.to_path_buf(),
        }
    }

    #[test]
    fn save_load_and_discard_round_trip_without_partial_state() {
        let root = tempfile::tempdir().expect("root");
        let store = store_in(root.path());
        let skill = SkillId::new();
        let version = VersionId::parse(&format!("sha256:{}", "a".repeat(64))).expect("version");
        store
            .save(
                skill,
                "SKILL.md",
                "# Draft\n",
                Some(&version),
                "object-1",
                1_800_000_000,
            )
            .expect("save draft");
        let record = store
            .load(skill, "SKILL.md")
            .expect("load")
            .expect("draft exists");
        assert_eq!(record.path, "SKILL.md");
        assert_eq!(record.markdown, "# Draft\n");
        assert_eq!(record.base_version_id.as_ref(), Some(&version));
        assert_eq!(record.base_content_identity, "object-1");
        assert_eq!(record.updated_at_epoch_seconds, 1_800_000_000);

        // 覆盖保存替换旧内容。
        store
            .save(
                skill,
                "SKILL.md",
                "# Draft 2\n",
                None,
                "object-2",
                1_800_000_100,
            )
            .expect("overwrite draft");
        let record = store
            .load(skill, "SKILL.md")
            .expect("load")
            .expect("draft exists");
        assert_eq!(record.markdown, "# Draft 2\n");

        // 无临时残留。
        let leftovers: Vec<String> = fs::read_dir(root.path().join(skill.to_string()))
            .expect("skill drafts dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "no temp files may remain");

        store.discard(skill, "SKILL.md").expect("discard");
        assert!(store.load(skill, "SKILL.md").expect("load").is_none());
        // 幂等丢弃。
        store.discard(skill, "SKILL.md").expect("discard again");
        // 不同 path 映射不同文件。
        store
            .save(skill, "docs/notes.md", "# N\n", None, "object-3", 1)
            .expect("save other draft");
        assert!(store.load(skill, "SKILL.md").expect("load").is_none());
        assert!(store.load(skill, "docs/notes.md").expect("load").is_some());
    }

    #[test]
    fn draft_file_name_is_a_safe_hash_of_the_path() {
        let root = tempfile::tempdir().expect("root");
        let store = store_in(root.path());
        let skill = SkillId::new();
        let file = store.draft_file(skill, "SKILL.md").expect("draft file");
        let name = file.file_name().expect("file name").to_string_lossy();
        assert!(name.ends_with(".json"));
        let stem = name.trim_end_matches(".json");
        assert_eq!(stem.len(), 64);
        assert!(stem.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(
            file.parent().expect("parent"),
            &root.path().join(skill.to_string())
        );
    }
}
