//! Parsing and running `git`. Everything here is read-only.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// What `git status --porcelain=v2 --branch --show-stash` tells us.
///
/// `#[derive(...)]` generates trait impls at compile time: `Default` gives a
/// zeroed value, `Serialize` lets serde turn it into JSON for the frontend.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")] // Rust's snake_case -> JS's camelCase
pub struct Status {
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    /// `None` when the branch doesn't track a remote branch.
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: u32,
    pub modified: u32,
    pub untracked: u32,
    pub conflicted: u32,
    pub stashes: u32,
}

/// Parses porcelain v2 output: a stable, script-friendly format.
/// See `git help status`, section "Porcelain Format Version 2".
pub fn parse_status(out: &str) -> Status {
    let mut s = Status::default();
    for line in out.lines() {
        // `if let` destructures only when the pattern matches.
        if let Some(head) = line.strip_prefix("# branch.head ") {
            if head != "(detached)" {
                s.branch = Some(head.to_string());
            }
        } else if let Some(up) = line.strip_prefix("# branch.upstream ") {
            s.upstream = Some(up.to_string());
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            // Looks like "+3 -1".
            let mut parts = ab.split_whitespace();
            s.ahead = parse_count(parts.next(), '+');
            s.behind = parse_count(parts.next(), '-');
        } else if let Some(n) = line.strip_prefix("# stash ") {
            s.stashes = n.trim().parse().unwrap_or(0);
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            // "1 XY ...": X is the staged state, Y the working-tree state,
            // and '.' means unchanged. A file can be both staged and modified.
            if let Some(&[x, y]) = line.as_bytes().get(2..4) {
                s.staged += u32::from(x != b'.');
                s.modified += u32::from(y != b'.');
            }
        } else if line.starts_with("u ") {
            s.conflicted += 1;
        } else if line.starts_with("? ") {
            s.untracked += 1;
        }
    }
    s
}

fn parse_count(part: Option<&str>, sign: char) -> u32 {
    part.and_then(|p| p.strip_prefix(sign))
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

/// Reduces any remote URL form to `host/owner/repo`, with credentials removed.
///
/// `git@github.com:Owner/Repo.git`, `https://github.com/Owner/Repo` and
/// `https://user:TOKEN@github.com/Owner/Repo.git` all become
/// `github.com/Owner/Repo`. The raw URL never leaves this module, because an
/// HTTPS remote can have a personal access token embedded in it.
pub fn normalize_remote(url: &str) -> String {
    let mut s = url.trim();
    for scheme in ["https://", "http://", "ssh://", "git://"] {
        if let Some(rest) = s.strip_prefix(scheme) {
            s = rest;
            break;
        }
    }
    // Drop "user@" or "user:token@". Only look before the first '/', so an
    // '@' later in the path isn't mistaken for credentials.
    let host_end = s.find('/').unwrap_or(s.len());
    if let Some(at) = s[..host_end].rfind('@') {
        s = &s[at + 1..];
    }
    // scp-style "host:owner/repo" -> "host/owner/repo".
    let s = s.replacen(':', "/", 1);
    s.trim_end_matches('/').trim_end_matches(".git").to_string()
}

/// `"github.com/Owner/Repo"` -> `Some("Owner/Repo")`. Returns `None` for other
/// hosts, and for anything that isn't exactly two safe path segments, since the
/// result is later passed to the `gh` CLI as an argument.
pub fn github_slug(normalized: &str) -> Option<String> {
    let rest = normalized.strip_prefix("github.com/")?; // `?` returns None early
    let (owner, repo) = rest.split_once('/')?;
    (is_safe_segment(owner) && is_safe_segment(repo)).then(|| format!("{owner}/{repo}"))
}

/// GitHub names use letters, digits, '-', '_' and '.'. Rejecting everything
/// else (and a leading '-') means a slug can never be read as a CLI flag.
pub fn is_safe_segment(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Runs `git -C <repo> <args>` and returns stdout.
///
/// `Result<T, E>` is Rust's error handling: callers must deal with the `Err`
/// case explicitly; there are no exceptions.
pub fn run(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        // Never take .git/index.lock: we're scanning repos you may be
        // committing in at the same moment.
        .env("GIT_OPTIONAL_LOCKS", "0")
        // Never block waiting for a password prompt nobody can see.
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("couldn't run git: {e}"))?;

    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// `#[cfg(test)]` compiles this module only for `cargo test`.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_busy_repo() {
        let out = "\
# branch.oid 1a2b3c
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -5
# stash 3
1 M. N... 100644 100644 100644 aaa bbb staged.txt
1 .M N... 100644 100644 100644 aaa bbb modified.txt
1 MM N... 100644 100644 100644 aaa bbb both.txt
2 R. N... 100644 100644 100644 aaa bbb R100 new.txt\told.txt
u UU N... 100644 100644 100644 100644 a b c conflict.txt
? untracked.txt
? another.txt
";
        assert_eq!(
            parse_status(out),
            Status {
                branch: Some("main".into()),
                upstream: Some("origin/main".into()),
                ahead: 2,
                behind: 5,
                staged: 3,
                modified: 2,
                untracked: 2,
                conflicted: 1,
                stashes: 3,
            }
        );
    }

    #[test]
    fn detached_head_without_upstream() {
        let s = parse_status("# branch.oid abc\n# branch.head (detached)\n");
        assert_eq!(s.branch, None);
        assert_eq!(s.upstream, None);
    }

    #[test]
    fn normalizes_every_remote_form() {
        for url in [
            "git@github.com:MasonKimball05/Parliament.git",
            "https://github.com/MasonKimball05/Parliament",
            "https://github.com/MasonKimball05/Parliament.git/",
            "ssh://git@github.com/MasonKimball05/Parliament.git",
        ] {
            assert_eq!(normalize_remote(url), "github.com/MasonKimball05/Parliament", "{url}");
        }
    }

    #[test]
    fn strips_embedded_tokens() {
        let n = normalize_remote("https://mason:ghp_SECRET123@github.com/o/r.git");
        assert_eq!(n, "github.com/o/r");
        assert!(!n.contains("SECRET"));
    }

    #[test]
    fn slug_rejects_unsafe_input() {
        assert_eq!(github_slug("github.com/o/r").as_deref(), Some("o/r"));
        assert_eq!(github_slug("gitlab.com/o/r"), None);
        assert_eq!(github_slug("github.com/o/r/extra"), None);
        assert_eq!(github_slug("github.com/-o/r"), None); // would look like a flag
        assert_eq!(github_slug("github.com/o/r;rm -rf"), None);
    }
}
