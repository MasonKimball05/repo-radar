//! Commit graph, diffs and uncommitted changes for the History window.
//! A port of KrakenLite's server.py, read-only like everything else here.

use crate::{git, scan};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

/// Diffing a root commit against this (git's empty tree) shows every file as added.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const LOG_LIMIT: usize = 1500;
// Field and record separators for `--format`: bytes that can't appear in a subject.
const US: char = '\x1f';
const RS: char = '\x1e';

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoList {
    pub root: String,
    pub repos: Vec<String>,
    pub default: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub name: String,
    pub branch: String,
    pub head: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub subject: String,
    /// Decorations as git prints them: "HEAD -> main", "origin/main", "tag: v1".
    pub refs: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefItem {
    pub name: String,
    pub hash: String,
    /// "[ahead 1, behind 2]" for local branches with an upstream, else empty.
    pub track: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refs {
    pub local: Vec<RefItem>,
    pub remote: Vec<RefItem>,
    pub tags: Vec<RefItem>,
    pub stashes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Log {
    pub commits: Vec<LogCommit>,
    pub refs: Refs,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// One letter from `--name-status` (M, A, D, R, C, T, U), or '?' for untracked.
    pub status: String,
    pub path: String,
    /// The old name of a renamed or copied file.
    pub old_path: Option<String>,
    /// `None` for binary files.
    pub add: Option<u32>,
    pub del: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub committer: String,
    pub ctime: i64,
    pub message: String,
    /// What the files are compared against: the first parent, or the empty tree.
    pub base: String,
    pub files: Vec<FileChange>,
}

#[derive(Debug, Serialize)]
pub struct WorkingTree {
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
}

#[derive(Debug, Serialize)]
pub struct Diff {
    pub diff: String,
}

#[derive(Debug, Serialize)]
pub struct Signature {
    pub sig: String,
}

/// The repos the window can switch between: the same list the dashboard scans.
pub fn repos(root: &str) -> Result<RepoList, String> {
    let root_path = Path::new(root);
    let (dirs, _) = scan::list_children(root_path)?;
    let repos = dirs
        .iter()
        .filter_map(|d| d.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    Ok(RepoList { root: root.to_string(), repos, default: None })
}

/// Resolves a repo name sent by the window. Only a direct child of `root`
/// that is a git repo is accepted, so a name like `../../etc` goes nowhere.
pub fn repo_path(root: &str, name: &str) -> Result<PathBuf, String> {
    let bad = name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']);
    let path = Path::new(root).join(name);
    if bad || !path.join(".git").exists() {
        return Err(format!("Unknown repo: {name}"));
    }
    Ok(path)
}

pub fn info(repo: &Path) -> Result<RepoInfo, String> {
    let name = repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(RepoInfo {
        name,
        branch: git::run_lenient(repo, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string(),
        head: git::run_lenient(repo, &["rev-parse", "HEAD"])?.trim().to_string(),
    })
}

pub fn log(repo: &Path) -> Result<Log, String> {
    let limit = format!("-n{LOG_LIMIT}");
    let format = format!("--format=%H{US}%P{US}%an{US}%ae{US}%at{US}%s{US}%D{RS}");
    let out = git::run_lenient(repo, &["log", "--all", "--date-order", &limit, &format])?;
    Ok(Log { commits: parse_log(&out), refs: refs(repo)? })
}

pub fn parse_log(out: &str) -> Vec<LogCommit> {
    out.split(RS)
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_matches('\n').split(US).collect();
            let [hash, parents, author, email, time, subject, refs] = f[..] else { return None };
            Some(LogCommit {
                hash: hash.to_string(),
                parents: parents.split_whitespace().map(String::from).collect(),
                author: author.to_string(),
                email: email.to_string(),
                time: time.parse().unwrap_or(0),
                subject: subject.to_string(),
                refs: refs.split(", ").filter(|r| !r.is_empty()).map(String::from).collect(),
            })
        })
        .collect()
}

fn refs(repo: &Path) -> Result<Refs, String> {
    let format = format!("--format=%(refname){US}%(objectname){US}%(upstream:track)");
    let out = git::run(repo, &["for-each-ref", "--sort=-committerdate", &format])?;
    let mut refs = Refs::default();
    for line in out.lines() {
        let mut f = line.split(US);
        let (Some(name), Some(hash), track) = (f.next(), f.next(), f.next().unwrap_or("")) else { continue };
        let item = |n: &str, track: &str| RefItem { name: n.into(), hash: hash.into(), track: track.into() };
        if let Some(n) = name.strip_prefix("refs/heads/") {
            refs.local.push(item(n, track));
        } else if let Some(n) = name.strip_prefix("refs/remotes/") {
            if !n.ends_with("/HEAD") {
                refs.remote.push(item(n, ""));
            }
        } else if let Some(n) = name.strip_prefix("refs/tags/") {
            refs.tags.push(item(n, ""));
        }
    }
    refs.stashes = git::run_lenient(repo, &["stash", "list"])?.lines().count();
    Ok(refs)
}

/// `--name-status` lines: "M\tpath", or "R100\told\tnew" for a rename.
pub fn parse_name_status(out: &str) -> Vec<FileChange> {
    out.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            let code = parts.first()?.get(..1)?;
            if parts.len() < 2 {
                return None;
            }
            let renamed = matches!(code, "R" | "C") && parts.len() > 2;
            Some(FileChange {
                status: code.to_string(),
                path: parts[parts.len() - 1].to_string(),
                old_path: renamed.then(|| parts[1].to_string()),
                add: None,
                del: None,
            })
        })
        .collect()
}

/// `--numstat` lines: "added\tdeleted\tpath", with "-" for binary files.
fn add_numstat(files: &mut [FileChange], out: &str) {
    let stats: HashMap<&str, (Option<u32>, Option<u32>)> = out
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            (parts.len() >= 3).then(|| (parts[parts.len() - 1], (parts[0].parse().ok(), parts[1].parse().ok())))
        })
        .collect();
    for f in files {
        if let Some(&(add, del)) = stats.get(f.path.as_str()) {
            (f.add, f.del) = (add, del);
        }
    }
}

fn changes(repo: &Path, args: &[&str]) -> Result<Vec<FileChange>, String> {
    let mut files = parse_name_status(&git::run(repo, &[&["diff", "--name-status"], args].concat())?);
    add_numstat(&mut files, &git::run(repo, &[&["diff", "--numstat"], args].concat())?);
    Ok(files)
}

pub fn commit(repo: &Path, sha: &str) -> Result<CommitDetail, String> {
    check_sha(sha)?;
    let format = format!("--format=%H{US}%P{US}%an{US}%ae{US}%at{US}%cn{US}%ct{US}%B");
    let meta = git::run(repo, &["show", "-s", &format, sha])?;
    let f: Vec<&str> = meta.splitn(8, US).collect();
    let [hash, parents, author, email, time, committer, ctime, message] = f[..] else {
        return Err(format!("couldn't read commit {sha}"));
    };
    let parents: Vec<String> = parents.split_whitespace().map(String::from).collect();
    let base = parents.first().map_or(EMPTY_TREE, String::as_str).to_string();
    Ok(CommitDetail {
        files: changes(repo, &["-M", &base, sha])?,
        hash: hash.into(),
        author: author.into(),
        email: email.into(),
        time: time.parse().unwrap_or(0),
        committer: committer.into(),
        ctime: ctime.parse().unwrap_or(0),
        message: message.trim().into(),
        parents,
        base,
    })
}

pub fn status(repo: &Path) -> Result<WorkingTree, String> {
    let staged = changes(repo, &["--cached", "-M"])?;
    let mut unstaged = changes(repo, &[])?;
    for path in untracked(repo)? {
        unstaged.push(FileChange { status: "?".into(), path, old_path: None, add: None, del: None });
    }
    Ok(WorkingTree { staged, unstaged })
}

fn untracked(repo: &Path) -> Result<Vec<String>, String> {
    Ok(git::run(repo, &["ls-files", "--others", "--exclude-standard"])?.lines().map(String::from).collect())
}

pub fn diff(
    repo: &Path,
    kind: &str,
    path: &str,
    old_path: Option<&str>,
    sha: Option<&str>,
    base: Option<&str>,
) -> Result<Diff, String> {
    let mut args: Vec<&str> = match kind {
        "commit" => {
            let (sha, base) = (sha.unwrap_or(""), base.unwrap_or(""));
            check_sha(sha)?;
            check_sha(base)?;
            vec!["diff", "-M", base, sha]
        }
        "staged" => vec!["diff", "--cached", "-M"],
        "unstaged" => vec!["diff"],
        "untracked" => {
            // --no-index can read any file on disk, so only allow this repo's own untracked files.
            if !untracked(repo)?.iter().any(|p| p == path) {
                return Err(format!("Not an untracked file: {path}"));
            }
            let diff = git::run_lenient(repo, &["diff", "--no-index", "--", "/dev/null", path])?;
            return Ok(Diff { diff });
        }
        _ => return Err(format!("unknown diff kind: {kind}")),
    };
    args.push("--");
    args.extend(old_path);
    args.push(path);
    Ok(Diff { diff: git::run_lenient(repo, &args)? })
}

/// Changes whenever a ref moves, HEAD changes, or the working tree changes;
/// the window polls it to know when to reload.
pub fn signature(repo: &Path) -> Result<Signature, String> {
    let mut h = DefaultHasher::new();
    git::run_lenient(repo, &["for-each-ref", "--format=%(refname)%(objectname)"])?.hash(&mut h);
    git::run_lenient(repo, &["rev-parse", "HEAD"])?.hash(&mut h);
    git::run_lenient(repo, &["status", "--porcelain"])?.hash(&mut h);
    Ok(Signature { sig: format!("{:016x}", h.finish()) })
}

/// A hex object id. Also guarantees the value can't be read as a git option.
fn check_sha(s: &str) -> Result<(), String> {
    let ok = (4..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    ok.then_some(()).ok_or_else(|| format!("bad sha: {s}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log_records() {
        let out = format!(
            "aaa{US}p1 p2{US}Mason{US}m@x{US}1700000000{US}Merge it{US}HEAD -> main, origin/main, tag: v1{RS}\n\
             p1{US}{US}Mason{US}m@x{US}1690000000{US}first, with a comma{US}{RS}\n"
        );
        let log = parse_log(&out);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].parents, ["p1", "p2"]);
        assert_eq!(log[0].refs, ["HEAD -> main", "origin/main", "tag: v1"]);
        assert!(log[1].parents.is_empty() && log[1].refs.is_empty());
        assert_eq!(log[1].subject, "first, with a comma");
    }

    #[test]
    fn parses_renames_and_numstat() {
        let mut files = parse_name_status("M\tsrc/a.rs\nR087\told.txt\tnew.txt\nA\timg.png\n");
        add_numstat(&mut files, "3\t1\tsrc/a.rs\n2\t2\tnew.txt\n-\t-\timg.png\n");
        assert_eq!(files[0], FileChange { status: "M".into(), path: "src/a.rs".into(), old_path: None, add: Some(3), del: Some(1) });
        assert_eq!(files[1].old_path.as_deref(), Some("old.txt"));
        assert_eq!((files[2].add, files[2].del), (None, None));
    }

    #[test]
    fn repo_names_cannot_escape_the_root() {
        for name in ["", ".", "..", "../x", "a/b", "a\\b"] {
            assert!(repo_path("/tmp", name).is_err(), "{name}");
        }
    }

    #[test]
    fn shas_must_be_hex() {
        assert!(check_sha("260710dd5c").is_ok());
        assert!(check_sha(EMPTY_TREE).is_ok());
        for bad in ["", "abc", "--output=x", "HEAD", "260710DD5C"] {
            assert!(check_sha(bad).is_err(), "{bad}");
        }
    }
}
