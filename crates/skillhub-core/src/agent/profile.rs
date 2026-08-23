use serde::{Deserialize, Serialize};

/// Shared structural validation for built-in and user-supplied profiles.
/// JSON schema validation remains the adapter boundary; this function keeps
/// typed custom profiles subject to the same safety invariants.
pub fn validate_profile_strict(profile: &AgentProfile) -> Result<(), String> {
    if profile.profile_version == 0
        || profile.brand.trim().is_empty()
        || profile.clients.is_empty()
        || profile.official_references.is_empty()
        || !valid_date(&profile.research_date)
        || profile
            .official_references
            .iter()
            .any(|url| !valid_url(url))
    {
        return Err("incomplete profile".into());
    }
    for client in &profile.clients {
        if client.id.trim().is_empty()
            || client.skill_marker.trim().is_empty()
            || client.supported_os.is_empty()
        {
            return Err("incomplete client profile".into());
        }
        for candidate in &client.path_candidates {
            let path = candidate.path.trim();
            if path.is_empty() || is_unbounded_root(path) || path.contains("**") {
                return Err("unbounded scan root".into());
            }
            if candidate.marker.trim().is_empty() {
                return Err("empty skill marker".into());
            }
        }
    }
    Ok(())
}

fn valid_date(value: &str) -> bool {
    let mut parts = value.split('-');
    let (Some(year), Some(month), Some(day), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    if year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) = (
        year.parse::<u32>(),
        month.parse::<u32>(),
        day.parse::<u32>(),
    ) else {
        return false;
    };
    if !(1..=12).contains(&month) || day == 0 {
        return false;
    }
    let days = match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    day <= days
}

fn valid_url(value: &str) -> bool {
    let Ok(parsed) = url::Url::parse(value) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https")
        && parsed.host_str().is_some_and(|host| !host.is_empty())
}

fn is_unbounded_root(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    let components = trimmed
        .split('/')
        .filter(|component| !component.is_empty())
        .collect::<Vec<_>>();
    let has_traversal = components
        .iter()
        .any(|component| *component == "." || *component == "..");
    let home_root = components.len() == 2
        && (components[0].eq_ignore_ascii_case("users")
            || components[0].eq_ignore_ascii_case("home"));
    let windows_home_root = components.len() == 3
        && components[0].len() == 2
        && components[0].as_bytes().get(1) == Some(&b':')
        && components[1].eq_ignore_ascii_case("Users");
    let unc_root = normalized.starts_with("//") && components.len() <= 2;
    trimmed.is_empty()
        || has_traversal
        || trimmed == "~"
        || trimmed == "."
        || trimmed.eq_ignore_ascii_case("%USERPROFILE%")
        || trimmed.eq_ignore_ascii_case("$HOME")
        || trimmed.eq_ignore_ascii_case("{user_home}")
        || trimmed.ends_with(':')
        || (trimmed.len() == 2 && trimmed.as_bytes().get(1) == Some(&b':'))
        || home_root
        || windows_home_root
        || unc_root
}

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
