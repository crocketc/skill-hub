use crate::deployment::{ObservedMatchState, ObservedOrigin};
use crate::relationship::{DirectoryRole, FileRepresentation, OwnershipState, RelationshipType};
use crate::{DeploymentId, DeploymentRecord, SkillId, VersionId};
use serde::{Deserialize, Serialize};

/// Deterministic comparison result for a managed deployment target.
/// The comparison is intentionally performed by the platform backend.  The
/// backend must compare the target's filesystem identity and tree hash with
/// the ownership facts recorded in the deployment relation and the selected
/// version manifest; this model does not infer Agent runtime behaviour.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ExternalChangeState {
    Unchanged,
    Modified,
    Missing,
    Ignored,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExternalChangeObservation {
    pub state: ExternalChangeState,
    pub observed_hash: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ReconcileAction {
    CollectChanges,
    Restore,
    KeepIndependentCopy,
    Ignore,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ReconcilePlan {
    pub deployment_id: DeploymentId,
    pub state: ExternalChangeState,
    pub expected_hash: String,
    pub observed_hash: Option<String>,
    pub allowed_actions: Vec<ReconcileAction>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ReconcileResult {
    pub deployment_id: DeploymentId,
    pub state_before: ExternalChangeState,
    pub action: ReconcileAction,
    pub version_id: Option<VersionId>,
    pub management_retained: bool,
}

/// Pure input fact used when a scanned path is classified against registered
/// directory nodes.  It deliberately contains no filesystem handle.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelationTargetFact {
    pub relation_id: Option<String>,
    pub skill_id: Option<SkillId>,
    pub agent_client_id: String,
    pub directory_node_id: String,
    pub directory_path: String,
    pub directory_role: DirectoryRole,
    pub relationship: RelationshipType,
    pub file_representation: FileRepresentation,
    pub ownership: OwnershipState,
    pub link_target_path: Option<String>,
    pub link_target_directory_id: Option<String>,
    pub content_fingerprint: String,
    pub origin: ObservedOrigin,
    pub match_state: ObservedMatchState,
    pub active: bool,
    pub observed_at: i64,
    pub released_at: Option<i64>,
}

impl RelationTargetFact {
    pub fn directory(
        directory_node_id: impl Into<String>,
        directory_path: impl Into<String>,
        agent_client_id: impl Into<String>,
        directory_role: DirectoryRole,
    ) -> Self {
        Self {
            relation_id: None,
            skill_id: None,
            agent_client_id: agent_client_id.into(),
            directory_node_id: directory_node_id.into(),
            directory_path: directory_path.into(),
            directory_role,
            relationship: RelationshipType::Unknown,
            file_representation: FileRepresentation::Directory,
            ownership: OwnershipState::ObservedUnmanaged,
            link_target_path: None,
            link_target_directory_id: None,
            content_fingerprint: String::new(),
            origin: ObservedOrigin::Scan,
            match_state: ObservedMatchState::ContentVerified,
            active: true,
            observed_at: 0,
            released_at: None,
        }
    }

    pub fn with_relation(
        mut self,
        relation_id: impl Into<String>,
        relationship: RelationshipType,
    ) -> Self {
        self.relation_id = Some(relation_id.into());
        self.relationship = relationship;
        self
    }

    pub fn with_file_representation(mut self, value: FileRepresentation) -> Self {
        self.file_representation = value;
        self
    }

    pub fn with_ownership(mut self, value: OwnershipState) -> Self {
        self.ownership = value;
        self
    }

    pub fn with_match_state(mut self, value: ObservedMatchState) -> Self {
        self.match_state = value;
        self
    }

    pub fn with_skill(mut self, skill_id: SkillId, fingerprint: impl Into<String>) -> Self {
        self.skill_id = Some(skill_id);
        self.content_fingerprint = fingerprint.into();
        self
    }

    pub fn with_link_target(
        mut self,
        path: impl Into<String>,
        directory_node_id: Option<String>,
    ) -> Self {
        self.link_target_path = Some(path.into());
        self.link_target_directory_id = directory_node_id;
        self
    }

    pub fn to_deployment_relation_fact(&self) -> crate::relationship::DeploymentRelationFact {
        crate::relationship::DeploymentRelationFact {
            relation_id: self
                .relation_id
                .clone()
                .unwrap_or_else(|| format!("observed:{}", relation_path_key(&self.directory_path))),
            skill_id: (self.match_state == ObservedMatchState::ContentVerified)
                .then_some(self.skill_id)
                .flatten(),
            agent_client_id: self.agent_client_id.clone(),
            path: self.directory_path.clone(),
            path_key: relation_path_key(&self.directory_path),
            directory_node_id: Some(self.directory_node_id.clone()),
            relationship: self.relationship,
            file_representation: self.file_representation,
            ownership: self.ownership,
            link_target_path: self.link_target_path.clone(),
            link_target_path_key: self.link_target_path.as_deref().map(relation_path_key),
            link_target_directory_id: self.link_target_directory_id.clone(),
            content_fingerprint: self.content_fingerprint.clone(),
            origin: self.origin,
            match_state: self.match_state,
            active: self.active,
            observed_at: self.observed_at,
            released_at: self.released_at,
        }
    }
}

pub fn normalized_path_key(path: &str, windows: bool) -> String {
    let path = path.replace('\\', "/");
    if windows {
        path.to_ascii_lowercase()
    } else {
        path
    }
}

pub fn path_lives_under_platform(candidate: &str, root: &str, windows: bool) -> bool {
    let candidate = normalized_path_key(candidate, windows);
    let root = normalized_path_key(root, windows);
    let root = root.trim_end_matches('/');
    candidate != root
        && candidate
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn relation_path_key(path: &str) -> String {
    crate::deployment::observed_path_key(path)
}

impl ReconcilePlan {
    pub fn from_observation(
        deployment: &DeploymentRecord,
        observation: ExternalChangeObservation,
    ) -> Self {
        let allowed_actions = match observation.state {
            ExternalChangeState::Modified => vec![
                ReconcileAction::CollectChanges,
                ReconcileAction::Restore,
                ReconcileAction::KeepIndependentCopy,
                ReconcileAction::Ignore,
            ],
            ExternalChangeState::Missing => vec![
                ReconcileAction::Restore,
                ReconcileAction::KeepIndependentCopy,
                ReconcileAction::Ignore,
            ],
            ExternalChangeState::Unchanged | ExternalChangeState::Ignored => Vec::new(),
        };
        Self {
            deployment_id: deployment.id,
            state: observation.state,
            expected_hash: deployment.expected_hash.clone(),
            observed_hash: observation.observed_hash,
            allowed_actions,
        }
    }
}
