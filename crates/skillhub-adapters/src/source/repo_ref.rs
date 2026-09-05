//! GitHub 仓库坐标校验（安全基线）。
//! 校验函数与规则逐字保留自发现模块实现规格 §4；所有进入 URL 的仓库坐标
//! （skills.sh 搜索结果、仓库发现配置）都必须先过这里，不得放宽。

use anyhow::{anyhow, Result};

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
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// 分支：按 '/' 分段做白名单（分支名合法含 '/'，如 feature/x）
pub(crate) fn is_valid_git_branch(branch: &str) -> bool {
    if branch.is_empty() || branch.eq_ignore_ascii_case("HEAD") {
        return true; // 哨兵，永不进 URL
    }
    if branch.len() > 255 {
        return false;
    }
    branch.split('/').all(|seg| {
        !seg.is_empty()
            && seg != "."
            && seg != ".."
            // Git 分支命名规则：段不得以 '.' 开头、不得以 ".lock" 结尾（规格 §11 测试表要求拒绝）
            && !seg.starts_with('.')
            && !seg.ends_with(".lock")
            && seg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
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
pub(crate) fn assert_github_archive_url(url: &str, owner: &str, name: &str) -> Result<()> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_repo_refs() {
        for branch in [
            "main",
            "master",
            "HEAD",
            "feature/new-thing",
            "release/v1.2.3",
            "fix-123",
            "",
        ] {
            assert!(
                validate_repo_ref("anthropics", "skills", branch).is_ok(),
                "branch {branch:?} should be accepted"
            );
        }
    }

    #[test]
    fn rejects_traversal_and_unsafe_branches() {
        for branch in [
            "../../../releases/download/v1/evil",
            "..",
            "../x",
            "a/../../b",
            "a/./b",
            "..\\..\\releases\\download\\v1\\evil",
            "/leading",
            "trailing/",
            "double//slash",
            "with space",
            "frag#ment",
            "pct%2e%2e",
            "ref@{0}",
            "seg.lock",
            ".hidden/x",
        ] {
            assert!(
                validate_repo_ref("anthropics", "skills", branch).is_err(),
                "branch {branch:?} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_invalid_owner_or_repo_coordinates() {
        assert!(validate_repo_ref("anthropics/skills", "x", "main").is_err());
        assert!(validate_repo_ref("skills.volces.com", "skills", "main").is_err());
        assert!(validate_repo_ref("anthropics", "..", "main").is_err());
        assert!(validate_repo_ref("anthropics", "re/po", "main").is_err());
        assert!(validate_repo_ref("anthropics", "with space", "main").is_err());
        assert!(validate_repo_ref("", "skills", "main").is_err());
        assert!(validate_repo_ref("anthropics", "", "main").is_err());
    }

    #[test]
    fn repo_name_allows_dot_dash_underscore_but_not_dot_or_dotdot() {
        assert!(is_valid_github_repo_name("a-b.c_d"));
        assert!(!is_valid_github_repo_name("."));
        assert!(!is_valid_github_repo_name(".."));
    }

    #[test]
    fn archive_url_assertion_blocks_non_github_landing() {
        let owner = "anthropics";
        let name = "skills";
        assert!(assert_github_archive_url(
            "https://github.com/anthropics/skills/archive/refs/heads/main.zip",
            owner,
            name
        )
        .is_ok());
        assert!(assert_github_archive_url(
            "https://evil.example/anthropics/skills/archive/refs/heads/main.zip",
            owner,
            name
        )
        .is_err());
        assert!(assert_github_archive_url(
            "http://github.com/anthropics/skills/archive/refs/heads/main.zip",
            owner,
            name
        )
        .is_err());
        assert!(assert_github_archive_url(
            "https://github.com/other/skills/archive/refs/heads/main.zip",
            owner,
            name
        )
        .is_err());
    }
}
