use std::net::{IpAddr, SocketAddr};

use tokio::net::lookup_host;
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

    pub async fn validate_resolved(&self, url: &Url) -> Result<(), SourceFetchErrorCode> {
        self.resolve_destination(url).await.map(|_| ())
    }

    pub async fn resolve_destination(
        &self,
        url: &Url,
    ) -> Result<Option<SocketAddr>, SourceFetchErrorCode> {
        if self.allow_private {
            return Ok(None);
        }
        let Some(host) = url.host_str() else {
            return Err(SourceFetchErrorCode::RedirectBlocked);
        };
        let host = normalize_host(host);
        if let Ok(address) = host.parse::<IpAddr>() {
            if is_blocked_ip(address) {
                return Err(SourceFetchErrorCode::RedirectBlocked);
            }
            let port = url
                .port_or_known_default()
                .ok_or(SourceFetchErrorCode::RedirectBlocked)?;
            return Ok(Some(SocketAddr::new(address, port)));
        }
        if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
            return Err(SourceFetchErrorCode::RedirectBlocked);
        }
        let port = url
            .port_or_known_default()
            .ok_or(SourceFetchErrorCode::RedirectBlocked)?;
        let addresses = lookup_host((host, port))
            .await
            .map_err(|_| SourceFetchErrorCode::RedirectBlocked)?
            .collect::<Vec<_>>();
        if addresses.is_empty() || addresses.iter().any(|address| is_blocked_ip(address.ip())) {
            return Err(SourceFetchErrorCode::RedirectBlocked);
        }
        Ok(addresses.first().copied())
    }
}

fn is_private_destination(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return true;
    };
    let host = normalize_host(host);
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return true;
    }
    let Ok(address) = host.parse::<IpAddr>() else {
        return false;
    };
    is_blocked_ip(address)
}

fn normalize_host(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host)
}

fn is_blocked_ip(address: IpAddr) -> bool {
    if let IpAddr::V6(address) = address {
        if let Some(mapped) = address.to_ipv4_mapped() {
            return is_blocked_ip(IpAddr::V4(mapped));
        }
    }
    match address {
        IpAddr::V4(address) => {
            address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_broadcast()
                || address.is_unspecified()
                || address.octets()[0] == 100 && (address.octets()[1] & 0b1100_0000) == 64
        }
        IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || address.is_unique_local()
                || address.is_unicast_link_local()
        }
    }
}
