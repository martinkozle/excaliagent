// Incremental scanner for Claude Code transcripts
// (<claudeDir>/projects/<slug>/<sessionId>.jsonl). Keeps a byte offset per file
// and parses only appended bytes. Never keeps message content.
import { open, stat } from "node:fs/promises";
import { onceLogger, type Logger, type Warn } from "./log.ts";

export const TTL_1H = 3600_000;
export const TTL_5M = 300_000;

export interface TranscriptInfo {
  aiTitle?: string;
  agentName?: string;
  prLinks: string[];
  continuedIn?: string;
  cwd?: string;
  gitBranch?: string;
  /** Epoch ms of the last user/assistant line, 0 if none. */
  lastTimestamp: number;
  /** Epoch ms of the last assistant line, 0 if none. */
  lastAssistantAt: number;
  /** 0 when there is no assistant line. */
  cacheTtlMs: number;
  /** lastAssistantAt + cacheTtlMs, or 0. */
  cacheExpiresAt: number;
}

interface Acc {
  aiTitle?: string;
  agentName?: string;
  prLinks: string[];
  continuedIn?: string;
  cwd?: string;
  gitBranch?: string;
  lastTimestamp: number;
  lastAssistantAt: number;
  /** TTL of the most recent assistant line that actually wrote cache (usage-based, legacy). */
  tierMs?: number;
  /** TTL requested by the most recent main-thread api-request with cacheControl. */
  apiMainTierMs?: number;
  /** Same, from any other query source (subagents, compaction, ...). */
  apiOtherTierMs?: number;
}

interface FileState {
  ino: number;
  dev: number;
  mtimeMs: number;
  offset: number;
  bytesRead: number;
  partial: Buffer;
  acc: Acc;
}

const CHUNK = 1 << 20;
const NL = 0x0a;
// Cheap prefilter; the parsed top-level `type` is still checked.
const INTERESTING = /"type":"(?:ai-title|agent-name|pr-link|continued-in|user|assistant|api-request)"/;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const tsOf = (v: unknown): number => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
};

function emptyAcc(): Acc {
  return { prLinks: [], lastTimestamp: 0, lastAssistantAt: 0 };
}

/** Folds one parsed line into the accumulator. Exported for tests and reuse. */
export function applyLine(acc: Acc, o: Record<string, unknown>): void {
  switch (o.type) {
    case "ai-title":
      acc.aiTitle = str(o.aiTitle) ?? acc.aiTitle;
      return;
    case "agent-name":
      acc.agentName = str(o.agentName) ?? acc.agentName;
      return;
    case "pr-link": {
      const url = str(o.prUrl);
      if (url && !acc.prLinks.includes(url)) acc.prLinks.push(url);
      return;
    }
    case "continued-in":
      acc.continuedIn = str(o.continuedInSessionId) ?? acc.continuedIn;
      return;
    case "api-request": {
      // Only cacheControl is read; params/tail are never kept.
      const cc = o.cacheControl;
      if (!Array.isArray(cc)) return;
      let tier = TTL_5M;
      for (const entry of cc) {
        const ttl = (entry as { value?: { ttl?: unknown } } | null)?.value?.ttl;
        if (ttl === "1h") tier = TTL_1H;
      }
      if (o.querySource === "repl_main_thread") acc.apiMainTierMs = tier;
      else acc.apiOtherTierMs = tier;
      return;
    }
    case "user":
    case "assistant": {
      acc.cwd = str(o.cwd) ?? acc.cwd;
      acc.gitBranch = str(o.gitBranch) ?? acc.gitBranch;
      const ts = tsOf(o.timestamp);
      if (ts > acc.lastTimestamp) acc.lastTimestamp = ts;
      if (o.type !== "assistant") return;
      if (ts > acc.lastAssistantAt) acc.lastAssistantAt = ts;
      const msg = o.message as { usage?: { cache_creation?: Record<string, unknown> } } | undefined;
      const cc = msg?.usage?.cache_creation;
      const h1 = Number(cc?.ephemeral_1h_input_tokens ?? 0);
      const m5 = Number(cc?.ephemeral_5m_input_tokens ?? 0);
      // A cache-read-only turn (both 0) keeps the previous tier.
      if (h1 > 0) acc.tierMs = TTL_1H;
      else if (m5 > 0) acc.tierMs = TTL_5M;
      return;
    }
  }
}

function snapshot(acc: Acc): TranscriptInfo {
  // Recent Claude Code reports every cache write as 5m in usage even for 1h
  // requests, so the api-request cacheControl is the source of truth when present.
  const tier = acc.apiMainTierMs ?? acc.apiOtherTierMs ?? acc.tierMs ?? TTL_5M;
  const ttl = acc.lastAssistantAt ? tier : 0;
  const out: TranscriptInfo = {
    prLinks: [...acc.prLinks],
    lastTimestamp: acc.lastTimestamp,
    lastAssistantAt: acc.lastAssistantAt,
    cacheTtlMs: ttl,
    cacheExpiresAt: ttl ? acc.lastAssistantAt + ttl : 0,
  };
  if (acc.aiTitle !== undefined) out.aiTitle = acc.aiTitle;
  if (acc.agentName !== undefined) out.agentName = acc.agentName;
  if (acc.continuedIn !== undefined) out.continuedIn = acc.continuedIn;
  if (acc.cwd !== undefined) out.cwd = acc.cwd;
  if (acc.gitBranch !== undefined) out.gitBranch = acc.gitBranch;
  return out;
}

export class TranscriptScanner {
  private files = new Map<string, FileState>();
  private inflight = new Map<string, Promise<TranscriptInfo | undefined>>();
  private warn: Warn;

  constructor(opts: { log?: Logger; warn?: Warn } = {}) {
    this.warn = opts.warn ?? onceLogger(opts.log ?? console.warn);
  }

  /** Scans new bytes of `path` and returns the folded info, or undefined if the file is gone. */
  scan(path: string): Promise<TranscriptInfo | undefined> {
    const running = this.inflight.get(path);
    if (running) return running;
    const p = this.doScan(path).finally(() => this.inflight.delete(path));
    this.inflight.set(path, p);
    return p;
  }

  /** Read bookkeeping, for tests. */
  stats(path: string): { offset: number; bytesRead: number } | undefined {
    const s = this.files.get(path);
    return s && { offset: s.offset, bytesRead: s.bytesRead };
  }

  forget(path: string): void {
    this.files.delete(path);
  }

  private async doScan(path: string): Promise<TranscriptInfo | undefined> {
    let st;
    try {
      st = await stat(path);
    } catch {
      this.files.delete(path);
      return undefined;
    }
    let s = this.files.get(path);
    const replaced = !s || s.ino !== st.ino || s.dev !== st.dev;
    const shrunk = !!s && st.size < s.offset;
    // Same size but touched: rewritten in place (appends always grow the file).
    const rewritten = !!s && st.size === s.offset && st.mtimeMs !== s.mtimeMs;
    if (!s || replaced || shrunk || rewritten) {
      s = { ino: st.ino, dev: st.dev, mtimeMs: st.mtimeMs, offset: 0, bytesRead: s?.bytesRead ?? 0, partial: Buffer.alloc(0), acc: emptyAcc() };
      this.files.set(path, s);
    }
    if (st.size > s.offset) {
      try {
        await this.readFrom(path, s, st.size);
      } catch (e) {
        this.warn(`excaliagent: cannot read transcript ${path}: ${(e as Error).message}`, path);
      }
    }
    s.mtimeMs = st.mtimeMs;
    return snapshot(s.acc);
  }

  private async readFrom(path: string, s: FileState, end: number): Promise<void> {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, end - s.offset));
      while (s.offset < end) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - s.offset), s.offset);
        if (bytesRead === 0) break;
        s.offset += bytesRead;
        s.bytesRead += bytesRead;
        this.consume(path, s, buf.subarray(0, bytesRead));
      }
    } finally {
      await fh.close();
    }
  }

  private consume(path: string, s: FileState, chunk: Buffer): void {
    let start = 0;
    let nl = chunk.indexOf(NL, start);
    while (nl !== -1) {
      const piece = chunk.subarray(start, nl);
      const line = s.partial.length ? Buffer.concat([s.partial, piece]) : piece;
      s.partial = Buffer.alloc(0);
      this.parseLine(path, s.acc, line);
      start = nl + 1;
      nl = chunk.indexOf(NL, start);
    }
    if (start < chunk.length) s.partial = Buffer.concat([s.partial, chunk.subarray(start)]);
  }

  private parseLine(path: string, acc: Acc, line: Buffer): void {
    if (line.length === 0) return;
    const text = line.toString("utf8");
    if (!INTERESTING.test(text)) return;
    let o: unknown;
    try {
      o = JSON.parse(text);
    } catch {
      this.warn(`excaliagent: skipping malformed line(s) in ${path}`, path);
      return;
    }
    if (o && typeof o === "object" && !Array.isArray(o)) applyLine(acc, o as Record<string, unknown>);
  }
}
