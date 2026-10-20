// Which OpenCode sessions are running, and in which process. OpenCode
// (verified on 1.19.3, Linux) keeps no session registry, lock or port file:
// the TUI is one process (the server runs in a worker thread, no listener
// unless --port is given) and the session it shows lives only in its memory.
// What is visible from outside: the TUI's argv (`-s/--session <id>` when it was
// started on a session) and its working directory (= the session's
// `directory` for sessions it creates). So:
//
// 1. a TUI started with `-s <id>` (not `--fork`) shows that session;
// 2. any other TUI shows the most recently updated root session of its
//    directory, if that session was updated after the TUI started (a TUI on
//    its home screen, or idle on an older session, claims nothing).
//
// This is a heuristic; docs/design.md "OpenCode data" lists where it is wrong.
// Only rule 1 is exact; only exact matches may be stopped from the board.
// Pure matching lives in `assignOpenCodeLive`; the /proc reading is Linux-only
// and takes a proc root, so tests read a synthetic tree.
import { readlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { createProcessTable } from "../desktop/process-table.ts";
import { bootTime, startedAt } from "./proc.ts";

export interface OpenCodeProcess {
  pid: number;
  ppid: number;
  argv: string[];
  cwd?: string;
  /** Epoch ms the process started. */
  startedAt: number;
}

/** OpenCode session ids: `ses_` + 12 hex (time) + 14 base62. */
export const OPENCODE_ID = /^ses_[0-9a-zA-Z]{26}$/;

/** The native binary (`opencode`, nix `.opencode-wrapped`), or the npm shim (`node …/bin/opencode`). */
export function looksLikeOpenCode(argv: readonly string[] | undefined, exe: string | undefined): boolean {
  const names = [argv?.[0], exe].filter((n): n is string => !!n).map((n) => basename(n));
  if (names.some((n) => /^\.?opencode(-wrapped)?(\.exe)?$/.test(n))) return true;
  const script = argv?.[1] ? basename(argv[1]) : "";
  return names.some((n) => /^(node|bun)(\.exe)?$/.test(n)) && (script === "opencode" || script === "opencode.js");
}

const VALUE_FLAGS = new Set([
  "--log-level", "--port", "--hostname", "--mdns-domain", "--cors", "-m", "--model", "-s", "--session", "--prompt",
  "--agent", "--replay-limit",
]);
// Subcommands that are not the interactive TUI (`opencode [project]`, `opencode pr <n>`).
const NOT_TUI = new Set([
  "completion", "acp", "mcp", "attach", "run", "debug", "providers", "auth", "agent", "upgrade", "uninstall", "serve",
  "web", "models", "stats", "export", "import", "github", "session", "plugin", "plug", "db",
]);

function args(argv: readonly string[]): string[] {
  const shim = /^(node|bun)(\.exe)?$/.test(basename(argv[0] ?? ""));
  return argv.slice(shim ? 2 : 1);
}

/** First positional word: a subcommand, a project dir, or undefined. */
export function openCodeSubcommand(argv: readonly string[]): string | undefined {
  const a = args(argv);
  for (let i = 0; i < a.length; i++) {
    const w = a[i]!;
    if (w === "--") return a[i + 1];
    if (w.startsWith("-")) {
      if (VALUE_FLAGS.has(w)) i++;
      continue;
    }
    return w;
  }
  return undefined;
}

export const isOpenCodeTui = (argv: readonly string[]): boolean => {
  const sub = openCodeSubcommand(argv);
  return sub === undefined || !NOT_TUI.has(sub);
};

/** `-s <id>`, `--session <id>`, `--session=<id>`; undefined with `--fork` (that makes a new session). */
export function argvSessionId(argv: readonly string[]): string | undefined {
  const a = args(argv);
  if (a.includes("--fork")) return undefined;
  for (let i = 0; i < a.length; i++) {
    const w = a[i]!;
    const v = w === "-s" || w === "--session" ? a[i + 1] : w.startsWith("--session=") ? w.slice(10) : undefined;
    if (v && OPENCODE_ID.test(v)) return v;
  }
  return undefined;
}

export interface CandidateSession {
  id: string;
  directory: string;
  updatedAt: number;
}

export interface LiveSession {
  id: string;
  pid: number;
  /** When the TUI started: status only counts messages after it. */
  since: number;
  /** Named on the command line (`-s <id>`), not inferred from a directory. */
  exact: boolean;
}

/**
 * Pure. `byId` finds a root, unarchived session by id; `inDir` lists the root,
 * unarchived sessions whose directory is `dir`.
 */
export function assignOpenCodeLive(
  procs: readonly OpenCodeProcess[],
  byId: (id: string) => CandidateSession | undefined,
  inDir: (dir: string) => readonly CandidateSession[],
): LiveSession[] {
  const pids = new Set(procs.map((p) => p.pid));
  // The npm shim and its native child count once, as the shim (the pane's foreground).
  // Newest first: a later TUI is more likely on the newest session of a directory.
  const tuis = procs
    .filter((p) => isOpenCodeTui(p.argv) && !pids.has(p.ppid))
    .sort((a, b) => b.startedAt - a.startedAt || b.pid - a.pid);
  const out: LiveSession[] = [];
  const taken = new Set<string>();
  const rest: OpenCodeProcess[] = [];
  for (const t of tuis) {
    const id = argvSessionId(t.argv);
    // A TUI that names its session never guesses another one.
    if (!id) {
      rest.push(t);
      continue;
    }
    const s = byId(id);
    if (s && !taken.has(s.id)) {
      taken.add(s.id);
      out.push({ id: s.id, pid: t.pid, since: t.startedAt, exact: true });
    }
  }
  for (const t of rest) {
    if (!t.cwd) continue;
    const best = inDir(t.cwd)
      .filter((s) => !taken.has(s.id) && s.updatedAt >= t.startedAt)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!best) continue;
    taken.add(best.id);
    out.push({ id: best.id, pid: t.pid, since: t.startedAt, exact: false });
  }
  return out;
}

/**
 * Running OpenCode processes with argv, cwd and start time, read from
 * `procRoot`. Undefined when it has no boot time (not Linux): liveness unknown.
 */
export async function scanOpenCodeProcesses(procRoot = "/proc"): Promise<OpenCodeProcess[] | undefined> {
  const btime = await bootTime(procRoot);
  if (btime === undefined) return undefined;
  const table = createProcessTable({ platform: "linux", procRoot });
  const out: OpenCodeProcess[] = [];
  for (const p of await table.list()) {
    // Cheap filter before reading argv: the binary, the nix wrapper, or a shim.
    if (!/opencode|node|bun|MainThread/i.test(p.comm)) continue;
    const [argv, exe] = await Promise.all([table.argv(p.pid), table.exe(p.pid)]);
    if (!argv || !looksLikeOpenCode(argv, exe)) continue;
    const [cwd, started] = await Promise.all([
      readlink(join(procRoot, String(p.pid), "cwd")).catch(() => undefined),
      startedAt(procRoot, p.pid, btime),
    ]);
    if (!started) continue;
    out.push({ pid: p.pid, ppid: p.ppid, argv, ...(cwd ? { cwd } : {}), startedAt: started });
  }
  return out;
}
