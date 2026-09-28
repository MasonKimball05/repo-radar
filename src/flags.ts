import type { Repo } from "./types";

export type Level = "bad" | "warn" | "ok";

export interface Flag {
  id: FlagId;
  label: string;
  level: Level;
}

export type FlagId =
  | "error"
  | "conflict"
  | "dirty"
  | "unpushed"
  | "behind"
  | "no-upstream"
  | "no-remote"
  | "stash"
  | "detached"
  | "duplicate";

/** Everything about a repo that deserves attention, worst first. */
export function flagsFor(repo: Repo, duplicateNames: Set<string>): Flag[] {
  const flags: Flag[] = [];
  const s = repo.status;
  if (repo.error || !s) {
    flags.push({ id: "error", label: "git error", level: "bad" });
    return flags;
  }
  if (s.conflicted) flags.push({ id: "conflict", label: `${s.conflicted} conflicted`, level: "bad" });
  const changes = s.staged + s.modified + s.untracked;
  if (changes) flags.push({ id: "dirty", label: "uncommitted", level: "warn" });
  if (s.ahead) flags.push({ id: "unpushed", label: `${s.ahead} unpushed`, level: "warn" });
  if (s.behind) flags.push({ id: "behind", label: `${s.behind} behind`, level: "warn" });
  if (!repo.remote) flags.push({ id: "no-remote", label: "no remote", level: "warn" });
  else if (s.branch && !s.upstream) flags.push({ id: "no-upstream", label: "branch not pushed", level: "warn" });
  if (!s.branch) flags.push({ id: "detached", label: "detached HEAD", level: "warn" });
  if (s.stashes) flags.push({ id: "stash", label: `${s.stashes} stashed`, level: "warn" });
  if (duplicateNames.has(repo.name)) flags.push({ id: "duplicate", label: "duplicate clone", level: "warn" });
  return flags;
}

export function worstLevel(flags: Flag[]): Level {
  if (flags.some((f) => f.level === "bad")) return "bad";
  if (flags.length) return "warn";
  return "ok";
}

const RANK: Record<Level, number> = { bad: 0, warn: 1, ok: 2 };
export const compareLevel = (a: Level, b: Level) => RANK[a] - RANK[b];

export function timeAgo(unixSeconds: number, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.round(now - unixSeconds));
  if (s < 60) return "just now";
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, "y"],
    [60 * 60 * 24 * 30, "mo"],
    [60 * 60 * 24 * 7, "w"],
    [60 * 60 * 24, "d"],
    [60 * 60, "h"],
    [60, "m"],
  ];
  for (const [size, unit] of units) {
    if (s >= size) return `${Math.floor(s / size)}${unit} ago`;
  }
  return "just now";
}
