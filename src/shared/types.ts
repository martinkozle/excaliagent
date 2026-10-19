// Wire types shared by the server and the frontend. Nothing here knows which
// harness (Claude, Codex, ...) produced a session.

export type SessionStatus =
  | "busy"
  | "idle"
  | "waiting"
  | "needs_user"
  | "needs_trust"
  | "blocked"
  | "exited"
  | "dormant";

export interface Pane {
  paneId: string;
  workspaceId: string;
}

export interface Session {
  id: string;
  source: "claude";
  cwd: string;
  /** Basename of the cwd's repo (cwd basename for now). */
  repo: string;
  branch?: string;
  /** ai-title, else agent-name. */
  title?: string;
  /** Registry name, e.g. "excaliagent-64". */
  name?: string;
  status: SessionStatus;
  waitingFor?: string;
  /** Epoch ms of the last thing that happened (registry statusUpdatedAt or last transcript line). */
  lastActivityAt: number;
  /** 0 when unknown (no assistant turn yet). */
  cacheTtlMs: number;
  /** 0 when unknown. */
  cacheExpiresAt: number;
  live: boolean;
  pid?: number;
  pane?: Pane;
  prLinks: string[];
  /** Session id this one was continued in, if any (recorded, not acted on yet). */
  continuedIn?: string;
}

/** Statuses that mean "a human is needed". */
export const NEEDS_INPUT: ReadonlySet<SessionStatus> = new Set([
  "needs_user",
  "waiting",
  "needs_trust",
  "blocked",
]);
