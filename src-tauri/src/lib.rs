mod ci;
pub mod git;
pub mod history;
pub mod scan;

use std::path::PathBuf;

// Tauri commands are Rust functions the frontend calls with `invoke()`.
// They're `async` and hand the work to a blocking thread pool, because a
// sync command would run on the main thread and freeze the window while
// 30 repos are being scanned.

#[tauri::command]
async fn scan_repos(root: String) -> Result<scan::ScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || scan::scan_root(&PathBuf::from(root)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ci_status(slug: String) -> Result<Option<ci::CiRun>, String> {
    tauri::async_runtime::spawn_blocking(move || ci::latest_run(&slug))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn default_root() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join("Documents/GitHub").display().to_string()
}

// The History window's commands. Each takes the scan root and a repo name
// (never a raw path) so the window can only read repos the dashboard lists.

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn kl_repos(root: String) -> Result<history::RepoList, String> {
    blocking(move || history::repos(&root)).await
}

#[tauri::command]
async fn kl_repo(root: String, repo: String) -> Result<history::RepoInfo, String> {
    blocking(move || history::info(&history::repo_path(&root, &repo)?)).await
}

#[tauri::command]
async fn kl_log(root: String, repo: String) -> Result<history::Log, String> {
    blocking(move || history::log(&history::repo_path(&root, &repo)?)).await
}

#[tauri::command]
async fn kl_commit(root: String, repo: String, sha: String) -> Result<history::CommitDetail, String> {
    blocking(move || history::commit(&history::repo_path(&root, &repo)?, &sha)).await
}

#[tauri::command]
async fn kl_status(root: String, repo: String) -> Result<history::WorkingTree, String> {
    blocking(move || history::status(&history::repo_path(&root, &repo)?)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn kl_diff(
    root: String,
    repo: String,
    kind: String,
    path: String,
    old_path: Option<String>,
    sha: Option<String>,
    base: Option<String>,
) -> Result<history::Diff, String> {
    blocking(move || {
        let dir = history::repo_path(&root, &repo)?;
        history::diff(&dir, &kind, &path, old_path.as_deref(), sha.as_deref(), base.as_deref())
    })
    .await
}

#[tauri::command]
async fn kl_signature(root: String, repo: String) -> Result<history::Signature, String> {
    blocking(move || history::signature(&history::repo_path(&root, &repo)?)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_repos,
            ci_status,
            default_root,
            kl_repos,
            kl_repo,
            kl_log,
            kl_commit,
            kl_status,
            kl_diff,
            kl_signature
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
