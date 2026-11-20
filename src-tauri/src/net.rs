//! Small pure helpers for the GitHub sign-in commands (kept free of Tauri so they can be unit-tested
//! with plain `rustc --test src/net.rs`).

/// Characters that must never reach a PowerShell single-quoted string or a process argument.
fn clean(s: &str) -> bool {
    !s.is_empty() && s.len() < 4096 && !s.chars().any(|c| c.is_control() || c == '\'' || c == '`' || c == '"' || c == '$' || c == '\\' || c == ' ')
}

/// Only the GitHub device-flow endpoints may be posted to from Rust (the browser build does its own fetch).
pub fn post_url_ok(url: &str) -> bool {
    clean(url)
        && (url == "https://github.com/login/device/code" || url == "https://github.com/login/oauth/access_token")
}

/// Only github.com pages may be opened in the browser from the sign-in dialog.
pub fn open_url_ok(url: &str) -> bool {
    clean(url) && url.starts_with("https://github.com/") && !url.contains(['<', '>', '|', '^', ';', '&'])
}

/// Escape a string for use inside a PowerShell single-quoted literal.
pub fn ps_quote(s: &str) -> String {
    s.replace('\'', "''")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn post_urls() {
        assert!(post_url_ok("https://github.com/login/device/code"));
        assert!(post_url_ok("https://github.com/login/oauth/access_token"));
        assert!(!post_url_ok("https://github.com/login/oauth/access_token?x=1"));
        assert!(!post_url_ok("https://evil.example/login/device/code"));
        assert!(!post_url_ok("http://github.com/login/device/code"));
        assert!(!post_url_ok(""));
    }

    #[test]
    fn open_urls() {
        assert!(open_url_ok("https://github.com/login/device"));
        assert!(!open_url_ok("https://github.com.evil.example/x"));
        assert!(!open_url_ok("https://github.com/a b"));
        assert!(!open_url_ok("https://github.com/x&calc"));
        assert!(!open_url_ok("file:///c:/windows/system32/calc.exe"));
        assert!(!open_url_ok("https://github.com/x'; calc; '"));
    }

    #[test]
    fn quoting() {
        assert_eq!(ps_quote("a'b"), "a''b");
    }
}
