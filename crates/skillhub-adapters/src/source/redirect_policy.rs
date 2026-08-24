use std::net::IpAddr;

use url::Url;

use super::http::SourceFetchErrorCode;

/// The single URL policy shared by initial requests and every redirect.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RedirectPolicy {
    allow_private: bool,
}

impl RedirectPolicy {
    pub fn new(allow_private: bool) -> Self {
        Self { allow_private }
    }

    pub fn validate(&self, url: &Url) -> Result<(), SourceFetchErrorCode> {
        if url.scheme() != "https" {
            return Err(SourceFetchErrorCode::HttpsRequired);
        }
        if !self.allow_private && is_private_destination(url) {
            return Err(SourceFetchErrorCode::RedirectBlocked);
        }
        Ok(())
    }

    pub fn resolve(&self, base: &Url, location: &str) -> Result<Url, SourceFetchErrorCode> {
        let target = base
            .join(location)
            .map_err(|_| SourceFetchErrorCode::RedirectBlocked)?;
        self.validate(&target)
            .map_err(|_| SourceFetchErrorCode::RedirectBlocked)?;
        Ok(target)
    }
}

fn is_private_destination(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return true;
    };
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return true;
    }
    let Ok(address) = host.parse::<IpAddr>() else {
        return false;
    };
    match address {
        IpAddr::V4(address) => {
            address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_broadcast()
                || address.is_unspecified()
        }
        IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || address.is_unique_local()
                || address.is_unicast_link_local()
        }
    }
}
