//! The `phasr` agent CLI (Story CLI1, architect §R7).
//!
//! A THIN client a spawned ticket agent shells out to (`phasr <verb> …`) to
//! advance its OWN ticket on the phasr board. It does NOT open the DB and does NOT
//! link the app's heavy modules (no Tauri, no sqlx) — it is DEPENDENCY-LIGHT by
//! design: only `std::os::unix::net::UnixStream` + `serde_json`. It connects to
//! the app's socket (`$PHASR_SOCK`), sends ONE line-delimited JSON request
//! `{ token, verb, args }` (token from `$PHASR_TOKEN`), prints the response, and
//! exits non-zero on error.
//!
//! The wire shape is duplicated (not imported) precisely so building this binary
//! never pulls `phasr_lib` (and thus Tauri/sqlx) in — the request/response is
//! plain `serde_json` here and typed `CliRequest`/`CliResponse` on the app side;
//! the two must stay byte-compatible (guarded by the app-side round-trip test).
//!
//! Invocation note: the on-disk binary name is irrelevant — agents call it via the
//! absolute `"$PHASR_BIN"` the app injects, so PATH never matters (§J4).

// Only Unix has AF_UNIX here (Windows deferred, §R4). A non-unix build still
// compiles but refuses to run rather than silently no-op.
#[cfg(not(unix))]
fn main() {
    eprintln!("phasr: the agent CLI is only supported on Unix");
    std::process::exit(1);
}

#[cfg(unix)]
fn main() {
    std::process::exit(run());
}

#[cfg(unix)]
fn run() -> i32 {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.is_empty() {
        eprintln!(
            "usage: phasr <request-review|comment|new-ticket|update-status|validate|approve|request-changes> [options]"
        );
        return 2;
    }
    let verb = argv[0].clone();
    let rest = &argv[1..];

    // Env is the PRIMARY channel — the app injects PHASR_TOKEN/PHASR_SOCK at spawn.
    // The `--token`/`--socket` flags are the manual-use fallback (§C.3).
    let mut token = std::env::var("PHASR_TOKEN").ok();
    let mut sock = std::env::var("PHASR_SOCK").ok();

    // Parse verb-specific args (+ the shared overrides) into a JSON object. A
    // plain index loop (no closures) keeps the borrows trivially clean.
    let mut args_obj = serde_json::Map::new();
    let mut positional: Vec<String> = Vec::new();
    let mut i = 0;
    while i < rest.len() {
        let flag = rest[i].as_str();
        // The value-taking flags map 1:1 to an `args` key; `--token`/`--socket`
        // set the connection instead. Both consume the next token as their value.
        let arg_key = match flag {
            "--role" => Some("role"),
            "--agent" => Some("agent"),
            "--prompt" => Some("prompt"),
            "--after" => Some("after"),
            "--body" => Some("body"),
            // Stage B reviewer verbs: the bounce reason (`request-changes`)
            // and an optional approval note.
            "--comment" => Some("comment"),
            _ => None,
        };
        if let Some(key) = arg_key {
            match rest.get(i + 1) {
                Some(value) => {
                    args_obj.insert(key.to_string(), serde_json::Value::String(value.clone()));
                    i += 2;
                }
                None => {
                    eprintln!("phasr: `{flag}` needs a value");
                    return 2;
                }
            }
            continue;
        }
        match flag {
            "--token" => match rest.get(i + 1) {
                Some(value) => {
                    token = Some(value.clone());
                    i += 2;
                }
                None => {
                    eprintln!("phasr: `--token` needs a value");
                    return 2;
                }
            },
            "--socket" | "--sock" => match rest.get(i + 1) {
                Some(value) => {
                    sock = Some(value.clone());
                    i += 2;
                }
                None => {
                    eprintln!("phasr: `--socket` needs a value");
                    return 2;
                }
            },
            "--done" => {
                // `update-status --done` is the only flag-toggle verb.
                args_obj.insert("done".to_string(), serde_json::Value::Bool(true));
                i += 1;
            }
            other if other.starts_with("--") => {
                eprintln!("phasr: unknown flag `{other}`");
                return 2;
            }
            _ => {
                positional.push(rest[i].clone());
                i += 1;
            }
        }
    }

    // `phasr comment "<body>"` — a single positional is the comment body.
    if verb == "comment" && !args_obj.contains_key("body") {
        if let Some(body) = positional.first() {
            args_obj.insert("body".to_string(), serde_json::Value::String(body.clone()));
        }
    }

    let token = match token.filter(|t| !t.is_empty()) {
        Some(t) => t,
        None => {
            eprintln!(
                "phasr: no token — agents get $PHASR_TOKEN automatically; for manual use pass --token"
            );
            return 2;
        }
    };
    let sock = match sock.filter(|s| !s.is_empty()) {
        Some(s) => s,
        None => {
            eprintln!("phasr: no socket — set $PHASR_SOCK or pass --socket");
            return 2;
        }
    };

    let request = serde_json::json!({
        "token": token,
        "verb": verb,
        "args": serde_json::Value::Object(args_obj),
    });

    let mut stream = match UnixStream::connect(&sock) {
        Ok(stream) => stream,
        Err(err) => {
            // Socket down is NON-FATAL context (the app may just not be running).
            eprintln!("phasr: app not running? could not connect to {sock} ({err})");
            return 1;
        }
    };
    let mut line = request.to_string();
    line.push('\n');
    if let Err(err) = stream.write_all(line.as_bytes()) {
        eprintln!("phasr: failed to send request: {err}");
        return 1;
    }

    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    if let Err(err) = reader.read_line(&mut response) {
        eprintln!("phasr: failed to read response: {err}");
        return 1;
    }

    let value: serde_json::Value = match serde_json::from_str(response.trim()) {
        Ok(value) => value,
        Err(err) => {
            eprintln!("phasr: malformed response: {err}");
            return 1;
        }
    };

    if value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        match value.get("result") {
            Some(result) => println!(
                "{}",
                serde_json::to_string_pretty(result).unwrap_or_else(|_| result.to_string())
            ),
            None => println!("ok"),
        }
        0
    } else {
        let error = value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        eprintln!("phasr: {error}");
        1
    }
}
