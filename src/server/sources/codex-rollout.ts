// Codex rollouts: <codexHome>/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl
// (old ones may be compressed to `.jsonl.zst`). Folded incrementally; only
// metadata is kept, plus the first user message (cut short) as the fallback
// title, which is what Codex itself shows in its resume picker.
// Formats: docs/design.md "Codex data".
import { readFile, stat } from "node:fs/promises";
import { JsonlScanner, type JsonlFold } from "./jsonl.ts";
import type { Logger, Warn } from "./log.ts";

export interface RolloutInfo {
  id?: string;
  /** session_meta cwd: where the thread was started. */
  cwd?: string;
  /** git branch recorded at start, if any. */
  branch?: string;
  /** session_meta source: "cli", "vscode" (the TUI says so too), "exec", "mcp", or an object for sub-agents. */
  source?: unknown;
  /** session_meta thread_source: "user", "subagent", "guardian_review", ... */
  threadSource?: string;
  parentThreadId?: string;
  /** First user message, whitespace-collapsed, at most TITLE_MAX chars. */
  firstUserMessage?: string;
  /** A turn started and has not completed or been aborted yet. */
  turnOpen: boolean;
  /** Epoch ms of the last line, 0 if none. */
  lastTimestamp: number;
}

type Acc = RolloutInfo;

export const TITLE_MAX = 120;
const USER_MESSAGE_BEGIN = "## My request for Codex:";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const TS = /^\{"timestamp":"([^"]+)"/;
// Cheap prefilter on the line; the parsed type is still checked.
const INTERESTING =
  /"type":"(?:session_meta|task_started|turn_started|task_complete|turn_complete|turn_aborted|user_message|UserMessage)"/;

function short(text: string): string | undefined {
  const i = text.indexOf(USER_MESSAGE_BEGIN);
  const t = (i >= 0 ? text.slice(i + USER_MESSAGE_BEGIN.length) : text).replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  const chars = [...t];
  return chars.length <= TITLE_MAX ? t : chars.slice(0, TITLE_MAX - 1).join("") + "…";
}

/** Text of an item_completed UserMessage (paginated history) or a legacy user_message event. */
function userText(p: Record<string, unknown>): string | undefined {
  if (p.type === "user_message") return str(p.message);
  const item = p.item as { type?: unknown; content?: unknown } | undefined;
  if (p.type !== "item_completed" || item?.type !== "UserMessage" || !Array.isArray(item.content)) return undefined;
  const parts = item.content
    .map((c) => (c && typeof c === "object" && (c as { type?: unknown }).type === "text" ? str((c as { text?: unknown }).text) : undefined))
    .filter((t): t is string => t !== undefined);
  return parts.length ? parts.join(" ") : undefined;
}

export function applyRolloutLine(acc: Acc, o: Record<string, unknown>): void {
  const p = o.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) return;
  const payload = p as Record<string, unknown>;
  if (o.type === "session_meta") {
    // A forked thread's file starts with its own meta; later metas (if any) do not override it.
    if (acc.id) return;
    acc.id = str(payload.id);
    acc.cwd = str(payload.cwd);
    acc.branch = str((payload.git as { branch?: unknown } | undefined)?.branch);
    acc.source = payload.source;
    acc.threadSource = str(payload.thread_source);
    acc.parentThreadId = str(payload.parent_thread_id);
    return;
  }
  if (o.type !== "event_msg") return;
  switch (payload.type) {
    case "task_started":
    case "turn_started":
      acc.turnOpen = true;
      return;
    case "task_complete":
    case "turn_complete":
    case "turn_aborted":
      acc.turnOpen = false;
      return;
  }
  if (acc.firstUserMessage === undefined) {
    const text = userText(payload);
    if (text !== undefined) acc.firstUserMessage = short(text);
  }
}

const fold: JsonlFold<Acc, RolloutInfo> = {
  empty: () => ({ turnOpen: false, lastTimestamp: 0 }),
  raw(acc, line) {
    const m = TS.exec(line);
    const t = m ? Date.parse(m[1]!) : NaN;
    if (Number.isFinite(t) && t > acc.lastTimestamp) acc.lastTimestamp = t;
  },
  interesting: (line) => INTERESTING.test(line),
  apply: applyRolloutLine,
  snapshot: (acc) => ({ ...acc }),
};

export class RolloutScanner extends JsonlScanner<Acc, RolloutInfo> {
  constructor(opts: { log?: Logger; warn?: Warn } = {}) {
    super(fold, { ...opts, noun: "Codex rollout" });
  }
}

/** Thread ids are UUIDs (v7 in practice). */
export const CODEX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Creation time of a UUIDv7 (its first 48 bits, epoch ms), else undefined. */
export function uuidV7Ms(id: string): number | undefined {
  if (id[14] !== "7") return undefined;
  const ms = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * `rollout-2026-10-20T14-07-46-<uuid>.jsonl[.zst]`; a reverted thread's file
 * appends `_<rollout id>` to the thread id. Returns the thread id.
 */
export function rolloutThreadId(name: string): string | undefined {
  const m = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})(?:_[0-9a-f-]{36})?\.jsonl(?:\.zst)?$/i.exec(name);
  return m && CODEX_ID.test(m[1]!) ? m[1]!.toLowerCase() : undefined;
}

/** Only threads a person started (not sub-agents, reviews, `codex exec` or MCP runs) go into the picker. */
export function isUserThread(r: RolloutInfo): boolean {
  if (r.parentThreadId) return false;
  if (r.threadSource !== undefined && r.threadSource !== "user") return false;
  if (r.source !== undefined && typeof r.source !== "string") return false;
  return r.source !== "exec" && r.source !== "mcp";
}

/**
 * `<codexHome>/session_index.jsonl`: `{"id","thread_name","updated_at"}` per
 * line, appended on every rename; the last entry for an id wins. Re-read only
 * when its size or mtime changes.
 */
export class SessionIndex {
  private key = "";
  private names = new Map<string, string>();

  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  async read(): Promise<Map<string, string>> {
    const st = await stat(this.path).catch(() => undefined);
    const key = st ? `${st.size}:${st.mtimeMs}` : "";
    if (key === this.key) return this.names;
    const names = new Map<string, string>();
    const text = st ? await readFile(this.path, "utf8").catch(() => "") : "";
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
        if (typeof o.id !== "string") continue;
        const name = typeof o.thread_name === "string" ? o.thread_name.trim() : "";
        if (name) names.set(o.id.toLowerCase(), name);
        else names.delete(o.id.toLowerCase());
      } catch {
        // a torn last line while Codex appends; the next read gets it
      }
    }
    this.key = key;
    this.names = names;
    return names;
  }
}
