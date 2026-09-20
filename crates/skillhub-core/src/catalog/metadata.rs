use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum TranslationState {
    NotTranslated,
    Translated,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize, specta::Type)]
pub enum SkillCallPolicy {
    /// The Skill can be selected by the model or explicitly by the user.
    #[default]
    AutomaticAndManual,
    /// Automatic model selection is disabled; explicit user invocation remains available.
    ManualOnly,
    /// The model can select the Skill, while a user-facing invocation entry is hidden.
    ModelOnly,
    /// Neither automatic nor explicit invocation is currently available.
    Disabled,
}

pub type CallPolicy = SkillCallPolicy;

/// Read-only source of an invocation-policy fact. `Explicit` means the Skill
/// declared a callable subject; `Default` means no declaration was found and
/// the safe default (`model_and_user`) applies; `Unknown` means the platform's
/// Skill format does not expose an invocation field at all.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum InvocationPolicySource {
    Explicit,
    #[default]
    Default,
    Unknown,
}

/// User-facing invocation mode exposed by the quick drawer and detail page.
/// Snake_case to match the desktop client `InvocationMode` contract.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum InvocationMode {
    #[default]
    ModelAndUser,
    ModelOnly,
    UserOnly,
    Disabled,
}

impl InvocationMode {
    /// Maps the stored `CallPolicy` to the user-facing invocation mode.
    pub fn from_call_policy(policy: &CallPolicy) -> Self {
        match policy {
            CallPolicy::AutomaticAndManual => InvocationMode::ModelAndUser,
            CallPolicy::ModelOnly => InvocationMode::ModelOnly,
            CallPolicy::ManualOnly => InvocationMode::UserOnly,
            CallPolicy::Disabled => InvocationMode::Disabled,
        }
    }

    /// Inverse of [`InvocationMode::from_call_policy`].
    pub fn to_call_policy(self) -> CallPolicy {
        match self {
            InvocationMode::ModelAndUser => CallPolicy::AutomaticAndManual,
            InvocationMode::ModelOnly => CallPolicy::ModelOnly,
            InvocationMode::UserOnly => CallPolicy::ManualOnly,
            InvocationMode::Disabled => CallPolicy::Disabled,
        }
    }
}

/// Read-only fact describing how a Skill may be invoked. The UI must present the
/// `Default` source as a derived rule, never as an explicit declaration.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct InvocationPolicyFact {
    pub mode: InvocationMode,
    pub source: InvocationPolicySource,
    /// The YAML/frontmatter field that produced the fact, when explicit.
    /// Omitted for default/unknown sources so the UI never invents a field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

impl InvocationPolicyFact {
    pub fn from_parts(policy: CallPolicy, source: InvocationPolicySource, field: Option<String>) -> Self {
        Self {
            mode: InvocationMode::from_call_policy(&policy),
            source,
            field,
        }
    }
}

/// Read-only fact describing one declared runtime requirement. Values of
/// sensitive environment variables are never recorded; only the variable name
/// and source location survive parsing.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeclaredRequirementFact {
    pub kind: RequirementKind,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub explicit: bool,
    /// Human-readable evidence snippet (variable values already masked).
    pub source: String,
}

impl DeclaredRequirementFact {
    pub fn from_declared(requirement: &DeclaredRequirement) -> Self {
        Self {
            kind: requirement.kind.clone(),
            name: requirement.name.clone(),
            version: requirement.version.clone(),
            explicit: requirement.explicit,
            source: requirement.source.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RequirementKind {
    Python,
    Ffmpeg,
    Mcp,
    Plugin,
    EnvironmentVariable,
    OtherTool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DeclaredRequirement {
    pub kind: RequirementKind,
    pub name: String,
    pub version: Option<String>,
    pub explicit: bool,
    pub source: String,
}

pub fn parse_declared_requirements(text: &str) -> Vec<DeclaredRequirement> {
    let mut result = Vec::new();
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        let explicit_line = lower.contains("requires")
            || lower.contains("requirement")
            || lower.starts_with("python=")
            || lower.starts_with("ffmpeg=");
        let kinds = [
            ("python", RequirementKind::Python),
            ("ffmpeg", RequirementKind::Ffmpeg),
            ("mcp", RequirementKind::Mcp),
            ("plugin", RequirementKind::Plugin),
        ];
        for (needle, kind) in kinds {
            if lower.contains(needle) {
                let mut req = DeclaredRequirement::new(kind, line.trim());
                req.explicit = explicit_line;
                req.source = line.trim().to_owned();
                req.version = version_from(line);
                result.push(req);
            }
        }
        for token in line.split(|c: char| !c.is_ascii_alphanumeric() && c != '_') {
            if token.len() > 2
                && token
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                && token.contains('_')
            {
                let mut req = DeclaredRequirement::new(RequirementKind::EnvironmentVariable, token);
                req.explicit = explicit_line;
                req.source = line.trim().to_owned();
                result.push(req);
            }
        }
        for tool in ["node", "docker", "pandoc", "imagemagick", "git"] {
            if lower.contains(tool) {
                let mut req = DeclaredRequirement::new(RequirementKind::OtherTool, tool);
                req.explicit = explicit_line;
                req.source = line.trim().to_owned();
                result.push(req);
            }
        }
    }
    result
}

impl DeclaredRequirement {
    pub fn new(kind: RequirementKind, name: impl Into<String>) -> Self {
        Self {
            kind,
            name: name.into(),
            version: None,
            explicit: true,
            source: String::new(),
        }
    }
}

fn version_from(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'>' || *b == b'=' || *b == b'<' {
            let tail = &line[i..];
            let value: String = tail
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}
