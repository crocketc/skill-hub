use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ClientKind {
    Cli,
    Desktop,
    IdeExtension,
    Tui,
    Headless,
    Acp,
    Web,
    Mobile,
    Bot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum OperatingSystem {
    Windows,
    Macos,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DirectoryPrecedence {
    Preferred,
    LowerPriorityCopy,
    MayCoexist,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CallPolicy {
    Automatic,
    UserSelected,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeploymentCapability {
    pub copy: bool,
    pub symlink: bool,
    pub junction: bool,
    #[serde(default)]
    pub limitations: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentClient {
    pub id: String,
    pub kind: ClientKind,
    pub supported_os: Vec<OperatingSystem>,
    pub path_candidates: Vec<super::PathCandidate>,
    pub skill_marker: String,
    pub deployment: DeploymentCapability,
    pub call_policy: CallPolicy,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentProfile {
    pub profile_version: u32,
    pub research_date: String,
    pub official_references: Vec<String>,
    pub brand: String,
    pub clients: Vec<AgentClient>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ProfileCatalog {
    pub profiles: Vec<AgentProfile>,
}
