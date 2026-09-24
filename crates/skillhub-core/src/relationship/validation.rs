//! 可治理关系校验（plan Task 5A）的两级契约与纯判定。
//!
//! 原始文件系统探测（adapter）只描述"路径上看到了什么"；业务探测
//! （`SourceCopyProbe`）由本模块的纯映射结合关系事实、受管占用与
//! Full 级内容指纹推导，最终经 [`validate_source_copy_transition`]
//! 落成关系更新或归档。Light 只核可达性/存在/类型/物理身份；Full
//! 额外计算内容指纹与受管占用。

use super::source_copy::{
    validate_source_copy_transition, SourceCopyHealth, SourceCopyProbe, SourceCopyRelationFact,
    SourceCopyTransition,
};
use crate::SkillId;
use serde::{Deserialize, Serialize};

/// 校验深度。Light 用于启动/上下文补偿扫描；Full 用于提交前强校验与
/// 定向复核。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipCheckLevel {
    Light,
    Full,
}

/// 校验范围：只检查范围内活动的关系，绝不全量 hash（plan 5.12）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum RelationshipCheckScope {
    AllActive,
    RelationIds { relation_ids: Vec<String> },
    Skill { skill_id: SkillId },
    Agent { client_id: String },
    Project { project_id: String },
    Batch { batch_id: String },
}

/// 平台文件系统错误类别：adapter 把 OS 错误归到这三类加"未知"，
/// 服务层据此决定保留活动关系还是等待补偿，绝不把失败误判为缺失。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PlatformFsErrorCategory {
    AccessDenied,
    VolumeUnavailable,
    TimedOut,
    Unknown,
}

/// 原始路径探测结果：只陈述文件系统事实，不做业务裁决
/// （ManagedOccupied 等占用判断是应用层职责，plan 5.10）。
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum RelationshipPathProbe {
    /// 路径在线且为目录；physical_source_id 来自 reparse-aware 身份推导。
    Accessible { physical_source_id: Option<String> },
    /// 父容器在线且可枚举、目标明确 NotFound——唯一允许归档的缺失形态。
    MissingWithAccessibleParent,
    /// 父目录本身不存在。
    ParentMissing,
    /// 路径存在但不是目录（表示形态与关系声明不符）。
    WrongRepresentation,
    /// 看见了路径但拒绝进入。
    PermissionDenied,
    /// 卷/网络位置不可用（Windows 盘未就绪/UNC 断链、macOS 卷未挂载）。
    DriveOrVolumeUnavailable,
    /// 超时或其他无法归类的失败。
    TimeoutOrUnknown,
}

/// 单个关系的校验结果（plan 5.11：逐项返回，失败不中止整批）。
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum RelationshipCheckItemStatus {
    /// 探测后关系事实发生了有意义的变化（含归档触发的 Archival 形态由
    /// Archived 单独表达）。
    Checked,
    /// 状态与已持久化事实一致，未推进 revision。
    Unchanged,
    /// 因 MissingWithAccessibleParent 归档并写入 ExternalRemoved 历史。
    Archived,
    /// 本项检查失败（探测错误或写入错误），保留活动关系。
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RelationshipCheckItem {
    pub relation_id: String,
    pub skill_id: SkillId,
    pub status: RelationshipCheckItemStatus,
    pub health: Option<SourceCopyHealth>,
    pub reason: Option<String>,
}

/// RunRelationshipCheck 的整批结果。
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RelationshipCheckReport {
    pub items: Vec<RelationshipCheckItem>,
    pub relationship_revision: i64,
}

/// 原始探测 → 业务探测的纯映射。级别是裁决的一部分：Light 一律只声明
/// 可达，即便调用方误传占用/指纹也不会改判内容或占用（plan 5.2）。
pub fn map_path_probe_to_source_copy(
    _relation: &SourceCopyRelationFact,
    level: RelationshipCheckLevel,
    probe: &RelationshipPathProbe,
    occupied: bool,
    content_fingerprint: Option<&str>,
) -> SourceCopyProbe {
    match probe {
        RelationshipPathProbe::Accessible { physical_source_id } => {
            if level == RelationshipCheckLevel::Light {
                return SourceCopyProbe::AccessibleDirectory;
            }
            if occupied {
                return SourceCopyProbe::ManagedOccupied;
            }
            match (physical_source_id, content_fingerprint) {
                (Some(physical), Some(fingerprint)) => SourceCopyProbe::VerifiedDirectory {
                    physical_source_id: physical.clone(),
                    content_fingerprint: fingerprint.to_owned(),
                },
                // Full 但指纹不可得：只声明可达，交由下次 Full 复核。
                _ => SourceCopyProbe::AccessibleDirectory,
            }
        }
        RelationshipPathProbe::MissingWithAccessibleParent => {
            SourceCopyProbe::MissingWithAccessibleParent
        }
        RelationshipPathProbe::ParentMissing => SourceCopyProbe::ParentMissing,
        RelationshipPathProbe::WrongRepresentation => SourceCopyProbe::WrongRepresentation,
        RelationshipPathProbe::PermissionDenied => SourceCopyProbe::PermissionDenied,
        RelationshipPathProbe::DriveOrVolumeUnavailable => {
            SourceCopyProbe::DriveOrVolumeUnavailable
        }
        RelationshipPathProbe::TimeoutOrUnknown => SourceCopyProbe::TimeoutOrUnknown,
    }
}

/// 组合纯映射与既有状态转换；供服务层在拿到原始探测后复用同一裁决。
pub fn evaluate_relationship_probe(
    relation: &SourceCopyRelationFact,
    level: RelationshipCheckLevel,
    probe: &RelationshipPathProbe,
    occupied: bool,
    content_fingerprint: Option<&str>,
    verified_at: i64,
) -> SourceCopyTransition {
    let business =
        map_path_probe_to_source_copy(relation, level, probe, occupied, content_fingerprint);
    validate_source_copy_transition(relation, business, verified_at)
}

/// 判定一次 Update 转换是否携带有意义的状态变化：仅 last_verified_at
/// 推进不推进 revision（plan 5.5）。
pub fn update_is_meaningful(
    before: &SourceCopyRelationFact,
    after: &SourceCopyRelationFact,
) -> bool {
    before.health != after.health
        || before.current_fingerprint != after.current_fingerprint
        || before.active != after.active
        || before.decision != after.decision
}
