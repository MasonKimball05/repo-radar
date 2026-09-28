//! Finds the git repos in a folder and gathers their state.

use crate::git::{self, Status};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    /// Unix seconds.
    pub timestamp: i64,
    pub subject: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub name: String,
    pub path: String,
    /// `None` if `git status` failed; see `error`.
    pub status: Option<Status>,
    pub last_commit: Option<Commit>,
    /// `host/owner/repo` for `origin`, credentials stripped.
    pub remote: Option<String>,
    /// `Owner/Repo` when origin is on GitHub.
    pub github: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root: String,
    pub repos: Vec<Repo>,
    /// Folders in the root that aren't git repos.
    pub not_repos: Vec<String>,
    /// Groups of repo names that share the same origin: extra clones.
    pub duplicates: Vec<Vec<String>>,
    pub scanned_at: i64,
}

/// Scans every direct child of `root`.
pub fn scan_root(root: &Path) -> Result<ScanResult, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("can't open {}: {e}", root.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }

    let (repo_dirs, not_repos) = list_children(&root)?;

    // One thread per repo; each spends most of its time waiting on git.
    // `thread::scope` guarantees every thread finishes before the scope ends,
    // which is what lets the threads borrow `repo_dirs` without copying it.
    let repos: Vec<Repo> = thread::scope(|s| {
        let handles: Vec<_> = repo_dirs.iter().map(|dir| s.spawn(|| scan_repo(dir))).collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("repo scan thread panicked"))
            .collect()
    });

    let duplicates = find_duplicates(&repos);
    Ok(ScanResult {
        root: root.display().to_string(),
        repos,
        not_repos,
        duplicates,
        scanned_at: now_unix(),
    })
}

/// Splits `root`'s subfolders into git repos and everything else, sorted by name.
fn list_children(root: &Path) -> Result<(Vec<PathBuf>, Vec<String>), String> {
    let mut repos = Vec::new();
    let mut others = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue }; // `let-else`: skip unreadable entries
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !path.is_dir() {
            continue;
        }
        // `.git` is a folder in a normal clone, a file in a worktree or submodule.
        if path.join(".git").exists() {
            repos.push(path);
        } else {
            others.push(name);
        }
    }
    repos.sort_by_key(|p| p.file_name().map(|n| n.to_ascii_lowercase()));
    others.sort_by_key(|n| n.to_lowercase());
    Ok((repos, others))
}

fn scan_repo(dir: &Path) -> Repo {
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut repo = Repo {
        name,
        path: dir.display().to_string(),
        status: None,
        last_commit: None,
        remote: None,
        github: None,
        error: None,
    };

    match git::run(dir, &["status", "--porcelain=v2", "--branch", "--show-stash"]) {
        Ok(out) => repo.status = Some(git::parse_status(&out)),
        Err(e) => repo.error = Some(e),
    }

    // %x00 separates the fields with a NUL byte, which can't appear in a subject.
    // An empty repo has no commits; that's not an error worth showing.
    if let Ok(out) = git::run(dir, &["log", "-1", "--format=%ct%x00%s"]) {
        if let Some((ts, subject)) = out.trim_end().split_once('\0') {
            repo.last_commit = ts.parse().ok().map(|timestamp| Commit {
                timestamp,
                subject: subject.to_string(),
            });
        }
    }

    // No origin is normal for a local-only repo.
    if let Ok(url) = git::run(dir, &["remote", "get-url", "origin"]) {
        let normalized = git::normalize_remote(&url);
        repo.github = git::github_slug(&normalized);
        repo.remote = Some(normalized);
    }
    repo
}

/// Groups repos whose origins match (case-insensitively, like GitHub).
fn find_duplicates(repos: &[Repo]) -> Vec<Vec<String>> {
    // BTreeMap keeps keys sorted, so the output order is stable between scans.
    let mut by_remote: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for r in repos {
        if let Some(remote) = &r.remote {
            by_remote.entry(remote.to_lowercase()).or_default().push(r.name.clone());
        }
    }
    by_remote.into_values().filter(|names| names.len() > 1).collect()
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// A throwaway folder under the system temp dir, deleted on drop.
    /// `Drop` is Rust's destructor: it runs when the value goes out of scope,
    /// even if the test panics.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("repo-radar-{label}-{nanos}"));
            fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sh_git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    fn make_repo(root: &Path, name: &str, remote: Option<&str>) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        sh_git(&dir, &["init", "-q", "-b", "main"]);
        fs::write(dir.join("a.txt"), "a").unwrap();
        sh_git(&dir, &["add", "."]);
        sh_git(&dir, &["commit", "-q", "-m", "first commit"]);
        if let Some(url) = remote {
            sh_git(&dir, &["remote", "add", "origin", url]);
        }
        dir
    }

    #[test]
    fn scans_a_folder_of_repos() {
        let tmp = TempDir::new("scan");
        make_repo(&tmp.0, "clean", Some("git@github.com:me/clean.git"));
        let dirty = make_repo(&tmp.0, "dirty", None);
        fs::write(dirty.join("a.txt"), "changed").unwrap();
        fs::write(dirty.join("new.txt"), "new").unwrap();
        make_repo(&tmp.0, "clean-copy", Some("https://github.com/Me/Clean"));
        fs::create_dir(tmp.0.join("just-a-folder")).unwrap();

        let result = scan_root(&tmp.0).unwrap();
        let names: Vec<_> = result.repos.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["clean", "clean-copy", "dirty"]);
        assert_eq!(result.not_repos, ["just-a-folder"]);

        let clean = &result.repos[0];
        assert_eq!(clean.github.as_deref(), Some("me/clean"));
        assert_eq!(clean.last_commit.as_ref().unwrap().subject, "first commit");
        assert_eq!(clean.status.as_ref().unwrap().branch.as_deref(), Some("main"));

        let st = result.repos[2].status.as_ref().unwrap();
        assert_eq!((st.modified, st.untracked), (1, 1));

        // Same origin, different URL style and case: still a duplicate.
        assert_eq!(result.duplicates, [["clean", "clean-copy"]]);
    }

    #[test]
    fn rejects_missing_root() {
        assert!(scan_root(Path::new("/definitely/not/here")).is_err());
    }
}
