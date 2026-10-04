use serde::{Deserialize, Serialize};

use crate::relationship::{RelationHealthReason, RelationshipPathProbe};
use crate::SkillId;

/// OPT-20260914-08：已观察部署关系。
///
/// 与 [`crate::deployment::DeploymentRecord`] 的区别：DeploymentRecord 描述
/// SkillHub 亲自创建并拥有所有权证明的部署；ObservedDeployment 描述的是
/// "这个 Agent 形态的这个路径上，已经部署着集中库中的某 Skill"这一观察
/// 事实。SkillHub 没有创建它，因此对它只有"记录/标注"，永远没有删除权
/// ——收回（解除部署）只作用于 SkillHub 创建的目标。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ObservedDeployment {
    pub id: crate::ObservedDeploymentId,
    pub skill_id: SkillId,
    /// Agent 形态 client_id（如 "trae.code"）。无目录归属证据的关系不会建档。
    pub client_id: String,
    /// 观察到的原始部署路径（目录包，含 SKILL.md）。
    pub original_path: String,
    /// 观察时的内容指纹（canonical tree hash，与库内 content_hash 同算法）。
    pub content_fingerprint: String,
    pub match_state: ObservedMatchState,
    pub origin: ObservedOrigin,
    pub status: ObservedStatus,
    /// 最近一次确认观察的时间（epoch 秒；跨 IPC 以字符串承载）。
    #[serde(with = "crate::i64_string")]
    #[specta(type = String)]
    pub observed_at: i64,
    /// 观察消失（路径不再被看到）的收回时间；仍活跃时为 None。
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub released_at: Option<i64>,
}

impl ObservedDeployment {
    /// Expose the legacy observation as a normalized relationship without
    /// guessing whether the observed path is a copy or a link.
    pub fn to_deployment_relation_fact(&self) -> crate::relationship::DeploymentRelationFact {
        crate::relationship::DeploymentRelationFact {
            relation_id: self.id.to_string(),
            skill_id: (self.match_state != ObservedMatchState::NameOnly).then_some(self.skill_id),
            agent_client_id: self.client_id.clone(),
            path: self.original_path.clone(),
            path_key: observed_path_key(&self.original_path),
            directory_node_id: None,
            relationship: crate::relationship::RelationshipType::Unknown,
            file_representation: crate::relationship::FileRepresentation::Unknown,
            ownership: crate::relationship::OwnershipState::ObservedUnmanaged,
            link_target_path: None,
            link_target_path_key: None,
            link_target_directory_id: None,
            content_fingerprint: self.content_fingerprint.clone(),
            origin: self.origin,
            match_state: self.match_state,
            health_reasons: None,
            active: self.status == ObservedStatus::Active,
            observed_at: self.observed_at,
            released_at: self.released_at,
        }
    }
}

/// 身份可靠性标注。只有 ContentVerified 才是"身份可靠匹配"；其余两种是
/// 明确的"不可靠"标注，绝不冒充已验证关系。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ObservedMatchState {
    /// 指纹一致：路径内容与库内 Skill 当前版本完全相同。
    ContentVerified,
    /// 仅同名（runtime name）匹配而指纹不一致：疑似同一 Skill，但不猜。
    NameOnly,
    /// 曾经指纹一致、当前扫描指纹已不一致：内容已分叉，标注不猜。
    Diverged,
}

/// 这条关系是如何建立的：扫描比对，或导入存证时自动建立。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ObservedOrigin {
    Scan,
    Import,
}

/// 关系生命周期：活跃 ↔ 已收回（路径不再被观察到）。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ObservedStatus {
    Active,
    Released,
}

/// 一次路径观察（扫描或导入时对某路径计算出的指纹）。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservedPathObservation {
    pub path: String,
    pub fingerprint: String,
}

/// 对一行既有关系的纯判定结果（无 I/O，存储层照此执行 upsert）。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ObservedRowAction {
    /// 不需要任何变更（观察与既有行完全一致）。
    Unchanged,
    /// 建立或更新为指纹一致的活跃关系。
    EstablishVerified {
        skill_id: SkillId,
        fingerprint: String,
    },
    /// 指纹不一致时的明确标注：同名疑似（仅导入链路产生）或内容分叉。
    MarkUnreliable {
        match_state: ObservedMatchState,
        fingerprint: String,
    },
    /// Persist a health fact for an existing target without ending or rebinding it.
    RecordHealth { reasons: Vec<RelationHealthReason> },
    /// 保留旧版显式结束路径的兼容动作；扫描缺少观察不应产生此动作。
    Release,
}

/// 关系行判定的纯规则。
///
/// - `observation` 为 None 只表示本轮没有可用观察，不构成用户结束关系的证据。
/// - `matched_library_skill` 仅在观察指纹与某库内 Skill 当前版本
///   content_hash 完全一致时为 `Some`——指纹不一致就是 None，不存在
///   "模糊匹配"。身份可靠匹配自动建立/维持关系；不可靠一律标注。
pub fn reconcile_observed_row(
    existing: Option<&ObservedDeployment>,
    observation: Option<&ObservedPathObservation>,
    matched_library_skill: Option<SkillId>,
) -> ObservedRowAction {
    if existing.is_some_and(|row| row.status == ObservedStatus::Released) {
        return ObservedRowAction::Unchanged;
    }
    let Some(observation) = observation else {
        return ObservedRowAction::Unchanged;
    };
    match (existing, matched_library_skill) {
        (None, Some(skill_id)) => ObservedRowAction::EstablishVerified {
            skill_id,
            fingerprint: observation.fingerprint.clone(),
        },
        (None, None) => ObservedRowAction::Unchanged,
        (Some(row), Some(skill_id)) => {
            if row.match_state != ObservedMatchState::NameOnly && row.skill_id != skill_id {
                return ObservedRowAction::MarkUnreliable {
                    match_state: ObservedMatchState::Diverged,
                    fingerprint: observation.fingerprint.clone(),
                };
            }
            let unchanged = row.status == ObservedStatus::Active
                && row.match_state == ObservedMatchState::ContentVerified
                && row.skill_id == skill_id
                && row.content_fingerprint == observation.fingerprint;
            if unchanged {
                ObservedRowAction::Unchanged
            } else {
                ObservedRowAction::EstablishVerified {
                    skill_id,
                    fingerprint: observation.fingerprint.clone(),
                }
            }
        }
        (Some(row), None) => {
            if row.status != ObservedStatus::Active {
                return ObservedRowAction::Unchanged;
            }
            if row.match_state == ObservedMatchState::ContentVerified {
                // 曾经验证过、现在指纹对不上：内容已分叉，诚实降级标注。
                ObservedRowAction::MarkUnreliable {
                    match_state: ObservedMatchState::Diverged,
                    fingerprint: observation.fingerprint.clone(),
                }
            } else {
                let fingerprint_changed = row.content_fingerprint != observation.fingerprint;
                if fingerprint_changed {
                    ObservedRowAction::MarkUnreliable {
                        match_state: row.match_state,
                        fingerprint: observation.fingerprint.clone(),
                    }
                } else {
                    ObservedRowAction::Unchanged
                }
            }
        }
    }
}

/// Record the explicit filesystem result for a previously known observation
/// whose content could not be scanned. Absence alone is never an end command.
pub fn reconcile_missing_observed_row(
    existing: Option<&ObservedDeployment>,
    probe: &RelationshipPathProbe,
) -> ObservedRowAction {
    let Some(row) = existing else {
        return ObservedRowAction::Unchanged;
    };
    if row.status == ObservedStatus::Released {
        return ObservedRowAction::Unchanged;
    }
    let reason = match probe {
        RelationshipPathProbe::MissingWithAccessibleParent => {
            RelationHealthReason::TargetEntryMissing
        }
        RelationshipPathProbe::WrongRepresentation => RelationHealthReason::TargetEntryReplaced,
        RelationshipPathProbe::PermissionDenied => RelationHealthReason::PermissionLimited,
        RelationshipPathProbe::Accessible { .. }
        | RelationshipPathProbe::ParentMissing
        | RelationshipPathProbe::DriveOrVolumeUnavailable
        | RelationshipPathProbe::TimeoutOrUnknown => RelationHealthReason::ProbeUnavailable,
    };
    ObservedRowAction::RecordHealth {
        reasons: vec![reason],
    }
}

/// Windows 文件系统大小写不敏感、POSIX 精确——沿用仓库既有的形态折叠
/// 裁决。关系按路径唯一建档：同一路径重复导入/重复扫描不产生重复行。
pub fn observed_path_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_owned()
    }
}

/// 路径前缀归属判定：`candidate` 是否位于 `root` 之下（含边界分隔符），
/// 大小写裁决与 [`observed_path_key`] 一致。用于把候选路径归属到已知
/// Agent 目录；没有目录证据就不归属。
pub fn path_lives_under(candidate: &str, root: &str) -> bool {
    let (candidate, root) = if cfg!(windows) {
        (candidate.to_lowercase(), root.to_lowercase())
    } else {
        (candidate.to_owned(), root.to_owned())
    };
    let root = root.trim_end_matches(['/', '\\']);
    if candidate == root {
        return false;
    }
    let Some(rest) = candidate.strip_prefix(root) else {
        return false;
    };
    rest.starts_with(['/', '\\'])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(
        skill_id: SkillId,
        fingerprint: &str,
        match_state: ObservedMatchState,
        status: ObservedStatus,
    ) -> ObservedDeployment {
        ObservedDeployment {
            id: crate::ObservedDeploymentId::new(),
            skill_id,
            client_id: "trae.code".into(),
            original_path: "/tmp/agents/trae-cn/skills/demo".into(),
            content_fingerprint: fingerprint.into(),
            match_state,
            origin: ObservedOrigin::Scan,
            status,
            observed_at: 100,
            released_at: None,
        }
    }

    const FP_A: &str = "sha256:aaaa";
    const FP_B: &str = "sha256:bbbb";

    // 指纹一致 → 自动建立关系（身份可靠匹配）。
    #[test]
    fn verified_content_establishes_a_relation() {
        let skill = SkillId::new();
        let observation = ObservedPathObservation {
            path: "/tmp/agents/trae-cn/skills/demo".into(),
            fingerprint: FP_A.into(),
        };
        let action = reconcile_observed_row(None, Some(&observation), Some(skill));
        assert_eq!(
            action,
            ObservedRowAction::EstablishVerified {
                skill_id: skill,
                fingerprint: FP_A.into(),
            }
        );
    }

    // 指纹不匹配且无既有关系 → 不建档（不猜）。
    #[test]
    fn unverified_content_without_prior_row_builds_nothing() {
        let observation = ObservedPathObservation {
            path: "/tmp/agents/trae-cn/skills/demo".into(),
            fingerprint: FP_A.into(),
        };
        let action = reconcile_observed_row(None, Some(&observation), None);
        assert_eq!(action, ObservedRowAction::Unchanged);
    }

    // 扫描缺少路径观察不是用户结束关系的证据。
    #[test]
    fn active_row_is_not_ended_when_observation_is_absent() {
        let skill = SkillId::new();
        let active = row(
            skill,
            FP_A,
            ObservedMatchState::ContentVerified,
            ObservedStatus::Active,
        );
        assert_eq!(
            reconcile_observed_row(Some(&active), None, None),
            ObservedRowAction::Unchanged
        );

        let released = row(
            skill,
            FP_A,
            ObservedMatchState::ContentVerified,
            ObservedStatus::Released,
        );
        assert_eq!(
            reconcile_observed_row(Some(&released), None, None),
            ObservedRowAction::Unchanged
        );

        // 已结束历史不会因扫描重新出现而复活。
        let observation = ObservedPathObservation {
            path: "/tmp/agents/trae-cn/skills/demo".into(),
            fingerprint: FP_A.into(),
        };
        assert_eq!(
            reconcile_observed_row(Some(&released), Some(&observation), Some(skill)),
            ObservedRowAction::Unchanged
        );
    }

    // 指纹不一致 → 明确标注分叉，不冒充已验证关系。
    #[test]
    fn diverged_content_is_annotated_not_claimed() {
        let skill = SkillId::new();
        let active = row(
            skill,
            FP_A,
            ObservedMatchState::ContentVerified,
            ObservedStatus::Active,
        );
        let observation = ObservedPathObservation {
            path: "/tmp/agents/trae-cn/skills/demo".into(),
            fingerprint: FP_B.into(),
        };
        assert_eq!(
            reconcile_observed_row(Some(&active), Some(&observation), None),
            ObservedRowAction::MarkUnreliable {
                match_state: ObservedMatchState::Diverged,
                fingerprint: FP_B.into(),
            }
        );
    }

    #[test]
    fn normalized_fact_keeps_identity_after_a_verified_target_diverges() {
        let skill = SkillId::new();
        let name_only = row(
            skill,
            FP_A,
            ObservedMatchState::NameOnly,
            ObservedStatus::Active,
        );
        assert_eq!(name_only.to_deployment_relation_fact().skill_id, None);

        let verified = row(
            skill,
            FP_A,
            ObservedMatchState::ContentVerified,
            ObservedStatus::Active,
        );
        assert_eq!(verified.to_deployment_relation_fact().skill_id, Some(skill));
        let diverged = row(
            skill,
            FP_B,
            ObservedMatchState::Diverged,
            ObservedStatus::Active,
        );
        assert_eq!(diverged.to_deployment_relation_fact().skill_id, Some(skill));
    }

    #[test]
    fn missing_observation_records_probe_health_without_ending_relation() {
        let active = row(
            SkillId::new(),
            FP_A,
            ObservedMatchState::ContentVerified,
            ObservedStatus::Active,
        );
        assert_eq!(
            reconcile_missing_observed_row(
                Some(&active),
                &RelationshipPathProbe::MissingWithAccessibleParent,
            ),
            ObservedRowAction::RecordHealth {
                reasons: vec![RelationHealthReason::TargetEntryMissing],
            }
        );
    }

    #[test]
    fn ambiguous_probe_results_never_claim_the_target_is_missing() {
        let active = row(
            SkillId::new(),
            FP_A,
            ObservedMatchState::ContentVerified,
            ObservedStatus::Active,
        );
        for probe in [
            RelationshipPathProbe::ParentMissing,
            RelationshipPathProbe::DriveOrVolumeUnavailable,
            RelationshipPathProbe::TimeoutOrUnknown,
            RelationshipPathProbe::Accessible {
                physical_source_id: None,
            },
        ] {
            assert_eq!(
                reconcile_missing_observed_row(Some(&active), &probe),
                ObservedRowAction::RecordHealth {
                    reasons: vec![RelationHealthReason::ProbeUnavailable],
                }
            );
        }
        assert_eq!(
            reconcile_missing_observed_row(Some(&active), &RelationshipPathProbe::PermissionDenied,),
            ObservedRowAction::RecordHealth {
                reasons: vec![RelationHealthReason::PermissionLimited],
            }
        );
        assert_eq!(
            reconcile_missing_observed_row(
                Some(&active),
                &RelationshipPathProbe::WrongRepresentation,
            ),
            ObservedRowAction::RecordHealth {
                reasons: vec![RelationHealthReason::TargetEntryReplaced],
            }
        );
    }

    // 路径内容匹配到其他主体不能静默重绑既有关系。
    #[test]
    fn relation_identity_is_preserved_when_content_matches_another_skill() {
        let old_skill = SkillId::new();
        let new_skill = SkillId::new();
        let active = row(
            old_skill,
            FP_A,
            ObservedMatchState::ContentVerified,
            ObservedStatus::Active,
        );
        let observation = ObservedPathObservation {
            path: "/tmp/agents/trae-cn/skills/demo".into(),
            fingerprint: FP_B.into(),
        };
        assert_eq!(
            reconcile_observed_row(Some(&active), Some(&observation), Some(new_skill)),
            ObservedRowAction::MarkUnreliable {
                match_state: ObservedMatchState::Diverged,
                fingerprint: FP_B.into(),
            }
        );
    }

    // 内容未变的已验证关系保持不动（幂等）。
    #[test]
    fn unchanged_verified_observation_keeps_the_row() {
        let skill = SkillId::new();
        let active = row(
            skill,
            FP_A,
            ObservedMatchState::ContentVerified,
            ObservedStatus::Active,
        );
        let observation = ObservedPathObservation {
            path: "/tmp/agents/trae-cn/skills/demo".into(),
            fingerprint: FP_A.into(),
        };
        assert_eq!(
            reconcile_observed_row(Some(&active), Some(&observation), Some(skill)),
            ObservedRowAction::Unchanged
        );
    }

    // 路径形态裁决：Windows 折叠大小写，POSIX 精确。
    #[test]
    fn path_key_folding_follows_platform_contract() {
        if cfg!(windows) {
            assert_eq!(observed_path_key("C:\\A\\Skills"), "c:\\a\\skills");
        } else {
            assert_eq!(observed_path_key("/tmp/Skills"), "/tmp/Skills");
            assert_ne!(observed_path_key("/tmp/Skills"), "/tmp/skills");
        }
    }

    #[test]
    fn path_lives_under_requires_component_boundary() {
        assert!(path_lives_under(
            "/tmp/trae/skills/demo",
            "/tmp/trae/skills"
        ));
        assert!(path_lives_under(
            "/tmp/trae/skills/demo/deep",
            "/tmp/trae/skills/"
        ));
        assert!(!path_lives_under("/tmp/trae/skills", "/tmp/trae/skills"));
        assert!(!path_lives_under(
            "/tmp/trae/skills-demo",
            "/tmp/trae/skills"
        ));
        assert!(!path_lives_under(
            "/tmp/other/skills/demo",
            "/tmp/trae/skills"
        ));
    }
}
