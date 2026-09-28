//! Latest GitHub Actions run for a repo, via the `gh` CLI (uses your existing
//! `gh auth login`, so this app never handles a GitHub token itself).

use crate::git::github_slug;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")] // gh's JSON is camelCase too
pub struct CiRun {
    /// "completed", "in_progress", "queued", ...
    pub status: String,
    /// "success", "failure", "cancelled", ... Empty while still running.
    pub conclusion: String,
    pub workflow_name: String,
    pub url: String,
    pub created_at: String,
}

/// Apps launched from Finder get a minimal PATH without Homebrew, so look in
/// the usual install locations as well as PATH.
fn gh_binary() -> &'static str {
    ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]
        .into_iter()
        .find(|p| Path::new(p).exists())
        .unwrap_or("gh")
}

/// `Ok(None)` means the repo has no workflow runs.
pub fn latest_run(slug: &str) -> Result<Option<CiRun>, String> {
    // Re-validate: this string arrives from the frontend.
    if github_slug(&format!("github.com/{slug}")).as_deref() != Some(slug) {
        return Err(format!("not a valid GitHub repo: {slug:?}"));
    }

    let out = Command::new(gh_binary())
        .args(["run", "list", "--repo", slug, "--limit", "1"])
        .args(["--json", "status,conclusion,workflowName,url,createdAt"])
        .env("GH_PROMPT_DISABLED", "1")
        .output()
        .map_err(|e| format!("couldn't run gh (is it installed?): {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.lines().next().unwrap_or("gh failed").to_string());
    }
    let mut runs: Vec<CiRun> = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    // `pop` on a 0- or 1-element Vec gives Option<CiRun> without cloning.
    Ok(runs.pop())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_injection_before_running_anything() {
        for bad in ["--help", "o/r --web", "o", "o/r/x", "../etc/passwd"] {
            assert!(latest_run(bad).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn parses_gh_output() {
        let json = r#"[{"status":"completed","conclusion":"success","workflowName":"Django CI/CD",
                        "url":"https://github.com/o/r/actions/runs/1","createdAt":"2026-09-27T20:00:00Z"}]"#;
        let runs: Vec<CiRun> = serde_json::from_str(json).unwrap();
        assert_eq!(runs[0].workflow_name, "Django CI/CD");
    }
}
