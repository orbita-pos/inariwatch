use std::net::Ipv4Addr;

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

    // Extract host (before port or path)
    let host = after_auth
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_lowercase();

    if host.is_empty() {
        return Err("Invalid URL: no host.".into());
    }

    // Block localhost variants
    if host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "0.0.0.0" {
        return Err("Local addresses are not allowed.".into());
    }

    // Block private IP ranges
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
}
