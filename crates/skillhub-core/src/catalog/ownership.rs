use serde::{Deserialize, Serialize};

/// QA-013：Markdown 内容的来源。v0.2.0 只有中央库托管副本会进入
/// 版本库；其余来源保留领域定义，供接管/建立托管关系流程使用。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentProvenance {
    /// SkillHub 中央库捕获的托管副本（复制导入或独立管理副本）。
    ManagedCopy,
    /// Agent 或运行时自带的内置 Skill。
    Builtin,
    /// 插件提供的 Skill。
    Plugin,
    /// 已发现但尚未接管的外部目录。
    ExternalUnmanaged,
    /// 操作系统权限拒绝读写。
    PermissionDenied,
}

/// QA-013：Markdown 只读原因，与桌面端 `MarkdownReadOnlyReason` 对齐。
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum MarkdownReadOnlyReason {
    Builtin,
    External,
    Permission,
    Plugin,
}

/// QA-013：所有权矩阵的判定结果。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MarkdownEditability {
    pub editable: bool,
    pub read_only_reason: Option<MarkdownReadOnlyReason>,
}

/// QA-013：所有权矩阵——只有用户自有或 SkillHub 管理的内容允许显式
/// 保存原文并形成新版本；内置、插件、未接管外部内容与权限受限内容
/// 只能复制导入或接管，绝不开放原文覆盖。
pub fn markdown_editability(provenance: ContentProvenance) -> MarkdownEditability {
    let read_only_reason = match provenance {
        ContentProvenance::ManagedCopy => None,
        ContentProvenance::Builtin => Some(MarkdownReadOnlyReason::Builtin),
        ContentProvenance::Plugin => Some(MarkdownReadOnlyReason::Plugin),
        ContentProvenance::ExternalUnmanaged => Some(MarkdownReadOnlyReason::External),
        ContentProvenance::PermissionDenied => Some(MarkdownReadOnlyReason::Permission),
    };
    MarkdownEditability {
        editable: read_only_reason.is_none(),
        read_only_reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // QA-013：所有权矩阵。每个来源的判定都是确定性领域规则，
    // 不能被前端或可选 LLM 结果替代。
    #[test]
    fn managed_copies_stay_editable_without_read_only_reason() {
        let editability = markdown_editability(ContentProvenance::ManagedCopy);
        assert!(editability.editable);
        assert_eq!(editability.read_only_reason, None);
    }

    #[test]
    fn builtin_plugin_external_and_permission_denied_content_stays_read_only() {
        let cases = [
            (ContentProvenance::Builtin, MarkdownReadOnlyReason::Builtin),
            (ContentProvenance::Plugin, MarkdownReadOnlyReason::Plugin),
            (
                ContentProvenance::ExternalUnmanaged,
                MarkdownReadOnlyReason::External,
            ),
            (
                ContentProvenance::PermissionDenied,
                MarkdownReadOnlyReason::Permission,
            ),
        ];
        for (provenance, reason) in cases {
            let editability = markdown_editability(provenance);
            assert!(!editability.editable, "{provenance:?} must stay read-only");
            assert_eq!(editability.read_only_reason, Some(reason));
        }
    }
}
