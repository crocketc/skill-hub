use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Local,
    Https,
    Git,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceLocator {
    LocalPath(PathBuf),
    HttpsUrl(String),
    GitUrl(String),
}

impl SourceLocator {
    pub fn local_path(path: impl Into<PathBuf>) -> Self {
        Self::LocalPath(path.into())
    }
    pub fn https_url(url: impl Into<String>) -> Self {
        Self::HttpsUrl(url.into())
    }
    pub fn git_url(url: impl Into<String>) -> Self {
        Self::GitUrl(url.into())
    }
    pub fn as_local_path(&self) -> Option<&PathBuf> {
        match self {
            Self::LocalPath(path) => Some(path),
            Self::HttpsUrl(_) | Self::GitUrl(_) => None,
        }
    }
    pub fn as_url(&self) -> Option<&str> {
        match self {
            Self::LocalPath(_) => None,
            Self::HttpsUrl(url) | Self::GitUrl(url) => Some(url),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SourceDescriptor {
    pub kind: SourceKind,
    pub locator: SourceLocator,
}

impl SourceDescriptor {
    pub fn new(kind: SourceKind, locator: SourceLocator) -> Self {
        Self { kind, locator }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ParsedSourceInput {
    pub original_input: String,
    pub descriptor: SourceDescriptor,
    pub skill_selector: Option<String>,
    pub target_hint: Option<String>,
    pub executable: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum SourceErrorCode {
    #[serde(rename = "source.invalid_input")]
    InvalidInput,
    #[serde(rename = "source.https_required")]
    HttpsRequired,
    #[serde(rename = "source.unsupported")]
    Unsupported,
    #[serde(rename = "source.command_not_parseable")]
    CommandNotParseable,
}

impl SourceErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidInput => "source.invalid_input",
            Self::HttpsRequired => "source.https_required",
            Self::Unsupported => "source.unsupported",
            Self::CommandNotParseable => "source.command_not_parseable",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SourceInputError {
    pub code: SourceErrorCode,
    pub params: BTreeMap<String, String>,
}

impl SourceInputError {
    pub fn new(code: SourceErrorCode) -> Self {
        Self {
            code,
            params: BTreeMap::new(),
        }
    }
}

impl fmt::Display for SourceInputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code.as_str())
    }
}

impl std::error::Error for SourceInputError {}
