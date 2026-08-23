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
