import { invoke } from "@tauri-apps/api/core";
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

export async function ciStatus(slug: string): Promise<CiRun | null> {
  if (!inTauri) return null;
  return invoke<CiRun | null>("ci_status", { slug });
}
