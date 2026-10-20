// Which Codex threads are running, and in which process. Codex has no session
// registry like Claude's; what it has (verified on 0.163.0, Linux):
//
// - `<codexHome>/thread-writer-locks/<thread id>.lock`: created and flock()ed
//   by whoever has the thread loaded, unlocked and deleted when it is unloaded.
//   Crashes leave the file but release the lock, so only a *held* lock counts:
//   the holder is found in /proc/locks by inode and confirmed through
//   /proc/<pid>/fd.
// - The interactive TUI (`codex`, `codex resume <id>`) does not hold it: it
//   talks to a shared app-server daemon (`codex app-server ... --managed-daemon`,
//   one per Codex home) that loads the thread. The daemon keeps a thread loaded
//   for `thread_unload_delay_secs` (default 30 min) after its last client left,
//   so a held lock alone does not mean someone is looking at it.
// - `codex exec` loads its thread in-process and holds the lock itself.
//
// So a thread held by a non-daemon codex process is live in that process. A
// thread held by the daemon is live only when a TUI process claims it: by its
// argv (`resume <id>`), else by working directory, newest lock first, among
// threads loaded after that TUI started (a thread loaded earlier belongs to
// another, maybe closed, TUI; a fresh TUI's own thread appears ~1 s after it).
// Daemon threads no TUI claims are lingering, i.e. dormant. Only the first two
// (in-process holder, `resume <id>`) are exact; a working-directory claim is a
// guess, so such a session cannot be stopped from the board. Pure matching
// lives in `assignLive`; the /proc reading around it is Linux-only and takes a
// proc root, so tests read a synthetic tree.
import { readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createProcessTable } from "../desktop/process-table.ts";
import { CODEX_ID, uuidV7Ms } from "./codex-rollout.ts";
import { bootTime, startedAt } from "./proc.ts";

export interface HeldLock {
  threadId: string;
  pid: number;
  /** When the thread was loaded (lock file birth, else ctime). */
  loadedAt: number;
}

export interface CodexProcess {
  pid: number;
  ppid: number;
  argv: string[];
  cwd?: string;
  /** Epoch ms the process started; 0 when unknown. */
  startedAt: number;
}

/** A Codex executable: argv[0] or exe named `codex`, or the npm shim (`node …/codex.js`). */
export function looksLikeCodex(argv: readonly string[] | undefined, exe: string | undefined): boolean {
  const names = [argv?.[0], exe].filter((n): n is string => !!n).map((n) => basename(n));
  if (names.some((n) => n === "codex" || n === "codex.exe")) return true;
  const script = argv?.[1] ? basename(argv[1]) : "";
  return names.some((n) => /^node(\.exe)?$/.test(n)) && (script === "codex" || script === "codex.js");
}

// Options that take a value, so the next word is not the subcommand.
const VALUE_FLAGS = new Set([
  "-c", "--config", "-m", "--model", "-p", "--profile", "-s", "--sandbox", "-a", "--ask-for-approval",
  "-C", "--cd", "-i", "--image", "--add-dir", "--enable", "--disable", "--local-provider", "--remote",
  "--remote-auth-token-env",
]);
// Subcommands that are not an interactive session (the TUI is `codex [PROMPT]`, `resume`, `fork`).
const NOT_TUI = new Set([
  "agents", "exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server", "remote-control",
  "completion", "update", "doctor", "sandbox", "debug", "apply", "a", "queue", "archive", "delete",
  "migrate-rollouts", "unarchive", "cloud", "exec-server", "features", "help", "mcp-server",
]);

/** The words after the program (and after the script, for the npm shim). */
function args(argv: readonly string[]): string[] {
  const shim = /^node(\.exe)?$/.test(basename(argv[0] ?? ""));
  return argv.slice(shim ? 2 : 1);
}

/** First positional word: the subcommand, a prompt, or undefined. */
export function codexSubcommand(argv: readonly string[]): string | undefined {
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

export const isDaemon = (argv: readonly string[]): boolean => codexSubcommand(argv) === "app-server";

/**
 * An interactive Codex TUI process. Codex also runs its own binary as helpers
 * (verified on 0.163.0: `codex-linux-sandbox ...` around every sandboxed
 * command, once under bwrap, with the repo as cwd); those have another
 * argv[0] (`codex-linux-sandbox`, `apply_patch`) or a `--codex-run-as-*`
 * argv[1], and are not TUIs.
 */
export const isTui = (argv: readonly string[]): boolean => {
  const shim = /^node(\.exe)?$/.test(basename(argv[0] ?? ""));
  const name = basename((shim ? argv[1] : argv[0]) ?? "");
  if (!(shim ? name === "codex" || name === "codex.js" : name === "codex" || name === "codex.exe")) return false;
  if (args(argv)[0]?.startsWith("--codex-run-as-")) return false;
  const sub = codexSubcommand(argv);
  return sub === undefined || !NOT_TUI.has(sub);
};

/** `codex resume <id>` / `codex fork <id>`: the thread named on the command line. */
export function argvThreadId(argv: readonly string[]): string | undefined {
  const a = args(argv);
  const sub = codexSubcommand(argv);
  if (sub !== "resume") return undefined; // a fork gets a new id
  const rest = a.slice(a.indexOf(sub) + 1);
  return rest.find((w) => CODEX_ID.test(w))?.toLowerCase();
}

export interface LiveThread {
  threadId: string;
  /** The process showing it: the TUI, or the in-process holder (`codex exec`). */
  pid: number;
  /** cwd of the claiming TUI, for threads with no rollout yet. */
  cwd?: string;
  /** Known for sure (in-process holder, or `codex resume <id>`), not inferred from a directory. */
  exact: boolean;
}

/**
 * Pure: which held threads are live, and where. `threadCwd` gives a thread's
 * start cwd (from its rollout; undefined before the first message is written).
 * `isUser` says whether a thread may be claimed by a TUI (not a sub-agent etc.).
 * Deterministic: the same locks and processes give the same answer in any order.
 */
export function assignLive(
  locks: readonly HeldLock[],
  procs: readonly CodexProcess[],
  threadCwd: (id: string) => string | undefined,
  isUser: (id: string) => boolean = () => true,
): LiveThread[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out: LiveThread[] = [];
  const daemonHeld: HeldLock[] = [];
  for (const l of locks) {
    const holder = byPid.get(l.pid);
    if (!holder) continue;
    if (isDaemon(holder.argv)) daemonHeld.push(l);
    else out.push({ threadId: l.threadId, pid: l.pid, exact: true });
  }
  // TUIs; the npm shim and the native binary below it count once (the outer one).
  const codexPids = new Set(procs.map((p) => p.pid));
  const tuis = procs
    .filter((p) => !isDaemon(p.argv) && isTui(p.argv) && !codexPids.has(p.ppid))
    .filter((p) => !out.some((t) => t.pid === p.pid))
    // Newest first: a later TUI is more likely on the newest thread of a directory.
    .sort((a, b) => b.startedAt - a.startedAt || b.pid - a.pid);
  const free = new Set(daemonHeld.filter((l) => isUser(l.threadId)).map((l) => l.threadId));
  const loaded = new Map(daemonHeld.map((l) => [l.threadId, l.loadedAt]));
  const claimed = new Set<number>();
  for (const t of tuis) {
    const id = argvThreadId(t.argv);
    // A TUI that names its thread never guesses another one, even if that one is taken.
    if (id) claimed.add(t.pid);
    if (id && free.has(id)) {
      free.delete(id);
      out.push({ threadId: id, pid: t.pid, exact: true, ...(t.cwd ? { cwd: t.cwd } : {}) });
    }
  }
  for (const t of tuis) {
    if (claimed.has(t.pid) || !t.cwd) continue;
    let best: string | undefined;
    for (const id of free) {
      const cwd = threadCwd(id);
      if (cwd !== undefined && cwd !== t.cwd) continue;
      // Only threads this TUI can have opened: loaded after it started (else
      // another TUI's, lingering), and, with no rollout yet (nobody can resume
      // such a thread), created after it started. startedAt is never late
      // (btime is whole seconds, rounded down), so its own thread always passes.
      if (t.startedAt > 0) {
        if (loaded.get(id)! < t.startedAt) continue;
        const created = uuidV7Ms(id);
        if (cwd === undefined && created !== undefined && created < t.startedAt) continue;
      }
      // Newest load wins; a tie goes to the larger (v7: newer) id, never to scan order.
      if (best === undefined || loaded.get(id)! > loaded.get(best)! || (loaded.get(id) === loaded.get(best) && id > best)) best = id;
    }
    if (best === undefined) continue;
    free.delete(best);
    out.push({ threadId: best, pid: t.pid, cwd: t.cwd, exact: false });
  }
  return out;
}

/** `/proc/locks` → inode → pids holding (not waiting for) a lock on it. */
export function parseProcLocks(text: string): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6 || f[1] === "->") continue;
    const pid = Number(f[4]);
    const inode = Number(f[5]!.split(":")[2]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(inode)) continue;
    out.set(inode, [...(out.get(inode) ?? []), pid]);
  }
  return out;
}

export interface CodexProcScan {
  locks: HeldLock[];
  procs: CodexProcess[];
}

/**
 * Reads the held thread locks under `lockDir`, their holders and, only when a
 * daemon holds one, the Codex TUI processes that may be showing it. No lock
 * file → nothing else is read. Undefined when /proc/locks is not readable (not
 * Linux): liveness unknown.
 */
export async function scanCodexProcesses(lockDir: string, procRoot = "/proc"): Promise<CodexProcScan | undefined> {
  const locksText = await readFile(join(procRoot, "locks"), "utf8").catch(() => undefined);
  if (locksText === undefined) return undefined;
  lockDir = await realpath(lockDir).catch(() => lockDir);
  const files = (await readdir(lockDir).catch(() => [] as string[])).filter(
    (f) => f.endsWith(".lock") && CODEX_ID.test(f.slice(0, -5)),
  );
  if (!files.length) return { locks: [], procs: [] };

  const table = createProcessTable({ platform: "linux", procRoot });
  const btime = await bootTime(procRoot);
  const procs = new Map<number, CodexProcess | null>();
  const proc = async (pid: number, ppid?: number): Promise<CodexProcess | undefined> => {
    const known = procs.get(pid);
    if (known !== undefined) return known ?? undefined;
    const [argv, exe] = await Promise.all([table.argv(pid), table.exe(pid)]);
    if (!argv || !looksLikeCodex(argv, exe)) {
      procs.set(pid, null);
      return undefined;
    }
    const [cwd, parent, started] = await Promise.all([
      readlink(join(procRoot, String(pid), "cwd")).catch(() => undefined),
      ppid ?? table.parent(pid),
      startedAt(procRoot, pid, btime),
    ]);
    const p: CodexProcess = { pid, ppid: parent ?? 0, argv, startedAt: started, ...(cwd ? { cwd } : {}) };
    procs.set(pid, p);
    return p;
  };
  const fds = async (pid: number): Promise<Set<string>> => {
    const dir = join(procRoot, String(pid), "fd");
    const names = await readdir(dir).catch(() => [] as string[]);
    return new Set((await Promise.all(names.map((n) => readlink(join(dir, n)).catch(() => "")))).filter(Boolean));
  };

  const holders = parseProcLocks(locksText);
  const fdCache = new Map<number, Set<string>>();
  const locks: HeldLock[] = [];
  for (const f of files) {
    const path = join(lockDir, f);
    const st = await stat(path).catch(() => undefined);
    if (!st) continue;
    for (const pid of holders.get(st.ino) ?? []) {
      if (!(await proc(pid))) continue;
      if (!fdCache.has(pid)) fdCache.set(pid, await fds(pid));
      if (!fdCache.get(pid)!.has(path)) continue;
      locks.push({ threadId: f.slice(0, -5).toLowerCase(), pid, loadedAt: st.birthtimeMs || st.ctimeMs });
      break;
    }
  }
  if (locks.some((l) => isDaemon(procs.get(l.pid)!.argv))) {
    for (const p of await table.list()) {
      // Cheap filter before reading argv: the native binary, or a node shim.
      if (/codex|node|MainThread/i.test(p.comm)) await proc(p.pid, p.ppid);
    }
  }
  return { locks, procs: [...procs.values()].filter((p): p is CodexProcess => p !== null) };
}

