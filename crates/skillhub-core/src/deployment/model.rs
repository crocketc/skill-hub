use crate::agent::LogicalTarget;
use crate::check::CheckRun;
use crate::path_policy::{physical_id_for_path, PathPolicy};
use crate::project::Project;
use crate::{
    AppError, AppResult, DeploymentCapability, DeploymentId, ErrorCode, RecoveryAction, Severity,
    SkillId, VersionId,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// The filesystem representation selected for one physical deployment target.
/// It is selected from the target's declared capabilities.
/// A symbolic link is preferred because it keeps a deployment connected to the
/// selected library version.  Junctions are a Windows directory fallback and
/// managed copies are the portable last resort.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentMode {
    SymbolicLink,
    DirectoryJunction,
    ManagedCopy,
}

impl DeploymentMode {
    pub fn select(capabilities: &DeploymentCapability) -> Option<Self> {
        if capabilities.symlink {
            Some(Self::SymbolicLink)
        } else if capabilities.junction {
            Some(Self::DirectoryJunction)
        } else if capabilities.copy {
            Some(Self::ManagedCopy)
        } else {
            None
        }
    }

    pub fn is_supported_by(self, capabilities: &DeploymentCapability) -> bool {
        match self {
            Self::SymbolicLink => capabilities.symlink,
            Self::DirectoryJunction => capabilities.junction,
            Self::ManagedCopy => capabilities.copy,
        }
    }
}

impl DeploymentCapability {
    /// Construct target capabilities without coupling planner callers to the
    /// Agent profile JSON field order.
    pub fn new(symlink: bool, junction: bool, copy: bool) -> Self {
        Self {
            copy,
            symlink,
            junction,
            limitations: Vec::new(),
        }
    }
}

/// The registered source from which a target fact was obtained.  Raw paths
/// supplied by callers are not a registered source and cannot be verified.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TargetFactSource {
    Discovery,
    Custom,
    Project,
}

/// A persisted/registered target claim awaiting current filesystem
/// verification.  This type deliberately has no planner conversion without a
/// `PathPolicy` check.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetFact {
    logical_target_id: String,
    registered_path: String,
    expected_physical_id: String,
    source: TargetFactSource,
    capabilities: DeploymentCapability,
    case_sensitive: bool,
}

impl TargetFact {
    pub fn registered(
        logical_target_id: impl Into<String>,
        registered_path: impl AsRef<Path>,
        expected_physical_id: impl Into<String>,
        source: TargetFactSource,
        capabilities: DeploymentCapability,
    ) -> Self {
        Self {
            logical_target_id: logical_target_id.into(),
            registered_path: registered_path.as_ref().to_string_lossy().into_owned(),
            expected_physical_id: expected_physical_id.into(),
            source,
            capabilities,
            case_sensitive: !cfg!(windows),
        }
    }

    pub fn from_logical_target(target: &LogicalTarget, capabilities: DeploymentCapability) -> Self {
        Self::registered(
            target.id.clone(),
            &target.path,
            target.physical_id.clone(),
            TargetFactSource::Discovery,
            capabilities,
        )
    }

    pub fn from_project(project: &Project, capabilities: DeploymentCapability) -> Self {
        Self::registered(
            project.id.to_string(),
            project.path(),
            project.physical_id.clone(),
            TargetFactSource::Project,
            capabilities,
        )
    }

    pub fn with_case_sensitive(mut self, case_sensitive: bool) -> Self {
        self.case_sensitive = case_sensitive;
        self
    }

    pub fn verify(self, policy: &PathPolicy) -> AppResult<VerifiedTarget> {
        VerifiedTarget::from_fact(self, policy)
    }
}

/// A target whose registered logical identity, allowed root and current
/// filesystem identity have all been checked.  Its fields are private so a
/// planner caller cannot manufacture one from an arbitrary path or id.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedTarget {
    logical_target_ids: Vec<String>,
    physical_target_id: String,
    canonical_path: String,
    capabilities: DeploymentCapability,
    existing: Vec<ExistingDeployment>,
    case_sensitive: bool,
}

impl VerifiedTarget {
    pub fn from_fact(fact: TargetFact, policy: &PathPolicy) -> AppResult<Self> {
        if fact.logical_target_id.trim().is_empty()
            || fact.expected_physical_id.trim().is_empty()
            || !matches!(
                fact.source,
                TargetFactSource::Discovery | TargetFactSource::Custom | TargetFactSource::Project
            )
        {
            return Err(invalid_target("registered target fact is incomplete"));
        }
        let safe_path = policy.authorize_existing(&fact.registered_path)?;
        if !safe_path.as_path().is_dir() {
            return Err(invalid_target("registered target is not a directory"));
        }
        let Some(current_physical_id) = physical_id_for_path(safe_path.as_path()) else {
            return Err(invalid_target("target physical identity is unavailable"));
        };
        if current_physical_id != fact.expected_physical_id {
            return Err(invalid_target("target physical identity changed"));
        }
        Ok(Self {
            logical_target_ids: vec![fact.logical_target_id],
            physical_target_id: current_physical_id,
            // Keep the registered spelling for deterministic operation paths;
            // authorization above canonicalizes it before any identity check.
            canonical_path: fact.registered_path,
            capabilities: fact.capabilities,
            existing: Vec::new(),
            case_sensitive: fact.case_sensitive,
        })
    }

    pub fn logical_target_ids(&self) -> &[String] {
        &self.logical_target_ids
    }

    pub fn physical_target_id(&self) -> &str {
        &self.physical_target_id
    }

    pub fn path(&self) -> &str {
        &self.canonical_path
    }

    pub fn capabilities(&self) -> &DeploymentCapability {
        &self.capabilities
    }

    pub fn existing(&self) -> &[ExistingDeployment] {
        &self.existing
    }

    pub fn case_sensitive(&self) -> bool {
        self.case_sensitive
    }

    pub fn with_existing(mut self, existing: ExistingDeployment) -> Self {
        self.existing.push(existing);
        self
    }
}

/// Facts observed for a runtime name already present in a physical target.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ExistingOwnership {
    Managed,
    Unknown,
    AgentBuiltin,
    Plugin,
    OtherTool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExistingDeployment {
    pub runtime_name: String,
    pub ownership: ExistingOwnership,
    pub deployment_id: Option<DeploymentId>,
    pub skill_id: Option<SkillId>,
    pub version_id: Option<VersionId>,
}

impl ExistingDeployment {
    pub fn new(runtime_name: impl Into<String>, ownership: ExistingOwnership) -> Self {
        Self {
            runtime_name: runtime_name.into(),
            ownership,
            deployment_id: None,
            skill_id: None,
            version_id: None,
        }
    }

    pub fn managed(
        runtime_name: impl Into<String>,
        deployment_id: DeploymentId,
        skill_id: SkillId,
        version_id: VersionId,
    ) -> Self {
        Self {
            runtime_name: runtime_name.into(),
            ownership: ExistingOwnership::Managed,
            deployment_id: Some(deployment_id),
            skill_id: Some(skill_id),
            version_id: Some(version_id),
        }
    }
}

/// Planner input after every selected logical target has been resolved and
/// verified against registered filesystem facts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeploymentPlanInput {
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub runtime_name: String,
    /// Path to the immutable central-library version tree.  The planner only
    /// copies this value into its output and never reads it.
    pub source_path: String,
    pub targets: Vec<VerifiedTarget>,
    pub mode_override: Option<DeploymentMode>,
    pub security_gate: DeploymentSecurityGate,
}

impl DeploymentPlanInput {
    pub fn new(
        skill_id: SkillId,
        version_id: VersionId,
        runtime_name: impl Into<String>,
        source_path: impl Into<String>,
        targets: Vec<VerifiedTarget>,
    ) -> Self {
        Self {
            skill_id,
            version_id,
            runtime_name: runtime_name.into(),
            source_path: source_path.into(),
            targets,
            mode_override: None,
            security_gate: DeploymentSecurityGate::default(),
        }
    }

    pub fn with_source_path(mut self, source_path: impl Into<String>) -> Self {
        self.source_path = source_path.into();
        self
    }

    pub fn with_mode(mut self, mode: DeploymentMode) -> Self {
        self.mode_override = Some(mode);
        self
    }

    pub fn with_basic_check_run(mut self, run: CheckRun) -> Self {
        self.security_gate.basic_check_run = Some(run);
        self
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DeploymentSecurityGate {
    pub basic_check_run: Option<CheckRun>,
}

/// API-facing deployment preview request.  The caller selects registered
/// logical target IDs; filesystem paths and physical identities are resolved
/// by the application boundary before constructing planner input.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeploymentPlanRequest {
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub runtime_name: String,
    pub logical_target_ids: Vec<String>,
    pub mode_override: Option<DeploymentMode>,
}

impl DeploymentPlanRequest {
    pub fn resolve<R: crate::deployment::RegisteredTargetResolver>(
        &self,
        resolver: &R,
        source_path: impl Into<String>,
    ) -> AppResult<DeploymentPlanInput> {
        Ok(DeploymentPlanInput {
            skill_id: self.skill_id,
            version_id: self.version_id.clone(),
            runtime_name: self.runtime_name.clone(),
            source_path: source_path.into(),
            targets: resolver.resolve(&self.logical_target_ids)?,
            mode_override: self.mode_override,
            security_gate: DeploymentSecurityGate::default(),
        })
    }
}

/// A registered-target resolver owned by the application layer.  Implementors
/// must load facts from discovery, custom-agent registration, or project
/// storage and verify them with the active PathPolicy before returning them.
pub struct RegisteredTargetIndex {
    facts: BTreeMap<String, TargetFact>,
    policy: PathPolicy,
}

impl RegisteredTargetIndex {
    pub fn from_facts(
        facts: impl IntoIterator<Item = TargetFact>,
        policy: PathPolicy,
    ) -> AppResult<Self> {
        let mut indexed = BTreeMap::new();
        for fact in facts {
            if fact.logical_target_id.trim().is_empty()
                || indexed
                    .insert(fact.logical_target_id.clone(), fact)
                    .is_some()
            {
                return Err(invalid_target(
                    "registered logical target IDs must be unique",
                ));
            }
        }
        Ok(Self {
            facts: indexed,
            policy,
        })
    }
}

impl crate::deployment::RegisteredTargetResolver for RegisteredTargetIndex {
    fn resolve(&self, logical_target_ids: &[String]) -> AppResult<Vec<VerifiedTarget>> {
        let mut targets = Vec::with_capacity(logical_target_ids.len());
        for id in logical_target_ids {
            let fact = self.facts.get(id).ok_or_else(|| {
                AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("logical_target_id", id.clone())
                    .with_action(RecoveryAction::InspectTarget)
            })?;
            targets.push(fact.clone().verify(&self.policy)?);
        }
        Ok(targets)
    }
}

/// Names used by the operation executor to summarize the filesystem change.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TargetChange {
    Create,
    NoOp,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TargetConflictReason {
    RuntimeNameAlreadyExists,
    OwnershipUnknown,
    ManagedByAnotherSkill,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct TargetConflict {
    pub physical_target_id: String,
    pub target_path: String,
    pub runtime_name: String,
    pub reason: TargetConflictReason,
    pub existing_ownership: ExistingOwnership,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct TargetPlan {
    pub physical_target_id: String,
    pub logical_target_ids: Vec<String>,
    pub target_path: String,
    pub destination_path: String,
    pub source_path: String,
    pub runtime_name: String,
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub mode: DeploymentMode,
    pub change: TargetChange,
    pub warnings: Vec<String>,
    pub conflicts: Vec<TargetConflict>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeploymentPlan {
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub runtime_name: String,
    /// For a single physical target this is its selected mode.  For a batch
    /// with different capabilities, inspect each `TargetPlan::mode`.
    pub mode: DeploymentMode,
    pub targets: Vec<TargetPlan>,
    pub warnings: Vec<String>,
    pub conflicts: Vec<TargetConflict>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentState {
    Planned,
    Deployed,
    Removed,
    NeedsRecovery,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeploymentRecord {
    pub id: DeploymentId,
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub target_id: String,
    pub state: DeploymentState,
    pub mode: DeploymentMode,
    pub managed: bool,
    pub runtime_name: String,
    pub expected_hash: String,
    pub observed_hash: Option<String>,
}

/// Compatibility aliases used by application services that call the planner
/// input a request or a planner input.
pub type DeploymentRequest = DeploymentPlanInput;
pub type PlannerInput = DeploymentPlanInput;
pub type TargetCapabilities = DeploymentCapability;
pub type DeploymentCapabilities = DeploymentCapability;

fn invalid_target(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("detail", detail.into())
        .with_action(RecoveryAction::InspectTarget)
}
