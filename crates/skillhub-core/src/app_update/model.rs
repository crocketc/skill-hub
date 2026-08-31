use serde::{Deserialize, Serialize};

/// Trust level of the currently running application build.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum BuildTrust {
    WindowsUnsigned,
    WindowsTrusted,
    MacosAdHoc,
    MacosNotarized,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum InstallAction {
    OpenOfficialRelease,
    InstallVerifiedAsset,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ApplicationUpdate {
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_url: String,
    pub asset_name: Option<String>,
    pub published_at: Option<String>,
    pub install_action: InstallAction,
}

impl ApplicationUpdate {
    pub fn none(current_version: impl Into<String>) -> Self {
        let current_version = current_version.into();
        Self {
            available: false,
            latest_version: current_version.clone(),
            current_version,
            release_url: String::new(),
            asset_name: None,
            published_at: None,
            install_action: InstallAction::OpenOfficialRelease,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ApplicationUpdatePolicy {
    pub enabled: bool,
    pub check_on_startup: bool,
}

impl Default for ApplicationUpdatePolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            check_on_startup: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CheckApplicationUpdate {
    pub current_version: String,
    pub repository: String,
    pub build_trust: BuildTrust,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct OpenOfficialRelease {
    pub release_url: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SetApplicationUpdatePolicy {
    pub enabled: bool,
    pub check_on_startup: bool,
}

pub fn install_action_for(trust: BuildTrust) -> InstallAction {
    match trust {
        BuildTrust::WindowsTrusted | BuildTrust::MacosNotarized => {
            InstallAction::InstallVerifiedAsset
        }
        BuildTrust::WindowsUnsigned | BuildTrust::MacosAdHoc | BuildTrust::Unknown => {
            InstallAction::OpenOfficialRelease
        }
    }
}

pub fn validate_official_release_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && {
            let segments = url
                .path()
                .split('/')
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>();
            segments.len() >= 3 && segments[2] == "releases"
        }
}

pub fn version_is_newer(current: &str, latest: &str) -> Option<bool> {
    fn parse(value: &str) -> Option<semver::Version> {
        semver::Version::parse(value.strip_prefix('v').unwrap_or(value)).ok()
    }
    Some(parse(latest)? > parse(current)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_gate_keeps_unsigned_builds_manual_only() {
        assert_eq!(
            install_action_for(BuildTrust::WindowsUnsigned),
            InstallAction::OpenOfficialRelease
        );
        assert_eq!(
            install_action_for(BuildTrust::MacosAdHoc),
            InstallAction::OpenOfficialRelease
        );
        assert_eq!(
            install_action_for(BuildTrust::WindowsTrusted),
            InstallAction::InstallVerifiedAsset
        );
    }

    #[test]
    fn versions_and_release_urls_are_validated_without_network() {
        assert_eq!(version_is_newer("0.1.0", "v0.2.0"), Some(true));
        assert_eq!(version_is_newer("1.0.0", "1.0.0-beta"), Some(false));
        assert_eq!(version_is_newer("dev", "1.0.0"), None);
        assert!(validate_official_release_url(
            "https://github.com/crocketc/skill-hub/releases/tag/v0.2.0"
        ));
        assert!(!validate_official_release_url(
            "https://example.com/crocketc/skill-hub/releases/tag/v0.2.0"
        ));
    }
}
