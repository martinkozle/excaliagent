// Reads the current branch straight from a repo's HEAD (no git subprocess).
// Claude Code stamps gitBranch once per session, so the transcript goes stale.
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface GitInfo {
  /** The directory containing `.git` (a worktree's own dir for worktrees). */
  root: string;
  /** Branch name, or the first 7 chars of a detached sha. */
  branch: string;
}

async function gitDirAt(dir: string): Promise<string | undefined> {
  const dotGit = join(dir, ".git");
  const st = await stat(dotGit).catch(() => undefined);
  if (!st) return undefined;
  if (st.isDirectory()) return dotGit;
  if (!st.isFile()) return undefined;
  const text = await readFile(dotGit, "utf8").catch(() => "");
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return undefined;
  return isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!);
}

export function parseHead(text: string): string | undefined {
  const t = text.trim();
  const ref = /^ref:\s*(\S+)$/.exec(t);
  if (ref) return ref[1]!.replace(/^refs\/heads\//, "");
  if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(t)) return t.slice(0, 7);
  return undefined;
}

/** Walks up from cwd to the nearest `.git`; undefined if none or HEAD is unreadable. */
export async function readGitInfo(cwd: string): Promise<GitInfo | undefined> {
  if (!cwd || !isAbsolute(cwd)) return undefined;
  let dir = resolve(cwd);
  for (;;) {
    const gitDir = await gitDirAt(dir);
    if (gitDir) {
      const head = await readFile(join(gitDir, "HEAD"), "utf8").catch(() => undefined);
      const branch = head === undefined ? undefined : parseHead(head);
      return branch ? { root: dir, branch } : undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Per-cwd cache: each cwd is re-read at most every ttlMs. */
export class GitReader {
  private cache = new Map<string, { at: number; value: Promise<GitInfo | undefined> }>();
  private ttlMs: number;
  private now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  get(cwd: string): Promise<GitInfo | undefined> {
    const hit = this.cache.get(cwd);
    const now = this.now();
    if (hit && now - hit.at < this.ttlMs) return hit.value;
    const value = readGitInfo(cwd).catch(() => undefined);
    this.cache.set(cwd, { at: now, value });
    return value;
  }
}
