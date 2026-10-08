//! Unified business projection for active skill usage relationships.

use crate::agent::AgentDirectoryProjection;
use crate::agent::AgentDirectoryRole;
use crate::relationship::{
    AgentDirectoryCapabilityFact, DeploymentRelationFact, DirectoryNodeFact, DirectoryRecognition,
    DirectoryRole, FileRepresentation, OwnershipState, RelationGovernanceTargetKind,
    RelationHealthReason, RelationshipType, SourceCopyHealth, SourceCopyRelationFact,
};
use crate::SkillId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(
    Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, specta::Type,
)]
#[serde(deny_unknown_fields)]
pub struct UsageEntryKey {
    pub directory_id: String,
    pub relative_entry_path: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UsageForm {
    Link,
    FullCopy,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UsageManagement {
    Managed,
    Unmanaged,
}

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum UsageHealthReason {
    Normal,
    FileMissing,
    LinkAbnormal,
    ContentChanged,
    NeedsSync,
    SyncFailed,
    UnableToVerify,
    UserConfirmation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UsageDecision {
    Released,
    RetainedIndependentCopy,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageDecisionEvidence {
    pub relation_id: String,
    pub decision: UsageDecision,
    pub history_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageManagementEvidence {
    pub relation_id: String,
    pub management: UsageManagement,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageRelationTarget {
    pub kind: crate::relationship::RelationGovernanceTargetKind,
    pub directory_id: Option<String>,
    pub agent_client_id: Option<String>,
    pub directory_role: Option<crate::agent::AgentDirectoryRole>,
    pub recognition: Option<crate::relationship::DirectoryRecognition>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageRelationView {
    pub relation_id: String,
    pub skill_id: Option<SkillId>,
    pub target: UsageRelationTarget,
    pub entry_key: Option<UsageEntryKey>,
    pub form: Option<UsageForm>,
    pub management: UsageManagement,
    pub health_reasons: Vec<UsageHealthReason>,
    pub decision: Option<UsageDecision>,
    pub decision_history_ids: Vec<String>,
    pub active: bool,
    pub file_representation: crate::relationship::FileRepresentation,
    pub link_target_path: Option<String>,
    pub link_target_path_key: Option<String>,
    pub link_target_directory_id: Option<String>,
    /// Ephemeral physical identity evidence; it is never part of `entry_key`.
    /// Multiple distinct IDs are retained as an explicit identity conflict.
    pub physical_source_ids_evidence: Vec<String>,
    pub evidence_relation_ids: Vec<String>,
}

pub struct UsageProjectionInput<'a> {
    pub deployments: &'a [DeploymentRelationFact],
    pub source_copies: &'a [SourceCopyRelationFact],
    pub directory_nodes: &'a [DirectoryNodeFact],
    pub directory_recognition: &'a [AgentDirectoryCapabilityFact],
    pub agent_directories: &'a AgentDirectoryProjection,
    pub decision_evidence: &'a [UsageDecisionEvidence],
    pub management_evidence: &'a [UsageManagementEvidence],
}

/// Builds one current usage view from the physical relationship facts. The
/// historical technical `RelationshipType` remains evidence only; it is not
/// surfaced as a business relation kind.
pub fn project_usage_relations(input: &UsageProjectionInput<'_>) -> Vec<UsageRelationView> {
    let decisions_by_relation =
        input
            .decision_evidence
            .iter()
            .fold(BTreeMap::new(), |mut evidence, item| {
                evidence.insert(item.relation_id.as_str(), item);
                evidence
            });
    let management_by_relation =
        input
            .management_evidence
            .iter()
            .fold(BTreeMap::new(), |mut evidence, item| {
                evidence.insert(item.relation_id.as_str(), item.management);
                evidence
            });
    let mut projected = BTreeMap::<String, UsageRelationView>::new();
    for relation in input
        .deployments
        .iter()
        .filter(|relation| relation.active && relation.released_at.is_none())
    {
        let node = directory_node_for(
            relation.directory_node_id.as_deref(),
            &relation.path_key,
            Some(&relation.agent_client_id),
            input.directory_nodes,
        );
        let (target, entry_key) =
            target_and_entry_key(node, &relation.agent_client_id, &relation.path_key, input);
        let mut health_reasons = deployment_health(relation);
        if relation.relationship == RelationshipType::Unknown {
            health_reasons.push(UsageHealthReason::UserConfirmation);
        }
        if form_for_representation(relation.file_representation).is_none() {
            health_reasons.push(UsageHealthReason::UnableToVerify);
            health_reasons.push(UsageHealthReason::UserConfirmation);
        }
        let form = form_for_representation(relation.file_representation);
        let (link_target_path, link_target_path_key, link_target_directory_id) =
            if form == Some(UsageForm::Link) {
                (
                    relation.link_target_path.clone(),
                    relation.link_target_path_key.clone(),
                    relation.link_target_directory_id.clone(),
                )
            } else {
                (None, None, None)
            };
        let view = UsageRelationView {
            relation_id: relation.relation_id.clone(),
            skill_id: relation.skill_id,
            target,
            entry_key,
            form,
            management: management_by_relation
                .get(relation.relation_id.as_str())
                .copied()
                .unwrap_or_else(|| management_from_ownership(relation.ownership)),
            health_reasons: normalize_health(health_reasons),
            decision: decisions_by_relation
                .get(relation.relation_id.as_str())
                .map(|item| item.decision),
            decision_history_ids: decision_history_ids(
                decisions_by_relation
                    .get(relation.relation_id.as_str())
                    .copied(),
            ),
            active: true,
            file_representation: relation.file_representation,
            link_target_path,
            link_target_path_key,
            link_target_directory_id,
            physical_source_ids_evidence: Vec::new(),
            evidence_relation_ids: vec![relation.relation_id.clone()],
        };
        insert_or_merge(&mut projected, view);
    }

    for copy in input
        .source_copies
        .iter()
        .filter(|copy| copy.active && copy.archived_at.is_none())
    {
        let node = directory_node_for(
            copy.directory_node_id
                .as_deref()
                .or(copy.source_container_id.as_deref()),
            &copy.source_path_key,
            copy.agent_client_id.as_deref(),
            input.directory_nodes,
        );
        let (target, entry_key) = target_and_entry_key(
            node,
            copy.agent_client_id.as_deref().unwrap_or_default(),
            &copy.source_path_key,
            input,
        );
        // An import location becomes a usage entry only when the real Agent,
        // shared, or Project directory projection confirms its role. Ordinary
        // user source folders remain import facts only.
        if !is_recognized_usage_directory(&target) {
            continue;
        }
        let mut health_reasons = source_copy_health(copy);
        if target.recognition != Some(DirectoryRecognition::Supported) {
            health_reasons.push(UsageHealthReason::UnableToVerify);
            health_reasons.push(UsageHealthReason::UserConfirmation);
        }
        if copy.current_fingerprint.as_deref() != Some(copy.expected_fingerprint.as_str()) {
            health_reasons.push(if copy.current_fingerprint.is_some() {
                UsageHealthReason::ContentChanged
            } else {
                UsageHealthReason::UnableToVerify
            });
        }
        let view = UsageRelationView {
            relation_id: copy.relation_id.clone(),
            skill_id: Some(copy.skill_id),
            target,
            entry_key,
            form: Some(UsageForm::FullCopy),
            // A source-copy row records an original location, not current
            // SkillHub maintenance responsibility. The legacy decision field
            // may have been auto-filled on import and is not user evidence.
            management: UsageManagement::Unmanaged,
            health_reasons: normalize_health(health_reasons),
            decision: decisions_by_relation
                .get(copy.relation_id.as_str())
                .map(|item| item.decision),
            decision_history_ids: decision_history_ids(
                decisions_by_relation
                    .get(copy.relation_id.as_str())
                    .copied(),
            ),
            active: true,
            file_representation: FileRepresentation::Directory,
            link_target_path: None,
            link_target_path_key: None,
            link_target_directory_id: None,
            physical_source_ids_evidence: vec![copy.physical_source_id.clone()],
            evidence_relation_ids: vec![copy.relation_id.clone()],
        };
        insert_or_merge(&mut projected, view);
    }

    let mut projected = projected.into_values().collect::<Vec<_>>();
    mark_conflicting_skill_evidence(&mut projected);
    projected
}

fn decision_history_ids(evidence: Option<&UsageDecisionEvidence>) -> Vec<String> {
    evidence
        .and_then(|item| item.history_id.clone())
        .into_iter()
        .collect()
}

fn management_from_ownership(ownership: OwnershipState) -> UsageManagement {
    if ownership == OwnershipState::SkillhubManaged {
        UsageManagement::Managed
    } else {
        UsageManagement::Unmanaged
    }
}

fn form_for_representation(representation: FileRepresentation) -> Option<UsageForm> {
    match representation {
        FileRepresentation::SymbolicLink | FileRepresentation::DirectoryJunction => {
            Some(UsageForm::Link)
        }
        FileRepresentation::Directory | FileRepresentation::Copy => Some(UsageForm::FullCopy),
        FileRepresentation::Unknown => None,
    }
}

fn deployment_health(relation: &DeploymentRelationFact) -> Vec<UsageHealthReason> {
    let mut reasons = relation.health_reasons.as_deref().map_or_else(
        || vec![UsageHealthReason::UnableToVerify],
        |reasons| {
            if reasons.is_empty() {
                vec![UsageHealthReason::Normal]
            } else {
                reasons
                    .iter()
                    .copied()
                    .flat_map(|reason| map_health_reason(reason, relation.file_representation))
                    .collect()
            }
        },
    );
    match relation.match_state {
        crate::deployment::ObservedMatchState::ContentVerified => {}
        crate::deployment::ObservedMatchState::NameOnly => {
            reasons.push(UsageHealthReason::UserConfirmation);
        }
        crate::deployment::ObservedMatchState::Diverged => {
            reasons.push(UsageHealthReason::ContentChanged);
        }
    }
    reasons
}

fn source_copy_health(copy: &SourceCopyRelationFact) -> Vec<UsageHealthReason> {
    let mut reasons = copy.health_reasons.as_deref().map_or_else(
        || vec![UsageHealthReason::UnableToVerify],
        |reasons| {
            reasons
                .iter()
                .copied()
                .flat_map(|reason| map_health_reason(reason, FileRepresentation::Directory))
                .collect()
        },
    );
    match copy.health {
        SourceCopyHealth::Normal => {}
        SourceCopyHealth::NeedsValidation => reasons.push(UsageHealthReason::UnableToVerify),
        SourceCopyHealth::ContentChanged => reasons.push(UsageHealthReason::ContentChanged),
        SourceCopyHealth::PermissionLimited => reasons.push(UsageHealthReason::UnableToVerify),
        SourceCopyHealth::ManagedOccupied => reasons.push(UsageHealthReason::UserConfirmation),
        SourceCopyHealth::OperationFailed => {
            reasons.push(UsageHealthReason::UnableToVerify);
            reasons.push(UsageHealthReason::UserConfirmation);
        }
    }
    reasons
}

fn map_health_reason(
    reason: RelationHealthReason,
    representation: FileRepresentation,
) -> Vec<UsageHealthReason> {
    match reason {
        RelationHealthReason::TargetEntryMissing => vec![UsageHealthReason::FileMissing],
        RelationHealthReason::TargetEntryReplaced | RelationHealthReason::TargetLinkUnavailable
            if matches!(
                representation,
                FileRepresentation::SymbolicLink | FileRepresentation::DirectoryJunction
            ) =>
        {
            vec![UsageHealthReason::LinkAbnormal]
        }
        RelationHealthReason::TargetEntryReplaced | RelationHealthReason::TargetLinkUnavailable => {
            vec![
                UsageHealthReason::UnableToVerify,
                UsageHealthReason::UserConfirmation,
            ]
        }
        RelationHealthReason::PermissionLimited
        | RelationHealthReason::SubjectUnavailable
        | RelationHealthReason::ProbeUnavailable => vec![UsageHealthReason::UnableToVerify],
        RelationHealthReason::ContentChanged => vec![UsageHealthReason::ContentChanged],
        RelationHealthReason::ManagedTargetOccupied => vec![UsageHealthReason::UserConfirmation],
        RelationHealthReason::OperationFailed => vec![
            UsageHealthReason::UnableToVerify,
            UsageHealthReason::UserConfirmation,
        ],
    }
}

fn normalize_health(mut reasons: Vec<UsageHealthReason>) -> Vec<UsageHealthReason> {
    let has_issue = reasons
        .iter()
        .any(|reason| *reason != UsageHealthReason::Normal);
    if has_issue {
        reasons.retain(|reason| *reason != UsageHealthReason::Normal);
    } else {
        reasons = vec![UsageHealthReason::Normal];
    }
    reasons.sort();
    reasons.dedup();
    reasons
}

fn directory_node_for<'a>(
    directory_id: Option<&str>,
    entry_path_key: &str,
    agent_client_id: Option<&str>,
    nodes: &'a [DirectoryNodeFact],
) -> Option<&'a DirectoryNodeFact> {
    if let Some(directory_id) = directory_id {
        return nodes.iter().find(|node| {
            node.node_id == directory_id
                && relative_entry_path(&node.path_key, entry_path_key).is_some()
        });
    }

    let mut candidates = nodes
        .iter()
        .filter(|node| {
            agent_client_id.is_none_or(|agent| node.agent_client_id.as_deref() == Some(agent))
                && relative_entry_path(&node.path_key, entry_path_key).is_some()
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|node| std::cmp::Reverse(normalize_path_key(&node.path_key).len()));
    let best = candidates.first().copied()?;
    if candidates.get(1).is_some_and(|other| {
        normalize_path_key(&other.path_key).len() == normalize_path_key(&best.path_key).len()
    }) {
        return None;
    }
    Some(best)
}

fn target_and_entry_key(
    node: Option<&DirectoryNodeFact>,
    agent_client_id: &str,
    entry_path_key: &str,
    input: &UsageProjectionInput<'_>,
) -> (UsageRelationTarget, Option<UsageEntryKey>) {
    let Some(node) = node else {
        return (
            UsageRelationTarget {
                kind: RelationGovernanceTargetKind::Agent,
                directory_id: None,
                agent_client_id: (!agent_client_id.is_empty()).then(|| agent_client_id.to_owned()),
                directory_role: None,
                recognition: None,
            },
            None,
        );
    };
    let recognitions = input
        .directory_recognition
        .iter()
        .filter(|fact| {
            fact.directory_node_id == node.node_id
                && (agent_client_id.is_empty() || fact.agent_client_id == agent_client_id)
        })
        .map(|fact| fact.recognition)
        .collect::<Vec<_>>();
    let recognition = recognitions
        .first()
        .copied()
        .filter(|first| recognitions.iter().all(|candidate| candidate == first));
    let actual_directory = actual_agent_directory(node, agent_client_id, input);
    let actual_agent_role = actual_directory.and_then(|directory| {
        if directory.is_shared_directory {
            Some(AgentDirectoryRole::SharedDirectory)
        } else {
            match directory.role {
                AgentDirectoryRole::Builtin
                | AgentDirectoryRole::AgentUser
                | AgentDirectoryRole::AgentWorkspace => Some(directory.role),
                // `AgentNative` is a historical umbrella and carries no evidence for
                // choosing built-in, user, or workspace. Shared scope is a separate
                // flag on the current Agent projection.
                AgentDirectoryRole::AgentNative
                | AgentDirectoryRole::SharedDirectory
                | AgentDirectoryRole::Project => None,
            }
        }
    });
    let directory_role = match node.role {
        DirectoryRole::SharedDirectory => Some(AgentDirectoryRole::SharedDirectory),
        DirectoryRole::Project => Some(AgentDirectoryRole::Project),
        DirectoryRole::AgentNative => actual_agent_role,
        DirectoryRole::CentralLibrary => None,
    };
    let kind = match node.role {
        DirectoryRole::SharedDirectory => RelationGovernanceTargetKind::SharedDirectory,
        DirectoryRole::Project => RelationGovernanceTargetKind::Project,
        DirectoryRole::AgentNative
            if actual_directory.is_some_and(|directory| directory.is_shared_directory) =>
        {
            RelationGovernanceTargetKind::SharedDirectory
        }
        DirectoryRole::AgentNative | DirectoryRole::CentralLibrary => {
            RelationGovernanceTargetKind::Agent
        }
    };
    let directory_role = if recognition == Some(DirectoryRecognition::Unsupported) {
        None
    } else {
        directory_role
    };
    let relative_path = relative_entry_path(&node.path_key, entry_path_key);
    (
        UsageRelationTarget {
            kind,
            directory_id: Some(node.node_id.clone()),
            agent_client_id: (!agent_client_id.is_empty()).then(|| agent_client_id.to_owned()),
            directory_role,
            recognition,
        },
        relative_path.map(|relative_entry_path| UsageEntryKey {
            directory_id: node.node_id.clone(),
            relative_entry_path,
        }),
    )
}

fn actual_agent_directory<'a>(
    node: &DirectoryNodeFact,
    agent_client_id: &str,
    input: &'a UsageProjectionInput<'_>,
) -> Option<&'a crate::agent::AgentDirectoryFact> {
    let path_key = normalize_path_key(&node.path_key);
    let matches = input
        .agent_directories
        .directories
        .iter()
        .filter(|directory| normalize_path_key(&directory.path) == path_key)
        .filter(|directory| {
            agent_client_id.is_empty()
                || directory
                    .members
                    .iter()
                    .any(|member| member.client_id.as_deref() == Some(agent_client_id))
        })
        .collect::<Vec<_>>();
    (matches.len() == 1).then(|| matches[0])
}

fn is_recognized_usage_directory(target: &UsageRelationTarget) -> bool {
    if target.recognition == Some(DirectoryRecognition::Unsupported) {
        return false;
    }
    matches!(
        target.kind,
        RelationGovernanceTargetKind::SharedDirectory | RelationGovernanceTargetKind::Project
    ) || matches!(
        target.directory_role,
        Some(
            AgentDirectoryRole::Builtin
                | AgentDirectoryRole::AgentUser
                | AgentDirectoryRole::AgentWorkspace
        )
    )
}

fn normalize_path_key(path: &str) -> String {
    let path = path.replace('\\', "/");
    crate::deployment::observed_path_key(&path)
        .trim_end_matches('/')
        .to_owned()
}

fn relative_entry_path(root: &str, entry: &str) -> Option<String> {
    let root = normalize_path_key(root);
    let entry = normalize_path_key(entry);
    let suffix = entry.strip_prefix(&root)?;
    let relative = suffix.strip_prefix('/')?;
    let components = relative
        .split('/')
        .filter(|component| !component.is_empty())
        .collect::<Vec<_>>();
    if components.is_empty()
        || components
            .iter()
            .any(|component| *component == "." || *component == "..")
    {
        return None;
    }
    Some(components.join("/"))
}

fn insert_or_merge(projected: &mut BTreeMap<String, UsageRelationView>, view: UsageRelationView) {
    let identity = view.entry_key.as_ref().map_or_else(
        || format!("relation:{}", view.relation_id),
        |key| {
            format!(
                "skill:{}\0directory:{}\0entry:{}",
                view.skill_id.map(|id| id.to_string()).unwrap_or_default(),
                key.directory_id,
                key.relative_entry_path
            )
        },
    );
    if let Some(existing) = projected.get_mut(&identity) {
        merge_view(existing, view);
    } else {
        projected.insert(identity, view);
    }
}

fn merge_view(existing: &mut UsageRelationView, mut other: UsageRelationView) {
    let conflicting_form = existing.form != other.form;
    let conflicting_link_target = existing.form == Some(UsageForm::Link)
        && other.form == Some(UsageForm::Link)
        && link_target_evidence_conflicts(existing, &other);
    if other.relation_id < existing.relation_id {
        std::mem::swap(&mut existing.relation_id, &mut other.relation_id);
    }
    if conflicting_form || conflicting_link_target {
        existing.form = None;
        existing.file_representation = FileRepresentation::Unknown;
        existing.link_target_path = None;
        existing.link_target_path_key = None;
        existing.link_target_directory_id = None;
        existing
            .health_reasons
            .push(UsageHealthReason::UserConfirmation);
    } else if existing.form == Some(UsageForm::Link) && other.form == Some(UsageForm::Link) {
        if existing.link_target_path.is_none() {
            existing.link_target_path = other.link_target_path.clone();
        }
        if existing.link_target_path_key.is_none() {
            existing.link_target_path_key = other.link_target_path_key.clone();
        }
        if existing.link_target_directory_id.is_none() {
            existing.link_target_directory_id = other.link_target_directory_id.clone();
        }
    }
    existing
        .physical_source_ids_evidence
        .append(&mut other.physical_source_ids_evidence);
    existing.physical_source_ids_evidence.sort();
    existing.physical_source_ids_evidence.dedup();
    if existing.physical_source_ids_evidence.len() > 1 {
        existing
            .health_reasons
            .push(UsageHealthReason::UserConfirmation);
    }
    if existing.management == UsageManagement::Unmanaged
        && other.management == UsageManagement::Managed
    {
        existing.management = UsageManagement::Managed;
    }
    if existing.decision.is_none() {
        existing.decision = other.decision;
    }
    existing
        .decision_history_ids
        .append(&mut other.decision_history_ids);
    existing
        .evidence_relation_ids
        .append(&mut other.evidence_relation_ids);
    existing.health_reasons.append(&mut other.health_reasons);
    existing.health_reasons = normalize_health(std::mem::take(&mut existing.health_reasons));
    existing.decision_history_ids.sort();
    existing.decision_history_ids.dedup();
    existing.evidence_relation_ids.sort();
    existing.evidence_relation_ids.dedup();
}

fn link_target_evidence_conflicts(left: &UsageRelationView, right: &UsageRelationView) -> bool {
    if matches!(
        (
            left.link_target_directory_id.as_deref(),
            right.link_target_directory_id.as_deref()
        ),
        (Some(left), Some(right)) if left != right
    ) {
        return true;
    }
    let left_target = left
        .link_target_path_key
        .as_deref()
        .map(normalize_path_key)
        .or_else(|| left.link_target_path.as_deref().map(normalize_path_key));
    let right_target = right
        .link_target_path_key
        .as_deref()
        .map(normalize_path_key)
        .or_else(|| right.link_target_path.as_deref().map(normalize_path_key));
    match (left_target, right_target) {
        (Some(left), Some(right)) => left != right,
        (None, None) => false,
        _ => true,
    }
}

fn mark_conflicting_skill_evidence(views: &mut [UsageRelationView]) {
    let mut skills_by_entry = BTreeMap::<(String, String), Vec<Option<String>>>::new();
    for view in views.iter() {
        let Some(key) = view.entry_key.as_ref() else {
            continue;
        };
        let skills = skills_by_entry
            .entry((key.directory_id.clone(), key.relative_entry_path.clone()))
            .or_default();
        let skill_id = view.skill_id.map(|id| id.to_string());
        if !skills.contains(&skill_id) {
            skills.push(skill_id);
        }
    }
    for view in views.iter_mut() {
        let Some(key) = view.entry_key.as_ref() else {
            continue;
        };
        let has_conflicting_skills = skills_by_entry
            .get(&(key.directory_id.clone(), key.relative_entry_path.clone()))
            .is_some_and(|skills| skills.len() > 1);
        if has_conflicting_skills {
            view.health_reasons
                .push(UsageHealthReason::UserConfirmation);
            view.health_reasons = normalize_health(std::mem::take(&mut view.health_reasons));
        }
    }
}
