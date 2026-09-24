//! OPT-20260914-08：原始文件清理（迁移）的领域规则。
//!
//! 迁移是一个独立、明确、可回滚的动作，与扫描/导入完全解耦：扫描和导入
//! 绝不删除用户原文件；只有用户在迁移命令中明确确认所有权之后，才允许
//! 在"备份完成 → 记录来源/目标 → 冲突清零"之后删除原始目录。本模块只
//! 放纯判定，文件系统副作用由 application 边界执行。
//!
//! 计划 8A 起以来源关系为对象：一条 `SourceCopyRelationFact`（唯一
//! relation_id）对应一次迁移；同一 Skill 的多条来源各自独立成计划，互不
//! 混淆。路径与期望指纹只来自关系事实，不再按 Skill 单行反查存证。

use serde::{Deserialize, Serialize};

use crate::relationship::SourceCopyHealth;
use crate::relationship::SourceCopyRelationFact;
use crate::{AppError, AppResult, ErrorCode, OperationId, RecoveryAction, Severity, SkillId};

/// 迁移计划/结果随行的 Agent 呈现快照。品牌与展示类型徽标由前端统一
/// presenter 按 client_id 推导；共享目录来源没有单一 Agent，client_id
/// 为空（见 [`OriginalMigrationTargetContext`]）。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentPresentationFact {
    pub client_id: Option<String>,
}

/// 清理后的逻辑部署目标上下文：只用于打开部署选择，绝不自动部署。
/// 共享目录来源给出目录节点与可识别 Agent 列表，不压扁成单一 agent。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct OriginalMigrationTargetContext {
    /// 来源副本所在 Agent 目录的 client_id；共享目录来源为空。
    pub agent_client_id: Option<String>,
    /// 共享目录节点 id（role=shared_directory 的目录节点）。
    pub shared_directory_node_id: Option<String>,
    /// 识别该共享目录的全部 Agent；非共享目录来源恒为空。
    pub associated_agent_client_ids: Vec<String>,
}

/// 迁移准备阶段能发现的阻断性冲突。任何一项存在都禁止删除。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum OriginalMigrationConflictReason {
    /// 没有活动来源关系证明这个路径与该 Skill 的来源关系。
    ProvenanceMissing,
    /// 原始路径已不存在。
    PathMissing,
    /// 原始路径不是真实目录（符号链接/联接/文件一律拒绝，绝不跟随）。
    PathNotRealDirectory,
    /// 当前内容指纹与关系期望不一致：库内副本可能已过期，先重新处理。
    ContentDiverged,
    /// 该路径上有 SkillHub 的活跃部署关系：先解除部署，再迁移。
    ManagedDeploymentAtPath,
    /// 权限受限：无法完整读取，绝不猜测内容后删除。
    PermissionLimited,
    /// 来源被某个 Agent 以受管形态占用。
    ManagedOccupied,
    /// 身份或修订不可证：物理身份变化、校验超时等 NeedsValidation 态。
    NeedsValidation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct OriginalMigrationConflict {
    pub reason: OriginalMigrationConflictReason,
    pub detail: String,
}

/// 迁移准备时由 application 边界采集的文件系统/库事实。纯数据，便于测试。
/// 关系事实来自 Full 校验后的最新行：路径、期望指纹与健康裁决都以它为准。
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct OriginalMigrationFacts {
    pub relation: Option<SourceCopyRelationFact>,
    pub path_exists: bool,
    pub is_symlink_or_junction: bool,
    pub is_directory: bool,
    pub current_fingerprint: Option<String>,
    pub has_managed_deployment_at_path: bool,
    pub relationship_revision: i64,
    pub agent_client_id: Option<String>,
    pub shared_directory_node_id: Option<String>,
    pub associated_agent_client_ids: Vec<String>,
}

/// 迁移准备结果：包含执行所需的一切事实与冲突清单。
/// `requires_confirmation` 恒为 true——准备本身从不删除，提交必须带确认。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct OriginalMigrationPlan {
    pub operation_id: OperationId,
    pub skill_id: SkillId,
    /// 迁移对象的来源关系；同一 Skill 的多条来源各自独立成计划。
    pub relation_id: String,
    pub agent: AgentPresentationFact,
    pub target_context: OriginalMigrationTargetContext,
    /// 关系投影修订号（跨 IPC 以字符串承载，见 `crate::i64_string`）。
    #[serde(with = "crate::i64_string")]
    #[specta(type = String)]
    pub relationship_revision: i64,
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
    pub relation_id: String,
    pub agent: AgentPresentationFact,
    pub target_context: OriginalMigrationTargetContext,
    #[serde(with = "crate::i64_string")]
    #[specta(type = String)]
    pub relationship_revision: i64,
    pub original_path: String,
    /// 备份目录（集中库内部路径）。回滚与审计都依赖它。
    pub backup_path: String,
    /// 迁移确认时的内容指纹（与关系期望一致才可能走到删除）。
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

/// 纯判定：根据事实列出全部阻断冲突。决策字段（保留/待定）不参与判定：
/// 已保留的来源同样可以直接进入清理准备，不要求先伪造 Pending 过渡。
pub fn plan_original_migration(
    operation_id: OperationId,
    skill_id: SkillId,
    facts: &OriginalMigrationFacts,
) -> OriginalMigrationPlan {
    let agent = AgentPresentationFact {
        client_id: facts.agent_client_id.clone(),
    };
    let target_context = OriginalMigrationTargetContext {
        agent_client_id: facts.agent_client_id.clone(),
        shared_directory_node_id: facts.shared_directory_node_id.clone(),
        associated_agent_client_ids: facts.associated_agent_client_ids.clone(),
    };
    let mut conflicts = Vec::new();
    let Some(relation) = facts.relation.as_ref() else {
        conflicts.push(OriginalMigrationConflict {
            reason: OriginalMigrationConflictReason::ProvenanceMissing,
            detail: "no active source-copy relation proves SkillHub owns this path".into(),
        });
        // 没有关系事实就没有可信的路径/指纹，其余检查无从谈起。
        return OriginalMigrationPlan {
            operation_id,
            skill_id,
            relation_id: String::new(),
            agent,
            target_context,
            relationship_revision: facts.relationship_revision,
            original_path: String::new(),
            content_fingerprint: String::new(),
            conflicts,
            requires_confirmation: true,
        };
    };
    let original_path = relation.source_path.clone();
    let content_fingerprint = relation.expected_fingerprint.clone();
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
                detail: "current content fingerprint differs from the relation expectation".into(),
            });
        }
    }
    // Full 校验后的健康裁决是独立防线：内容变化、权限受限、受管占用、
    // 身份/修订不可证各有专名，任何非 Normal 健康都阻断备份与删除；
    // 与指纹比对同因时不重复列出。
    if let Some(reason) = health_conflict(relation.health) {
        if !conflicts.iter().any(|conflict| conflict.reason == reason) {
            let detail = format!("full relationship check reported {reason:?}");
            conflicts.push(OriginalMigrationConflict { reason, detail });
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
        relation_id: relation.relation_id.clone(),
        agent,
        target_context,
        relationship_revision: facts.relationship_revision,
        original_path,
        content_fingerprint,
        conflicts,
        requires_confirmation: true,
    }
}

fn health_conflict(health: SourceCopyHealth) -> Option<OriginalMigrationConflictReason> {
    match health {
        SourceCopyHealth::Normal => None,
        SourceCopyHealth::ContentChanged => Some(OriginalMigrationConflictReason::ContentDiverged),
        SourceCopyHealth::PermissionLimited => {
            Some(OriginalMigrationConflictReason::PermissionLimited)
        }
        SourceCopyHealth::ManagedOccupied => Some(OriginalMigrationConflictReason::ManagedOccupied),
        SourceCopyHealth::NeedsValidation | SourceCopyHealth::OperationFailed => {
            Some(OriginalMigrationConflictReason::NeedsValidation)
        }
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
    use crate::relationship::validate_source_copy_transition;
    use crate::relationship::SourceCopyDecision;
    use crate::relationship::SourceCopyProbe;
    use crate::relationship::SourceCopyTransition;

    /// 与导入落库同形的关系事实：Full 校验后（指纹一致）为 Normal。
    fn checked_relation(path: &str, fingerprint: &str) -> SourceCopyRelationFact {
        let event_relation = SourceCopyRelationFact {
            relation_id: "rel-migration".into(),
            skill_id: SkillId::new(),
            latest_provenance_id: "event-1".into(),
            source_class: crate::ImportSourceClass::AgentLocal,
            source_path: path.into(),
            source_path_key: path.into(),
            physical_source_id: path.into(),
            source_container_id: None,
            directory_node_id: None,
            agent_client_id: Some("trae.code".into()),
            expected_fingerprint: fingerprint.into(),
            current_fingerprint: None,
            decision: SourceCopyDecision::Pending,
            health: SourceCopyHealth::NeedsValidation,
            active: true,
            last_verified_at: None,
            archived_at: None,
            archive_reason: None,
        };
        match validate_source_copy_transition(
            &event_relation,
            SourceCopyProbe::VerifiedDirectory {
                physical_source_id: path.into(),
                content_fingerprint: fingerprint.into(),
            },
            1_000,
        ) {
            SourceCopyTransition::Update(checked) => checked,
            SourceCopyTransition::Archive { .. } => unreachable!("verified directory stays"),
        }
    }

    fn clean_facts(path: &str, fingerprint: &str) -> OriginalMigrationFacts {
        OriginalMigrationFacts {
            relation: Some(checked_relation(path, fingerprint)),
            path_exists: true,
            is_symlink_or_junction: false,
            is_directory: true,
            current_fingerprint: Some(fingerprint.into()),
            has_managed_deployment_at_path: false,
            relationship_revision: 3,
            agent_client_id: Some("trae.code".into()),
            shared_directory_node_id: None,
            associated_agent_client_ids: Vec::new(),
        }
    }

    const FP: &str = "sha256:aa11";

    // 干净事实 → 无冲突；但确认门槛恒在（requires_confirmation=true）。
    #[test]
    fn clean_facts_produce_a_conflict_free_plan_that_still_requires_confirmation() {
        let facts = clean_facts("/tmp/trae/skills/demo", FP);
        let relation = facts.relation.clone().expect("relation");
        let plan = plan_original_migration(OperationId::new(), relation.skill_id, &facts);
        assert!(plan.conflicts.is_empty());
        assert!(plan.requires_confirmation);
        assert_eq!(plan.original_path, "/tmp/trae/skills/demo");
        assert_eq!(plan.content_fingerprint, FP);
        assert_eq!(plan.relation_id, "rel-migration");
        assert_eq!(plan.agent.client_id.as_deref(), Some("trae.code"));
        assert_eq!(
            plan.target_context.agent_client_id.as_deref(),
            Some("trae.code")
        );
        assert_eq!(plan.relationship_revision, 3);

        // 冲突为零但未确认 → 拒绝（硬边界）。
        let denied = ensure_original_deletion_authorized(&plan, false);
        let error = denied.expect_err("unconfirmed migration must be denied");
        assert_eq!(error.code, ErrorCode::InvalidInput);
    }

    // 确认 + 无冲突 → 授权进入删除阶段。
    #[test]
    fn confirmed_and_conflict_free_plan_is_authorized() {
        let facts = clean_facts("/tmp/trae/skills/demo", FP);
        let relation = facts.relation.clone().expect("relation");
        let plan = plan_original_migration(OperationId::new(), relation.skill_id, &facts);
        assert!(ensure_original_deletion_authorized(&plan, true).is_ok());
    }

    // 已保留（Retained）的来源不阻断清理准备：判定不读决策字段。
    #[test]
    fn retained_decision_does_not_block_prepare() {
        let mut facts = clean_facts("/tmp/demo", FP);
        if let Some(relation) = facts.relation.as_mut() {
            relation.decision = SourceCopyDecision::Retained;
        }
        let relation = facts.relation.clone().expect("relation");
        let plan = plan_original_migration(OperationId::new(), relation.skill_id, &facts);
        assert!(plan.conflicts.is_empty());
        assert!(ensure_original_deletion_authorized(&plan, true).is_ok());
    }

    // 缺少关系事实 → ProvenanceMissing，且不暴露路径/指纹。
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
        assert_eq!(plan.relation_id, String::new());
        let error = ensure_original_deletion_authorized(&plan, true)
            .expect_err("conflicting plan must be denied");
        assert_eq!(error.code, ErrorCode::OperationConflict);
    }

    // 各类事实异常都成为独立冲突：路径缺失/非真实目录/指纹分叉/健康
    // 异常（权限/占用/身份不可证）/活跃部署。
    #[test]
    fn fact_anomalies_surface_as_individual_conflicts() {
        let missing = OriginalMigrationFacts {
            path_exists: false,
            is_symlink_or_junction: false,
            is_directory: false,
            current_fingerprint: None,
            ..clean_facts("/tmp/demo", FP)
        };
        let relation = missing.relation.clone().expect("relation");
        let plan = plan_original_migration(OperationId::new(), relation.skill_id, &missing);
        assert_eq!(plan.conflicts.len(), 1);
        assert_eq!(
            plan.conflicts[0].reason,
            OriginalMigrationConflictReason::PathMissing
        );

        let link = OriginalMigrationFacts {
            is_symlink_or_junction: true,
            ..clean_facts("/tmp/demo", FP)
        };
        let relation = link.relation.clone().expect("relation");
        let plan = plan_original_migration(OperationId::new(), relation.skill_id, &link);
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
        let relation = diverged.relation.clone().expect("relation");
        let plan = plan_original_migration(OperationId::new(), relation.skill_id, &diverged);
        assert_eq!(
            plan.conflicts
                .iter()
                .map(|conflict| conflict.reason.clone())
                .collect::<Vec<_>>(),
            vec![OriginalMigrationConflictReason::ContentDiverged]
        );

        // 健康：权限受限 → PermissionLimited；受管占用 → ManagedOccupied；
        // NeedsValidation → NeedsValidation；指纹分叉健康叠加指纹冲突。
        let mut permission = clean_facts("/tmp/demo", FP);
        if let Some(relation) = permission.relation.as_mut() {
            relation.health = SourceCopyHealth::PermissionLimited;
        }
        let relation = permission.relation.clone().expect("relation");
        let plan = plan_original_migration(OperationId::new(), relation.skill_id, &permission);
        assert_eq!(
            plan.conflicts
                .iter()
                .map(|conflict| conflict.reason.clone())
                .collect::<Vec<_>>(),
            vec![OriginalMigrationConflictReason::PermissionLimited]
        );

        let mut occupied = clean_facts("/tmp/demo", FP);
        if let Some(relation) = occupied.relation.as_mut() {
            relation.health = SourceCopyHealth::ManagedOccupied;
        }
        let relation = occupied.relation.clone().expect("relation");
        let plan = plan_original_migration(OperationId::new(), relation.skill_id, &occupied);
        assert_eq!(
            plan.conflicts
                .iter()
                .map(|conflict| conflict.reason.clone())
                .collect::<Vec<_>>(),
            vec![OriginalMigrationConflictReason::ManagedOccupied]
        );

        let mut identity = clean_facts("/tmp/demo", FP);
        if let Some(relation) = identity.relation.as_mut() {
            relation.health = SourceCopyHealth::NeedsValidation;
        }
        let relation = identity.relation.clone().expect("relation");
        let plan = plan_original_migration(OperationId::new(), relation.skill_id, &identity);
        assert_eq!(
            plan.conflicts
                .iter()
                .map(|conflict| conflict.reason.clone())
                .collect::<Vec<_>>(),
            vec![OriginalMigrationConflictReason::NeedsValidation]
        );

        let deployed = OriginalMigrationFacts {
            has_managed_deployment_at_path: true,
            ..clean_facts("/tmp/demo", FP)
        };
        let relation = deployed.relation.clone().expect("relation");
        let plan = plan_original_migration(OperationId::new(), relation.skill_id, &deployed);
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
            current_fingerprint: Some("sha256:other".into()),
            has_managed_deployment_at_path: true,
            ..clean_facts("/tmp/demo", FP)
        };
        let relation = facts.relation.clone().expect("relation");
        let plan = plan_original_migration(OperationId::new(), relation.skill_id, &facts);
        assert_eq!(plan.conflicts.len(), 2);
        assert!(ensure_original_deletion_authorized(&plan, true).is_err());
    }
}
