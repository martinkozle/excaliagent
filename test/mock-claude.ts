// A throwaway, fully synthetic Claude Code home: registry files for "live"
// sessions backed by real dummy processes (so `kill -0 pid` works), plus
// transcripts. Used by the e2e tests and `npm run demo`. Never touches ~/.claude.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type MockStatus = "busy" | "idle" | "waiting" | "needs_user" | "needs_trust" | "blocked" | "exited";

export interface MockSessionSpec {
  id: string;
  cwd: string;
  name?: string;
  title?: string;
  branch?: string;
  status?: MockStatus;
  waitingFor?: string;
  prUrl?: string;
  /** Minutes ago of the last assistant turn. */
  lastTurnMinutesAgo?: number;
  /** Cache tier of the last turn that wrote cache. */
  cache?: "1h" | "5m";
  /** false → only a transcript (dormant). Default true. */
  live?: boolean;
  /** Use this existing process (e.g. one running in a herdr pane) instead of spawning a dummy. */
  pid?: number;
}

export interface MockSession extends MockSessionSpec {
  pid?: number;
  process?: ChildProcess;
}

export interface MockClaude {
  dir: string;
  sessions: Map<string, MockSession>;
  add(spec: MockSessionSpec): MockSession;
  setStatus(id: string, status: MockStatus, waitingFor?: string): void;
  /** Append an assistant turn now (refreshes cache warmth). */
  turn(id: string, cache?: "1h" | "5m"): void;
  /** Kill the process and remove its registry file, like a clean exit. */
  exit(id: string): void;
  /** Kill the process but leave the registry file behind, like a crash. */
  crash(id: string): void;
  /** Start a process for a dormant session, like `claude --resume`. */
  resume(id: string): void;
  teardown(): void;
}

const slug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
const iso = (ms: number) => new Date(ms).toISOString();

function dummyProcess(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
  child.unref();
  return child;
}

export function createMockClaude(dir = mkdtempSync(join(tmpdir(), "excaliagent-mock-claude-"))): MockClaude {
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const sessions = new Map<string, MockSession>();

  const transcriptPath = (s: MockSession) => join(dir, "projects", slug(s.cwd), `${s.id}.jsonl`);
  const registryPath = (s: MockSession) => join(dir, "sessions", `${s.pid}.json`);
  const line = (s: MockSession, obj: object) => appendFileSync(transcriptPath(s), `${JSON.stringify(obj)}\n`);

  function assistant(s: MockSession, at: number, cache: "1h" | "5m") {
    line(s, {
      type: "assistant",
      sessionId: s.id,
      cwd: s.cwd,
      gitBranch: s.branch ?? "main",
      timestamp: iso(at),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "(synthetic)" }],
        usage: {
          input_tokens: 3,
          output_tokens: 42,
          cache_creation: {
            ephemeral_1h_input_tokens: cache === "1h" ? 1200 : 0,
            ephemeral_5m_input_tokens: cache === "5m" ? 1200 : 0,
          },
        },
      },
    });
  }

  function writeRegistry(s: MockSession) {
    if (s.pid === undefined) return;
    const now = Date.now();
    writeFileSync(
      registryPath(s),
      JSON.stringify({
        pid: s.pid,
        sessionId: s.id,
        cwd: s.cwd,
        startedAt: now,
        version: "0.0.0-mock",
        kind: "interactive",
        entrypoint: "cli",
        name: s.name ?? `${s.cwd.split("/").pop()}-mock`,
        nameSource: "derived",
        status: s.status ?? "idle",
        ...(s.waitingFor ? { waitingFor: s.waitingFor } : {}),
        updatedAt: now,
        statusUpdatedAt: now,
      }),
    );
  }

  function start(s: MockSession) {
    if (s.pid === undefined) {
      s.process = dummyProcess();
      s.pid = s.process.pid;
    }
    writeRegistry(s);
  }

  function stop(s: MockSession, removeRegistry: boolean) {
    if (removeRegistry && s.pid !== undefined) rmSync(registryPath(s), { force: true });
    s.process?.kill("SIGKILL");
    s.process = undefined;
    if (removeRegistry) s.pid = undefined;
  }

  const get = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new Error(`unknown mock session ${id}`);
    return s;
  };

  return {
    dir,
    sessions,
    add(spec) {
      const s: MockSession = { ...spec };
      sessions.set(s.id, s);
      mkdirSync(join(dir, "projects", slug(s.cwd)), { recursive: true });
      const turnAt = Date.now() - (s.lastTurnMinutesAgo ?? 1) * 60_000;
      line(s, {
        type: "user",
        sessionId: s.id,
        cwd: s.cwd,
        gitBranch: s.branch ?? "main",
        timestamp: iso(turnAt - 30_000),
        message: { role: "user", content: "(synthetic)" },
      });
      if (s.title) line(s, { type: "ai-title", aiTitle: s.title, sessionId: s.id });
      assistant(s, turnAt, s.cache ?? "1h");
      if (s.prUrl) {
        const prNumber = Number(s.prUrl.split("/").pop());
        line(s, { type: "pr-link", sessionId: s.id, prNumber, prUrl: s.prUrl, timestamp: iso(turnAt) });
      }
      if (s.live !== false) start(s);
      return s;
    },
    setStatus(id, status, waitingFor) {
      const s = get(id);
      s.status = status;
      s.waitingFor = waitingFor;
      writeRegistry(s);
    },
    turn(id, cache = "1h") {
      assistant(get(id), Date.now(), cache);
    },
    exit(id) {
      stop(get(id), true);
    },
    crash(id) {
      stop(get(id), false);
    },
    resume(id) {
      const s = get(id);
      s.status = "idle";
      start(s);
    },
    teardown() {
      for (const s of sessions.values()) s.process?.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The demo cast: one of each state the board distinguishes. */
export function seedDemo(mock: MockClaude) {
  mock.add({ id: "11111111-0000-4000-8000-000000000001", cwd: "/home/alice/src/demo-app", title: "Add OAuth login", branch: "feat/oauth", status: "busy" });
  mock.add({ id: "11111111-0000-4000-8000-000000000002", cwd: "/home/alice/src/demo-app", title: "Fix flaky checkout test", branch: "fix/flaky", status: "needs_user", waitingFor: "input needed", prUrl: "https://github.com/example/demo-app/pull/12" });
  mock.add({ id: "11111111-0000-4000-8000-000000000003", cwd: "/home/alice/src/api-server", title: "Grill: rate limiting design", status: "idle", lastTurnMinutesAgo: 12, cache: "1h" });
  mock.add({ id: "11111111-0000-4000-8000-000000000004", cwd: "/home/alice/src/api-server", title: "Bump dependencies", status: "idle", lastTurnMinutesAgo: 90, cache: "5m" });
  mock.add({ id: "11111111-0000-4000-8000-000000000005", cwd: "/home/alice/src/docs-site", title: "Blocked on design review", status: "waiting", waitingFor: "dialog open" });
  mock.add({ id: "22222222-0000-4000-8000-000000000001", cwd: "/home/alice/src/demo-app", title: "Old migration spike", live: false, lastTurnMinutesAgo: 3 * 24 * 60 });
  mock.add({ id: "22222222-0000-4000-8000-000000000002", cwd: "/home/alice/src/infra", title: "Terraform state cleanup", live: false, lastTurnMinutesAgo: 26 * 60, prUrl: "https://github.com/example/infra/pull/7" });
}
