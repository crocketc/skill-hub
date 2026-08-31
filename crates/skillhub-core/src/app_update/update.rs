use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{AppError, AppResult, ErrorCode, Severity};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UpdatePlatform {
    pub target: String,
    pub arch: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UpdateArtifact {
    pub target: String,
    pub url: String,
    #[serde(with = "u64_string")]
    #[specta(type = String)]
    pub size: u64,
    pub sha256: String,
    pub signature: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UpdateManifest {
    pub version: String,
    pub notes: String,
    pub published_at: Option<String>,
    pub artifacts: Vec<UpdateArtifact>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UpdateState {
    NotChecked,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Verifying,
    ReadyToInstall,
    Failed,
    RolledBack,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PreparedApplicationUpdate {
    pub manifest: UpdateManifest,
    pub artifact: UpdateArtifact,
    pub state: UpdateState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DownloadedApplicationUpdate {
    pub artifact: UpdateArtifact,
    pub state: UpdateState,
}

pub fn select_artifact(
    manifest: &UpdateManifest,
    platform: &UpdatePlatform,
) -> AppResult<UpdateArtifact> {
    let expected_target = format!("{}-{}", platform.target, platform.arch);
    manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.target == expected_target)
        .cloned()
        .ok_or_else(|| AppError::new(ErrorCode::ApplicationUpdateUnavailable, Severity::Warning))
}

pub fn verify_artifact(bytes: &[u8], artifact: &UpdateArtifact) -> AppResult<()> {
    validate_artifact_url(&artifact.url)?;

    if artifact.signature.is_empty() {
        return Err(AppError::new(
            ErrorCode::ApplicationUpdateSignatureMissing,
            Severity::Error,
        ));
    }

    if artifact.size != bytes.len() as u64 {
        return Err(integrity_error());
    }

    let digest = Sha256::digest(bytes);
    let observed = format!("{digest:x}");
    if artifact.sha256 != observed || !is_lower_hex_sha256(&artifact.sha256) {
        return Err(integrity_error());
    }

    Ok(())
}

fn validate_artifact_url(value: &str) -> AppResult<()> {
    let Ok(url) = url::Url::parse(value) else {
        return Err(invalid_artifact_url());
    };
    if url.scheme() != "https" {
        return Err(invalid_artifact_url());
    }
    Ok(())
}

fn invalid_artifact_url() -> AppError {
    AppError::new(
        ErrorCode::ApplicationUpdateInvalidArtifactUrl,
        Severity::Error,
    )
}

fn integrity_error() -> AppError {
    AppError::new(ErrorCode::ApplicationUpdateIntegrityFailed, Severity::Error)
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

mod u64_string {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        value.parse().map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_artifact_target_is_platform_dash_architecture() {
        let manifest = UpdateManifest {
            version: "1.0.0".to_owned(),
            notes: String::new(),
            published_at: None,
            artifacts: vec![UpdateArtifact {
                target: "macos-aarch64".to_owned(),
                url: "https://updates.example.invalid/skillhub.dmg".to_owned(),
                size: 0,
                sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                    .to_owned(),
                signature: "signature".to_owned(),
            }],
        };

        let selected = select_artifact(
            &manifest,
            &UpdatePlatform {
                target: "macos".to_owned(),
                arch: "aarch64".to_owned(),
            },
        )
        .unwrap();

        assert_eq!(selected.target, "macos-aarch64");
    }
}
