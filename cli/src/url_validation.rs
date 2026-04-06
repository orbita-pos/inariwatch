use std::net::{Ipv4Addr, Ipv6Addr};

/// Validates a URL to prevent SSRF attacks.
/// Rust port of `web/lib/url-validation.ts`.
/// Only allows HTTP/HTTPS and blocks private/local network addresses.
pub fn validate_public_url(url_str: &str) -> Result<(), String> {
    // Protocol check
    if !url_str.starts_with("http://") && !url_str.starts_with("https://") {
        return Err("Only HTTP and HTTPS URLs are allowed.".into());
    }

    // Extract hostname (between :// and the next / or : or end)
    let after_scheme = url_str
        .split("://")
        .nth(1)
        .ok_or("Invalid URL".to_string())?;

    // Strip userinfo (user:pass@)
    let after_auth = if let Some(idx) = after_scheme.find('@') {
        &after_scheme[idx + 1..]
    } else {
        after_scheme
    };

    // Extract host (before port or path). Handle IPv6 bracket notation.
    let host = if after_auth.starts_with('[') {
        // IPv6: [::1]:port/path
        let end = after_auth.find(']').ok_or("Invalid IPv6 address")?;
        &after_auth[..=end]
    } else {
        after_auth
            .split('/')
            .next()
            .unwrap_or("")
            .split(':')
            .next()
            .unwrap_or("")
    }.to_lowercase();

    if host.is_empty() {
        return Err("Invalid URL: no host.".into());
    }

    // Block localhost variants
    if host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "0.0.0.0" {
        return Err("Local addresses are not allowed.".into());
    }

    // Block private IPv4 ranges
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        let o = ip.octets();
        if o[0] == 10
            || (o[0] == 172 && (16..=31).contains(&o[1]))
            || (o[0] == 192 && o[1] == 168)
            || (o[0] == 169 && o[1] == 254)
            || o[0] == 0
        {
            return Err("Private network addresses are not allowed.".into());
        }
    }

    // Block private IPv6 ranges (strip brackets for parsing)
    let ipv6_str = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip6) = ipv6_str.parse::<Ipv6Addr>() {
        if ip6.is_loopback() || ip6.is_unspecified() {
            return Err("Local addresses are not allowed.".into());
        }
        let segs = ip6.segments();
        // fe80::/10 (link-local)
        if segs[0] & 0xffc0 == 0xfe80 {
            return Err("Link-local IPv6 addresses are not allowed.".into());
        }
        // fc00::/7 (unique local)
        if segs[0] & 0xfe00 == 0xfc00 {
            return Err("Private IPv6 addresses are not allowed.".into());
        }
        // ::ffff:x.x.x.x (IPv4-mapped) — check the embedded IPv4
        if segs[0..6] == [0, 0, 0, 0, 0, 0xffff] {
            let mapped = Ipv4Addr::new(
                (segs[6] >> 8) as u8, segs[6] as u8,
                (segs[7] >> 8) as u8, segs[7] as u8,
            );
            let o = mapped.octets();
            if o[0] == 127 || o[0] == 10
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 169 && o[1] == 254)
                || o[0] == 0
            {
                return Err("Private IPv4-mapped IPv6 addresses are not allowed.".into());
            }
        }
    }

    // Block decimal/octal IP representations (e.g., 2130706433 = 127.0.0.1)
    if let Ok(decimal) = host.parse::<u32>() {
        let ip = Ipv4Addr::from(decimal);
        let o = ip.octets();
        if o[0] == 127 || o[0] == 10 || o[0] == 0
            || (o[0] == 172 && (16..=31).contains(&o[1]))
            || (o[0] == 192 && o[1] == 168)
            || (o[0] == 169 && o[1] == 254)
        {
            return Err("Private network addresses are not allowed.".into());
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_public_urls() {
        assert!(validate_public_url("https://app.inariwatch.com/api/cron/poll").is_ok());
        assert!(validate_public_url("https://example.com").is_ok());
        assert!(validate_public_url("http://203.0.113.1:8080/path").is_ok());
    }

    #[test]
    fn blocks_localhost() {
        assert!(validate_public_url("http://localhost:9111/ingest").is_err());
        assert!(validate_public_url("http://127.0.0.1:8080").is_err());
        assert!(validate_public_url("http://0.0.0.0").is_err());
    }

    #[test]
    fn blocks_private_ips() {
        assert!(validate_public_url("http://10.0.0.1").is_err());
        assert!(validate_public_url("http://172.16.0.1").is_err());
        assert!(validate_public_url("http://192.168.1.1").is_err());
        assert!(validate_public_url("http://169.254.169.254/latest/meta-data/").is_err());
    }

    #[test]
    fn blocks_non_http() {
        assert!(validate_public_url("ftp://example.com").is_err());
        assert!(validate_public_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn blocks_ipv6_private() {
        assert!(validate_public_url("http://[::1]").is_err());
        assert!(validate_public_url("http://[fe80::1]").is_err());
        assert!(validate_public_url("http://[fc00::1]").is_err());
        assert!(validate_public_url("http://[::ffff:127.0.0.1]").is_err());
        assert!(validate_public_url("http://[::ffff:10.0.0.1]").is_err());
    }

    #[test]
    fn blocks_decimal_ip() {
        // 2130706433 = 127.0.0.1
        assert!(validate_public_url("http://2130706433").is_err());
        // 167772161 = 10.0.0.1
        assert!(validate_public_url("http://167772161").is_err());
    }
}
