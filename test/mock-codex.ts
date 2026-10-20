// A throwaway, fully synthetic Codex home: rollouts under sessions/YYYY/MM/DD,
// names in session_index.jsonl, and for "live" threads a lock file in
// thread-writer-locks/ held (in the synthetic /proc of test/mock-proc.ts) by a
// real dummy process presented as an in-process `codex` holder, like
// `codex exec`; or, with `holder: "daemon"`, by a dummy shared app-server
// daemon, with TUIs (`tui()`) and other Codex processes (`spawn()`) as
// separate dummies, which is how the interactive TUI really works (see
// docs/design.md "Liveness"). Used by the e2e tests and `npm run demo`. Never
// touches ~/.codex, and the server under test never reads the real /proc.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockProc } from "./mock-proc.ts";

export interface MockCodexThreadSpec {
  /** A UUIDv7-shaped thread id. */
  id: string;
  cwd: string;
  /** First user message (Codex's own fallback title). */
  prompt?: string;
  /** A /rename name (session_index.jsonl). */
  name?: string;
  branch?: string;
  /** A turn is in progress. Default false (idle). */
  busy?: boolean;
  /** Minutes ago of the last line. */
  lastMinutesAgo?: number;
  /** false → only a rollout (dormant). Default true. */
  live?: boolean;
  /**
   * false → no rollout file at all, only the held lock: a TUI that was opened
   * but not prompted yet (Codex writes the rollout with the first prompt).
   * Default true.
   */
  rollout?: boolean;
  /**
   * Who holds the lock: "self" (default), a dummy `codex exec`; "daemon", the
   * shared dummy app-server daemon, so only a TUI from `tui()` makes it live.
   */
  holder?: "self" | "daemon";
}

export interface MockCodexProcess {
  pid: number;
  kill(): void;
}

export interface MockCodexThread extends MockCodexThreadSpec {
  pid?: number;
  process?: ChildProcess;
  path: string;
}

export interface MockCodex {
  dir: string;
  /** Live threads are simulated through the synthetic /proc; always possible. */
  canLive: boolean;
  threads: Map<string, MockCodexThread>;
  add(spec: MockCodexThreadSpec): MockCodexThread;
  /** Start (true) or finish (false) a turn. */
  setBusy(id: string, busy: boolean): void;
  /** Unload the thread like a clean exit: the process ends (or the daemon unlocks) and its lock file goes. */
  exit(id: string): void;
  /** A Codex TUI (`codex [args]`) in `cwd`, started now. */
  tui(cwd: string, args?: string[]): MockCodexProcess;
  /** Any other process running Codex's binary, e.g. its sandbox helper. */
  spawn(argv: string[], cwd: string, ppid?: number): MockCodexProcess;
  teardown(): void;
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * A UUIDv7 thread id created `at` (like Codex's, its first 48 bits are the
 * creation time in ms), random otherwise, so parallel runs never share one.
 */
export const mockThreadId = (at = Date.now()): string => {
  const t = Math.floor(at).toString(16).padStart(12, "0").slice(-12);
  const h = randomBytes(5).toString("hex");
  return `${t.slice(0, 8)}-${t.slice(8)}-7${h.slice(0, 3)}-8${h.slice(3, 6)}-${randomBytes(6).toString("hex")}`;
};

export function createMockCodex(proc: MockProc, dir = mkdtempSync(join(tmpdir(), "excaliagent-mock-codex-"))): MockCodex {
  mkdirSync(join(dir, "thread-writer-locks"), { recursive: true });
  const bin = join(dir, "bin", "codex"); // only a name in the synthetic /proc
  const canLive = true;
  const threads = new Map<string, MockCodexThread>();

  const line = (t: MockCodexThread, at: number, type: string, payload: object) =>
    appendFileSync(t.path, `${JSON.stringify({ timestamp: iso(at), type, payload })}\n`);
  const lockPath = (t: MockCodexThread) => join(dir, "thread-writer-locks", `${t.id}.lock`);

  const dummy = (argv: string[], cwd: string, ppid?: number): ChildProcess => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    child.unref();
    proc.add(child, { comm: "codex", argv, exe: bin, cwd, ...(ppid ? { ppid } : {}) });
    return child;
  };
  const handle = (child: ChildProcess): MockCodexProcess => ({ pid: child.pid!, kill: () => child.kill("SIGKILL") });
  let daemon: ChildProcess | undefined;
  const spawned: ChildProcess[] = [];

  function start(t: MockCodexThread) {
    writeFileSync(lockPath(t), "");
    if (t.holder === "daemon") {
      daemon ??= dummy([bin, "app-server", "--listen", "unix://", "--analytics-default-enabled", "--managed-daemon"], "/");
      t.pid = daemon.pid;
      proc.openFd(daemon.pid!, lockPath(t));
      proc.lock(daemon.pid!, statSync(lockPath(t)).ino);
      return;
    }
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    child.unref();
    t.process = child;
    t.pid = child.pid;
    proc.add(child, { comm: "codex", argv: [bin, "exec", "(synthetic)"], exe: bin, cwd: t.cwd, fds: [lockPath(t)] });
    if (child.pid !== undefined) proc.lock(child.pid, statSync(lockPath(t)).ino);
  }

  const get = (id: string) => {
    const t = threads.get(id);
    if (!t) throw new Error(`unknown mock thread ${id}`);
    return t;
  };

  return {
    dir,
    canLive,
    threads,
    add(spec) {
      const at = Date.now() - (spec.lastMinutesAgo ?? 1) * 60_000;
      const d = new Date(at - 60_000);
      const day = join(dir, "sessions", String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
      mkdirSync(day, { recursive: true });
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
      const t: MockCodexThread = { ...spec, path: join(day, `rollout-${stamp}-${spec.id}.jsonl`) };
      threads.set(t.id, t);
      if (t.rollout === false) {
        if (t.live !== false) start(t);
        return t;
      }
      line(t, at - 60_000, "session_meta", {
        session_id: t.id,
        id: t.id,
        timestamp: iso(at - 60_000),
        cwd: t.cwd,
        originator: "codex-tui",
        cli_version: "0.0.0-mock",
        source: "cli",
        thread_source: "user",
        model_provider: "openai",
        git: t.branch ? { branch: t.branch } : {},
      });
      line(t, at - 50_000, "event_msg", { type: "task_started", turn_id: "turn-1" });
      if (t.prompt) {
        line(t, at - 50_000, "event_msg", {
          type: "item_completed",
          thread_id: t.id,
          turn_id: "turn-1",
          item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: t.prompt, text_elements: [] }] },
        });
      }
      if (!t.busy) line(t, at, "event_msg", { type: "task_complete", turn_id: "turn-1", last_agent_message: "(synthetic)" });
      if (t.name) {
        appendFileSync(join(dir, "session_index.jsonl"), `${JSON.stringify({ id: t.id, thread_name: t.name, updated_at: iso(at) })}\n`);
      }
      if (t.live !== false) start(t);
      return t;
    },
    setBusy(id, busy) {
      const t = get(id);
      if (t.rollout === false) throw new Error("a mock thread without a rollout has no turns");
      t.busy = busy;
      line(t, Date.now(), "event_msg", busy ? { type: "task_started", turn_id: "turn-n" } : { type: "task_complete", turn_id: "turn-n" });
    },
    exit(id) {
      const t = get(id);
      if (t.holder === "daemon" && t.pid !== undefined) proc.unlock(t.pid, statSync(lockPath(t)).ino);
      t.process?.kill("SIGKILL");
      t.process = undefined;
      t.pid = undefined;
      rmSync(lockPath(t), { force: true });
    },
    tui(cwd, args = []) {
      const c = dummy([bin, ...args], cwd);
      spawned.push(c);
      return handle(c);
    },
    spawn(argv, cwd, ppid) {
      const c = dummy(argv, cwd, ppid);
      spawned.push(c);
      return handle(c);
    },
    teardown() {
      for (const t of threads.values()) t.process?.kill("SIGKILL");
      daemon?.kill("SIGKILL");
      for (const p of spawned) p.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The demo's Codex cast: a busy one, an idle one, and a parked one (random ids). */
export function seedCodexDemo(mock: MockCodex): { busy: string; idle: string; parked: string } {
  const ids = { busy: mockThreadId(), idle: mockThreadId(), parked: mockThreadId() };
  mock.add({ id: ids.busy, cwd: "/home/alice/src/api-server", prompt: "Add pagination to the orders endpoint", branch: "feat/pagination", busy: true });
  mock.add({ id: ids.idle, cwd: "/home/alice/src/demo-app", name: "Tidy the landing page CSS", lastMinutesAgo: 7 });
  mock.add({ id: ids.parked, cwd: "/home/alice/src/infra", prompt: "Explain the deploy pipeline", live: false, lastMinutesAgo: 2 * 24 * 60 });
  return ids;
}
