use serde::{Deserialize, Serialize};

/// GitHub 仓库配置（发现模块规格 §2；空串或 "HEAD" 为"默认分支"哨兵）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SkillRepo {
    pub owner: String,
    pub name: String,
    pub branch: String,
    pub enabled: bool,
}

/// 仓库发现的可安装 Skill（规格 §2；两条链路共同的产物形状）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DiscoverableRepoSkill {
    /// 唯一标识："owner/name:directory"
    pub key: String,
    /// 显示名称（从 SKILL.md 解析，缺失用 directory 兜底）
    pub name: String,
    /// 描述（可为空串）
    pub description: String,
    /// 仓库内的相对目录（允许多级，如 "a/b/c"）
    pub directory: String,
    /// GitHub 上 SKILL.md 的 blob URL
    pub readme_url: Option<String>,
    pub repo_owner: String,
    pub repo_name: String,
    pub repo_branch: String,
}

/// 单个仓库发现失败的告警（不拖垮整体发现）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RepoDiscoveryWarning {
    pub owner: String,
    pub name: String,
    pub reason: String,
}

/// 仓库发现报告：技能列表 + 每个失败仓库的告警。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RepoDiscoveryReport {
    pub skills: Vec<DiscoverableRepoSkill>,
    pub warnings: Vec<RepoDiscoveryWarning>,
}

/// 已下载到本机临时目录、可进入导入向导的仓库 Skill。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DownloadedRepoSkill {
    /// 本地目录（作为 Local 来源进入现有导入管线）
    pub local_path: String,
    /// 目录末段名（导入候选的运行时名称参考）
    pub runtime_name: String,
}

/// `~/.agents/.skill-lock.json` 中的一条 GitHub 来源 Skill（Q17 lock 导入）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentsLockEntry {
    /// lock 文件中的 skill 名（导入后的显示名参考）
    pub name: String,
    pub owner: String,
    pub repo: String,
    /// 分支；None 表示走仓库默认分支回退（main → master）
    pub branch: Option<String>,
    /// 仓库内 Skill 子目录；None 表示仓库根整体即 Skill
    pub skill_path: Option<String>,
}
