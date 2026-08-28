use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum TranslationState {
    NotTranslated,
    Translated,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum CallPolicy {
    /// The Skill can be selected by the model or explicitly by the user.
    AutomaticAndManual,
    /// Automatic model selection is disabled; explicit user invocation remains available.
    ManualOnly,
    /// The model can select the Skill, while a user-facing invocation entry is hidden.
    ModelOnly,
    /// Neither automatic nor explicit invocation is currently available.
    Disabled,
}

impl Default for CallPolicy {
    fn default() -> Self {
        Self::AutomaticAndManual
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
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
