use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum TranslationState {
    NotTranslated,
    Translated,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum CallPolicy {
    AutomaticAndManual,
    ManualOnly,
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
}

pub fn parse_declared_requirements(text: &str) -> Vec<DeclaredRequirement> {
    let mut result = Vec::new();
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        let kind = if lower.contains("python") {
            Some(RequirementKind::Python)
        } else if lower.contains("ffmpeg") {
            Some(RequirementKind::Ffmpeg)
        } else if lower.contains("mcp") {
            Some(RequirementKind::Mcp)
        } else if lower.contains("plugin") {
            Some(RequirementKind::Plugin)
        } else {
            None
        };
        if let Some(kind) = kind {
            result.push(DeclaredRequirement::new(kind, line.trim()));
        }
        for token in line.split(|c: char| !c.is_ascii_alphanumeric() && c != '_') {
            if token.ends_with("_API_KEY") || token.starts_with("OPENAI_") {
                result.push(DeclaredRequirement::new(
                    RequirementKind::EnvironmentVariable,
                    token,
                ));
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
        }
    }
}
