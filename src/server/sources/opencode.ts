// OpenCode source: sessions from OpenCode's SQLite database
// ($XDG_DATA_HOME/opencode/opencode.db), read-only through `node:sqlite`
// (Node 22.13+; without it the source logs once and shows nothing). Live
// sessions come from the running TUI processes (opencode-live.ts); status from
// the newest message since the TUI started: busy while a reply is unfinished.
// Permission prompts are not stored, so they show as busy.
// Formats: docs/design.md "OpenCode data".
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Session } from "../../shared/types.ts";
import { createProcessTable } from "../desktop/process-table.ts";
import { GitReader, type GitInfo } from "./git.ts";
import { onceLogger, type Logger } from "./log.ts";
import {
  assignOpenCodeLive, isOpenCodeTui, looksLikeOpenCode, OPENCODE_ID, scanOpenCodeProcesses,
  type CandidateSession, type LiveSession, type OpenCodeProcess,
} from "./opencode-live.ts";
import type { Source } from "./types.ts";

export interface SessionRow {
  id: string;
  directory: string;
  title: string;
  /** Epoch ms (V on 1.19.3). */
  time_updated: number;
  time_created: number;
  parent_id: string | null;
  time_archived: number | null;
}

export interface LastMessage {
  role: string | null;
  completed: number | null;
  created: number;
}

/** The few queries the source needs; `openOpenCodeDb` implements them with node:sqlite. */
export interface OpenCodeDb {
  /** Root, unarchived sessions, newest first. */
  recent(limit: number): SessionRow[];
  byIds(ids: readonly string[]): SessionRow[];
  inDirs(dirs: readonly string[]): SessionRow[];
  lastMessage(sessionId: string): LastMessage | undefined;
  close(): void;
}

export interface OpenCodeSourceOptions {
  /** The OpenCode data dir (holds opencode.db). Default $XDG_DATA_HOME/opencode, else ~/.local/share/opencode. */
  dataDir?: string;
  /** The database file; default $OPENCODE_DB (absolute, or relative to dataDir), else <dataDir>/opencode.db. */
  dbPath?: string;
  /** Opens the database; default node:sqlite, read-only. Undefined when it cannot be opened (yet). */
  openDb?: (path: string) => Promise<OpenCodeDb | undefined>;
  /** Where processes are read from. Default /proc; tests and the demo pass a synthetic tree. */
  procRoot?: string;
  /** Running OpenCode processes. Default: read from procRoot (Linux); undefined = unknown (no live sessions). */
  scan?: () => Promise<OpenCodeProcess[] | undefined>;
  pollMs?: number;
  /** How long one look (processes, database, git) is reused by list/listDormant/get. Default pollMs. */
  cacheMs?: number;
  log?: Logger;
  maxDormant?: number;
  gitTtlMs?: number;
  /** Is `pid` still an OpenCode TUI? Guards end() against pid reuse. */
  isOpenCodeTui?: (pid: number) => Promise<boolean>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export const openCodeResumeCommand = (id: string): string => `opencode -s ${id}`;

export function defaultOpenCodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode");
}

export function defaultOpenCodeDbPath(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCODE_DB;
  if (override && override !== ":memory:") return override.startsWith("/") ? override : join(dataDir, override);
  return join(dataDir, "opencode.db");
}

/** Default titles OpenCode gives before it has generated one. */
export function isDefaultTitle(title: string): boolean {
  return /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(title);
}

const COLS = "id, directory, title, time_updated, time_created, parent_id, time_archived";
const ROOT = "parent_id IS NULL AND time_archived IS NULL";

/** node:sqlite, read-only. */
export async function openOpenCodeDb(path: string): Promise<OpenCodeDb | undefined> {
  if (!(await stat(path).catch(() => undefined))) return undefined;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  // OpenCode writes all the time (WAL); wait briefly instead of failing a poll.
  db.exec("PRAGMA busy_timeout = 250");
  const placeholders = (n: number) => Array(n).fill("?").join(",");
  return {
    recent: (limit) => db.prepare(`SELECT ${COLS} FROM session WHERE ${ROOT} ORDER BY time_updated DESC LIMIT ?`).all(limit) as unknown as SessionRow[],
    byIds: (ids) =>
      ids.length ? (db.prepare(`SELECT ${COLS} FROM session WHERE id IN (${placeholders(ids.length)})`).all(...ids) as unknown as SessionRow[]) : [],
    inDirs: (dirs) =>
      dirs.length
        ? (db.prepare(`SELECT ${COLS} FROM session WHERE ${ROOT} AND directory IN (${placeholders(dirs.length)})`).all(...dirs) as unknown as SessionRow[])
        : [],
    lastMessage: (id) =>
      db
        .prepare(
          `SELECT json_extract(data, '$.role') AS role, json_extract(data, '$.time.completed') AS completed, time_created AS created
           FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1`,
        )
        .get(id) as unknown as LastMessage | undefined,
    close: () => db.close(),
  };
}

function defaultIsOpenCodeTui(procRoot: string | undefined): (pid: number) => Promise<boolean> {
  const table = procRoot ? createProcessTable({ platform: "linux", procRoot }) : createProcessTable();
  return async (pid) => {
    const argv = await table.argv(pid);
    return !!argv && looksLikeOpenCode(argv, await table.exe(pid)) && isOpenCodeTui(argv);
  };
}

/** Busy while the newest message since the TUI started is a prompt or an unfinished reply. */
export function openCodeStatus(last: LastMessage | undefined, since: number): "busy" | "idle" {
  if (!last || last.created < since) return "idle";
  if (last.role === "user") return "busy";
  return last.role === "assistant" && last.completed == null ? "busy" : "idle";
}

const epochMs = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export function openCodeSession(row: SessionRow, opts: { live?: LiveSession; status?: "busy" | "idle"; git?: GitInfo }): Session {
  const s: Session = {
    id: row.id,
    source: "opencode",
    cwd: row.directory,
    repo: basename(row.directory),
    status: opts.live ? (opts.status ?? "idle") : "dormant",
    // A missing or odd value never becomes a number the board would date from 1970 (it shows no age for 0).
    lastActivityAt: epochMs(row.time_updated) || epochMs(row.time_created),
    cacheTtlMs: 0,
    cacheExpiresAt: 0,
    live: !!opts.live,
    prLinks: [],
    resumeCommand: openCodeResumeCommand(row.id),
  };
  if (opts.live) s.pid = opts.live.pid;
  // Stop only for a TUI started on exactly this session, never a directory guess.
  if (opts.live?.exact) s.canEnd = true;
  if (row.title && !isDefaultTitle(row.title)) s.title = row.title;
  if (opts.git) {
    s.repo = basename(opts.git.root);
    s.repoRoot = opts.git.root;
    s.branch = opts.git.branch;
  }
  return s;
}

const candidate = (r: SessionRow): CandidateSession => ({ id: r.id, directory: r.directory, updatedAt: r.time_updated });

/** Rows whose id is not a valid OpenCode id never become a session (or a command). */
const valid = (rows: SessionRow[]): SessionRow[] => rows.filter((r) => typeof r.id === "string" && OPENCODE_ID.test(r.id));

export function createOpenCodeSource(opts: OpenCodeSourceOptions = {}): Source {
  const dataDir = opts.dataDir ?? defaultOpenCodeDataDir();
  const dbPath = opts.dbPath ?? defaultOpenCodeDbPath(dataDir);
  const openDb = opts.openDb ?? openOpenCodeDb;
  const scan = opts.scan ?? (() => scanOpenCodeProcesses(opts.procRoot));
  const pollMs = opts.pollMs ?? 2000;
  const cacheMs = opts.cacheMs ?? pollMs;
  const maxDormant = opts.maxDormant ?? 200;
  const warn = onceLogger(opts.log ?? console.warn);
  const git = new GitReader({ ttlMs: opts.gitTtlMs ?? 2000 });
  const isTui = opts.isOpenCodeTui ?? defaultIsOpenCodeTui(opts.procRoot);
  const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  let db: OpenCodeDb | undefined;
  let opening: Promise<OpenCodeDb | undefined> | undefined;

  async function database(): Promise<OpenCodeDb | undefined> {
    if (db) return db;
    opening ??= openDb(dbPath)
      .catch((e: Error) => {
        warn(`excaliagent: cannot open the OpenCode database ${dbPath}: ${e.message}`, "opencode-db");
        return undefined;
      })
      .finally(() => (opening = undefined));
    db = await opening;
    return db;
  }

  /** Runs a query; on failure (schema change, file replaced) reopens next time. */
  async function query<T>(fn: (d: OpenCodeDb) => T, fallback: T): Promise<T> {
    const d = await database();
    if (!d) return fallback;
    try {
      return fn(d);
    } catch (e) {
      warn(`excaliagent: reading the OpenCode database failed: ${(e as Error).message}`, "opencode-query");
      db = undefined;
      try {
        d.close();
      } catch {
        // already closed
      }
      return fallback;
    }
  }

  async function live(): Promise<Array<{ row: SessionRow; live: LiveSession }>> {
    const procs = await scan().catch(() => undefined);
    if (!procs?.length) return [];
    const ids = procs.map((p) => p.argv).flatMap((a) => a.filter((w) => OPENCODE_ID.test(w) || w.startsWith("--session=")).map((w) => w.replace(/^--session=/, "")));
    const dirs = [...new Set(procs.map((p) => p.cwd).filter((c): c is string => !!c))];
    const rows = new Map<string, SessionRow>();
    for (const r of valid(await query((d) => [...d.byIds(ids), ...d.inDirs(dirs)], [] as SessionRow[]))) rows.set(r.id, r);
    const usable = [...rows.values()].filter((r) => r.parent_id == null && r.time_archived == null);
    const assigned = assignOpenCodeLive(
      procs,
      (id) => {
        const r = rows.get(id);
        return r && usable.includes(r) ? candidate(r) : undefined;
      },
      (dir) => usable.filter((r) => r.directory === dir).map(candidate),
    );
    return assigned.map((l) => ({ row: rows.get(l.id)!, live: l }));
  }

  /** One look at the live sessions, reused for cacheMs. */
  type Look = { at: number; live: Array<{ row: SessionRow; live: LiveSession }>; sessions: Session[] };
  let look: Look | undefined;
  let looking: Promise<Look> | undefined;

  async function current(fresh = false): Promise<Look> {
    if (!fresh && look && Date.now() - look.at < cacheMs) return look;
    looking ??= (async () => {
      const found = await live();
      look = { at: Date.now(), live: found, sessions: await build(found) };
      return look;
    })().finally(() => (looking = undefined));
    return looking;
  }

  async function list(): Promise<Session[]> {
    return (await current()).sessions;
  }

  async function build(found: Array<{ row: SessionRow; live: LiveSession }>): Promise<Session[]> {
    const out: Session[] = [];
    for (const { row, live: l } of found) {
      const last = await query((d) => d.lastMessage(row.id), undefined);
      out.push(openCodeSession(row, { live: l, status: openCodeStatus(last, l.since), git: await git.get(row.directory) }));
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async function listDormant(): Promise<Session[]> {
    const liveIds = new Set((await current()).live.map((l) => l.row.id));
    const rows = valid(await query((d) => d.recent(maxDormant + liveIds.size), [] as SessionRow[])).filter((r) => !liveIds.has(r.id));
    const out: Session[] = [];
    for (const r of rows.slice(0, maxDormant)) out.push(openCodeSession(r, { git: await git.get(r.directory) }));
    return out;
  }

  async function get(id: string): Promise<Session | undefined> {
    if (!OPENCODE_ID.test(id)) return undefined;
    const running = (await list()).find((s) => s.id === id);
    if (running) return running;
    const [row] = valid(await query((d) => d.byIds([id]), [] as SessionRow[]));
    return row ? openCodeSession(row, { git: await git.get(row.directory) }) : undefined;
  }

  function watch(cb: (sessions: Session[]) => void): () => void {
    let closed = false;
    let running = false;
    let last: string | undefined;
    // No file to watch tells more than a poll: the db changes on every token.
    const refresh = async () => {
      if (running || closed) return;
      running = true;
      try {
        const sessions = (await current(true)).sessions;
        const key = JSON.stringify(sessions);
        if (!closed && key !== last) {
          last = key;
          try {
            cb(sessions);
          } catch (e) {
            warn(`excaliagent: session watcher callback threw: ${(e as Error).message}`, "opencode-watch-callback");
          }
        }
      } catch (e) {
        warn(`excaliagent: refreshing OpenCode sessions failed: ${(e as Error).message}`, "opencode-refresh");
      } finally {
        running = false;
      }
    };
    const poll = setInterval(() => void refresh(), pollMs);
    void refresh();
    return () => {
      closed = true;
      clearInterval(poll);
      db?.close();
      db = undefined;
    };
  }

  /**
   * SIGTERM to the TUI: OpenCode closes the reply, restores the terminal and
   * exits. Only for a TUI started with `-s <id>`: a session matched by
   * directory is "unsupported", so a guess never ends a process.
   */
  async function end(id: string): Promise<"ended" | "not-live" | "unsupported"> {
    if (!OPENCODE_ID.test(id)) return "not-live";
    const l = (await current()).live.find((x) => x.row.id === id);
    if (!l) return "not-live";
    if (!l.live.exact) return "unsupported";
    if (!(await isTui(l.live.pid).catch(() => false))) return "not-live";
    try {
      kill(l.live.pid, "SIGTERM");
    } catch {
      return "not-live";
    }
    return "ended";
  }

  return { list, listDormant, get, watch, end };
}
