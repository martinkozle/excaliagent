// A throwaway, fully synthetic OpenCode data dir: an opencode.db with the
// tables and columns the board reads (shaped like OpenCode 1.19.3's), and for
// "live" sessions a real dummy process that the synthetic /proc
// (test/mock-proc.ts) shows as `opencode -s <id>`. Used by the e2e tests and
// `npm run demo`. Never touches ~/.local/share/opencode, and the server under
// test never reads the real /proc.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MockProc } from "./mock-proc.ts";

export interface MockOpenCodeSpec {
  /** `ses_` + 26 chars. */
  id: string;
  directory: string;
  /** Omitted = OpenCode's default "New session - <iso>". */
  title?: string;
  /** A reply is being generated. */
  busy?: boolean;
  lastMinutesAgo?: number;
  /** false → only in the database (dormant). Default true. */
  live?: boolean;
}

export interface MockOpenCodeSession extends MockOpenCodeSpec {
  pid?: number;
  process?: ChildProcess;
}

export interface MockOpenCode {
  dir: string;
  /** Live sessions are simulated through the synthetic /proc; always possible. */
  canLive: boolean;
  sessions: Map<string, MockOpenCodeSession>;
  add(spec: MockOpenCodeSpec): MockOpenCodeSession;
  /** A prompt is sent (busy) or the reply finishes (idle). */
  setBusy(id: string, busy: boolean): void;
  teardown(): void;
}

const SCHEMA = `
CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, vcs text, name text, time_created integer NOT NULL, time_updated integer NOT NULL, sandboxes text NOT NULL DEFAULT '[]');
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
`;

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** `ses_` + 12 hex + 14 base62, random per call, so parallel runs never share one. */
export const mockSessionId = (): string =>
  `ses_${randomBytes(6).toString("hex")}${[...randomBytes(14)].map((b) => B62[b % 62]).join("")}`;

export function createMockOpenCode(proc: MockProc, dir = mkdtempSync(join(tmpdir(), "excaliagent-mock-opencode-"))): MockOpenCode {
  // Shown like the npm shim: `node …/bin/opencode -s <id>` (only a name in the synthetic /proc).
  const shim = join(dir, "bin", "opencode");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "opencode.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  db.prepare("INSERT INTO project VALUES ('global', '/', NULL, NULL, 0, 0, '[]')").run();
  const canLive = true;
  const sessions = new Map<string, MockOpenCodeSession>();
  let msg = 0;

  const message = (s: MockOpenCodeSession, at: number, data: object) => {
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(`msg_${String(++msg).padStart(26, "0")}`, s.id, at, at, JSON.stringify(data));
    db.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(at, s.id);
  };
  const turn = (s: MockOpenCodeSession, at: number, busy: boolean) => {
    message(s, at, { role: "user", time: { created: at }, agent: "build" });
    message(s, at + 1, { role: "assistant", time: busy ? { created: at + 1 } : { created: at + 1, completed: at + 2 }, finish: busy ? undefined : "stop" });
  };
  const get = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new Error(`unknown mock session ${id}`);
    return s;
  };

  return {
    dir,
    canLive,
    sessions,
    add(spec) {
      const s: MockOpenCodeSession = { ...spec };
      sessions.set(s.id, s);
      const at = Date.now() - (s.lastMinutesAgo ?? 1) * 60_000;
      const title = s.title ?? `New session - ${new Date(at).toISOString()}`;
      db.prepare("INSERT INTO session VALUES (?, 'global', NULL, NULL, 'mock-slug', ?, '', ?, '1.19.3', ?, ?, NULL)").run(s.id, s.directory, title, at, at);
      if (s.live !== false) {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
        child.unref();
        s.process = child;
        s.pid = child.pid;
        proc.add(child, { comm: "MainThread", argv: ["node", shim, "-s", s.id], exe: process.execPath, cwd: s.directory });
        // Activity after the process started counts for the status.
        turn(s, Date.now() + 50, !!s.busy);
      } else {
        turn(s, at, false);
      }
      return s;
    },
    setBusy(id, busy) {
      const s = get(id);
      s.busy = busy;
      const now = Date.now();
      if (busy) message(s, now, { role: "user", time: { created: now }, agent: "build" });
      else message(s, now, { role: "assistant", time: { created: now, completed: now }, finish: "stop" });
    },
    teardown() {
      for (const s of sessions.values()) s.process?.kill("SIGKILL");
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The demo's OpenCode cast: one live, one parked (random ids). */
export function seedOpenCodeDemo(mock: MockOpenCode): { live: string; parked: string } {
  const ids = { live: mockSessionId(), parked: mockSessionId() };
  mock.add({ id: ids.live, directory: "/home/alice/src/docs-site", title: "Rewrite the getting-started guide", busy: true });
  mock.add({ id: ids.parked, directory: "/home/alice/src/api-server", title: "Profile the slow search query", live: false, lastMinutesAgo: 5 * 60 });
  return ids;
}
