//! OPT-20260914-08：原始文件清理（迁移）的领域规则。
//!
//! 迁移是一个独立、明确、可回滚的动作，与扫描/导入完全解耦：扫描和导入
//! 绝不删除用户原文件；只有用户在迁移命令中明确确认所有权之后，才允许
//! 在"备份完成 → 记录来源/目标 → 冲突清零"之后删除原始目录。本模块只
//! 放纯判定，文件系统副作用由 application 边界执行。

use serde::{Deserialize, Serialize};

use super::provenance::ImportProvenance;
use crate::{AppError, AppResult, ErrorCode, OperationId, RecoveryAction, Severity, SkillId};

/// 迁移准备阶段能发现的阻断性冲突。任何一项存在都禁止删除。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum OriginalMigrationConflictReason {
    /// 没有导入存证：SkillHub 无法证明这个路径与该 Skill 的来源关系。
    ProvenanceMissing,
    /// 原始路径已不存在。
    PathMissing,
    /// 原始路径不是真实目录（符号链接/联接/文件一律拒绝，绝不跟随）。
    PathNotRealDirectory,
    /// 当前内容指纹与导入存证不一致：库内副本可能已过期，先重新处理。
    ContentDiverged,
    /// 该路径上有 SkillHub 的活跃部署关系：先解除部署，再迁移。
    ManagedDeploymentAtPath,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct OriginalMigrationConflict {
    pub reason: OriginalMigrationConflictReason,
    pub detail: String,
}

/// 迁移准备时由 application 边界采集的文件系统/库事实。纯数据，便于测试。
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct OriginalMigrationFacts {
    pub provenance: Option<ImportProvenance>,
    pub path_exists: bool,
    pub is_symlink_or_junction: bool,
    pub is_directory: bool,
    pub current_fingerprint: Option<String>,
    pub has_managed_deployment_at_path: bool,
}

/// 迁移准备结果：包含执行所需的一切事实与冲突清单。
/// `requires_confirmation` 恒为 true——准备本身从不删除，提交必须带确认。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct OriginalMigrationPlan {
    pub operation_id: OperationId,
    pub skill_id: SkillId,
    pub original_path: String,
    pub content_fingerprint: String,
    pub conflicts: Vec<OriginalMigrationConflict>,
    pub requires_confirmation: bool,
}

/// 迁移/回滚的持久化结果，同时是给用户的回滚信息。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct OriginalMigrationResult {
    pub migration_id: OperationId,
    pub skill_id: SkillId,
    pub original_path: String,
    /// 备份目录（集中库内部路径）。回滚与审计都依赖它。
    pub backup_path: String,
    /// 迁移确认时的内容指纹（与导入存证一致才可能走到删除）。
    pub content_fingerprint: String,
    pub state: OriginalMigrationState,
    /// 迁移确认时间（epoch 秒；跨 IPC 以字符串承载，见 `crate::i64_string`）。
    #[serde(with = "crate::i64_string")]
    #[specta(type = String)]
    pub confirmed_at: i64,
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub rolled_back_at: Option<i64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum OriginalMigrationState {
    Migrated,
    RolledBack,
}

/// 纯判定：根据事实列出全部阻断冲突。
pub fn plan_original_migration(
    operation_id: OperationId,
    skill_id: SkillId,
    facts: &OriginalMigrationFacts,
) -> OriginalMigrationPlan {
    let mut conflicts = Vec::new();
    let Some(provenance) = facts.provenance.as_ref() else {
        conflicts.push(OriginalMigrationConflict {
            reason: OriginalMigrationConflictReason::ProvenanceMissing,
            detail: "no import provenance proves SkillHub imported this path".into(),
        });
        // 没有存证就没有可信的路径/指纹，其余检查无从谈起。
        return OriginalMigrationPlan {
            operation_id,
            skill_id,
            original_path: String::new(),
            content_fingerprint: String::new(),
            conflicts,
            requires_confirmation: true,
        };
    };
    let original_path = provenance.original_path.clone();
    let content_fingerprint = provenance.content_fingerprint.clone();
    if !facts.path_exists {
        conflicts.push(OriginalMigrationConflict {
            reason: OriginalMigrationConflictReason::PathMissing,
            detail: "original path no longer exists".into(),
        });
    } else {
        if facts.is_symlink_or_junction || !facts.is_directory {
            conflicts.push(OriginalMigrationConflict {
                reason: OriginalMigrationConflictReason::PathNotRealDirectory,
                detail: "original path is not a real directory".into(),
            });
        }
        if facts.current_fingerprint.as_deref() != Some(content_fingerprint.as_str()) {
            conflicts.push(OriginalMigrationConflict {
                reason: OriginalMigrationConflictReason::ContentDiverged,
                detail: "current content fingerprint differs from the import provenance".into(),
            });
        }
    }
    if facts.has_managed_deployment_at_path {
        conflicts.push(OriginalMigrationConflict {
            reason: OriginalMigrationConflictReason::ManagedDeploymentAtPath,
            detail: "a SkillHub deployment still owns this path; undeploy first".into(),
        });
    }
    OriginalMigrationPlan {
        operation_id,
        skill_id,
        original_path,
        content_fingerprint,
        conflicts,
        requires_confirmation: true,
    }
}

/// 硬边界：只有"冲突清零 + 用户明确确认所有权"两者同时成立，才允许
/// 进入删除阶段。用户未明确确认时必须拒绝执行且不触碰任何用户文件。
pub fn ensure_original_deletion_authorized(
    plan: &OriginalMigrationPlan,
    ownership_confirmed: bool,
) -> AppResult<()> {
    if !plan.conflicts.is_empty() {
        return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
            .with_param("detail", "original migration has blocking conflicts")
            .with_param(
                "conflicts",
                plan.conflicts
                    .iter()
                    .map(|conflict| format!("{:?}", conflict.reason))
                    .collect::<Vec<_>>()
                    .join(","),
            )
            .with_action(RecoveryAction::InspectTarget));
    }
    if !ownership_confirmed {
        // 这是产品语义的硬门槛：默认拒绝，绝不因为"看起来安全"而放行。
        return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
            .with_param("field", "ownership_confirmed")
            .with_param(
                "detail",
                "original file deletion requires explicit ownership confirmation",
            )
            .with_action(RecoveryAction::Acknowledge));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::CandidateOwnership;
    use crate::source::{SourceDescriptor, SourceKind, SourceLocator};

    fn provenance(path: &str, fingerprint: &str) -> ImportProvenance {
        ImportProvenance::new(
            SkillId::new(),
            path,
            SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(path)),
            CandidateOwnership::KnownAgentTarget,
            fingerprint,
            1_000,
        )
        .with_agent_client_id("trae.code")
    }

    fn clean_facts(path: &str, fingerprint: &str) -> OriginalMigrationFacts {
        OriginalMigrationFacts {
            provenance: Some(provenance(path, fingerprint)),
            path_exists: true,
            is_symlink_or_junction: false,
            is_directory: true,
            current_fingerprint: Some(fingerprint.into()),
            has_managed_deployment_at_path: false,
        }
    }

    const FP: &str = "sha256:aa11";

    // 干净事实 → 无冲突；但确认门槛恒在（requires_confirmation=true）。
    #[test]
    fn clean_facts_produce_a_conflict_free_plan_that_still_requires_confirmation() {
        let facts = clean_facts("/tmp/trae/skills/demo", FP);
        let plan = plan_original_migration(OperationId::new(), SkillId::new(), &facts);
        assert!(plan.conflicts.is_empty());
        assert!(plan.requires_confirmation);
        assert_eq!(plan.original_path, "/tmp/trae/skills/demo");
        assert_eq!(plan.content_fingerprint, FP);

        // 冲突为零但未确认 → 拒绝（硬边界）。
        let denied = ensure_original_deletion_authorized(&plan, false);
        let error = denied.expect_err("unconfirmed migration must be denied");
        assert_eq!(error.code, ErrorCode::InvalidInput);
    }

    // 确认 + 无冲突 → 授权进入删除阶段。
    #[test]
    fn confirmed_and_conflict_free_plan_is_authorized() {
        let facts = clean_facts("/tmp/trae/skills/demo", FP);
        let plan = plan_original_migration(OperationId::new(), SkillId::new(), &facts);
        assert!(ensure_original_deletion_authorized(&plan, true).is_ok());
    }

    // 缺少存证 → ProvenanceMissing，且不暴露路径/指纹。
    #[test]
    fn missing_provenance_blocks_migration_without_exposing_paths() {
        let facts = OriginalMigrationFacts::default();
        let plan = plan_original_migration(OperationId::new(), SkillId::new(), &facts);
        assert_eq!(plan.conflicts.len(), 1);
        assert_eq!(
            plan.conflicts[0].reason,
            OriginalMigrationConflictReason::ProvenanceMissing
        );
        assert_eq!(plan.original_path, String::new());
        let error = ensure_original_deletion_authorized(&plan, true)
            .expect_err("conflicting plan must be denied");
        assert_eq!(error.code, ErrorCode::OperationConflict);
    }

    // 各类事实异常都成为独立冲突：路径缺失/非真实目录/指纹分叉/活跃部署。
    #[test]
    fn fact_anomalies_surface_as_individual_conflicts() {
        let missing = OriginalMigrationFacts {
            provenance: Some(provenance("/tmp/demo", FP)),
            path_exists: false,
            is_symlink_or_junction: false,
            is_directory: false,
            current_fingerprint: None,
            has_managed_deployment_at_path: false,
        };
        let plan = plan_original_migration(OperationId::new(), SkillId::new(), &missing);
        assert_eq!(plan.conflicts.len(), 1);
        assert_eq!(
            plan.conflicts[0].reason,
            OriginalMigrationConflictReason::PathMissing
        );

        let link = OriginalMigrationFacts {
            provenance: Some(provenance("/tmp/demo", FP)),
            path_exists: true,
            is_symlink_or_junction: true,
            is_directory: true,
            current_fingerprint: Some(FP.into()),
            has_managed_deployment_at_path: false,
        };
        let plan = plan_original_migration(OperationId::new(), SkillId::new(), &link);
        assert_eq!(
            plan.conflicts
                .iter()
                .map(|conflict| conflict.reason.clone())
                .collect::<Vec<_>>(),
            vec![OriginalMigrationConflictReason::PathNotRealDirectory]
        );

        let diverged = OriginalMigrationFacts {
            current_fingerprint: Some("sha256:other".into()),
            ..clean_facts("/tmp/demo", FP)
        };
        let plan = plan_original_migration(OperationId::new(), SkillId::new(), &diverged);
        assert_eq!(
            plan.conflicts
                .iter()
                .map(|conflict| conflict.reason.clone())
                .collect::<Vec<_>>(),
            vec![OriginalMigrationConflictReason::ContentDiverged]
        );

        let deployed = OriginalMigrationFacts {
            has_managed_deployment_at_path: true,
            ..clean_facts("/tmp/demo", FP)
        };
        let plan = plan_original_migration(OperationId::new(), SkillId::new(), &deployed);
        assert_eq!(
            plan.conflicts
                .iter()
                .map(|conflict| conflict.reason.clone())
                .collect::<Vec<_>>(),
            vec![OriginalMigrationConflictReason::ManagedDeploymentAtPath]
        );
    }

    // 多重异常同时列出；任一冲突存在即拒绝，即使已确认。
    #[test]
    fn any_conflict_denies_deletion_even_when_confirmed() {
        let facts = OriginalMigrationFacts {
            provenance: Some(provenance("/tmp/demo", FP)),
            path_exists: true,
            is_symlink_or_junction: false,
            is_directory: true,
            current_fingerprint: Some("sha256:other".into()),
            has_managed_deployment_at_path: true,
        };
        let plan = plan_original_migration(OperationId::new(), SkillId::new(), &facts);
        assert_eq!(plan.conflicts.len(), 2);
        assert!(ensure_original_deletion_authorized(&plan, true).is_err());
    }
}
