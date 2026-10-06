import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { CiRun, ScanResult } from "./types";

/** True inside the Tauri window; false when the UI is opened in a plain browser. */
export const inTauri = "__TAURI_INTERNALS__" in window;

export async function defaultRoot(): Promise<string> {
  return inTauri ? invoke<string>("default_root") : "(demo data)";
}

export async function scanRepos(root: string): Promise<ScanResult> {
  if (inTauri) return invoke<ScanResult>("scan_repos", { root });
  // Browser demo mode for UI work: `npm run demo-data` writes this file.
  const res = await fetch("/demo-scan.json");
  if (!res.ok) throw new Error("No demo data. Run `npm run demo-data`, or use `npm run tauri dev`.");
  return res.json();
}

/** Opens a repo's History window (commit graph and diffs), or brings it forward if it's open. */
export async function openHistory(root: string, name: string): Promise<void> {
  const label = "graph-" + name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.unminimize();
    await existing.setFocus();
    return;
  }
  const win = new WebviewWindow(label, {
    url: `graph.html?${new URLSearchParams({ root, repo: name })}`,
    title: `${name} — History`,
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 500,
  });
  win.once("tauri://error", (e) => console.error("couldn't open History window", e));
}

export async function ciStatus(slug: string): Promise<CiRun | null> {
  if (!inTauri) return null;
  return invoke<CiRun | null>("ci_status", { slug });
}
