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
            || client.display_name.trim().is_empty()
        {
            return Err("incomplete client profile".into());
        }
        for candidate in &client.path_candidates {
            let path = candidate.path.trim();
            if path.is_empty() || is_unbounded_root(path) || !valid_agent_directory_pattern(path) {
                return Err("unbounded scan root".into());
            }
            if let Some(agent_root) = candidate.agent_root.as_deref() {
                if agent_root.trim().is_empty()
                    || is_unbounded_root(agent_root)
                    || !valid_agent_directory_pattern(agent_root)
                {
                    return Err("unbounded agent recognition root".into());
                }
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

/// The only dynamic profile segment is one Agent directory directly below an
/// explicitly anchored root. This supports per-Agent roots without accepting
/// glob patterns or recursive scans.
fn valid_agent_directory_pattern(path: &str) -> bool {
    let count = path.matches("{agent_directory}").count();
    if path.contains('*') || count > 1 {
        return false;
    }
    if count == 0 {
        return true;
    }
    let Some((anchored_prefix, _)) = path.split_once("{agent_directory}") else {
        return false;
    };
    let component_is_marker = path
        .split(['/', '\\'])
        .any(|component| component == "{agent_directory}");
    let after_anchor = anchored_prefix
        .split_once("{user_home}")
        .or_else(|| anchored_prefix.split_once("{project_root}"))
        .map(|(_, suffix)| suffix)
        .unwrap_or_default();
    let parent_is_bounded = after_anchor
        .split(['/', '\\'])
        .any(|component| !component.is_empty());
    component_is_marker
        && parent_is_bounded
        && (anchored_prefix.contains("{user_home}") || anchored_prefix.contains("{project_root}"))
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
    /// OPT-20260914-07: the brand-agnostic `.agents/skills` convention entry.
    /// It is a shared directory registry, not an installed client product;
    /// presence stays `Unknown` and no runtime loading is implied.
    SharedDirectory,
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
    /// Official product name of this concrete client form (e.g. "CodeBuddy
    /// Code", "Claude Desktop"), verified per client; never guessed from the
    /// brand name. Optional on read so persisted profiles keep deserializing.
    #[serde(default)]
    pub display_name: String,
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
    /// Declared deployment support of one concrete client.  Deployment modes
    /// must satisfy both the host filesystem and this profile claim, so an
    /// unconfirmed capability (for example Claude Code junctions) never gets
    /// selected even when the host could create one.  Unknown clients return
    /// `None`; callers keep their host-derived capabilities in that case.
    pub fn deployment_capability_for_client(
        &self,
        client_id: &str,
    ) -> Option<&DeploymentCapability> {
        // Legacy persisted CLI identity resolves to the single active declaration.
        let client_id = if client_id == "codex.cli" {
            "openai.codex-cli"
        } else {
            client_id
        };
        self.profiles
            .iter()
            .flat_map(|profile| profile.clients.iter())
            .find(|client| client.id == client_id)
            .map(|client| &client.deployment)
    }

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
            // OPT-20260914-07: the brand-agnostic `.agents/skills` convention
            // entry comes first; brand profiles only carry shared references.
            include_str!("../../../skillhub-adapters/profiles/agent-skills.json"),
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
            include_str!("../../../skillhub-adapters/profiles/pi.json"),
            include_str!("../../../skillhub-adapters/profiles/deepseek-harness.json"),
            include_str!("../../../skillhub-adapters/profiles/doubao.json"),
            include_str!("../../../skillhub-adapters/profiles/minimax-code.json"),
        ];
        Self {
            profiles: PROFILES
                .iter()
                .map(|content| serde_json::from_str(content).expect("valid builtin profile"))
                .collect(),
        }
    }
}

impl AgentProfile {
    /// Return the deterministic directory-recognition fact for a concrete
    /// path.  A profile path is evidence about file discovery only; the
    /// generic Agent Skills profile intentionally remains unknown about a
    /// runtime consumer.
    pub fn directory_recognition(&self, path: &str) -> crate::relationship::DirectoryRecognition {
        for client in &self.clients {
            for candidate in &client.path_candidates {
                if !path_matches_candidate(candidate, path) {
                    continue;
                }
                if matches!(client.kind, ClientKind::SharedDirectory) {
                    // A shared-directory profile identifies a possible
                    // location only.  Runtime support must come from an
                    // explicit AgentDirectoryCapabilityFact.
                    continue;
                }
                if candidate.shared_reference {
                    // A shared candidate identifies a possible directory only;
                    // it does not prove that this Agent consumes it. That
                    // fact must come from AgentDirectoryCapabilityFact.
                    continue;
                } else {
                    return crate::relationship::DirectoryRecognition::Supported;
                }
            }
        }
        crate::relationship::DirectoryRecognition::Unknown
    }
}

/// Match a concrete directory against a profile candidate without treating a
/// prefix such as `.agents/skills-demo` as `.agents/skills`.
pub fn path_matches_candidate(candidate: &super::PathCandidate, path: &str) -> bool {
    let candidate = candidate.path.replace('\\', "/");
    let path = path.replace('\\', "/");
    let suffix = candidate
        .split_once("{user_home}")
        .or_else(|| candidate.split_once("{project_root}"))
        .map(|(_, suffix)| suffix)
        .unwrap_or(candidate.as_str())
        .trim_matches('/');
    let candidate = candidate.trim_end_matches('/');
    let path = path.trim_end_matches('/');
    let windows = looks_like_windows_path(candidate) || looks_like_windows_path(path);
    path_has_suffix_components(path, suffix, windows)
}

fn path_has_suffix_components(path: &str, suffix: &str, case_insensitive: bool) -> bool {
    let expected = suffix
        .split('/')
        .filter(|component| !component.is_empty())
        .collect::<Vec<_>>();
    let actual = path
        .split('/')
        .filter(|component| !component.is_empty())
        .collect::<Vec<_>>();
    if expected.is_empty() {
        return actual.is_empty();
    }
    if actual.len() < expected.len() {
        return false;
    }
    let actual_suffix = &actual[actual.len() - expected.len()..];
    expected
        .iter()
        .zip(actual_suffix)
        .all(|(expected, actual)| {
            if *expected == "{agent_directory}" {
                !actual.is_empty() && *actual != "." && *actual != ".."
            } else if case_insensitive {
                expected.eq_ignore_ascii_case(actual)
            } else {
                expected == actual
            }
        })
}

fn looks_like_windows_path(path: &str) -> bool {
    path.as_bytes().get(1) == Some(&b':') || path.contains('\\')
}
