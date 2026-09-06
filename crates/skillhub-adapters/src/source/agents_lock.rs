use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// `~/.agents/.skill-lock.json` 中单个 Skill 条目（Q17，规格"可选增强"：
/// `.agents/.skill-lock.json` 导入；解析规则逐条对齐 cc-switch 实现）。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentsLockEntry {
    pub name: String,
    pub owner: String,
    pub repo: String,
    pub branch: Option<String>,
    pub skill_path: Option<String>,
}

#[derive(Deserialize)]
struct AgentsLockFile {
    #[serde(default)]
    skills: BTreeMap<String, AgentsLockSkill>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentsLockSkill {
    source: Option<String>,
    source_type: Option<String>,
    source_url: Option<String>,
    skill_path: Option<String>,
    branch: Option<String>,
    source_branch: Option<String>,
}

/// `~/.agents/.skill-lock.json` 的标准位置。
pub fn agents_lock_path(home: &Path) -> PathBuf {
    home.join(".agents").join(".skill-lock.json")
}

/// 读取并解析 home 下的 lock 文件；文件缺失或解析失败一律返回空列表
/// （与 cc-switch 一致：lock 只是增强信息，不阻塞主流程）。
pub fn read_agents_lock(home: &Path) -> Vec<AgentsLockEntry> {
    let content = match std::fs::read_to_string(agents_lock_path(home)) {
        Ok(content) => content,
        Err(_) => return Vec::new(),
    };
    parse_agents_lock(&content)
}

/// 解析 lock 文件内容：
/// - 仅接受 `source_type == "github"` 且 `source` 能拆出 owner/repo 的条目；
/// - 分支回退次序：`branch` → `source_branch` → `source_url`（tree 路径 /
///   `#fragment` / `?branch=` / `?ref=`）；
/// - 空白分支视同缺失。
pub fn parse_agents_lock(content: &str) -> Vec<AgentsLockEntry> {
    let lock: AgentsLockFile = match serde_json::from_str(content) {
        Ok(lock) => lock,
        Err(_) => return Vec::new(),
    };
    let mut entries: Vec<AgentsLockEntry> = lock
        .skills
        .into_iter()
        .filter_map(|(name, skill)| {
            let source = skill.source?;
            if skill.source_type.as_deref() != Some("github") {
                return None;
            }
            let (owner, repo) = source.split_once('/')?;
            if owner.is_empty() || repo.is_empty() {
                return None;
            }
            let branch = normalize_optional_branch(skill.branch)
                .or_else(|| normalize_optional_branch(skill.source_branch))
                .or_else(|| parse_branch_from_source_url(skill.source_url.as_deref()));
            Some(AgentsLockEntry {
                name,
                owner: owner.to_string(),
                repo: repo.to_string(),
                branch,
                skill_path: skill.skill_path,
            })
        })
        .collect();
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    entries
}

fn normalize_optional_branch(branch: Option<String>) -> Option<String> {
    branch.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn parse_branch_from_source_url(source_url: Option<&str>) -> Option<String> {
    let source_url = source_url?;
    let source_url = source_url.trim();
    if source_url.is_empty() {
        return None;
    }

    // https://github.com/owner/repo/tree/<branch>/...
    if let Some((_, after_tree)) = source_url.split_once("/tree/") {
        let branch = after_tree
            .split('/')
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())?;
        return Some(branch.to_string());
    }

    // URL fragment: ...git#branch
    if let Some((_, fragment)) = source_url.split_once('#') {
        let branch = fragment
            .split('&')
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())?;
        return Some(branch.to_string());
    }

    // query: ...?branch=xxx / ?ref=xxx
    if let Some((_, query)) = source_url.split_once('?') {
        for pair in query.split('&') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            if matches!(key, "branch" | "ref") && !value.trim().is_empty() {
                return Some(value.trim().to_string());
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_entries_and_applies_branch_fallback_chain() {
        let content = r#"{
            "skills": {
                "pdf": {
                    "source": "anthropics/skills",
                    "sourceType": "github",
                    "skillPath": "skills/pdf",
                    "branch": "v2"
                },
                "deploy": {
                    "source": "octo/deploy",
                    "sourceType": "github",
                    "sourceBranch": " release/v1 ",
                    "sourceUrl": "https://github.com/octo/deploy#main"
                },
                "reader": {
                    "source": "octo/reader",
                    "sourceType": "github",
                    "sourceUrl": "https://github.com/octo/reader/tree/dev/tools"
                },
                "writer": {
                    "source": "octo/writer",
                    "sourceType": "github",
                    "sourceUrl": "https://github.com/octo/writer?ref=feature/w"
                }
            }
        }"#;
        let entries = parse_agents_lock(content);
        assert_eq!(entries.len(), 4);
        let by_name = |name: &str| {
            entries
                .iter()
                .find(|entry| entry.name == name)
                .unwrap_or_else(|| panic!("missing {name}"))
        };
        assert_eq!(by_name("pdf").owner, "anthropics");
        assert_eq!(by_name("pdf").repo, "skills");
        assert_eq!(by_name("pdf").skill_path.as_deref(), Some("skills/pdf"));
        assert_eq!(by_name("pdf").branch.as_deref(), Some("v2"));
        // branch 优先于 source_branch/source_url
        assert_eq!(by_name("deploy").branch.as_deref(), Some("release/v1"));
        // sourceBranch 缺失时回退 sourceUrl fragment
        assert_eq!(by_name("reader").branch.as_deref(), Some("dev"));
        // 无 branch/sourceBranch 时回退 query ref
        assert_eq!(by_name("writer").branch.as_deref(), Some("feature/w"));
    }

    #[test]
    fn skips_non_github_and_unparseable_sources() {
        let content = r#"{
            "skills": {
                "gitlab-one": { "source": "group/proj", "sourceType": "gitlab" },
                "no-source": { "sourceType": "github" },
                "bad-source": { "source": "just-a-name", "sourceType": "github" },
                "empty-owner": { "source": "/repo", "sourceType": "github" },
                "ok": { "source": "octo/ok", "sourceType": "github" }
            }
        }"#;
        let entries = parse_agents_lock(content);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "ok");
    }

    #[test]
    fn invalid_json_yields_empty_result() {
        assert!(parse_agents_lock("not json").is_empty());
        assert!(parse_agents_lock("").is_empty());
    }

    #[test]
    fn read_agents_lock_returns_empty_for_missing_file() {
        let home = tempfile::tempdir().unwrap();
        assert!(read_agents_lock(home.path()).is_empty());
    }

    #[test]
    fn read_agents_lock_reads_the_standard_location() {
        let home = tempfile::tempdir().unwrap();
        let lock_dir = home.path().join(".agents");
        std::fs::create_dir_all(&lock_dir).unwrap();
        std::fs::write(
            agents_lock_path(home.path()),
            r#"{"skills":{"a":{"source":"o/r","sourceType":"github"}}}"#,
        )
        .unwrap();
        let entries = read_agents_lock(home.path());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].owner, "o");
    }
}
