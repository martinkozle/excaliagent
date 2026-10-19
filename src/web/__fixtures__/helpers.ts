import type { Session } from "../../shared/types.ts";
import type { Gen } from "../cards.ts";

export const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    source: "claude",
    cwd: "/home/me/dev/excaliagent",
    repo: "excaliagent",
    branch: "main",
    title: "ExcaliClaude handoff",
    name: "excaliagent-64",
    status: "busy",
    lastActivityAt: NOW - 2 * MIN,
    cacheTtlMs: HOUR,
    cacheExpiresAt: NOW + 41 * MIN,
    live: true,
    pid: 100,
    pane: { paneId: "w7:p1", workspaceId: "w7" },
    prLinks: [],
    ...over,
  };
}

/** Deterministic id/seed generator. */
export function testGen(): Gen {
  let i = 0;
  let s = 1000;
  return {
    id: () => `gen-${++i}`,
    seed: () => ++s,
  };
}
