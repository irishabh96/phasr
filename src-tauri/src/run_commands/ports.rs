//! Dev-server port detection on a run command's (ANSI-stripped) output.
//!
//! A printed port is only a claim — servers print their URL before (or
//! without ever) binding, and a test runner may echo a URL it doesn't
//! serve — so a candidate is reported only once a TCP connect succeeds.

use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;

/// Connect attempts per candidate, `CONFIRM_INTERVAL` apart (~10s): a
/// bundler can print its URL a few seconds before it accepts connections.
const CONFIRM_ATTEMPTS: u32 = 40;
const CONFIRM_INTERVAL: Duration = Duration::from_millis(250);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Text carried between chunks so a URL split across two reads still
/// matches.
const CARRY: usize = 256;

fn port_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Loopback / any-address hosts, with or without a scheme:
        // `http://localhost:5173/`, `127.0.0.1:8080`, `tcp://0.0.0.0:3000`,
        // `http://[::1]:3000`, `[::]:8080`.
        Regex::new(r"(?i)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b")
            .expect("static port regex")
    })
}

/// Every plausible port in `text`, in order of appearance, deduplicated.
pub fn find_ports(text: &str) -> Vec<u16> {
    let mut out = Vec::new();
    for caps in port_regex().captures_iter(text) {
        if let Some(port) = caps.get(1).and_then(|m| m.as_str().parse::<u16>().ok()) {
            if port != 0 && !out.contains(&port) {
                out.push(port);
            }
        }
    }
    out
}

/// Streaming scanner: feed ANSI-stripped text, get newly seen ports.
#[derive(Debug, Default)]
pub struct PortScanner {
    carry: String,
    seen: Vec<u16>,
}

impl PortScanner {
    pub fn feed(&mut self, text: &str) -> Vec<u16> {
        let window = format!("{}{}", self.carry, text);
        let fresh: Vec<u16> = find_ports(&window)
            .into_iter()
            .filter(|p| !self.seen.contains(p))
            .collect();
        self.seen.extend(&fresh);
        let cut = window.len().saturating_sub(CARRY);
        let cut = (cut..=window.len()).find(|i| window.is_char_boundary(*i)).unwrap_or(window.len());
        self.carry = window[cut..].to_string();
        fresh
    }
}

/// Whether something accepts TCP connections on `port` on this machine.
pub async fn accepts_connections(port: u16) -> bool {
    for addr in [format!("127.0.0.1:{port}"), format!("[::1]:{port}")] {
        if let Ok(Ok(_)) = tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect(&addr)).await {
            return true;
        }
    }
    false
}

/// Poll `port` until it accepts a connection (→ `true`) or we give up.
pub async fn confirm(port: u16) -> bool {
    for i in 0..CONFIRM_ATTEMPTS {
        if accepts_connections(port).await {
            return true;
        }
        if i + 1 < CONFIRM_ATTEMPTS {
            tokio::time::sleep(CONFIRM_INTERVAL).await;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real banners (ANSI already stripped).
    #[test]
    fn finds_ports_in_common_dev_server_banners() {
        let fixtures: &[(&str, &str, &[u16])] = &[
            ("vite", "  VITE v5.4.2  ready in 312 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose\n", &[5173]),
            ("next", "  ▲ Next.js 14.2.3\n  - Local:        http://localhost:3000\n  - Environments: .env\n\n ✓ Ready in 1843ms\n", &[3000]),
            ("cargo axum", "   Compiling api v0.1.0\n    Finished dev [unoptimized] target(s)\n     Running `target/debug/api`\nlistening on 0.0.0.0:8080\n", &[8080]),
            ("cargo actix", "[2026-11-09T10:00:00Z INFO  actix_server::builder] starting service: \"actix-web-service-127.0.0.1:8081\"\n", &[8081]),
            ("rails puma", "=> Booting Puma\n* Listening on http://127.0.0.1:3000\n* Listening on http://[::1]:3000\nUse Ctrl-C to stop\n", &[3000]),
            ("puma tcp", "* Listening on tcp://0.0.0.0:9292\n", &[9292]),
            ("ipv6 any", "server bound to [::]:4000\n", &[4000]),
        ];
        for (name, text, want) in fixtures {
            assert_eq!(find_ports(text), want.to_vec(), "{name}");
        }
    }

    #[test]
    fn ignores_things_that_are_not_local_ports() {
        for text in [
            "compiled at 12:30:45",
            "fetching https://registry.npmjs.org:443/react",
            "localhost:abc",
            "listening on 10.0.0.5:3000",
            "localhost:0",
            "localhost:99999",
        ] {
            assert!(find_ports(text).is_empty(), "{text}");
        }
    }

    #[test]
    fn scanner_matches_across_chunks_and_reports_each_port_once() {
        let mut s = PortScanner::default();
        assert!(s.feed("  ➜  Local:   http://local").is_empty());
        assert_eq!(s.feed("host:5173/\n"), vec![5173]);
        assert!(s.feed("again http://localhost:5173/\n").is_empty());
        assert_eq!(s.feed("hmr on localhost:24678\n"), vec![24678]);
    }

    #[tokio::test]
    async fn confirms_only_a_listening_port() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(accepts_connections(port).await);
        // Bound but not listening: the port is held (so a parallel test
        // can't grab it between drop and connect), and connects are refused.
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let closed = socket.local_addr().unwrap().port();
        assert!(!accepts_connections(closed).await);
        drop(listener);
    }
}
