use crate::{SkillId, VersionId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct GetSkill {
    pub skill_id: SkillId,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ListVersions {
    pub skill_id: SkillId,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct DiffVersions {
    pub left: VersionId,
    pub right: VersionId,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ListCombinations;
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SkillResult {
    pub skill_id: SkillId,
    pub display_name: String,
    pub runtime_name: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct VersionResult {
    pub version_id: VersionId,
    pub skill_id: SkillId,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct VersionDiffResult {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct CombinationResult {
    pub name: String,
    pub members: Vec<SkillId>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct BootstrapSnapshot {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", content = "payload")]
pub enum AppQuery {
    #[serde(rename = "get_skill")]
    GetSkill(GetSkill),
    #[serde(rename = "list_versions")]
    ListVersions(ListVersions),
    #[serde(rename = "diff_versions")]
    DiffVersions(DiffVersions),
    #[serde(rename = "list_combinations")]
    ListCombinations(ListCombinations),
    #[serde(rename = "get_bootstrap_snapshot")]
    GetBootstrapSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", content = "payload")]
pub enum AppQueryResult {
    #[serde(rename = "skill")]
    Skill(SkillResult),
    #[serde(rename = "versions")]
    Versions(Vec<VersionResult>),
    #[serde(rename = "version_diff")]
    VersionDiff(VersionDiffResult),
    #[serde(rename = "combinations")]
    Combinations(Vec<CombinationResult>),
    #[serde(rename = "bootstrap_snapshot")]
    BootstrapSnapshot(BootstrapSnapshot),
}
