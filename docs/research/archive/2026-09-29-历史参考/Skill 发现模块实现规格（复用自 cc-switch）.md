# Skill 发现模块实现规格（复用自 cc-switch）

> 本文档是给**开发 agent** 的直接实现规格：目标、架构、数据结构、代码骨架、安全约束、验收清单。
> 所有内容基于 cc-switch 仓库 `v3.19.x` 源码（`src-tauri/src/services/skill.rs`、`database/schema.rs`、`database/dao/skills.rs`、`app_config.rs`、`src/hooks/useSkills.ts`、`src/components/skills/SkillsPage.tsx`）提炼改写，去除项目特有耦合，适配本项目（Tauri + React + Rust + SQLite）。
> 代码骨架中的函数签名、常量、安全规则为**必须保留**的基线；命名空间、模块组织可随项目调整。

---

## 0. 给开发 agent 的任务摘要

实现一个「发现 + 安装 Skill」模块，能力如下：

1. **skills.sh 公共注册表搜索**：调 `https://skills.sh/api/search`，返回可安装的 skill 列表（含来源仓库坐标），支持分页。
2. **GitHub 仓库 Skill 发现**：从用户配置的 GitHub 仓库列表（默认内置 4 个）下载仓库 ZIP，递归扫描 `SKILL.md`，解析元数据，汇总为可安装列表。
3. **统一安装管线**：两条发现链路的产物归一为同一结构，安装时下载到 SSOT（单一事实源）目录，落盘 + 计算内容哈希 + 写入 SQLite + 按需同步到目标应用目录。

**验收标准**（详见 §11）：三条链路端到端可用；第三方内容解压有预算上限；仓库坐标有白名单校验；安装目录无路径穿越；前端搜索 ≥2 字符才发请求、分页累积加载。

---

## 1. 总体架构

### 1.1 分层

```
┌─ Tauri command 层（薄桥，参数透传 + AppState 注入）
│    search_skills_sh / discover_available_skills / install_skill / get_skill_repos ...
├─ Service 层（全部业务逻辑，纯 Rust，不依赖 Tauri 类型）
│    skill::search_skills_sh()
│    skill::discover_available(repos)
│    skill::install(db, skill, app)
├─ 存储层
│    SQLite：skill_repos 表（仓库配置）、skills 表（安装记录）
│    文件系统：SSOT 目录（安装内容本体）、各应用 skills 目录（同步目标）
└─ 前端（React + TanStack Query）
     api/skills.ts（invoke 封装）→ hooks/useSkills.ts（query/mutation）→ SkillsPage.tsx（UI）
```

### 1.2 关键设计决策（改动前先读，不要自行推翻）

| 决策 | 理由 |
|---|---|
| **SSOT 单一事实源**：安装内容只写 `~/.cc-switch/skills/`（本项目可换目录名），不直接写各应用目录；装完再按启用状态同步 | 多应用共享同一份安装，卸载/更新/回滚只动一处；应用目录可随时重建 |
| **发现与安装解耦**：两条发现链路都产 `DiscoverableSkill`，安装管线只认这一个结构 | skills.sh 只给 `owner/repo + skillId`，仓库扫描给完整路径，二者必须归一 |
| **不依赖 GitHub API / 无 token**：仓库发现用 `archive/refs/heads/{branch}.zip` 下载 + 本地扫描 | 免鉴权、免限流、免 API 兼容性维护；代价是每次发现都要整仓下载（仓库大时慢），可接受 |
| **分支回退**：`指定分支 → main → master` 依次尝试 | 仓库默认分支名不确定，`HEAD` 语义不可直接拼 URL |
| **发现结果不落库**：`discover_available` 每次现扫，只有安装才写 DB | 仓库内容随时变，缓存会过期；列表页体验靠前端 `staleTime: Infinity` 缓存 |
| **安全预算贯穿下载→解压→落盘** | 第三方仓库内容不可信，见 §6.2 |

### 1.3 依赖清单

```toml
# Cargo.toml（新增/必保项）
reqwest = { version = "0.12", features = ["rustls-tls", "json", "stream"] }
tokio = { version = "1", features = ["macros", "rt-multi-thread", "time"] }
futures = "0.3"              # join_all 并行仓库发现
zip = "2.2"                  # 归档解压
serde_yaml = "0.9"           # SKILL.md front-matter 解析
url = "2.5"                  # URL 拼参与解析
sha2 = "0.10"                # 内容哈希（更新检测）
anyhow = "1.0"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tempfile = "3"               # 下载/解压的临时目录
rusqlite = { version = "0.31", features = ["bundled"] }  # 或项目现有 DB 层
log = "0.4"
```

```jsonc
// package.json（前端新增）
"@tanstack/react-query": "^5",
"@tauri-apps/api": "^2"
```

---

## 2. 核心数据结构（Rust，与前端 TS 一一对应）

```rust
// ========== 发现层 ==========
/// 可发现的技能（两条链路共同的产物）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverableSkill {
    /// 唯一标识："owner/name:directory"
    pub key: String,
    /// 显示名称（从 SKILL.md 解析，缺失用 directory 兜底）
    pub name: String,
    /// 描述（可为空串）
    pub description: String,
    /// 目录名（安装路径的最后一段；允许多级相对路径如 "a/b/c"）
    pub directory: String,
    /// GitHub README URL
    pub readme_url: Option<String>,
    pub repo_owner: String,
    pub repo_name: String,
    pub repo_branch: String,
}

/// 仓库配置（存 skill_repos 表）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRepo {
    pub owner: String,
    pub name: String,
    /// 空串 或 "HEAD" 为哨兵：下载时跳过该分支，改试 main/master
    pub branch: String,
    pub enabled: bool,
}

// ========== 安装层 ==========
/// 已安装技能（存 skills 表；apps 是启用目标应用集合，简化版可退化为单应用布尔）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    pub id: String,                      // "owner/repo:directory" 或 "local:directory"
    pub name: String,
    pub description: Option<String>,
    pub directory: String,               // SSOT 下的子目录名（只用末段）
    pub repo_owner: Option<String>,
    pub repo_name: Option<String>,
    pub repo_branch: Option<String>,
    pub readme_url: Option<String>,
    pub apps: SkillApps,                 // 见下
    pub installed_at: i64,               // Unix 时间戳
    pub content_hash: Option<String>,    // SHA-256，更新检测用
    pub updated_at: i64,                 // 0 = 从未更新
}

/// 简化版应用启用集合：若项目只支持单一应用，可替换为 `pub enabled: bool`（见 §10 裁剪）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillApps {
    pub claude: bool,
    pub codex: bool,
    pub gemini: bool,
    // 可按项目实际支持的应用增减
}

// ========== skills.sh API 类型 ==========
/// 注意：API 命名不一致（searchType 是 camelCase，duration_ms 是 snake_case），
/// 必须逐字段指定 rename，不能整体用 rename_all。
#[derive(Debug, Clone, Deserialize)]
struct SkillsShApiResponse {
    pub query: String,
    #[serde(rename = "searchType")]
    pub search_type: String,
    pub skills: Vec<SkillsShApiSkill>,
    pub count: usize,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct SkillsShApiSkill {
    pub id: String,
    #[serde(rename = "skillId")]
    pub skill_id: String,
    pub name: String,
    pub installs: u64,
    /// 形如 "owner/repo"；可能是裸坐标，也可能含额外路径段
    pub source: String,
}

/// 搜索返回给前端的结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsShSearchResult {
    pub skills: Vec<SkillsShDiscoverableSkill>,
    pub total_count: usize,
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsShDiscoverableSkill {
    pub key: String,
    pub name: String,
    pub directory: String,       // 即 skillId（末级目录名）
    pub repo_owner: String,
    pub repo_name: String,
    pub repo_branch: String,     // 固定 "main"
    pub installs: u64,
    pub readme_url: Option<String>,
}

/// SKILL.md front-matter（YAML）
#[derive(Debug, Clone, Deserialize)]
pub struct SkillMetadata {
    pub name: Option<String>,
    pub description: Option<String>,
}
```

---

## 3. SQLite Schema

```sql
-- 安装记录（InstalledSkill 落库）
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,                      -- "owner/repo:directory" | "local:directory"
    name TEXT NOT NULL,
    description TEXT,
    directory TEXT NOT NULL,
    repo_owner TEXT,
    repo_name TEXT,
    repo_branch TEXT DEFAULT 'main',
    readme_url TEXT,
    enabled_claude BOOLEAN NOT NULL DEFAULT 0,
    enabled_codex BOOLEAN NOT NULL DEFAULT 0,
    enabled_gemini BOOLEAN NOT NULL DEFAULT 0,
    installed_at INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
);

-- 仓库配置
CREATE TABLE IF NOT EXISTS skill_repos (
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT 'main',      -- 空串/HEAD 为"默认分支"哨兵，必须允许
    enabled BOOLEAN NOT NULL DEFAULT 1,
    PRIMARY KEY (owner, name)
);

-- 可选：settings 表存初始化标记等
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
```

**初始化逻辑**：`skill_repos` 为空且 `settings.default_skill_repos_initialized` 未置位时，写入默认 4 仓库并置位：

```rust
const DEFAULT_SKILL_REPOS: [(&str, &str, &str); 4] = [
    ("anthropics",   "skills",                     "main"),
    ("ComposioHQ",   "awesome-claude-skills",      "master"),
    ("cexll",        "myclaude",                   "master"),
    ("JimLiu",       "baoyu-skills",               "main"),
];
```

**查询**：安装列表 `SELECT ... FROM skills ORDER BY name ASC`；仓库列表 `SELECT owner, name, branch, enabled FROM skill_repos ORDER BY owner ASC, name ASC`。

---

## 4. 仓库坐标校验（安全基线 #1，所有进 URL 的坐标必须过这里）

```rust
/// owner：GitHub 用户名/组织，仅字母数字与 '-'
pub(crate) fn is_valid_github_owner(owner: &str) -> bool {
    !owner.is_empty()
        && owner.len() <= 39
        && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// repo 名：允许 . - _，但不能整体是 "." 或 ".."
pub(crate) fn is_valid_github_repo_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name != "."
        && name != ".."
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// 分支：按 '/' 分段做白名单（分支名合法含 '/'，如 feature/x）
fn is_valid_git_branch(branch: &str) -> bool {
    if branch.is_empty() || branch.eq_ignore_ascii_case("HEAD") {
        return true; // 哨兵，永不进 URL，见 §1.2
    }
    if branch.len() > 255 { return false; }
    branch.split('/').all(|seg| {
        !seg.is_empty()
            && seg != "."
            && seg != ".."
            && seg.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    })
}

pub(crate) fn validate_repo_ref(owner: &str, name: &str, branch: &str) -> Result<()> {
    if !is_valid_github_owner(owner) || !is_valid_github_repo_name(name) {
        return Err(anyhow!("INVALID_REPO_REF: {owner}/{name}"));
    }
    if !is_valid_git_branch(branch) {
        return Err(anyhow!("INVALID_REPO_REF: {owner}/{name}@{branch}"));
    }
    Ok(())
}

/// 出口断言（纵深防御）：URL 拼好后再次确认它确实指向预期的 github.com 路径。
/// 即使字符集校验将来漏了某种变形（百分号编码等），这里也能拦住落点改写。
fn assert_github_archive_url(url: &str, owner: &str, name: &str) -> Result<()> {
    let parsed = url::Url::parse(url).map_err(|e| anyhow!("Invalid archive URL: {e}"))?;
    let expected_prefix = format!("/{owner}/{name}/archive/refs/heads/");
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || !parsed.path().starts_with(&expected_prefix)
    {
        return Err(anyhow!("INVALID_REPO_REF: URL 落点被改写"));
    }
    Ok(())
}
```

---

## 5. 链路 A：skills.sh 公共注册表搜索

### 5.1 实现（直接可用）

```rust
use std::time::Duration;

pub async fn search_skills_sh(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
    offset: usize,
) -> Result<SkillsShSearchResult> {
    let url = url::Url::parse_with_params(
        "https://skills.sh/api/search",
        &[
            ("q", query),
            ("limit", &limit.to_string()),
            ("offset", &offset.to_string()),
        ],
    )?;

    let resp = client
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?
        .json::<SkillsShApiResponse>()
        .await?;

    let skills = resp
        .skills
        .into_iter()
        .filter_map(|s| {
            // 只认 "owner/repo"；splitn(2) 保证 repo 内即使含 '/' 也只拆一段
            let parts: Vec<&str> = s.source.splitn(2, '/').collect();
            if parts.len() != 2 {
                return None;
            }
            let (owner, repo) = (parts[0].to_string(), parts[1].to_string());
            // 与 download_repo 同一套坐标校验：
            // 1) 防注入；2) 顺带过滤非 GitHub 来源（带点的 owner 不是合法用户名）
            if validate_repo_ref(&owner, &repo, "main").is_err() {
                return None;
            }
            Some(SkillsShDiscoverableSkill {
                key: s.id,
                name: s.name,
                directory: s.skill_id.clone(),
                repo_owner: owner.clone(),
                repo_name: repo.clone(),
                repo_branch: "main".to_string(),
                installs: s.installs,
                readme_url: Some(format!("https://github.com/{owner}/{repo}")),
            })
        })
        .collect();

    Ok(SkillsShSearchResult {
        skills,
        total_count: resp.count,
        query: resp.query,
    })
}
```

### 5.2 要点

- **超时 10s**；失败直接返回错误，由前端提示网络问题。
- **`splitn(2, '/')` 而非 `split('/')`**：skills.sh 的 `source` 有时含额外路径段，`split` 会拆出三段导致误判非法。
- **`directory = skillId`**：skills.sh 的 skillId 是仓库根目录下的 skill 目录名（末级）。安装时下载整仓后按它定位子目录。
- **readme_url 指向仓库首页**（`github.com/owner/repo`），不是具体文件——skills.sh 不给确切路径。

---

## 6. 链路 B：GitHub 仓库 Skill 发现

### 6.1 主流程

```rust
pub async fn discover_available(
    client: &reqwest::Client,
    repos: Vec<SkillRepo>,
) -> Result<Vec<DiscoverableSkill>> {
    // 仅用启用仓库
    let enabled: Vec<SkillRepo> = repos.into_iter().filter(|r| r.enabled).collect();

    // 并行下载+扫描；单个仓库失败只告警，不拖垮整体
    let results: Vec<Result<Vec<DiscoverableSkill>>> =
        futures::future::join_all(enabled.iter().map(|r| fetch_repo_skills(client, r))).await;

    let mut skills = Vec::new();
    for (repo, result) in enabled.into_iter().zip(results) {
        match result {
            Ok(mut repo_skills) => skills.append(&mut repo_skills),
            Err(e) => log::warn!("获取仓库 {}/{} 技能失败: {}", repo.owner, repo.name, e),
        }
    }

    // 去重 + 按名称排序
    deduplicate_discoverable_skills(&mut skills);
    skills.sort_by_key(|s| s.name.to_lowercase());
    Ok(skills)
}

async fn fetch_repo_skills(
    client: &reqwest::Client,
    repo: &SkillRepo,
) -> Result<Vec<DiscoverableSkill>> {
    // 60s 超时包住整个下载+解压
    let (temp_guard, resolved_branch) = tokio::time::timeout(
        Duration::from_secs(60),
        download_repo(client, repo),
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
```

### 6.2 下载 + 解压（安全预算 #2，#3，#4，#5）

```rust
/// 常量（必须保留，来源 cc-switch，见代码注释的攻防理由）
const MAX_ARCHIVE_ENTRIES: usize = 10_000;          // 解压条目上限（防海量小文件耗 inode）
const MAX_ARCHIVE_TOTAL_BYTES: u64 = 512 * 1024 * 1024;  // 解压后总字节上限（防压缩炸弹）
const MAX_SYMLINK_TARGET_BYTES: u64 = 4 * 1024;     // symlink 目标上限（防 zip crate 的 symlink 膨胀 bug 打穿内存）
const DIRECTORY_BUDGET_COST: u64 = 4096;            // 每个目录按 4KiB 计费（防空目录无限造 inode）
const MAX_ARCHIVE_DOWNLOAD_BYTES: u64 = 128 * 1024 * 1024; // 压缩体上限（流式计数，防下载阶段撑爆内存）

async fn download_repo(client: &reqwest::Client, repo: &SkillRepo) -> Result<(tempfile::TempDir, String)> {
    validate_repo_ref(&repo.owner, &repo.name, &repo.branch)?;

    let temp_dir = tempfile::tempdir()?;
    let temp_path = temp_dir.path().to_path_buf();

    // 分支候选：指定分支 → main → master（跳过哨兵）
    let mut branches: Vec<&str> = Vec::new();
    if !repo.branch.is_empty() && !repo.branch.eq_ignore_ascii_case("HEAD") {
        branches.push(repo.branch.as_str());
    }
    if !branches.contains(&"main") { branches.push("main"); }
    if !branches.contains(&"master") { branches.push("master"); }

    let mut last_error = None;
    for branch in branches {
        let url = format!(
            "https://github.com/{}/{}/archive/refs/heads/{}.zip",
            repo.owner, repo.name, branch
        );
        assert_github_archive_url(&url, &repo.owner, &repo.name)?;

        match download_and_extract(client, &url, &temp_path).await {
            Ok(_) => return Ok((temp_dir, branch.to_string())),
            Err(e) => {
                // 每个分支各自重算预算，失败必须清掉上一轮残留，否则 N 个候选分支 = N 倍落盘
                let _ = std::fs::remove_dir_all(&temp_path);
                let _ = std::fs::create_dir_all(&temp_path);
                last_error = Some(e);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow!("所有分支下载失败")))
}

async fn download_and_extract(client: &reqwest::Client, url: &str, dest: &Path) -> Result<()> {
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
    extract_repo_archive(archive, dest)   // 见 6.3
}
```

### 6.3 解压预算实现（按实际写出字节计费）

```rust
fn extract_repo_archive(mut archive: zip::ZipArchive<std::io::Cursor<Vec<u8>>>, dest: &Path) -> Result<()> {
    let mut total_bytes: u64 = 0;
    let mut entries: usize = 0;

    for i in 0..archive.len() {
        entries += 1;
        if entries > MAX_ARCHIVE_ENTRIES {
            return Err(anyhow!("ARCHIVE_TOO_MANY_ENTRIES"));
        }
        let mut entry = archive.by_index(i)?;

        // 1) 先做路径穿越防护
        let entry_path = entry.enclosed_name().ok_or_else(|| anyhow!("INVALID_ARCHIVE_PATH"))?;
        let out_path = dest.join(entry_path);

        // 2) symlink 条目：目标路径读入有 4KiB 上限（防 zip 2.4.2 symlink 膨胀 bug）
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
                .trim().to_string();
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, &out_path)?;
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
            if read == 0 { break; }
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
```

> 简化说明：cc-switch 中 symlink 分支"超长/非 UTF-8 一律跳过"而非报错；目录/文件计费口径同此保守原则。真实实现建议照抄 cc-switch 的 `extract_local_zip` / `extract_repo_archive`（`skill.rs` 3157–3900 行区间），本骨架已保留全部上限常量。

### 6.4 递归扫描 SKILL.md

```rust
fn scan_dir_recursive(
    current_dir: &Path,
    base_dir: &Path,
    repo: &SkillRepo,
    skills: &mut Vec<DiscoverableSkill>,
) -> Result<()> {
    let skill_md = current_dir.join("SKILL.md");

    // 目录含 SKILL.md → 该目录即一个 skill（识别规则）
    if skill_md.exists() {
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
) -> Result<DiscoverableSkill> {
    let meta = parse_skill_metadata(skill_md)?;
    Ok(DiscoverableSkill {
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
/// 坐标不合法返回 None（该值最终交给前端 openExternal 打开，必须可信）
fn build_skill_doc_url(owner: &str, repo: &str, branch: &str, doc_path: &str) -> Option<String> {
    if validate_repo_ref(owner, repo, branch).is_err() {
        log::warn!("跳过非法仓库坐标的文档链接: {owner}/{repo}@{branch}");
        return None;
    }
    Some(format!("https://github.com/{owner}/{repo}/blob/{branch}/{doc_path}"))
}

/// SKILL.md front-matter 解析：--- 分隔的 YAML，失败不报错，用 None 兜底
fn parse_skill_metadata(path: &Path) -> Result<SkillMetadata> {
    let content = std::fs::read_to_string(path)?;
    let content = content.trim_start_matches('\u{feff}'); // 去 BOM
    let parts: Vec<&str> = content.splitn(3, "---").collect();
    if parts.len() < 3 {
        return Ok(SkillMetadata { name: None, description: None });
    }
    let front_matter = parts[1].trim();
    Ok(serde_yaml::from_str(front_matter).unwrap_or(SkillMetadata {
        name: None,
        description: None,
    }))
}
```

### 6.5 去重

```rust
fn deduplicate_discoverable_skills(skills: &mut Vec<DiscoverableSkill>) {
    let mut seen = std::collections::HashSet::new();
    skills.retain(|s| seen.insert(s.key.clone())); // key = owner/name:directory
}
```

---

## 7. 统一安装管线

### 7.1 目录规划

```
<app_config_dir>/skills/          # SSOT：~/.cc-switch/skills/（本项目可改，如 ~/.<app>/skills）
<home>/.claude/skills/            # 目标应用目录示例（每个支持的应用一个）
```

### 7.2 安装流程（install）

```
1. 校验 skill.directory：
   sanitize_skill_source_path()  —— 允许多级相对路径（a/b/c），拒绝 .. / 绝对路径 / 空段 / . 段
   install_name = directory 的最后一段（sanitize 后再取，SSOT 中只建一级目录）
2. 已存在同名安装？
   ├─ 同仓库 → 直接更新该应用的启用状态，返回（幂等）
   └─ 不同仓库 → 报 SKILL_DIRECTORY_CONFLICT，提示先卸载（目录名冲突不可静默覆盖）
3. SSOT 下目标目录不存在时：
   a. download_repo（§6.2，含全部预算）→ 临时目录
   b. resolve_skill_source_dir：temp/<directory>，并校验 canonical 后仍在临时目录内（防穿越）
   c. 用真实解析出的源目录推导 doc_path（嵌套目录场景不能直接用 skillId 拼，会 404）
   d. 复制到 SSOT：copy_dir_recursive(source, dest)
4. 计算内容哈希（递归 SHA-256，失败仅告警不中断安装）
5. 写 InstalledSkill 到 DB（id = skill.key，apps 只启用当前应用）
6. 同步到当前应用目录：symlink 优先，失败回退 copy（或按 SyncMethod 设置）
7. 返回 InstalledSkill
```

**路径安全（安全基线 #6）：**

```rust
/// 校验并规范化技能源路径（允许多级目录），拒绝路径穿越和绝对路径
fn sanitize_skill_source_path(raw: &str) -> Option<std::path::PathBuf> {
    use std::path::Component;
    let trimmed = raw.trim();
    if trimmed.is_empty() { return None; }

    let mut normalized = std::path::PathBuf::new();
    let mut has_component = false;
    for component in std::path::Path::new(trimmed).components() {
        match component {
            Component::Normal(name) => {
                let segment = name.to_string_lossy().trim().to_string();
                if segment.is_empty() || segment == "." || segment == ".." { return None; }
                normalized.push(segment);
                has_component = true;
            }
            Component::CurDir | Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return None;
            }
        }
    }
    has_component.then_some(normalized)
}
```

**同步到应用目录（symlink/copy 二选一）：**

```rust
fn sync_to_app_dir(install_name: &str, app: AppType) -> Result<()> {
    let ssot = get_ssot_dir()?.join(install_name);
    let app_skills = get_app_skills_dir(app)?;   // 见 §7.4
    let target = app_skills.join(install_name);

    // 目标已存在且不是指向 SSOT 的链接 → 属外部管理，跳过（不覆盖用户已有内容）
    if target.exists() || target.symlink_metadata().is_ok() {
        if paths_alias(&target, &ssot) { return Ok(()); }
        // 否则视为外部内容，跳过并告警
        log::warn!("{} 已存在于应用目录且非本模块管理，跳过同步", target.display());
        return Ok(());
    }

    std::fs::create_dir_all(&app_skills)?;
    match std::os::unix::fs::symlink(&ssot, &target) {
        Ok(_) => {}
        Err(_) => copy_dir_recursive(&ssot, &target)?, // 回退：文件复制（Windows/无权限场景）
    }
    Ok(())
}
```

> cc-switch 完整版还包含：卸载（先备份到 `skill-backups/` 再删 SSOT/DB）、更新检测（对比远端哈希与本地 `content_hash`）、存储位置迁移、从 `.agents/.skill-lock.json` 导入外部仓库。以上为**可选增强**，首版可不做（见 §10）。

### 7.3 并发安全（可选但推荐）

```rust
// 全局锁：下载期间释放写锁（不跨 .await 持有 std 锁），下载完成后再拿写锁做"落盘+入库+同步"
// 保证并发安装/卸载时 DB 与文件系统状态原子一致。
fn skill_state_lock() -> &'static std::sync::RwLock<()> {
    use std::sync::OnceLock;
    static LOCK: OnceLock<std::sync::RwLock<()>> = OnceLock::new();
    LOCK.get_or_init(|| std::sync::RwLock::new(()))
}
// 使用模式：
//   let _guard = skill_state_lock().write()...;  // 只有下载完成后的落盘段持有
```

### 7.4 应用目录解析（按项目实际支持的应用裁剪）

```rust
fn get_app_skills_dir(app: AppType) -> Result<PathBuf> {
    let home = home_dir();
    Ok(match app {
        AppType::Claude => home.join(".claude").join("skills"),
        AppType::Codex  => home.join(".codex").join("skills"),
        AppType::Gemini => home.join(".gemini").join("skills"),
        // ...按需
    })
}
```

---

## 8. 前端集成（React + TanStack Query）

### 8.1 TS 类型（与 §2 对应，snake_case → camelCase）

```ts
export interface DiscoverableSkill {
  key: string;
  name: string;
  description: string;
  directory: string;
  readmeUrl?: string;
  repoOwner: string;
  repoName: string;
  repoBranch: string;
}
export interface SkillsShDiscoverableSkill {
  key: string; name: string; directory: string;
  repoOwner: string; repoName: string; repoBranch: string;
  installs: number; readmeUrl?: string;
}
export interface SkillsShSearchResult {
  skills: SkillsShDiscoverableSkill[];
  totalCount: number;
  query: string;
}
export interface SkillRepo { owner: string; name: string; branch: string; enabled: boolean; }
export interface InstalledSkill {
  id: string; name: string; description?: string; directory: string;
  repoOwner?: string; repoName?: string; repoBranch?: string; readmeUrl?: string;
  apps: SkillApps; installedAt: number; contentHash?: string; updatedAt: number;
}
```

### 8.2 API 封装

```ts
import { invoke } from "@tauri-apps/api/core";

export const skillsApi = {
  searchSkillsSh: (query: string, limit: number, offset: number) =>
    invoke<SkillsShSearchResult>("search_skills_sh", { query, limit, offset }),
  discoverAvailable: () => invoke<DiscoverableSkill[]>("discover_available_skills"),
  installUnified: (skill: DiscoverableSkill, currentApp: string) =>
    invoke<InstalledSkill>("install_skill_unified", { skill, currentApp }),
  getRepos: () => invoke<SkillRepo[]>("get_skill_repos"),
  addRepo: (repo: SkillRepo) => invoke<boolean>("add_skill_repo", { repo }),
  removeRepo: (owner: string, name: string) => invoke<boolean>("remove_skill_repo", { owner, name }),
  getInstalled: () => invoke<InstalledSkill[]>("get_installed_skills"),
};
```

### 8.3 Hooks（关键：缓存与分页模式）

```ts
// 搜索：300ms staleTime + keepPreviousData 平滑体验；查询词 <2 字符不发请求
export function useSearchSkillsSh(query: string, limit: number, offset: number) {
  return useQuery({
    queryKey: ["skills", "skillssh", query, limit, offset],
    queryFn: () => skillsApi.searchSkillsSh(query, limit, offset),
    enabled: query.length >= 2,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}

// 仓库发现：首次进入用缓存，刷新才重取（后端每次现扫，前端必须缓存）
export function useDiscoverableSkills() {
  return useQuery({
    queryKey: ["skills", "discoverable"],
    queryFn: () => skillsApi.discoverAvailable(),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
}
```

### 8.4 搜索页交互要点（照抄 cc-switch SkillsPage 的模式）

- 输入框**手动触发**（Enter 或按钮，不实时请求）：`handleSearch = () => { const t = input.trim(); if (t === query && offset === 0) return; setOffset(0); setQuery(t); }`
- **累积加载更多**：`PAGE_SIZE = 20`；点"加载更多" → `setOffset(prev => prev + PAGE_SIZE)`；用 `useEffect` 在结果返回且非 placeholder 时 `accumulated = [...accumulated, ...newSkills]`（offset===0 时重置）。
- 安装前把 skills.sh 结果转成统一结构复用安装流程：

```ts
const toDiscoverableSkill = (s: SkillsShDiscoverableSkill): DiscoverableSkill => ({
  key: s.key, name: s.name, description: "",
  directory: s.directory,
  repoOwner: s.repoOwner, repoName: s.repoName, repoBranch: s.repoBranch,
  readmeUrl: s.readmeUrl,
});
```

- 仓库发现列表的"已安装"状态：用已安装列表的 `directory` 集合比对（`installedDirs.has(skill.directory)`）。

---

## 9. Tauri command 桥（薄层）

```rust
// commands/skill.rs（示意；参数与返回类型见 §2/§5/§6）
#[tauri::command]
pub async fn search_skills_sh(query: String, limit: usize, offset: usize) -> Result<SkillsShSearchResult, String> {
    let client = crate::http_client::get();
    SkillService::search_skills_sh(&client, &query, limit, offset).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn discover_available_skills(app_state: State<'_, AppState>) -> Result<Vec<DiscoverableSkill>, String> {
    let repos = app_state.db.get_skill_repos().map_err(|e| e.to_string())?;
    let client = crate::http_client::get();
    SkillService::discover_available(&client, repos).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_skill_unified(skill: DiscoverableSkill, current_app: String, app_state: State<'_, AppState>) -> Result<InstalledSkill, String> {
    SkillService::install(&app_state.db, &skill, parse_app(&current_app)?).await.map_err(|e| e.to_string())
}

// 注册：lib.rs 的 invoke_handler 中追加以上命令
```

> HTTP 客户端建议用 reqwest::Client 单例（Tauri setup 中创建，State 注入），复用连接池 + 统一代理配置。

---

## 10. 裁剪建议（按项目范围选档）

| 档位 | 包含 | 裁掉 |
|---|---|---|
| **最小版（只搜索）** | §5 skills.sh 搜索 + §4 校验 + command 桥 | 仓库发现、安装管线、DB 两张表仍要（skills 表可后加） |
| **标准版（推荐）** | §5 + §6 + §7 安装到单一应用目录（`SkillApps` 退化为 `enabled: bool`）+ §8 | 多应用同步、卸载备份、更新检测、lock 文件导入 |
| **完整版** | 全部 + 卸载备份/恢复、更新检测（哈希对比）、存储位置迁移、`.agents/.skill-lock.json` 导入 | — |

**单应用退化改动**：`SkillApps` → `pub enabled: bool`；`skills` 表把 `enabled_claude/enabled_codex/enabled_gemini` 三列合并为一列 `enabled`；`sync_to_app_dir` 的 app 参数固定。

---

## 11. 测试与验收清单

### 单元测试（参照 cc-switch `skill.rs` 测试模块）

| 用例 | 断言 |
|---|---|
| `validate_repo_ref` 接受：`main`、`master`、`HEAD`、`feature/new-thing`、`release/v1.2.3`、`fix-123`、空串 | Ok |
| `validate_repo_ref` 拒绝：`../../../releases/download/v1/evil`、`..`、`../x`、`a/../../b`、`a/./b`、`..\\..\\releases\\...`、`/leading`、`trailing/`、`double//slash`、`with space`、`frag#ment`、`pct%2e%2e`、`ref@{0}`、`seg.lock`、`.hidden/x` | Err |
| `validate_repo_ref` 拒绝非法坐标：owner 含 `/` 或 `.`（如 `skills.volces.com`）、repo 为 `..` 或 `re/po` 或含空格 | Err |
| `sanitize_skill_source_path`：拒绝 `..`、`a/../b`、空串、`.`、绝对路径；接受 `a`、`a/b/c` | 按预期 |
| `parse_skill_metadata`：标准 front-matter → 正确 name/description；无 front-matter → None；非法 YAML → None 不 panic | 按预期 |
| `scan_dir_recursive`：构造含多个 SKILL.md 的目录树 → 数量正确、directory 为相对路径、根目录 SKILL.md 用仓库名 | 按预期 |
| 解压预算：构造超 512MiB 解压流 / 超 1 万条目 / 超长 symlink 目标 的 zip → 返回对应错误，不写盘 | 按预期 |
| 分支回退：`download_repo` 对 `master` 仓库返回实际分支 | 按预期（可 mock） |

### 集成验收

1. `search_skills_sh("find", 20, 0)` 返回 ≥1 条结果，`totalCount` 与 API 一致；`directory` 均为 skillId 末级名。
2. `discover_available` 对默认 4 仓库返回列表，key 格式均为 `owner/name:directory`，无重复。
3. 安装一个 skill → SSOT 出现 `install_name` 目录 → 目标应用目录出现 symlink → `skills` 表有记录（含 content_hash）。
4. 重复安装同一 skill → 幂等（不重复下载，直接返回已安装记录）。
5. 安装与另一仓库同目录名的 skill → 报目录冲突，不覆盖。
6. 前端：输入 1 个字符不触发请求；搜索 20 条后点"加载更多"累积到 40 条。
7. 断网/仓库 404 时：发现列表其余仓库结果仍展示，失败仓库仅告警。

### 声明口径

- 本规格所有常量、字段、流程直接取自 cc-switch 实际源码；标注"可选增强"的部分未展开实现细节，实现时按需回查源仓库 `src-tauri/src/services/skill.rs`。
