// Mirrors the Rust structs in src-tauri/src/{git,scan,ci}.rs (serde camelCase).

export interface Status {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  stashes: number;
}

export interface Commit {
  timestamp: number;
  subject: string;
}

export interface Repo {
  name: string;
  path: string;
  status: Status | null;
  lastCommit: Commit | null;
  remote: string | null;
  github: string | null;
  error: string | null;
}

export interface ScanResult {
  root: string;
  repos: Repo[];
  notRepos: string[];
  duplicates: string[][];
  scannedAt: number;
}

export interface CiRun {
  status: string;
  conclusion: string;
  workflowName: string;
  url: string;
  createdAt: string;
}

export type CiState =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "run"; run: CiRun }
  | { kind: "error"; message: string };
