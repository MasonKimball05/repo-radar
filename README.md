# Repo Radar

A desktop dashboard for every git repo in a folder: what's uncommitted,
unpushed, behind, stashed, duplicated, and whether CI is passing. Built
with [Tauri 2](https://tauri.app), with a Rust backend and a React + TypeScript UI.

## What it shows

| Column | Source |
|---|---|
| Status dot | 🔴 conflicts / git error · 🟡 anything below needs attention · 🟢 clean and pushed |
| Branch | current branch, ↑ unpushed / ↓ behind (as of your last fetch), "not pushed" if no upstream |
| Working tree | staged, modified, untracked, conflicted, stashed counts |
| Last commit | age and subject |
| CI | latest GitHub Actions run via `gh` (click to open it) |

Filters: needs attention, uncommitted, unpushed, behind, no remote, **duplicates**
(folders cloned from the same origin, e.g. `Parliament` / `Parliament-clean`).
It rescans automatically when the window regains focus.

**History:** click a repo's name (or ⎇) to open its commit graph in its own
window: branch lanes, commit details, and diffs (Hunk or Split). The window's
repo switcher lists the same repos as the dashboard. It's the
[KrakenLite](../krakenlite) UI (`src/graph/`, `graph.html`) backed by the
`kl_*` commands in `src-tauri/src/history.rs`, and refreshes itself when the
repo changes.

## Run

```bash
npm install
npm run tauri dev          # the app, with hot reload
npm test                   # Rust unit + integration tests
npm run tauri build        # a real .app in src-tauri/target/release/bundle/
```

UI-only work in a plain browser: `npm run demo-data`, then `npm run dev` and
open http://localhost:1420. It shows a saved snapshot, and CI/actions are disabled.
The snapshot contains your local paths and is gitignored.

A CLI scan that prints the JSON the UI receives:
`cd src-tauri && cargo run --example scan -- ~/Documents/GitHub`

## Safe by design

- **Read-only.** Every git call runs with `GIT_OPTIONAL_LOCKS=0`, so scanning
  never takes `.git/index.lock` in a repo you're committing in. It never fetches.
- **No tokens.** CI goes through your existing `gh auth login`. Remote URLs are
  reduced to `host/owner/repo` in Rust, so a token embedded in an HTTPS remote
  never reaches the UI.
- **No shell.** Commands run via `std::process::Command` with argument arrays,
  and the GitHub slug is validated before it's passed to `gh`.
- **Locked-down webview.** A strict CSP, plus Tauri capabilities limiting the UI
  to the opener plugin (reveal in Finder, open https links).

## Layout

```
src-tauri/src/git.rs     porcelain-v2 parser, remote normalization, `git` runner (+ tests)
src-tauri/src/scan.rs    finds repos, scans them in parallel with thread::scope (+ temp-repo tests)
src-tauri/src/ci.rs      `gh run list` wrapper
src-tauri/src/lib.rs     Tauri commands exposed to the UI
src/App.tsx              table, filters, CI loading (4 at a time)
src/flags.ts             what counts as "needs attention"
```

## Ideas

- Actions per repo: open in VS Code / Terminal, `git fetch` all (opt-in, since it touches the network)
- Menu-bar icon with a count of repos needing attention
- Show sentinel status for repos that have a deployed site
