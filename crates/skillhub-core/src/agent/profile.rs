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

impl ProfileCatalog {
    pub fn profile_ids(&self) -> std::collections::BTreeSet<String> {
        self.profiles
            .iter()
            .map(|profile| {
                profile
                    .brand
                    .chars()
                    .filter_map(|character| {
                        if character.is_ascii_alphanumeric() {
                            Some(character.to_ascii_lowercase())
                        } else if character == '-' || character == '_' || character == ' ' {
                            Some('-')
                        } else {
                            None
                        }
                    })
                    .collect::<String>()
                    .trim_matches('-')
                    .to_owned()
            })
            .collect()
    }

    /// Return the checked-in compatibility catalog. The adapter crate owns the
    /// JSON files; this method keeps the stable catalog API on the domain type.
    pub fn builtin() -> Self {
        const PROFILES: &[&str] = &[
            include_str!("../../../skillhub-adapters/profiles/openai.json"),
            include_str!("../../../skillhub-adapters/profiles/anthropic.json"),
            include_str!("../../../skillhub-adapters/profiles/google.json"),
            include_str!("../../../skillhub-adapters/profiles/cursor.json"),
            include_str!("../../../skillhub-adapters/profiles/github-copilot.json"),
            include_str!("../../../skillhub-adapters/profiles/windsurf.json"),
            include_str!("../../../skillhub-adapters/profiles/cline.json"),
            include_str!("../../../skillhub-adapters/profiles/opencode.json"),
            include_str!("../../../skillhub-adapters/profiles/trae.json"),
            include_str!("../../../skillhub-adapters/profiles/qoder.json"),
            include_str!("../../../skillhub-adapters/profiles/codebuddy.json"),
            include_str!("../../../skillhub-adapters/profiles/comate.json"),
            include_str!("../../../skillhub-adapters/profiles/kimi.json"),
            include_str!("../../../skillhub-adapters/profiles/zcode.json"),
            include_str!("../../../skillhub-adapters/profiles/openclaw.json"),
            include_str!("../../../skillhub-adapters/profiles/hermes.json"),
            include_str!("../../../skillhub-adapters/profiles/grok.json"),
        ];
        Self {
            profiles: PROFILES
                .iter()
                .map(|content| serde_json::from_str(content).expect("valid builtin profile"))
                .collect(),
        }
    }
}
