use crate::backup::{SensitiveContentDecision, SensitiveItem};
use crate::deployment::DeploymentRecord;
use crate::{CombinationId, SkillId, VersionId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ExportSelection {
    Skills(Vec<SkillId>),
    Combination(CombinationId),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum VersionSelection {
    Current,
    History(Vec<VersionId>),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExportSkill {
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub content: String,
    pub display_name: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Folder,
    Zip,
}

impl Default for ExportFormat {
    fn default() -> Self {
        Self::Folder
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExportInput {
    pub selection: ExportSelection,
    pub versions: VersionSelection,
    pub skills: Vec<ExportSkill>,
    /// Export packaging. Defaults to the legacy folder layout so payloads
    /// recorded before the field existed keep deserializing.
    #[serde(default)]
    pub format: ExportFormat,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExportPlan {
    pub selection: ExportSelection,
    pub versions: VersionSelection,
    pub skills: Vec<ExportSkillSummary>,
    pub sensitive_items: Vec<SensitiveItem>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExportSkillSummary {
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub display_name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExportDecision {
    pub skill_id: SkillId,
    pub decision: SensitiveContentDecision,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExportResult {
    pub path: String,
    pub skills_exported: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UninstallAction {
    Backup,
    StandardExport,
    UndeployAll,
    LeaveTargetsIndependent,
    RemoveDeviceData,
    RetainCentralLibrary,
    ClearCredentials,
    Cancel,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UninstallImpact {
    pub deployments: Vec<DeploymentRecord>,
    pub actions: Vec<UninstallAction>,
    pub preserves_central_library: bool,
}

pub struct UninstallService;

impl UninstallService {
    pub fn prepare(deployments: Vec<DeploymentRecord>) -> UninstallImpact {
        UninstallImpact {
            deployments,
            actions: vec![
                UninstallAction::Backup,
                UninstallAction::StandardExport,
                UninstallAction::UndeployAll,
                UninstallAction::LeaveTargetsIndependent,
                UninstallAction::RemoveDeviceData,
                UninstallAction::RetainCentralLibrary,
                UninstallAction::ClearCredentials,
                UninstallAction::Cancel,
            ],
            preserves_central_library: true,
        }
    }
}
