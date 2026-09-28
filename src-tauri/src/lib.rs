mod ci;
pub mod git;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![scan_repos, ci_status, default_root])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
