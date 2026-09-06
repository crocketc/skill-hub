//! GitHub 仓库 Skill 发现（发现模块实现规格 §6，标准档）。
//!
//! 安全基线：§4 坐标校验在 [`super::repo_ref`]，本模块逐字保留 §6.2 的
//! 全部下载/解压预算常量与函数；`sanitize_skill_source_path` 逐字保留自
//! 规格 §7.2（安全基线 #6）。所有上限不得放宽。
//!
//! GitHub 归档带 "<repo>-<branch>" 顶层包装目录，解压后按 `git.rs` 的既有
//! 先例展平，使规格 §6.4 的"根目录 SKILL.md 用仓库名"规则成立。

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{anyhow, Result};
use reqwest::Client;
use skillhub_core::source::{DiscoverableRepoSkill, SkillRepo};

use super::repo_ref::{assert_github_archive_url, validate_repo_ref};

/// 解压条目上限（防海量小文件耗 inode）
const MAX_ARCHIVE_ENTRIES: usize = 10_000;
/// 解压后总字节上限（防压缩炸弹）
const MAX_ARCHIVE_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
/// symlink 目标上限（防 zip crate 的 symlink 膨胀 bug 打穿内存）
const MAX_SYMLINK_TARGET_BYTES: u64 = 4 * 1024;
/// 每个目录按 4KiB 计费（防空目录无限造 inode）
const DIRECTORY_BUDGET_COST: u64 = 4096;
/// 压缩体上限（流式计数，防下载阶段撑爆内存）
const MAX_ARCHIVE_DOWNLOAD_BYTES: u64 = 128 * 1024 * 1024;

/// 60s 超时包住整个下载+解压
const DOWNLOAD_TIMEOUT_SECONDS: u64 = 60;
/// 生产环境的归档 URL 落点（规格 §6.2）
const GITHUB_ARCHIVE_BASE: &str = "https://github.com";
/// 本机临时下载目录中超过该时长的残留会被尽力清理
const STALE_DOWNLOAD_MAX_AGE_SECONDS: u64 = 24 * 60 * 60;

pub struct RepoDiscoveryProvider {
    client: Client,
    /// 测试注入用；生产恒为 GITHUB_ARCHIVE_BASE（出口断言仅在默认落点启用）
    archive_base: String,
}

impl Default for RepoDiscoveryProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug)]
pub struct RepoDiscovery {
    pub skills: Vec<DiscoverableRepoSkill>,
    /// 每个失败仓库一条 (owner, name, reason) 告警（不拖垮整体发现）
    pub failures: Vec<(String, String, String)>,
}

impl RepoDiscoveryProvider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            archive_base: GITHUB_ARCHIVE_BASE.to_string(),
        }
    }

    /// 仅供测试：把归档下载指向本地 fixture 服务器。
    #[doc(hidden)]
    pub fn with_archive_base_for_tests(base: &str) -> Self {
        Self {
            client: Client::new(),
            archive_base: base.to_string(),
        }
    }

    pub fn validate_repo(&self, repo: &SkillRepo) -> Result<()> {
        validate_repo_ref(&repo.owner, &repo.name, &repo.branch)
    }

    /// 规格 §6.1：并行下载+扫描；单个仓库失败只告警；去重 + 按名称排序。
    pub async fn discover(&self, repos: Vec<SkillRepo>) -> RepoDiscovery {
        let enabled: Vec<SkillRepo> = repos.into_iter().filter(|repo| repo.enabled).collect();

        let results: Vec<Result<Vec<DiscoverableRepoSkill>>> = futures::future::join_all(
            enabled
                .iter()
                .map(|repo| fetch_repo_skills(&self.client, &self.archive_base, repo)),
        )
        .await;

        let mut skills = Vec::new();
        let mut failures = Vec::new();
        for (repo, result) in enabled.into_iter().zip(results) {
            match result {
                Ok(mut repo_skills) => skills.append(&mut repo_skills),
                Err(error) => failures.push((repo.owner, repo.name, error.to_string())),
            }
        }

        deduplicate_discoverable_skills(&mut skills);
        skills.sort_by_key(|skill| skill.name.to_lowercase());
        RepoDiscovery { skills, failures }
    }

    /// 安装管线适配（SkillHub 版）：下载仓库 → 定位 skill 子目录 → 复制到
    /// `dest_root` 下的独立目录并返回路径，之后以本地目录身份进入现有导入管线。
    pub async fn download_skill_directory(
        &self,
        repo: &SkillRepo,
        directory: &str,
        dest_root: &Path,
    ) -> Result<PathBuf> {
        // 空目录 = 仓库根整体即 Skill（lock 文件条目常无 skill_path）；
        // 非空的非法值（穿越、绝对路径）仍必须拒绝。
        let trimmed = directory.trim();
        let sanitized = if trimmed.is_empty() {
            None
        } else {
            Some(
                sanitize_skill_source_path(directory)
                    .ok_or_else(|| anyhow!("INVALID_SKILL_DIRECTORY: {directory}"))?,
            )
        };
        let (temp_guard, _resolved_branch) = tokio::time::timeout(
            Duration::from_secs(DOWNLOAD_TIMEOUT_SECONDS),
            download_repo(&self.client, &self.archive_base, repo),
        )
        .await
        .map_err(|_| anyhow!("DOWNLOAD_TIMEOUT: {}/{}", repo.owner, repo.name))??;

        let source_dir = match &sanitized {
            Some(relative) => resolve_skill_source_dir(temp_guard.path(), relative)?,
            None => {
                let root = std::fs::canonicalize(temp_guard.path()).map_err(|error| {
                    anyhow!("INVALID_SKILL_DIRECTORY: canonicalize failed: {error}")
                })?;
                let canonical_root = std::fs::canonicalize(temp_guard.path())?;
                if !root.starts_with(&canonical_root) {
                    return Err(anyhow!(
                        "INVALID_SKILL_DIRECTORY: resolved path escapes temp root"
                    ));
                }
                root
            }
        };
        let install_name = sanitized
            .as_ref()
            .and_then(|relative| relative.file_name())
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| repo.name.clone());
        let dest_dir = dest_root.join(unique_download_id()).join(&install_name);
        copy_dir_recursive(&source_dir, &dest_dir)?;
        Ok(dest_dir)
    }
}

async fn fetch_repo_skills(
    client: &Client,
    archive_base: &str,
    repo: &SkillRepo,
) -> Result<Vec<DiscoverableRepoSkill>> {
    let (temp_guard, resolved_branch) = tokio::time::timeout(
        Duration::from_secs(DOWNLOAD_TIMEOUT_SECONDS),
        download_repo(client, archive_base, repo),
    )
    .await
    .map_err(|_| anyhow!("DOWNLOAD_TIMEOUT: {}/{}", repo.owner, repo.name))??;

    let mut skills = Vec::new();
    let scan_dir = temp_guard.path();
    let mut resolved_repo = repo.clone();
    resolved_repo.branch = resolved_branch; // 用实际成功分支，保证 readme_url 不 404
    scan_dir_recursive(scan_dir, scan_dir, &resolved_repo, &mut skills)?;
    Ok(skills)
}

async fn download_repo(
    client: &Client,
    archive_base: &str,
    repo: &SkillRepo,
) -> Result<(tempfile::TempDir, String)> {
    validate_repo_ref(&repo.owner, &repo.name, &repo.branch)?;

    let temp_dir = tempfile::tempdir()?;
    let temp_path = temp_dir.path().to_path_buf();

    // 分支候选：指定分支 → main → master（跳过哨兵）
    let mut branches: Vec<&str> = Vec::new();
    if !repo.branch.is_empty() && !repo.branch.eq_ignore_ascii_case("HEAD") {
        branches.push(repo.branch.as_str());
    }
    if !branches.contains(&"main") {
        branches.push("main");
    }
    if !branches.contains(&"master") {
        branches.push("master");
    }

    let mut last_error = None;
    for branch in branches {
        let url = format!(
            "{archive_base}/{}/{}/archive/refs/heads/{}.zip",
            repo.owner, repo.name, branch
        );
        assert_archive_landing(&url, archive_base, &repo.owner, &repo.name)?;

        match download_and_extract(client, &url, &temp_path).await {
            Ok(_) => return Ok((temp_dir, branch.to_string())),
            Err(error) => {
                // 每个分支各自重算预算，失败必须清掉上一轮残留，否则 N 个候选分支 = N 倍落盘
                let _ = std::fs::remove_dir_all(&temp_path);
                let _ = std::fs::create_dir_all(&temp_path);
                last_error = Some(error);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow!("所有分支下载失败")))
}

/// 出口断言（纵深防御）：默认落点走规格 §4 的 `assert_github_archive_url`
/// 逐字实现；测试注入的本地 base 只校验路径形状。
fn assert_archive_landing(url: &str, archive_base: &str, owner: &str, name: &str) -> Result<()> {
    if archive_base == GITHUB_ARCHIVE_BASE {
        return assert_github_archive_url(url, owner, name);
    }
    let parsed = url::Url::parse(url).map_err(|e| anyhow!("Invalid archive URL: {e}"))?;
    let expected_prefix = format!("/{owner}/{name}/archive/refs/heads/");
    if !parsed.path().starts_with(&expected_prefix) {
        return Err(anyhow!("INVALID_REPO_REF: URL 落点被改写"));
    }
    Ok(())
}

async fn download_and_extract(client: &Client, url: &str, dest: &Path) -> Result<()> {
    let response = client.get(url).send().await?;
    if !response.status().is_success() {
        // 403 → 提示被限流；404 → 提示仓库/分支不存在；429 → 提示稍后重试
        return Err(anyhow!("DOWNLOAD_FAILED status={}", response.status()));
    }

    // 逐块读并卡压缩体上限：不能只信 Content-Length（可撒谎/缺失），必须按实际字节算。
    // 不能在响应整体进内存后才开始预算——那时堆已被吃光。
    let mut response = response;
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len().saturating_add(chunk.len()) as u64 > MAX_ARCHIVE_DOWNLOAD_BYTES {
            return Err(anyhow!("ARCHIVE_TOO_LARGE"));
        }
        body.extend_from_slice(&chunk);
    }

    let cursor = std::io::Cursor::new(body);
    let archive = zip::ZipArchive::new(cursor)?;
    extract_repo_archive(archive, dest)?;
    flatten_archive_root(dest);
    Ok(())
}

/// 规格 §6.3 解压预算实现（按实际写出字节计费）。
fn extract_repo_archive(
    mut archive: zip::ZipArchive<std::io::Cursor<Vec<u8>>>,
    dest: &Path,
) -> Result<()> {
    let mut total_bytes: u64 = 0;
    let mut entries: usize = 0;

    for i in 0..archive.len() {
        entries += 1;
        if entries > MAX_ARCHIVE_ENTRIES {
            return Err(anyhow!("ARCHIVE_TOO_MANY_ENTRIES"));
        }
        let mut entry = archive.by_index(i)?;

        // 1) 先做路径穿越防护
        let entry_path = entry
            .enclosed_name()
            .ok_or_else(|| anyhow!("INVALID_ARCHIVE_PATH"))?;
        let out_path = dest.join(entry_path);

        // 2) symlink 条目：目标路径读入有 4KiB 上限（防 zip symlink 膨胀 bug）
        if entry.is_symlink() {
            let mut raw = Vec::new();
            let mut limited = std::io::Read::take(&mut entry, MAX_SYMLINK_TARGET_BYTES + 1);
            std::io::Read::read_to_end(&mut limited, &mut raw)?;
            if raw.len() as u64 > MAX_SYMLINK_TARGET_BYTES {
                return Err(anyhow!("SYMLINK_TARGET_TOO_LARGE"));
            }
            charge_archive_budget(&mut total_bytes, raw.len() as u64)?;
            let target = String::from_utf8(raw)
                .map_err(|_| anyhow!("SYMLINK_TARGET_NOT_UTF8"))?
                .trim()
                .to_string();
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&target, &out_path)?;
            }
            #[cfg(not(unix))]
            {
                let _ = target;
                let _ = &out_path;
            }
            continue;
        }

        // 3) 目录：按 4KiB 计费（空目录也吃 inode）
        if entry.is_dir() {
            charge_archive_budget(&mut total_bytes, DIRECTORY_BUDGET_COST)?;
            std::fs::create_dir_all(&out_path)?;
            continue;
        }

        // 4) 普通文件：逐块写并累计计费（不信任归档头里声明的 size，压缩炸弹会撒谎）
        charge_archive_budget(&mut total_bytes, DIRECTORY_BUDGET_COST)?; // 文件也占一个目录块（保守）
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut writer = std::fs::File::create(&out_path)?;
        let mut buffer = [0u8; 16 * 1024];
        loop {
            let read = entry.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            charge_archive_budget(&mut total_bytes, read as u64)?;
            writer.write_all(&buffer[..read])?;
        }
    }
    Ok(())
}

fn charge_archive_budget(total: &mut u64, add: u64) -> Result<()> {
    *total = total.saturating_add(add);
    if *total > MAX_ARCHIVE_TOTAL_BYTES {
        return Err(anyhow!("ARCHIVE_TOO_LARGE"));
    }
    Ok(())
}

/// GitHub 归档的 "<repo>-<branch>" 单层包装目录：内容上移一层。
/// 无包装（或顶层还有散文件）时不做任何事，保持归档结构。
fn flatten_archive_root(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut wrapper: Option<PathBuf> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if wrapper.is_some() {
                return; // 多个顶层目录：不是单包装结构
            }
            wrapper = Some(path);
        } else {
            return; // 顶层已有散文件：不展平
        }
    }
    let Some(wrapper) = wrapper else { return };
    let Ok(children) = std::fs::read_dir(&wrapper) else {
        return;
    };
    for child in children.flatten() {
        let target = root.join(child.file_name());
        if std::fs::rename(child.path(), &target).is_err() {
            return;
        }
    }
    let _ = std::fs::remove_dir(&wrapper);
}

/// 规格 §6.4 递归扫描 SKILL.md。
fn scan_dir_recursive(
    current_dir: &Path,
    base_dir: &Path,
    repo: &SkillRepo,
    skills: &mut Vec<DiscoverableRepoSkill>,
) -> Result<()> {
    let skill_md = current_dir.join("SKILL.md");

    // 目录含 SKILL.md → 该目录即一个 skill（识别规则）
    if skill_md.is_file() {
        let directory = if current_dir == base_dir {
            repo.name.clone() // 仓库根目录就是 skill（如 anthropics/skills 的根）
        } else {
            current_dir
                .strip_prefix(base_dir)
                .unwrap_or(current_dir)
                .to_string_lossy()
                .replace('\\', "/")
        };
        let doc_path = skill_md
            .strip_prefix(base_dir)
            .unwrap_or(skill_md.as_path())
            .to_string_lossy()
            .replace('\\', "/");

        if let Ok(skill) = build_skill_from_metadata(&skill_md, &directory, &doc_path, repo) {
            skills.push(skill);
        }
        return Ok(()); // 找到 SKILL.md 就停止向下递归（skill 不嵌套）
    }

    for entry in std::fs::read_dir(current_dir)? {
        let path = entry?.path();
        if path.is_dir() {
            scan_dir_recursive(&path, base_dir, repo, skills)?;
        }
    }
    Ok(())
}

fn build_skill_from_metadata(
    skill_md: &Path,
    directory: &str,
    doc_path: &str,
    repo: &SkillRepo,
) -> Result<DiscoverableRepoSkill> {
    let meta = parse_skill_metadata(skill_md)?;
    Ok(DiscoverableRepoSkill {
        key: format!("{}/{}:{}", repo.owner, repo.name, directory),
        name: meta.name.unwrap_or_else(|| directory.to_string()),
        description: meta.description.unwrap_or_default(),
        directory: directory.to_string(),
        readme_url: build_skill_doc_url(&repo.owner, &repo.name, &repo.branch, doc_path),
        repo_owner: repo.owner.clone(),
        repo_name: repo.name.clone(),
        repo_branch: repo.branch.clone(),
    })
}

/// README URL：https://github.com/{owner}/{repo}/blob/{branch}/{doc_path}
/// 坐标不合法返回 None（该值最终交给前端打开浏览器，必须可信）
fn build_skill_doc_url(owner: &str, repo: &str, branch: &str, doc_path: &str) -> Option<String> {
    if validate_repo_ref(owner, repo, branch).is_err() {
        return None;
    }
    Some(format!(
        "https://github.com/{owner}/{repo}/blob/{branch}/{doc_path}"
    ))
}

/// SKILL.md front-matter 解析：--- 分隔的 YAML，失败不报错，用 None 兜底
fn parse_skill_metadata(path: &Path) -> Result<SkillFileMetadata> {
    let content = std::fs::read_to_string(path)?;
    let content = content.trim_start_matches('\u{feff}'); // 去 BOM
    let parts: Vec<&str> = content.splitn(3, "---").collect();
    if parts.len() < 3 {
        return Ok(SkillFileMetadata {
            name: None,
            description: None,
        });
    }
    let front_matter = parts[1].trim();
    Ok(
        serde_yaml::from_str(front_matter).unwrap_or(SkillFileMetadata {
            name: None,
            description: None,
        }),
    )
}

#[derive(serde::Deserialize)]
struct SkillFileMetadata {
    name: Option<String>,
    description: Option<String>,
}

/// 规格 §6.5 去重（key = owner/name:directory）
fn deduplicate_discoverable_skills(skills: &mut Vec<DiscoverableRepoSkill>) {
    let mut seen = HashSet::new();
    skills.retain(|skill| seen.insert(skill.key.clone()));
}

/// 规格 §7.2 安全基线 #6：校验并规范化技能源路径（允许多级目录），
/// 拒绝路径穿越和绝对路径。
pub(crate) fn sanitize_skill_source_path(raw: &str) -> Option<PathBuf> {
    use std::path::Component;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut normalized = PathBuf::new();
    let mut has_component = false;
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(name) => {
                let segment = name.to_string_lossy().trim().to_string();
                if segment.is_empty() || segment == "." || segment == ".." {
                    return None;
                }
                normalized.push(segment);
                has_component = true;
            }
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return None;
            }
        }
    }
    has_component.then_some(normalized)
}

/// 校验解析出的源目录存在且 canonical 化后仍位于临时根内（防穿越）。
fn resolve_skill_source_dir(extract_root: &Path, relative: &Path) -> Result<PathBuf> {
    let candidate = extract_root.join(relative);
    let canonical_root = std::fs::canonicalize(extract_root)?;
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|_| anyhow!("INVALID_SKILL_DIRECTORY: {}", relative.display()))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(anyhow!(
            "INVALID_SKILL_DIRECTORY: resolved path escapes temp root"
        ));
    }
    Ok(canonical)
}

fn copy_dir_recursive(source: &Path, dest: &Path) -> Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let entry_path = entry.path();
        let target = dest.join(entry.file_name());
        if entry_path.is_dir() {
            copy_dir_recursive(&entry_path, &target)?;
        } else {
            std::fs::copy(&entry_path, &target)?;
        }
    }
    Ok(())
}

fn unique_download_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    format!("{}-{}", nanos, COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// 尽力清理超过 `max_age` 的历史下载残留；任何失败都被忽略。
pub fn cleanup_stale_downloads(dest_root: &Path, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(dest_root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let Ok(age) = modified.elapsed() else {
            continue;
        };
        if age > max_age {
            if metadata.is_dir() {
                let _ = std::fs::remove_dir_all(entry.path());
            } else {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// 下载目录的保留期。
pub fn stale_download_retention() -> Duration {
    Duration::from_secs(STALE_DOWNLOAD_MAX_AGE_SECONDS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn write_skill_md(dir: &Path, name: &str, description: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let mut file = std::fs::File::create(dir.join("SKILL.md")).unwrap();
        writeln!(file, "---").unwrap();
        writeln!(file, "name: {name}").unwrap();
        writeln!(file, "description: {description}").unwrap();
        writeln!(file, "---").unwrap();
        writeln!(file, "# body").unwrap();
    }

    fn build_zip(entries: Vec<(String, Vec<u8>)>) -> zip::ZipArchive<std::io::Cursor<Vec<u8>>> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut cursor);
            for (name, body) in entries {
                if body.is_empty() {
                    zip.add_directory(name, SimpleFileOptions::default())
                        .unwrap();
                } else {
                    zip.start_file(name, SimpleFileOptions::default()).unwrap();
                    zip.write_all(&body).unwrap();
                }
            }
            zip.finish().unwrap();
        }
        zip::ZipArchive::new(cursor).unwrap()
    }

    /// 规格 §11：解压预算——构造超 512MiB 解压流的 zip → 返回错误，不写盘。
    /// （512MiB 零字节流在 deflate 下极小，可快速构造。）
    #[test]
    fn extract_rejects_archives_over_total_budget() {
        let chunk = vec![0_u8; 64 * 1024];
        let mut body = Vec::new();
        for _ in 0..(512 * 1024 * 1024 / chunk.len() as u64 + 2) {
            body.extend_from_slice(&chunk);
        }
        let archive = build_zip(vec![("big.bin".into(), body)]);
        let dest = tempfile::tempdir().unwrap();
        let error = extract_repo_archive(archive, dest.path()).unwrap_err();
        assert!(error.to_string().contains("ARCHIVE_TOO_LARGE"), "{error}");
        // 逐块计费必然先写后错；残留由调用方兜底：TempDir drop 清理 +
        // download_repo 每个分支失败后的 remove_dir_all（§6.2）。
    }

    /// 规格 §11：解压预算——超 1 万条目的 zip → 返回错误。
    #[test]
    fn extract_rejects_archives_over_entry_budget() {
        let entries: Vec<(String, Vec<u8>)> = (0..10_001)
            .map(|i| (format!("dir{i}"), Vec::new()))
            .collect();
        let archive = build_zip(entries);
        let dest = tempfile::tempdir().unwrap();
        let error = extract_repo_archive(archive, dest.path()).unwrap_err();
        assert!(
            error.to_string().contains("ARCHIVE_TOO_MANY_ENTRIES"),
            "{error}"
        );
    }

    /// 规格 §11：解压预算——超长 symlink 目标 → 返回错误。
    #[test]
    fn extract_rejects_oversized_symlink_targets() {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut cursor);
            zip.add_symlink("evil", &"x".repeat(5 * 1024), SimpleFileOptions::default())
                .unwrap();
            zip.finish().unwrap();
        }
        let archive = zip::ZipArchive::new(cursor).unwrap();
        let dest = tempfile::tempdir().unwrap();
        let error = extract_repo_archive(archive, dest.path()).unwrap_err();
        assert!(
            error.to_string().contains("SYMLINK_TARGET_TOO_LARGE"),
            "{error}"
        );
    }

    #[test]
    fn parse_skill_metadata_reads_front_matter() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("SKILL.md");
        std::fs::write(&path, "---\nname: PDF\ndescription: Handle PDFs\n---\nbody").unwrap();
        let meta = parse_skill_metadata(&path).unwrap();
        assert_eq!(meta.name.as_deref(), Some("PDF"));
        assert_eq!(meta.description.as_deref(), Some("Handle PDFs"));
    }

    #[test]
    fn parse_skill_metadata_survives_missing_or_invalid_front_matter() {
        let temp = tempfile::tempdir().unwrap();
        let plain = temp.path().join("plain.md");
        std::fs::write(&plain, "# no front matter").unwrap();
        let meta = parse_skill_metadata(&plain).unwrap();
        assert!(meta.name.is_none() && meta.description.is_none());

        let invalid = temp.path().join("invalid.md");
        std::fs::write(&invalid, "---\n[not: valid: yaml\n---\nbody").unwrap();
        let meta = parse_skill_metadata(&invalid).unwrap();
        assert!(meta.name.is_none() && meta.description.is_none());
    }

    #[test]
    fn sanitize_skill_source_path_accepts_relative_and_rejects_traversal() {
        assert_eq!(sanitize_skill_source_path("a"), Some(PathBuf::from("a")));
        assert_eq!(
            sanitize_skill_source_path("a/b/c"),
            Some(PathBuf::from("a").join("b").join("c"))
        );
        assert_eq!(sanitize_skill_source_path(".."), None);
        assert_eq!(sanitize_skill_source_path("a/../b"), None);
        assert_eq!(sanitize_skill_source_path(""), None);
        assert_eq!(sanitize_skill_source_path("."), None);
        assert_eq!(sanitize_skill_source_path("/abs"), None);
        assert_eq!(sanitize_skill_source_path("C:\\abs"), None);
    }

    #[test]
    fn dedupe_keeps_first_key_occurrence_only() {
        let skill = |name: &str| DiscoverableRepoSkill {
            key: "o/r:dir".into(),
            name: name.into(),
            description: String::new(),
            directory: "dir".into(),
            readme_url: None,
            repo_owner: "o".into(),
            repo_name: "r".into(),
            repo_branch: "main".into(),
        };
        let mut skills = vec![skill("first"), skill("second")];
        deduplicate_discoverable_skills(&mut skills);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "first");
    }

    #[test]
    fn skill_doc_url_requires_valid_coordinates() {
        assert_eq!(
            build_skill_doc_url("anthropics", "skills", "main", "pdf/SKILL.md"),
            Some("https://github.com/anthropics/skills/blob/main/pdf/SKILL.md".into())
        );
        assert_eq!(
            build_skill_doc_url("../evil", "skills", "main", "SKILL.md"),
            None
        );
    }

    #[test]
    fn scan_dir_recursive_stops_at_skill_boundary_and_uses_repo_name_for_root() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        write_skill_md(&base.join("nested/tool"), "Tool", "nested skill");
        write_skill_md(&base.join("readme"), "Readme", "top skill");
        std::fs::create_dir_all(base.join("readme/child")).unwrap();
        write_skill_md(
            &base.join("readme/child/deeper"),
            "Deeper",
            "must not be scanned",
        );
        let repo = SkillRepo {
            owner: "o".into(),
            name: "r".into(),
            branch: "main".into(),
            enabled: true,
        };
        let mut skills = Vec::new();
        scan_dir_recursive(base, base, &repo, &mut skills).unwrap();
        let mut directories: Vec<String> = skills.iter().map(|s| s.directory.clone()).collect();
        directories.sort();
        assert_eq!(directories, vec!["nested/tool", "readme"]);
    }

    #[test]
    fn flatten_archive_root_unwraps_single_wrapper_dir_only() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let wrapper = root.join("repo-main");
        write_skill_md(&wrapper.join("pdf"), "PDF", "d");
        flatten_archive_root(root);
        assert!(root.join("pdf").is_dir());
        assert!(!wrapper.exists());

        // 顶层散文件存在时不展平
        let temp2 = tempfile::tempdir().unwrap();
        let root2 = temp2.path();
        std::fs::write(root2.join("loose.txt"), b"x").unwrap();
        let wrapper2 = root2.join("repo-main");
        write_skill_md(&wrapper2.join("pdf"), "PDF", "d");
        flatten_archive_root(root2);
        assert!(wrapper2.exists());
    }
}
