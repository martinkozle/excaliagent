// OpenAI Codex source: dormant sessions from rollouts
// (<codexHome>/sessions/YYYY/MM/DD/rollout-*.jsonl), live ones from held
// thread locks (codex-live.ts), names from session_index.jsonl. Codex writes no
// status registry: busy = a turn is open in the rollout, else idle. Prompts
// waiting for approval are not persisted, so they show as busy.
// Formats: docs/design.md "Codex data".
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Session } from "../../shared/types.ts";
import { createProcessTable } from "../desktop/process-table.ts";
import { assignLive, isDaemon, looksLikeCodex, scanCodexProcesses, type CodexProcScan, type LiveThread } from "./codex-live.ts";
import { CODEX_ID, isUserThread, RolloutScanner, rolloutThreadId, SessionIndex, type RolloutInfo } from "./codex-rollout.ts";
import { GitReader, type GitInfo } from "./git.ts";
import { onceLogger, type Logger } from "./log.ts";
import type { Source } from "./types.ts";

export interface CodexSourceOptions {
  /** Default $CODEX_HOME, else ~/.codex. */
  codexDir?: string;
  /** Where processes are read from. Default /proc; tests and the demo pass a synthetic tree. */
  procRoot?: string;
  /** Live processes and held locks. Default: read from procRoot (Linux); undefined = unknown (no live sessions). */
  scan?: (lockDir: string) => Promise<CodexProcScan | undefined>;
  pollMs?: number;
  /** How long one look at processes, rollouts and git is reused by list/listDormant/get. Default pollMs. */
  cacheMs?: number;
  debounceMs?: number;
  log?: Logger;
  maxDormant?: number;
  gitTtlMs?: number;
  /** Is `pid` still a Codex session process (a TUI or `codex exec`, not the shared daemon)? Guards end() against pid reuse. */
  isCodexSessionProcess?: (pid: number) => Promise<boolean>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export const codexResumeCommand = (id: string): string => `codex resume ${id}`;

export function defaultCodexDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

function defaultIsCodexSessionProcess(procRoot: string | undefined): (pid: number) => Promise<boolean> {
  const table = procRoot ? createProcessTable({ platform: "linux", procRoot }) : createProcessTable();
  return async (pid) => {
    const argv = await table.argv(pid);
    return !!argv && looksLikeCodex(argv, await table.exe(pid)) && !isDaemon(argv);
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Creation time of a UUIDv7 (its first 48 bits, epoch ms), else undefined. */
export function uuidV7Ms(id: string): number | undefined {
  if (id[14] !== "7") return undefined;
  const ms = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  return Number.isFinite(ms) ? ms : undefined;
}

interface RolloutFile {
  id: string;
  path: string;
  mtimeMs: number;
}

export function codexSession(
  id: string,
  r: RolloutInfo | undefined,
  opts: { live?: LiveThread; name?: string; git?: GitInfo; mtimeMs?: number },
): Session {
  const live = opts.live;
  const cwd = r?.cwd ?? live?.cwd ?? "";
  const s: Session = {
    id,
    source: "codex",
    cwd,
    repo: basename(cwd),
    status: live ? (r?.turnOpen ? "busy" : "idle") : "dormant",
    // The newest line, else the file's mtime, else (a fresh thread has no rollout yet) the id's creation time.
    lastActivityAt: r?.lastTimestamp || Math.floor(opts.mtimeMs ?? 0) || (uuidV7Ms(id) ?? 0),
    cacheTtlMs: 0,
    cacheExpiresAt: 0,
    live: !!live,
    prLinks: [],
    resumeCommand: codexResumeCommand(id),
  };
  if (live) s.pid = live.pid;
  // Stop only where the process is known for sure, never a directory guess.
  if (live?.exact) s.canEnd = true;
  const title = opts.name ?? r?.firstUserMessage;
  if (title) s.title = title;
  if (r?.branch) s.branch = r.branch;
  const git = opts.git;
  if (git) {
    s.repo = basename(git.root);
    s.repoRoot = git.root;
    // A live session is on the repo's current branch; a parked one keeps the one it recorded.
    if (live || !s.branch) s.branch = git.branch;
  }
  return s;
}

export function createCodexSource(opts: CodexSourceOptions = {}): Source {
  const codexDir = opts.codexDir ?? defaultCodexDir();
  const sessionsDir = join(codexDir, "sessions");
  const lockDir = join(codexDir, "thread-writer-locks");
  const scanProcs = opts.scan ?? ((dir: string) => scanCodexProcesses(dir, opts.procRoot));
  const pollMs = opts.pollMs ?? 2000;
  const cacheMs = opts.cacheMs ?? pollMs;
  const debounceMs = opts.debounceMs ?? 200;
  const maxDormant = opts.maxDormant ?? 200;
  const warn = onceLogger(opts.log ?? console.warn);
  const scanner = new RolloutScanner({ warn });
  const git = new GitReader({ ttlMs: opts.gitTtlMs ?? 2000 });
  const index = new SessionIndex(join(codexDir, "session_index.jsonl"));
  const isCodexSessionProcess = opts.isCodexSessionProcess ?? defaultIsCodexSessionProcess(opts.procRoot);
  const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const pathById = new Map<string, string>();
  const realCwd = new Map<string, string>();

  async function real(p: string): Promise<string> {
    let r = realCwd.get(p);
    if (r === undefined) {
      r = await realpath(p).catch(() => p);
      realCwd.set(p, r);
    }
    return r;
  }

  async function subdirs(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /** Rollout files, newest day first, stopping once `limit` files are found. */
  async function rolloutFiles(limit = Infinity): Promise<RolloutFile[]> {
    const out: RolloutFile[] = [];
    for (const y of await subdirs(sessionsDir))
      for (const m of await subdirs(join(sessionsDir, y)))
        for (const d of await subdirs(join(sessionsDir, y, m))) {
          if (out.length >= limit) return out;
          const dir = join(sessionsDir, y, m, d);
          const names = await readdir(dir).catch(() => [] as string[]);
          const day: RolloutFile[] = [];
          for (const name of names) {
            const id = rolloutThreadId(name);
            if (!id) continue;
            const path = join(dir, name);
            const st = await stat(path).catch(() => undefined);
            if (!st?.isFile()) continue;
            // A thread's plain file wins over a compressed twin.
            const prev = day.find((f) => f.id === id);
            if (prev && !prev.path.endsWith(".zst")) continue;
            if (prev) day.splice(day.indexOf(prev), 1);
            day.push({ id, path, mtimeMs: st.mtimeMs });
          }
          for (const f of day) pathById.set(f.id, f.path);
          out.push(...day);
        }
    return out;
  }

  /** id → when a full walk last failed to find it (fresh threads have no rollout yet). */
  const missing = new Map<string, number>();

  async function findRollout(id: string): Promise<string | undefined> {
    const cached = pathById.get(id);
    if (cached && (await stat(cached).catch(() => undefined))) return cached;
    pathById.delete(id);
    // A v7 thread id carries its creation time, and the file sits in that
    // (local) day's directory: look there first, a day either side for safety.
    const created = uuidV7Ms(id);
    if (created !== undefined) {
      for (const delta of [0, -1, 1]) {
        const d = new Date(created + delta * 86_400_000);
        const dir = join(sessionsDir, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
        const names = await readdir(dir).catch(() => [] as string[]);
        const hits = names.filter((n) => rolloutThreadId(n) === id).sort((a, b) => Number(a.endsWith(".zst")) - Number(b.endsWith(".zst")));
        if (hits[0]) {
          pathById.set(id, join(dir, hits[0]));
          return pathById.get(id);
        }
      }
    }
    const failedAt = missing.get(id);
    if (failedAt !== undefined && Date.now() - failedAt < 60_000) return undefined;
    await rolloutFiles();
    if (!pathById.has(id)) missing.set(id, Date.now());
    else missing.delete(id);
    return pathById.get(id);
  }

  async function liveThreads(): Promise<LiveThread[]> {
    const scan = await scanProcs(lockDir).catch((e: Error) => {
      warn(`excaliagent: reading Codex processes failed: ${e.message}`, "codex-scan");
      return undefined;
    });
    if (!scan?.locks.length) return [];
    const infos = new Map<string, RolloutInfo | undefined>();
    for (const l of scan.locks) {
      const path = await findRollout(l.threadId);
      infos.set(l.threadId, path ? await scanner.scan(path) : undefined);
    }
    const cwds = new Map<string, string | undefined>();
    for (const [id, r] of infos) cwds.set(id, r?.cwd ? await real(r.cwd) : undefined);
    // A thread without a rollout yet is a fresh TUI's; a thread with one must be a person's.
    return assignLive(scan.locks, scan.procs, (id) => cwds.get(id), (id) => {
      const r = infos.get(id);
      return !r || isUserThread(r);
    });
  }

  /** One look at the live threads and their sessions, reused for cacheMs. */
  let look: { at: number; threads: LiveThread[]; sessions: Session[] } | undefined;
  let looking: Promise<{ threads: LiveThread[]; sessions: Session[] }> | undefined;

  async function current(fresh = false): Promise<{ threads: LiveThread[]; sessions: Session[] }> {
    if (!fresh && look && Date.now() - look.at < cacheMs) return look;
    looking ??= (async () => {
      const threads = await liveThreads();
      const sessions = await build(threads);
      look = { at: Date.now(), threads, sessions };
      return look;
    })().finally(() => (looking = undefined));
    return looking;
  }

  async function list(): Promise<Session[]> {
    return (await current()).sessions;
  }

  async function build(threads: LiveThread[]): Promise<Session[]> {
    const names = await index.read();
    const out: Session[] = [];
    for (const live of threads) {
      if (!CODEX_ID.test(live.threadId)) continue;
      const path = pathById.get(live.threadId);
      const r = path ? await scanner.scan(path) : undefined;
      const st = path && !r?.lastTimestamp ? await stat(path).catch(() => undefined) : undefined;
      const cwd = r?.cwd ?? live.cwd;
      const name = names.get(live.threadId);
      out.push(
        codexSession(live.threadId, r, {
          live,
          ...(st ? { mtimeMs: st.mtimeMs } : {}),
          ...(name ? { name } : {}),
          ...(cwd ? { git: await git.get(cwd) } : {}),
        }),
      );
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async function dormant(f: RolloutFile, r: RolloutInfo, names: Map<string, string>): Promise<Session> {
    const name = names.get(f.id);
    return codexSession(f.id, r, {
      mtimeMs: f.mtimeMs,
      ...(name ? { name } : {}),
      ...(r.cwd ? { git: await git.get(r.cwd) } : {}),
    });
  }

  async function listDormant(): Promise<Session[]> {
    const live = new Set((await current()).threads.map((t) => t.threadId));
    const names = await index.read();
    const files = (await rolloutFiles()).filter((f) => !live.has(f.id)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: Session[] = [];
    for (const f of files) {
      if (out.length >= maxDormant) break;
      if (!CODEX_ID.test(f.id)) continue;
      const r = await scanner.scan(f.path);
      if (!r || !isUserThread(r)) continue;
      out.push(await dormant(f, r, names));
    }
    return out;
  }

  async function get(id: string): Promise<Session | undefined> {
    if (!CODEX_ID.test(id)) return undefined;
    id = id.toLowerCase();
    const live = (await list()).find((s) => s.id === id);
    if (live) return live;
    const path = await findRollout(id);
    const st = path ? await stat(path).catch(() => undefined) : undefined;
    const r = path ? await scanner.scan(path) : undefined;
    if (!path || !st || !r) return undefined;
    return dormant({ id, path, mtimeMs: st.mtimeMs }, r, await index.read());
  }

  function watch(cb: (sessions: Session[]) => void): () => void {
    let closed = false;
    let running = false;
    let again = false;
    let last: string | undefined;
    let debounce: NodeJS.Timeout | undefined;
    let watcher: FSWatcher | undefined;

    const refresh = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const sessions = (await current(true)).sessions;
          if (closed) return;
          const key = JSON.stringify(sessions);
          if (key !== last) {
            last = key;
            try {
              cb(sessions);
            } catch (e) {
              warn(`excaliagent: session watcher callback threw: ${(e as Error).message}`, "codex-watch-callback");
            }
          }
        } while (again && !closed);
      } catch (e) {
        warn(`excaliagent: refreshing Codex sessions failed: ${(e as Error).message}`, "codex-refresh");
      } finally {
        running = false;
      }
    };

    const kick = () => {
      if (closed) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(), debounceMs);
    };

    // Lock files come and go as threads load and unload: react at once.
    const ensureWatcher = () => {
      if (watcher || closed) return;
      try {
        watcher = fsWatch(lockDir, kick);
        watcher.on("error", () => {
          watcher?.close();
          watcher = undefined;
        });
      } catch {
        watcher = undefined; // dir missing; the poll retries
      }
    };

    ensureWatcher();
    // Turn starts and ends are only in the rollouts: poll.
    const poll = setInterval(() => {
      ensureWatcher();
      void refresh();
    }, pollMs);
    void refresh();

    return () => {
      closed = true;
      clearInterval(poll);
      clearTimeout(debounce);
      watcher?.close();
      watcher = undefined;
    };
  }

  /**
   * SIGTERM to the TUI (or `codex exec`), as when its terminal closes. The thread
   * stays on disk and can be resumed. Only for exact matches: a thread matched
   * by directory is "unsupported", so a guess never ends a process.
   */
  async function end(id: string): Promise<"ended" | "not-live" | "unsupported"> {
    if (!CODEX_ID.test(id)) return "not-live";
    const t = (await current()).threads.find((x) => x.threadId === id.toLowerCase());
    if (!t) return "not-live";
    if (!t.exact) return "unsupported";
    if (!(await isCodexSessionProcess(t.pid).catch(() => false))) return "not-live";
    try {
      kill(t.pid, "SIGTERM");
    } catch {
      return "not-live";
    }
    return "ended";
  }

  return { list, listDormant, get, watch, end };
}
