use crate::{AppResult, ProjectId, SharedProjectConfig, SharedSkillRequirement, VersionId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AssemblyPlan {
    pub id: String,
    pub project_id: ProjectId,
    pub items: Vec<AssemblyItemPlan>,
}

impl AssemblyPlan {
    pub fn new(project_id: ProjectId, items: Vec<AssemblyItemPlan>) -> Self {
        Self {
            id: project_id.to_string(),
            project_id,
            items,
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
}

impl AssemblyItemPlan {
    pub fn new(requirement: SharedSkillRequirement, status: AssemblyItemStatus) -> Self {
        Self {
            requirement,
            status,
            version_id: None,
            reasons: Vec::new(),
            choice: None,
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
