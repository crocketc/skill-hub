//! External link policy for the desktop shell.
//!
//! Contract: [`OpenExternalUrl`].
//!
//! Imported Skill content (README files, repository metadata) can contain
//! arbitrary links. Handing those straight to the platform browser would let
//! an imported file open `file://` paths, launch custom schemes or point the
//! user at an intranet host. The desktop shell therefore only opens links that
//! pass [`validate_external_url`]: https on an allowlisted host, no embedded
//! credentials and no bare IP literals.

/// Hosts the application itself can surface: repository README links and
/// release pages (`github.com`, `githubusercontent.com`), online discovery
/// (`skills.sh`) and the vendor documentation those README files usually link
/// to (`anthropic.com`, `claude.com`, `npmjs.com`). Subdomains are allowed.
///
/// The list is a deliberate product boundary, not a transport detail: links to
/// any other host are rejected with a structured error so the UI can show the
/// target and explain the refusal instead of silently doing nothing.
use serde::{Deserialize, Serialize};

pub const EXTERNAL_URL_ALLOWED_HOSTS: [&str; 6] = [
    "github.com",
    "githubusercontent.com",
    "skills.sh",
    "anthropic.com",
    "claude.com",
    "npmjs.com",
];

/// Returns true when `value` may be handed to the platform browser.
pub fn validate_external_url(value: &str) -> bool {
    // The WHATWG parser silently strips whitespace and control characters, so
    // reject them up front instead of relying on the parsed shape alone.
    if value.is_empty() || value.trim() != value || value.chars().any(char::is_control) {
        return false;
    }
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match external_url_host(value) {
        Some(host) => host_is_allowlisted(&host),
        None => false,
    }
}

/// Lower-cased host of a parsed URL, used for honest error reporting. Returns
/// `None` for values that are not https URLs with a named host, which is the
/// same class of input the validator rejects.
pub fn external_url_host(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() || host.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    Some(host)
}

fn host_is_allowlisted(host: &str) -> bool {
    EXTERNAL_URL_ALLOWED_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

/// Opens one validated https link in the platform default browser. The
/// desktop shell supplies the opener; without one the command is refused
/// instead of pretending the link was opened.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct OpenExternalUrl {
    pub url: String,
}

#[cfg(test)]
mod tests {
    use super::{external_url_host, validate_external_url, EXTERNAL_URL_ALLOWED_HOSTS};

    #[test]
    fn allowlisted_https_hosts_open() {
        assert!(validate_external_url(
            "https://github.com/anthropics/skills/blob/main/pdf/SKILL.md"
        ));
        assert!(validate_external_url(
            "https://raw.githubusercontent.com/anthropics/skills/main/README.md"
        ));
        assert!(validate_external_url("https://skills.sh/anthropics/pdf"));
        assert!(validate_external_url("https://docs.anthropic.com/en/docs"));
        assert!(validate_external_url(
            "https://www.npmjs.com/package/left-pad"
        ));
    }

    #[test]
    fn host_matching_is_case_insensitive_and_trims_a_trailing_dot() {
        assert!(validate_external_url(
            "HTTPS://GitHub.COM/anthropics/skills"
        ));
        assert!(validate_external_url(
            "https://github.com./anthropics/skills"
        ));
    }

    #[test]
    fn non_https_schemes_are_rejected() {
        assert!(!validate_external_url(
            "http://github.com/anthropics/skills"
        ));
        assert!(!validate_external_url("file:///C:/Users/secret/SKILL.md"));
        assert!(!validate_external_url("javascript:alert(1)"));
        assert!(!validate_external_url("data:text/html,<script>1</script>"));
        assert!(!validate_external_url("ftp://github.com/skills"));
    }

    #[test]
    fn hosts_outside_the_allowlist_are_rejected() {
        assert!(!validate_external_url("https://example.com/readme"));
        assert!(!validate_external_url("https://github.com.evil.com/readme"));
        assert!(!validate_external_url("https://notgithub.com/readme"));
        assert!(!validate_external_url("https://evilgithub.com/readme"));
        assert!(!validate_external_url("https://localhost:3000/readme"));
    }

    #[test]
    fn ip_literals_and_embedded_credentials_are_rejected() {
        assert!(!validate_external_url("https://127.0.0.1/admin"));
        assert!(!validate_external_url("https://[::1]/admin"));
        assert!(!validate_external_url(
            "https://user:password@github.com/anthropics/skills"
        ));
    }

    #[test]
    fn unparsable_and_empty_values_are_rejected() {
        assert!(!validate_external_url(""));
        assert!(!validate_external_url("github.com/anthropics/skills"));
        assert!(!validate_external_url("   "));
    }

    #[test]
    fn allowlist_only_contains_plain_hosts() {
        for host in EXTERNAL_URL_ALLOWED_HOSTS {
            assert!(!host.starts_with('.'), "{host} must be a plain host");
            assert!(!host.contains('/'), "{host} must be a plain host");
            assert_eq!(host, host.to_ascii_lowercase());
        }
    }

    #[test]
    fn host_is_reported_for_error_messages() {
        assert_eq!(
            external_url_host("https://GitHub.com/anthropics/skills"),
            Some("github.com".to_owned())
        );
        assert_eq!(
            external_url_host("https://example.com"),
            Some("example.com".to_owned())
        );
        assert_eq!(external_url_host("not a url"), None);
    }
}
