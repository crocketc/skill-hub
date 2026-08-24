use crate::{
    AppResult, OperationId, ProjectId, SharedProjectConfig, SharedSkillRequirement, VersionId,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AssemblyPlan {
    pub id: String,
    pub operation_id: OperationId,
    pub project_id: ProjectId,
    pub items: Vec<AssemblyItemPlan>,
    pub committed: bool,
}

impl AssemblyPlan {
    pub fn new(project_id: ProjectId, items: Vec<AssemblyItemPlan>) -> Self {
        Self {
            id: project_id.to_string(),
            operation_id: OperationId::new(),
            project_id,
            items,
            committed: false,
        }
    }

    pub fn with_choice_for_item(mut self, index: usize, choice: AssemblyChoice) -> Self {
        if let Some(item) = self.items.get_mut(index) {
            item.choice = Some(choice);
        }
        self
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AssemblyItemPlan {
    pub requirement: SharedSkillRequirement,
    pub status: AssemblyItemStatus,
    pub version_id: Option<VersionId>,
    pub reasons: Vec<String>,
    pub choice: Option<AssemblyChoice>,
    pub conflict_kind: Option<AssemblyConflictKind>,
    pub allowed_choices: Vec<AssemblyChoice>,
}

impl AssemblyItemPlan {
    pub fn new(requirement: SharedSkillRequirement, status: AssemblyItemStatus) -> Self {
        Self {
            requirement,
            status,
            version_id: None,
            reasons: Vec::new(),
            choice: None,
            conflict_kind: None,
            allowed_choices: Vec::new(),
        }
    }

    pub fn with_version(mut self, version_id: VersionId) -> Self {
        self.version_id = Some(version_id);
        self
    }

    pub fn with_reasons(mut self, reasons: Vec<String>) -> Self {
        self.reasons = reasons;
        self
    }

    pub fn with_conflict(
        mut self,
        kind: AssemblyConflictKind,
        allowed_choices: Vec<AssemblyChoice>,
    ) -> Self {
        self.conflict_kind = Some(kind);
        self.allowed_choices = allowed_choices;
        self
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AssemblyConflictKind {
    SourceAmbiguity,
    SameNameConflict,
    HighRiskFinding,
    DeploymentTargetConflict,
}

impl AssemblyConflictKind {
    pub fn from_reasons(reasons: &[String]) -> Self {
        if reasons.iter().any(|reason| {
            let reason = reason.to_ascii_lowercase();
            reason.contains("source") || reason.contains("ambig")
        }) {
            return Self::SourceAmbiguity;
        }
        if reasons.iter().any(|reason| {
            let reason = reason.to_ascii_lowercase();
            reason.contains("same_name") || reason.contains("name_conflict")
        }) {
            return Self::SameNameConflict;
        }
        Self::DeploymentTargetConflict
    }

    pub const fn allowed_choices(self) -> &'static [AssemblyChoice] {
        match self {
            Self::SourceAmbiguity => &[AssemblyChoice::Skip],
            Self::SameNameConflict => &[AssemblyChoice::UseExisting, AssemblyChoice::Skip],
            Self::HighRiskFinding => &[AssemblyChoice::Acquire, AssemblyChoice::Skip],
            Self::DeploymentTargetConflict => &[AssemblyChoice::UseExisting, AssemblyChoice::Skip],
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AssemblyItemStatus {
    AlreadySatisfied,
    ReadyToAcquire,
    ConflictNeedsChoice,
    Skipped,
    Failed,
    Succeeded,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AssemblyChoice {
    Acquire,
    Skip,
    UseExisting,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SkillResolution {
    Satisfied { version_id: VersionId },
    Missing { requested_source: String },
    Conflict { reasons: Vec<String> },
    Failed { reasons: Vec<String> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SourcePreparation {
    NotNeeded,
    Ready { version_id: VersionId },
    Conflict { reasons: Vec<String> },
    Failed { reasons: Vec<String> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CheckPreparation {
    NotNeeded,
    Passed,
    HighRiskNeedsChoice { reasons: Vec<String> },
    Failed { reasons: Vec<String> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeploymentPreparation {
    NotNeeded,
    Ready,
    Conflict { reasons: Vec<String> },
    Failed { reasons: Vec<String> },
}

pub trait SkillResolutionPort {
    fn shared_config(&self, project_id: ProjectId) -> AppResult<SharedProjectConfig>;
    fn resolve_requirement(
        &self,
        requirement: &SharedSkillRequirement,
    ) -> AppResult<SkillResolution>;
}

pub trait SourcePreparationPort {
    fn prepare_source(&self, requirement: &SharedSkillRequirement) -> AppResult<SourcePreparation>;
}

pub trait CheckPreparationPort {
    fn prepare_checks(
        &self,
        requirement: &SharedSkillRequirement,
        version_id: &VersionId,
    ) -> AppResult<CheckPreparation>;
}

pub trait DeploymentPreparationPort {
    fn prepare_project_deployment(
        &self,
        requirement: &SharedSkillRequirement,
        version_id: &VersionId,
    ) -> AppResult<DeploymentPreparation>;

    fn commit_project_deployment(
        &self,
        requirement: &SharedSkillRequirement,
        version_id: &VersionId,
    ) -> AppResult<()>;
}
