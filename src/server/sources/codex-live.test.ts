import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  argvThreadId, assignLive, codexSubcommand, isDaemon, isTui, looksLikeCodex, parseProcLocks, scanCodexProcesses,
  type CodexProcess, type HeldLock,
} from "./codex-live.ts";
import { tid } from "./__fixtures__/codex-seed.ts";

const BIN = "/opt/codex/bin/codex";
const DAEMON = [BIN, "app-server", "--listen", "unix://", "--analytics-default-enabled", "--managed-daemon"];
const A = "/home/alice/src/demo-app";
const B = "/home/alice/src/other-lib";

describe("process classification", () => {
  it("recognises the native binary and the npm shim, nothing else", () => {
    expect(looksLikeCodex([BIN], undefined)).toBe(true);
    expect(looksLikeCodex(["codex"], "/nix/store/x-codex-0.163.0/libexec/codex/bin/codex")).toBe(true);
    expect(looksLikeCodex(["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"], "/usr/bin/node")).toBe(true);
    expect(looksLikeCodex(["codex-linux-sandbox", "--"], "/x/codex-linux-sandbox")).toBe(false);
    expect(looksLikeCodex(["node", "server.js"], "/usr/bin/node")).toBe(false);
    expect(looksLikeCodex(["vim", "codex.md"], "/usr/bin/vim")).toBe(false);
  });

  it("finds the subcommand past options and their values", () => {
    expect(codexSubcommand([BIN])).toBeUndefined();
    expect(codexSubcommand([BIN, "-m", "gpt-x", "-C", "/w", "resume", tid(1)])).toBe("resume");
    expect(codexSubcommand([BIN, "--yolo", "fix the bug"])).toBe("fix the bug");
    expect(codexSubcommand(["node", "/x/codex.js", "exec", "hi"])).toBe("exec");
    expect(isDaemon(DAEMON)).toBe(true);
    expect(isDaemon([BIN, "resume"])).toBe(false);
  });

  it("TUIs are plain codex, a prompt, resume and fork; not exec, review, mcp, ...", () => {
    expect(isTui([BIN])).toBe(true);
    expect(isTui([BIN, "fix the bug"])).toBe(true);
    expect(isTui([BIN, "resume", "--last"])).toBe(true);
    expect(isTui([BIN, "fork", tid(1)])).toBe(true);
    for (const sub of ["exec", "e", "review", "app-server", "mcp-server", "login", "agents"]) expect(isTui([BIN, sub])).toBe(false);
  });

  it("reads the thread id of `codex resume <id>` only", () => {
    expect(argvThreadId([BIN, "resume", tid(7).toUpperCase()])).toBe(tid(7));
    expect(argvThreadId([BIN, "-c", "x=1", "resume", "--all", tid(7)])).toBe(tid(7));
    expect(argvThreadId([BIN, "fork", tid(7)])).toBeUndefined();
    expect(argvThreadId([BIN, "resume", "my-name"])).toBeUndefined();
    expect(argvThreadId([BIN, tid(7)])).toBeUndefined();
  });
});

describe("parseProcLocks", () => {
  it("maps inodes to holder pids and ignores waiters", () => {
    const text = [
      "1: POSIX  ADVISORY  WRITE 812 00:1a:4401 0 EOF",
      "94: FLOCK  ADVISORY  WRITE 186770 00:22:4676584 0 EOF",
      "94: -> FLOCK  ADVISORY  WRITE 999 00:22:4676584 0 EOF",
      "95: OFDLCK ADVISORY  READ  -1 00:22:77 0 EOF",
      "garbage",
    ].join("\n");
    expect(Object.fromEntries(parseProcLocks(text))).toEqual({ 4401: [812], 4676584: [186770] });
  });
});

const lock = (n: number, pid: number, loadedAt = n): HeldLock => ({ threadId: tid(n), pid, loadedAt });
const proc = (pid: number, argv: string[], cwd?: string, ppid = 1, startedAt = pid): CodexProcess => ({
  pid, ppid, argv, startedAt, ...(cwd ? { cwd } : {}),
});

describe("assignLive", () => {
  it("a thread held in-process (codex exec, or a TUI without the daemon) is live in its holder", () => {
    expect(assignLive([lock(1, 50)], [proc(50, [BIN, "exec", "hi"], A)], () => A)).toEqual([{ threadId: tid(1), pid: 50, exact: true }]);
  });

  it("locks held by something that is not a known Codex process are ignored", () => {
    expect(assignLive([lock(1, 50)], [], () => A)).toEqual([]);
  });

  it("a daemon thread is live in the TUI that resumed it by id", () => {
    const procs = [proc(10, DAEMON, "/"), proc(20, [BIN, "resume", tid(1)], B)];
    expect(assignLive([lock(1, 10), lock(2, 10, 99)], procs, (id) => (id === tid(1) ? A : B))).toEqual([
      { threadId: tid(1), pid: 20, cwd: B, exact: true },
    ]);
  });

  it("else a TUI claims the newest loaded thread from its own directory (or one with no rollout yet)", () => {
    const procs = [proc(10, DAEMON, "/"), proc(20, [BIN], A), proc(30, [BIN], B)];
    const cwd = (id: string) => ({ [tid(1)]: A, [tid(2)]: A, [tid(3)]: B })[id];
    const live = assignLive([lock(1, 10, 100), lock(2, 10, 200), lock(3, 10, 50), lock(4, 10, 300)], procs, cwd);
    // TUI 30 (started last) in B: tid(4) has no rollout yet and is newer than tid(3).
    expect(live).toEqual([
      { threadId: tid(4), pid: 30, cwd: B, exact: false },
      { threadId: tid(2), pid: 20, cwd: A, exact: false },
    ]);
  });

  it("daemon threads no TUI claims are lingering, not live (the daemon unloads them ~30 min later)", () => {
    expect(assignLive([lock(1, 10)], [proc(10, DAEMON, "/")], () => A)).toEqual([]);
    expect(assignLive([lock(1, 10)], [proc(10, DAEMON, "/"), proc(20, [BIN], B)], () => A)).toEqual([]);
  });

  it("sub-agent and other non-user threads are never claimed", () => {
    const procs = [proc(10, DAEMON, "/"), proc(20, [BIN], A)];
    expect(assignLive([lock(1, 10, 200), lock(2, 10, 100)], procs, () => A, (id) => id !== tid(1))).toEqual([
      { threadId: tid(2), pid: 20, cwd: A, exact: false },
    ]);
  });

  it("the npm shim and its native child count as one TUI (the shim, the pane's foreground)", () => {
    const procs = [proc(10, DAEMON, "/"), proc(20, ["node", "/x/codex.js"], A), proc(21, [BIN], A, 20)];
    expect(assignLive([lock(1, 10), lock(2, 10)], procs, () => A)).toEqual([{ threadId: tid(2), pid: 20, cwd: A, exact: false }]);
  });

  it("orders TUIs by start time, not pid (pids wrap)", () => {
    const procs = [proc(10, DAEMON, "/"), proc(900, [BIN], A, 1, 100), proc(20, [BIN], A, 1, 500)];
    expect(assignLive([lock(1, 10, 1), lock(2, 10, 2)], procs, () => A)).toEqual([
      { threadId: tid(2), pid: 20, cwd: A, exact: false },
      { threadId: tid(1), pid: 900, cwd: A, exact: false },
    ]);
  });

  it("a TUI that names its thread never falls back to guessing by directory", () => {
    const procs = [proc(10, DAEMON, "/"), proc(20, [BIN, "resume", tid(9)], A)];
    expect(assignLive([lock(1, 10)], procs, () => A)).toEqual([]);
  });

  it("non-TUI subcommands never claim daemon threads", () => {
    const procs = [proc(10, DAEMON, "/"), proc(20, [BIN, "exec", "x"], A), proc(21, [BIN, "mcp-server"], A)];
    expect(assignLive([lock(1, 10)], procs, () => A)).toEqual([]);
  });
});

describe("scanCodexProcesses (fake /proc)", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function fakeProc(p: { pid: number; ppid?: number; comm: string; argv: string[]; exe?: string; cwd?: string; fds?: string[] }) {
    const dir = join(root!, "proc", String(p.pid));
    await mkdir(join(dir, "fd"), { recursive: true });
    await writeFile(join(dir, "stat"), `${p.pid} (${p.comm}) S ${p.ppid ?? 1} ${p.pid} ${p.pid} 0 -1`);
    await writeFile(join(dir, "cmdline"), p.argv.join("\0") + "\0");
    if (p.exe) await symlink(p.exe, join(dir, "exe"));
    if (p.cwd) await symlink(p.cwd, join(dir, "cwd"));
    for (const [i, f] of (p.fds ?? []).entries()) await symlink(f, join(dir, "fd", String(i + 3)));
  }

  async function setup() {
    root = await mkdtemp(join(tmpdir(), "excaliagent-proc-"));
    const lockDir = join(root, "codex", "thread-writer-locks");
    await mkdir(lockDir, { recursive: true });
    const lockFile = (n: number) => join(lockDir, `${tid(n)}.lock`);
    for (const n of [1, 2, 3]) await writeFile(lockFile(n), "");
    await writeFile(join(lockDir, ".coordination.lock"), "");
    const ino = async (n: number) => (await stat(lockFile(n))).ino;
    return { lockDir, lockFile, ino };
  }

  it("returns undefined without /proc/locks (not Linux)", async () => {
    root = await mkdtemp(join(tmpdir(), "excaliagent-proc-"));
    expect(await scanCodexProcesses(join(root, "locks-dir"), join(root, "proc"))).toBeUndefined();
  });

  it("reads nothing else when there are no lock files", async () => {
    root = await mkdtemp(join(tmpdir(), "excaliagent-proc-"));
    await mkdir(join(root, "proc"), { recursive: true });
    await writeFile(join(root, "proc", "locks"), "");
    await fakeProc({ pid: 20, comm: "codex", argv: [BIN], cwd: A });
    expect(await scanCodexProcesses(join(root, "nothing"), join(root, "proc"))).toEqual({ locks: [], procs: [] });
  });

  it("finds held locks (holder confirmed via its fds) and, for the daemon, the TUIs", async () => {
    const { lockDir, lockFile, ino } = await setup();
    await mkdir(join(root!, "proc"), { recursive: true });
    await writeFile(
      join(root!, "proc", "locks"),
      [
        `1: FLOCK  ADVISORY  WRITE 10 00:22:${await ino(1)} 0 EOF`,
        // Held by a pid without the file open (stale inode reuse): ignored.
        `2: FLOCK  ADVISORY  WRITE 10 00:22:${await ino(2)} 0 EOF`,
        // Held by something that is not Codex: ignored.
        `3: FLOCK  ADVISORY  WRITE 40 00:22:${await ino(3)} 0 EOF`,
      ].join("\n"),
    );
    await fakeProc({ pid: 10, comm: "codex", argv: DAEMON, exe: BIN, cwd: "/", fds: [lockFile(1), "/dev/null"] });
    await fakeProc({ pid: 20, ppid: 5, comm: "codex", argv: [BIN], exe: BIN, cwd: A });
    await fakeProc({ pid: 40, comm: "flock", argv: ["flock", lockFile(3)], exe: "/usr/bin/flock", fds: [lockFile(3)] });
    await fakeProc({ pid: 41, comm: "bash", argv: ["bash"], exe: "/usr/bin/bash", cwd: A });
    const scan = await scanCodexProcesses(lockDir, join(root!, "proc"));
    expect(scan!.locks).toEqual([{ threadId: tid(1), pid: 10, loadedAt: expect.any(Number) }]);
    expect(scan!.procs.map((p) => [p.pid, p.ppid, p.cwd]).sort()).toEqual([[10, 1, "/"], [20, 5, A]]);
    // Start times from <procRoot>/stat btime + ticks (here: no stat file → unknown, 0).
    expect(scan!.procs.every((p) => p.startedAt === 0)).toBe(true);
  });

  it("skips the process scan when no daemon holds a lock", async () => {
    const { lockDir, lockFile, ino } = await setup();
    await mkdir(join(root!, "proc"), { recursive: true });
    await writeFile(join(root!, "proc", "locks"), `1: FLOCK  ADVISORY  WRITE 50 00:22:${await ino(1)} 0 EOF`);
    await fakeProc({ pid: 50, comm: "codex", argv: [BIN, "exec", "x"], exe: BIN, cwd: A, fds: [lockFile(1)] });
    await fakeProc({ pid: 20, comm: "codex", argv: [BIN], exe: BIN, cwd: A });
    const scan = await scanCodexProcesses(lockDir, join(root!, "proc"));
    expect(scan!.locks.map((l) => l.pid)).toEqual([50]);
    expect(scan!.procs.map((p) => p.pid)).toEqual([50]);
  });
});
