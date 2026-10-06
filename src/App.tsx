import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { ciStatus, defaultRoot, inTauri, openHistory, scanRepos } from "./api";
import { compareLevel, flagsFor, timeAgo, worstLevel, type Flag, type FlagId, type Level } from "./flags";
import type { CiState, Repo, ScanResult } from "./types";
import "./App.css";

type Filter = "all" | "attention" | FlagId;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "attention", label: "Needs attention" },
  { id: "dirty", label: "Uncommitted" },
  { id: "unpushed", label: "Unpushed" },
  { id: "behind", label: "Behind" },
  { id: "no-remote", label: "No remote" },
  { id: "duplicate", label: "Duplicates" },
  { id: "all", label: "All" },
];

const ROOT_KEY = "repo-radar:root";
const CI_CONCURRENCY = 4;

interface Row {
  repo: Repo;
  flags: Flag[];
  level: Level;
}

export default function App() {
  const [root, setRoot] = useState<string>("");
  const [rootDraft, setRootDraft] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState<Filter>("attention");
  const [query, setQuery] = useState("");
  const [ci, setCi] = useState<Record<string, CiState>>({});
  const scanId = useRef(0);

  // Pick the saved folder, or ~/Documents/GitHub the first time.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(ROOT_KEY);
    } catch {
      /* storage unavailable: fall back to the default */
    }
    (saved ? Promise.resolve(saved) : defaultRoot()).then((r) => {
      setRoot(r);
      setRootDraft(r);
    });
  }, []);

  const runScan = useCallback(async () => {
    if (!root) return;
    const id = ++scanId.current; // ignore results from a scan that was superseded
    setScanning(true);
    setError(null);
    try {
      const result = await scanRepos(root);
      if (id !== scanId.current) return;
      setScan(result);
      loadCi(result, id);
    } catch (e) {
      if (id === scanId.current) setError(String(e));
    } finally {
      if (id === scanId.current) setScanning(false);
    }
  }, [root]);

  // Fetch CI a few repos at a time so we don't fire 30 `gh` calls at once.
  const loadCi = (result: ScanResult, id: number) => {
    if (!inTauri) return;
    const slugs = [...new Set(result.repos.map((r) => r.github).filter((s): s is string => !!s))];
    setCi(Object.fromEntries(slugs.map((s) => [s, { kind: "loading" }])));
    const queue = [...slugs];
    const worker = async () => {
      for (let slug = queue.shift(); slug; slug = queue.shift()) {
        let state: CiState;
        try {
          const run = await ciStatus(slug);
          state = run ? { kind: "run", run } : { kind: "none" };
        } catch (e) {
          state = { kind: "error", message: String(e) };
        }
        if (id !== scanId.current) return;
        setCi((prev) => ({ ...prev, [slug!]: state }));
      }
    };
    for (let i = 0; i < CI_CONCURRENCY; i++) worker();
  };

  useEffect(() => {
    runScan();
  }, [runScan]);

  // Rescan when the window regains focus: you probably just committed something.
  useEffect(() => {
    const onFocus = () => {
      if (!scanning) runScan();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [runScan, scanning]);

  const duplicateNames = useMemo(() => new Set(scan?.duplicates.flat() ?? []), [scan]);

  const rows: Row[] = useMemo(() => {
    if (!scan) return [];
    return scan.repos
      .map((repo) => {
        const flags = flagsFor(repo, duplicateNames);
        return { repo, flags, level: worstLevel(flags) };
      })
      .sort(
        (a, b) =>
          compareLevel(a.level, b.level) ||
          (b.repo.lastCommit?.timestamp ?? 0) - (a.repo.lastCommit?.timestamp ?? 0),
      );
  }, [scan, duplicateNames]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length, attention: 0 };
    for (const r of rows) {
      if (r.level !== "ok") c.attention++;
      for (const f of r.flags) c[f.id] = (c[f.id] ?? 0) + 1;
    }
    return c;
  }, [rows]);

  const visible = rows.filter((r) => {
    if (query && !r.repo.name.toLowerCase().includes(query.toLowerCase())) return false;
    if (filter === "all") return true;
    if (filter === "attention") return r.level !== "ok";
    return r.flags.some((f) => f.id === filter);
  });

  const applyRoot = (e: React.FormEvent) => {
    e.preventDefault();
    const next = rootDraft.trim();
    if (!next || next === root) return;
    try {
      localStorage.setItem(ROOT_KEY, next);
    } catch {
      /* not critical */
    }
    setRoot(next);
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>Repo Radar</h1>
        <form className="root" onSubmit={applyRoot}>
          <input
            value={rootDraft}
            onChange={(e) => setRootDraft(e.target.value)}
            spellCheck={false}
            aria-label="Folder to scan"
            disabled={!inTauri}
          />
        </form>
        <span className="muted scanned">{scan && !scanning ? `Scanned ${timeAgo(scan.scannedAt)}` : ""}</span>
        <button onClick={runScan} disabled={scanning}>
          {scanning ? "Scanning…" : "Rescan"}
        </button>
      </header>

      {!inTauri && <div className="banner">Browser demo mode: showing a saved snapshot. CI and actions need the app.</div>}
      {error && <div className="banner bad">{error}</div>}

      <nav className="filters" aria-label="Filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={filter === f.id ? "chip active" : "chip"}
            onClick={() => setFilter(f.id)}
            disabled={f.id !== "all" && f.id !== "attention" && !counts[f.id]}
          >
            {f.label}
            <span className="count">{counts[f.id] ?? 0}</span>
          </button>
        ))}
        <input
          className="search"
          placeholder="Filter by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter by name"
        />
      </nav>

      {scan && scan.duplicates.length > 0 && (filter === "duplicate" || filter === "attention") && (
        <section className="dupes">
          <strong>Duplicate clones</strong> (same origin):{" "}
          {scan.duplicates.map((g) => g.join(" · ")).join("  |  ")}
        </section>
      )}

      <main className="table-wrap">
        <table>
          <thead>
            <tr>
              <th aria-label="Status" />
              <th>Repo</th>
              <th>Branch</th>
              <th>Working tree</th>
              <th>Last commit</th>
              <th>CI</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <RepoRow
                key={r.repo.path}
                row={r}
                ci={r.repo.github ? ci[r.repo.github] : undefined}
                onHistory={() => openHistory(scan!.root, r.repo.name)}
              />
            ))}
          </tbody>
        </table>
        {scan && visible.length === 0 && (
          <p className="empty">{filter === "attention" ? "Everything is committed and pushed. 🎉" : "No repos match."}</p>
        )}
        {scan && scan.notRepos.length > 0 && filter === "all" && (
          <p className="muted footnote">Not git repos: {scan.notRepos.join(", ")}</p>
        )}
      </main>
    </div>
  );
}

function RepoRow({ row, ci, onHistory }: { row: Row; ci?: CiState; onHistory: () => void }) {
  const { repo, flags, level } = row;
  const s = repo.status;

  return (
    <tr>
      <td>
        <span className={`dot ${level}`} title={flags.map((f) => f.label).join(", ") || "clean"} />
      </td>
      <td>
        <button className="name link" title="Open history" disabled={!inTauri} onClick={onHistory}>
          {repo.name}
        </button>
        <div className="muted small">{repo.github ?? repo.remote ?? "no remote"}</div>
      </td>
      <td>
        {s ? (
          <>
            <span className="mono">{s.branch ?? "(detached)"}</span>
            {s.ahead > 0 && <span className="pill warn" title="Commits not pushed">↑{s.ahead}</span>}
            {s.behind > 0 && <span className="pill warn" title="Commits to pull (as of last fetch)">↓{s.behind}</span>}
            {s.branch && !s.upstream && repo.remote && <span className="pill warn">not pushed</span>}
          </>
        ) : (
          <span className="bad-text" title={repo.error ?? ""}>error</span>
        )}
      </td>
      <td>
        <WorkingTree repo={repo} />
      </td>
      <td className="commit">
        {repo.lastCommit ? (
          <>
            <span className="muted">{timeAgo(repo.lastCommit.timestamp)}</span>{" "}
            <span className="subject" title={repo.lastCommit.subject}>{repo.lastCommit.subject}</span>
          </>
        ) : (
          <span className="muted">no commits</span>
        )}
      </td>
      <td>
        <CiBadge state={ci} hasGithub={!!repo.github} />
      </td>
      <td className="actions">
        <button className="icon" title="History: commit graph and diffs" disabled={!inTauri} onClick={onHistory}>
          ⎇
        </button>
        <button className="icon" title="Show in Finder" disabled={!inTauri} onClick={() => revealItemInDir(repo.path)}>
          ⌕
        </button>
        {repo.github && (
          <button
            className="icon"
            title="Open on GitHub"
            disabled={!inTauri}
            onClick={() => openUrl(`https://github.com/${repo.github}`)}
          >
            ↗
          </button>
        )}
      </td>
    </tr>
  );
}

function WorkingTree({ repo }: { repo: Repo }) {
  const s = repo.status;
  if (!s) return null;
  const parts: [number, string, string][] = [
    [s.conflicted, "conflicted", "bad"],
    [s.staged, "staged", "warn"],
    [s.modified, "modified", "warn"],
    [s.untracked, "untracked", "warn"],
    [s.stashes, "stashed", "muted"],
  ];
  const shown = parts.filter(([n]) => n > 0);
  if (shown.length === 0) return <span className="ok-text">clean</span>;
  return (
    <>
      {shown.map(([n, label, tone]) => (
        <span key={label} className={`pill ${tone}`}>
          {n} {label}
        </span>
      ))}
    </>
  );
}

function CiBadge({ state, hasGithub }: { state?: CiState; hasGithub: boolean }) {
  if (!hasGithub || !state) return <span className="muted">—</span>;
  switch (state.kind) {
    case "loading":
      return <span className="muted">…</span>;
    case "none":
      return <span className="muted">no runs</span>;
    case "error":
      return <span className="muted" title={state.message}>unavailable</span>;
    case "run": {
      const { run } = state;
      const tone =
        run.status !== "completed" ? "muted" : run.conclusion === "success" ? "ok" : run.conclusion === "skipped" ? "muted" : "bad";
      const label = run.status !== "completed" ? run.status.replace("_", " ") : run.conclusion;
      return (
        <button className={`pill link ${tone}`} title={`${run.workflowName} · ${run.createdAt}`} onClick={() => openUrl(run.url)}>
          {label}
        </button>
      );
    }
  }
}
