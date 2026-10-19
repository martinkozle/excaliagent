// Claude Code source: live sessions from the registry (<claudeDir>/sessions),
// enriched from transcripts (<claudeDir>/projects/<slug>/<id>.jsonl), plus
// dormant sessions from the transcript store.
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Session, SessionStatus } from "../../shared/types.ts";
import { onceLogger, type Logger } from "./log.ts";
import { defaultIsAlive, isLive, readRegistry, type IsAlive, type RegistryEntry } from "./registry.ts";
import { TranscriptScanner, type TranscriptInfo } from "./transcript.ts";
import type { Source } from "./types.ts";

export interface ClaudeSourceOptions {
  claudeDir?: string;
  isAlive?: IsAlive;
  pollMs?: number;
  debounceMs?: number;
  /** Warnings sink; each file is reported at most once. Default console.warn. */
  log?: Logger;
  maxDormant?: number;
}

const LIVE_STATUSES: ReadonlySet<string> = new Set<SessionStatus>([
  "busy", "idle", "waiting", "needs_user", "needs_trust", "blocked",
]);

interface TranscriptFile {
  id: string;
  slug: string;
  path: string;
  mtimeMs: number;
}

export function liveSession(e: RegistryEntry, t: TranscriptInfo | undefined): Session {
  const cwd = e.cwd || t?.cwd || "";
  const s: Session = {
    id: e.sessionId,
    source: "claude",
    cwd,
    repo: basename(cwd),
    status: LIVE_STATUSES.has(e.status) ? (e.status as SessionStatus) : "idle",
    lastActivityAt: Math.max(e.statusUpdatedAt ?? e.updatedAt ?? 0, t?.lastTimestamp ?? 0),
    cacheTtlMs: t?.cacheTtlMs ?? 0,
    cacheExpiresAt: t?.cacheExpiresAt ?? 0,
    live: true,
    pid: e.pid,
    prLinks: t?.prLinks ?? [],
  };
  return withTranscriptExtras(s, t, e.name, e.waitingFor);
}

export function dormantSession(f: TranscriptFile, t: TranscriptInfo, fallbackCwd: string | undefined): Session {
  const cwd = t.cwd ?? fallbackCwd ?? "";
  const s: Session = {
    id: f.id,
    source: "claude",
    cwd,
    repo: cwd ? basename(cwd) : f.slug,
    status: "dormant",
    lastActivityAt: t.lastTimestamp || Math.floor(f.mtimeMs),
    cacheTtlMs: t.cacheTtlMs,
    cacheExpiresAt: t.cacheExpiresAt,
    live: false,
    prLinks: t.prLinks,
  };
  return withTranscriptExtras(s, t, undefined, undefined);
}

function withTranscriptExtras(
  s: Session,
  t: TranscriptInfo | undefined,
  name: string | undefined,
  waitingFor: string | undefined,
): Session {
  const title = t?.aiTitle ?? t?.agentName;
  if (t?.gitBranch !== undefined) s.branch = t.gitBranch;
  if (title !== undefined) s.title = title;
  if (name !== undefined) s.name = name;
  if (waitingFor !== undefined) s.waitingFor = waitingFor;
  if (t?.continuedIn !== undefined) s.continuedIn = t.continuedIn;
  return s;
}

/** One entry per session id: the most recently updated live registry file wins. */
function dedupe(entries: RegistryEntry[]): RegistryEntry[] {
  const best = new Map<string, RegistryEntry>();
  const at = (e: RegistryEntry) => e.updatedAt ?? e.statusUpdatedAt ?? 0;
  for (const e of entries) {
    const cur = best.get(e.sessionId);
    if (!cur || at(e) > at(cur) || (at(e) === at(cur) && e.pid > cur.pid)) best.set(e.sessionId, e);
  }
  return [...best.values()];
}

export function createClaudeSource(opts: ClaudeSourceOptions = {}): Source {
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
  const sessionsDir = join(claudeDir, "sessions");
  const projectsDir = join(claudeDir, "projects");
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const pollMs = opts.pollMs ?? 5000;
  const debounceMs = opts.debounceMs ?? 200;
  const maxDormant = opts.maxDormant ?? 200;
  const warn = onceLogger(opts.log ?? console.warn);
  const scanner = new TranscriptScanner({ warn });
  const pathById = new Map<string, string>();
  /** A cwd seen in any transcript of a project dir, for transcripts without one. */
  const cwdBySlug = new Map<string, string>();

  async function scan(path: string, slug: string): Promise<TranscriptInfo | undefined> {
    const t = await scanner.scan(path);
    if (t?.cwd) cwdBySlug.set(slug, t.cwd);
    return t;
  }

  async function slugs(): Promise<string[]> {
    try {
      return (await readdir(projectsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  }

  async function findTranscript(id: string): Promise<string | undefined> {
    const cached = pathById.get(id);
    if (cached && (await stat(cached).catch(() => undefined))) return cached;
    pathById.delete(id);
    for (const slug of await slugs()) {
      const p = join(projectsDir, slug, `${id}.jsonl`);
      if (await stat(p).catch(() => undefined)) {
        pathById.set(id, p);
        return p;
      }
    }
    return undefined;
  }

  async function liveEntries(): Promise<RegistryEntry[]> {
    const all = await readRegistry(sessionsDir, warn);
    return dedupe(all.filter((e) => isLive(e, isAlive)));
  }

  async function list(): Promise<Session[]> {
    const out: Session[] = [];
    for (const e of await liveEntries()) {
      const path = await findTranscript(e.sessionId);
      const t = path ? await scan(path, basename(join(path, ".."))) : undefined;
      out.push(liveSession(e, t));
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async function transcriptFiles(): Promise<TranscriptFile[]> {
    const out: TranscriptFile[] = [];
    for (const slug of await slugs()) {
      let entries;
      try {
        entries = await readdir(join(projectsDir, slug), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of entries) {
        if (!d.isFile() || !d.name.endsWith(".jsonl")) continue;
        const path = join(projectsDir, slug, d.name);
        const st = await stat(path).catch(() => undefined);
        if (!st) continue;
        const id = d.name.slice(0, -".jsonl".length);
        pathById.set(id, path);
        out.push({ id, slug, path, mtimeMs: st.mtimeMs });
      }
    }
    return out;
  }

  async function toDormant(files: TranscriptFile[]): Promise<Session[]> {
    const scanned: Array<[TranscriptFile, TranscriptInfo]> = [];
    for (const f of files) {
      const t = await scan(f.path, f.slug);
      if (t) scanned.push([f, t]);
    }
    // Map after scanning all, so sibling cwds are known.
    return scanned.map(([f, t]) => dormantSession(f, t, cwdBySlug.get(f.slug)));
  }

  async function listDormant(): Promise<Session[]> {
    const live = new Set((await liveEntries()).map((e) => e.sessionId));
    const files = (await transcriptFiles())
      .filter((f) => !live.has(f.id))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxDormant);
    return toDormant(files);
  }

  async function get(id: string): Promise<Session | undefined> {
    const live = (await list()).find((s) => s.id === id);
    if (live) return live;
    const path = await findTranscript(id);
    if (!path) return undefined;
    const st = await stat(path).catch(() => undefined);
    if (!st) return undefined;
    const slug = basename(join(path, ".."));
    if (!cwdBySlug.has(slug)) {
      // Learn a fallback cwd from a sibling transcript when this one has none.
      const t = await scan(path, slug);
      if (!t?.cwd) await toDormant((await transcriptFiles()).filter((f) => f.slug === slug && f.id !== id).slice(0, 5));
    }
    const [s] = await toDormant([{ id, slug, path, mtimeMs: st.mtimeMs }]);
    return s;
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
          const sessions = await list();
          if (closed) return;
          const key = JSON.stringify(sessions);
          if (key !== last) {
            last = key;
            try {
              cb(sessions);
            } catch (e) {
              warn(`excaliagent: session watcher callback threw: ${(e as Error).message}`, "watch-callback");
            }
          }
        } while (again && !closed);
      } catch (e) {
        warn(`excaliagent: refreshing Claude sessions failed: ${(e as Error).message}`, "refresh");
      } finally {
        running = false;
      }
    };

    const kick = () => {
      if (closed) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(), debounceMs);
    };

    const ensureWatcher = () => {
      if (watcher || closed) return;
      try {
        watcher = fsWatch(sessionsDir, kick);
        watcher.on("error", () => {
          watcher?.close();
          watcher = undefined;
        });
      } catch {
        watcher = undefined; // dir missing; the poll retries
      }
    };

    ensureWatcher();
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

  return { list, listDormant, get, watch };
}
