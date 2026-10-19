import type { Session } from "../shared/types.ts";
import type { PaneLink } from "./panes/types.ts";
import type { Source } from "./sources/types.ts";

export interface Hub {
  start(): Promise<void>;
  stop(): void;
  /** Current live sessions with panes attached. */
  sessions(): Session[];
  subscribe(cb: (sessions: Session[]) => void): () => void;
  /** Sessions by id, live or dormant; unknown ids are dropped. */
  lookup(ids: string[]): Promise<Session[]>;
  /** Dormant sessions for the picker. */
  picker(): Promise<Session[]>;
  /** Focus the session's pane. False when it has none. */
  focus(sessionId: string): Promise<boolean>;
  /**
   * Reopen a dormant session in a new terminal (`claude --resume <id>`).
   * "live": it is running, focus it instead. "no-herdr": nothing can open a terminal.
   */
  resume(sessionId: string): Promise<ResumeResult>;
}

export type ResumeResult = "resumed" | "no-herdr" | "unknown" | "live";

/** Claude session ids are UUIDs; anything else is never put into a command. */
export const SESSION_ID = /^[0-9a-f-]{36}$/i;

const LABEL_MAX = 40;

function resumeLabel(s: Session): string {
  const title = s.title?.trim();
  if (!title) return s.repo;
  const chars = [...title];
  return chars.length <= LABEL_MAX ? title : chars.slice(0, LABEL_MAX - 1).join("") + "…";
}

/** Joins a Source with a PaneLink and fans the result out to subscribers. */
export function createHub({ source, panes }: { source: Source; panes: PaneLink }): Hub {
  let raw: Session[] = [];
  let current: Session[] = [];
  let serialized = "[]";
  const listeners = new Set<(s: Session[]) => void>();
  const cleanups: (() => void)[] = [];

  const withPane = (s: Session): Session => {
    const pane = s.pid !== undefined ? panes.match(s.pid) : undefined;
    const { pane: _old, ...rest } = s;
    return pane ? { ...rest, pane } : rest;
  };

  function recompute() {
    const next = raw.map(withPane);
    const json = JSON.stringify(next);
    if (json === serialized) return;
    current = next;
    serialized = json;
    for (const cb of listeners) cb(current);
  }

  function setRaw(next: Session[]) {
    const ids = (l: Session[]) => l.map((s) => `${s.id}:${s.pid}`).join(",");
    const membershipChanged = ids(next) !== ids(raw);
    raw = next;
    recompute();
    if (membershipChanged) void panes.refresh?.().catch(() => {});
  }

  return {
    async start() {
      raw = await source.list();
      current = raw.map(withPane);
      serialized = JSON.stringify(current);
      cleanups.push(source.watch(setRaw));
      cleanups.push(panes.onChange(recompute));
    },
    stop() {
      for (const c of cleanups.splice(0)) c();
      listeners.clear();
    },
    sessions: () => current,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async lookup(ids) {
      const out: Session[] = [];
      for (const id of ids) {
        const live = current.find((s) => s.id === id);
        const found = live ?? (await source.get(id));
        if (found) out.push(live ? found : withPane(found));
      }
      return out;
    },
    async picker() {
      const live = new Set(current.map((s) => s.id));
      return (await source.listDormant()).filter((s) => !s.live && !live.has(s.id));
    },
    async resume(sessionId) {
      if (!SESSION_ID.test(sessionId)) return "unknown";
      if (current.some((s) => s.id === sessionId)) return "live";
      const s = await source.get(sessionId);
      if (!s) return "unknown";
      if (s.live) return "live";
      if (!panes.resume || !panes.available()) return "no-herdr";
      await panes.resume({
        cwd: s.cwd,
        ...(s.repoRoot !== undefined ? { repoRoot: s.repoRoot } : {}),
        command: `claude --resume ${s.id}`,
        label: resumeLabel(s),
      });
      return "resumed";
    },
    async focus(sessionId) {
      const pane = current.find((s) => s.id === sessionId)?.pane;
      if (!pane) return false;
      await panes.focus(pane.paneId);
      return true;
    },
  };
}
