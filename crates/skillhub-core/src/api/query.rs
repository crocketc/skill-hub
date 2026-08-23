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
    #[serde(rename = "get_bootstrap_snapshot")]
    GetBootstrapSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", content = "payload")]
pub enum AppQueryResult {
    #[serde(rename = "bootstrap_snapshot")]
    BootstrapSnapshot(BootstrapSnapshot),
}
