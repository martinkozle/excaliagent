import { appendFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types.ts";
import { codexResumeCommand, createCodexSource, defaultCodexDir, uuidV7Ms } from "./codex.ts";
import type { CodexProcScan } from "./codex-live.ts";
import {
  complete, CX_ALICE, CX_BOB, meta, seedCodexHome, started, tid, userItem, type SeededCodexHome,
} from "./__fixtures__/codex-seed.ts";

const silent = (): void => {};
const BIN = "/opt/codex/bin/codex";
const DAEMON = [BIN, "app-server", "--listen", "unix://", "--managed-daemon"];
let home: SeededCodexHome | undefined;
afterEach(async () => {
  await home?.cleanup();
  home = undefined;
});

/** tid(1): busy, named; tid(2): idle; tid(3): parked; tid(4): a sub-agent; tid(5): an exec run. */
async function standard(scan: CodexProcScan | undefined, extra: Partial<Parameters<typeof createCodexSource>[0]> = {}) {
  home = await seedCodexHome({
    rollouts: [
      { id: tid(1), lines: [meta(tid(1), CX_ALICE), started("2026-10-20T10:00:01.000Z"), userItem("2026-10-20T10:00:01.000Z", "Fix login")] },
      {
        id: tid(2),
        lines: [meta(tid(2), CX_BOB, { git: {} }), started("2026-10-20T09:00:01.000Z"), userItem("2026-10-20T09:00:01.000Z", "Write docs"), complete("2026-10-20T09:10:00.000Z")],
        mtimeMs: Date.parse("2026-10-20T09:10:00.000Z"),
      },
      {
        id: tid(3),
        day: "2026/10/18",
        stamp: "2026-10-18T08-00-00",
        lines: [meta(tid(3), CX_ALICE, { git: { branch: "old-branch" } }), userItem("2026-10-18T08:00:01.000Z", "Parked idea"), complete("2026-10-18T08:30:00.000Z")],
        mtimeMs: Date.parse("2026-10-18T08:30:00.000Z"),
      },
      { id: tid(4), lines: [meta(tid(4), CX_ALICE, { thread_source: "subagent", parent_thread_id: tid(1) })] },
      { id: tid(5), lines: [meta(tid(5), CX_ALICE, { source: "exec" })] },
    ],
    index: [{ id: tid(1), thread_name: "Login fix", updated_at: "x" }],
  });
  return createCodexSource({ codexDir: home.dir, scan: async () => scan, log: silent, ...extra });
}

const daemonScan = (locks: Array<[number, number]>, tuis: CodexProcScan["procs"]): CodexProcScan => ({
  locks: locks.map(([n, loadedAt]) => ({ threadId: tid(n), pid: 10, loadedAt })),
  procs: [{ pid: 10, ppid: 1, startedAt: 0, argv: DAEMON, cwd: "/" }, ...tuis],
});

describe("codex source", () => {
  it("lists threads a TUI shows: busy while a turn is open, named from session_index", async () => {
    const src = await standard(
      daemonScan([[1, 1], [2, 2]], [
        { pid: 20, ppid: 1, startedAt: 0, argv: [BIN, "resume", tid(1)], cwd: CX_ALICE },
        { pid: 30, ppid: 1, startedAt: 0, argv: [BIN], cwd: CX_BOB },
      ]),
    );
    const list = await src.list();
    expect(list).toEqual<Session[]>([
      {
        id: tid(1), source: "codex", cwd: CX_ALICE, repo: "demo-app", branch: "main", title: "Login fix", status: "busy",
        lastActivityAt: Date.parse("2026-10-20T10:00:01.000Z"), cacheTtlMs: 0, cacheExpiresAt: 0, live: true, pid: 20,
        prLinks: [], resumeCommand: `codex resume ${tid(1)}`, canEnd: true,
      },
      {
        id: tid(2), source: "codex", cwd: CX_BOB, repo: "other-lib", title: "Write docs", status: "idle",
        lastActivityAt: Date.parse("2026-10-20T09:10:00.000Z"), cacheTtlMs: 0, cacheExpiresAt: 0, live: true, pid: 30,
        prLinks: [], resumeCommand: `codex resume ${tid(2)}`,
      },
    ]);
  });

  it("a thread the daemon still holds but no TUI shows is not live", async () => {
    const src = await standard(daemonScan([[1, 1], [2, 2]], [{ pid: 20, ppid: 1, startedAt: 0, argv: [BIN], cwd: CX_ALICE }]));
    expect((await src.list()).map((s) => [s.id, s.pid])).toEqual([[tid(1), 20]]);
  });

  it("a fresh thread with no rollout yet takes its TUI's directory", async () => {
    const src = await standard(daemonScan([[9, 5]], [{ pid: 20, ppid: 1, startedAt: 0, argv: [BIN], cwd: CX_BOB }]));
    expect(await src.list()).toMatchObject([{ id: tid(9), cwd: CX_BOB, repo: "other-lib", status: "idle", live: true, pid: 20 }]);
  });

  it("a fresh thread with no rollout yet dates from its v7 id, never from the epoch", async () => {
    const src = await standard(daemonScan([[9, 5]], [{ pid: 20, ppid: 1, startedAt: 0, argv: [BIN], cwd: CX_BOB }]));
    expect((await src.list())[0]!.lastActivityAt).toBe(uuidV7Ms(tid(9)));
  });

  it("a live rollout without line timestamps dates from its mtime", async () => {
    const mtimeMs = Date.parse("2026-10-20T13:00:00.000Z");
    home = await seedCodexHome({
      rollouts: [{ id: tid(7), lines: [{ type: "session_meta", payload: { id: tid(7), cwd: CX_BOB, source: "vscode" } }], mtimeMs }],
    });
    const src = createCodexSource({
      codexDir: home.dir,
      scan: async () => daemonScan([[7, 1]], [{ pid: 30, ppid: 1, startedAt: 0, argv: [BIN, "resume", tid(7)], cwd: CX_BOB }]),
      log: silent,
    });
    expect((await src.list())[0]).toMatchObject({ id: tid(7), live: true, lastActivityAt: mtimeMs });
  });

  it("no live sessions when liveness is unknown (no /proc)", async () => {
    const src = await standard(undefined);
    expect(await src.list()).toEqual([]);
  });

  it("the picker lists parked user threads, newest first, with their recorded branch; not live, sub-agent or exec ones", async () => {
    const src = await standard(daemonScan([[1, 1]], [{ pid: 20, ppid: 1, startedAt: 0, argv: [BIN], cwd: CX_ALICE }]));
    const dormant = await src.listDormant();
    expect(dormant.map((s) => [s.id, s.title, s.status, s.live, s.branch])).toEqual([
      [tid(2), "Write docs", "dormant", false, undefined],
      [tid(3), "Parked idea", "dormant", false, "old-branch"],
    ]);
    expect(dormant[1]!.lastActivityAt).toBe(Date.parse("2026-10-18T08:30:00.000Z"));
    expect(dormant[1]!.resumeCommand).toBe(`codex resume ${tid(3)}`);
  });

  it("get finds live and dormant threads by id, case-insensitively; refuses other ids", async () => {
    const src = await standard(daemonScan([[1, 1]], [{ pid: 20, ppid: 1, startedAt: 0, argv: [BIN], cwd: CX_ALICE }]));
    expect((await src.get(tid(1)))?.live).toBe(true);
    expect((await src.get(tid(3).toUpperCase()))?.status).toBe("dormant");
    expect(await src.get(tid(99))).toBeUndefined();
    expect(await src.get("../../etc/passwd")).toBeUndefined();
    expect(await src.get("0a1b2c3d-0000-4000-8000-000000000001")).toBeUndefined();
  });

  it("follows appended turns", async () => {
    const src = await standard(daemonScan([[2, 1]], [{ pid: 30, ppid: 1, startedAt: 0, argv: [BIN], cwd: CX_BOB }]), { cacheMs: 0 });
    expect((await src.list())[0]!.status).toBe("idle");
    await appendFile(home!.rolloutPath(tid(2)), JSON.stringify(started("2026-10-20T11:00:00.000Z")) + "\n");
    expect((await src.list())[0]).toMatchObject({ status: "busy", lastActivityAt: Date.parse("2026-10-20T11:00:00.000Z") });
  });

  it("end sends SIGTERM to the TUI, only when it is still a Codex session process", async () => {
    const kill = vi.fn();
    let isTui = true;
    const src = await standard(daemonScan([[1, 1]], [{ pid: 20, ppid: 1, startedAt: 0, argv: [BIN, "resume", tid(1)], cwd: CX_ALICE }]), {
      kill,
      isCodexSessionProcess: async () => isTui,
    });
    expect(await src.end!(tid(3))).toBe("not-live");
    expect(await src.end!("x; rm -rf ~")).toBe("not-live");
    isTui = false;
    expect(await src.end!(tid(1))).toBe("not-live");
    isTui = true;
    expect(await src.end!(tid(1))).toBe("ended");
    expect(kill).toHaveBeenCalledExactlyOnceWith(20, "SIGTERM");
  });

  it("a thread matched only by directory cannot be stopped (no guess ever gets a SIGTERM)", async () => {
    const kill = vi.fn();
    const src = await standard(daemonScan([[1, 1]], [{ pid: 20, ppid: 1, startedAt: 0, argv: [BIN], cwd: CX_ALICE }]), {
      kill,
      isCodexSessionProcess: async () => true,
    });
    expect((await src.list())[0]).toMatchObject({ id: tid(1), live: true });
    expect((await src.list())[0]!.canEnd).toBeUndefined();
    expect(await src.end!(tid(1))).toBe("unsupported");
    expect(kill).not.toHaveBeenCalled();
  });

  it("one look at processes is shared by list, listDormant and get for cacheMs", async () => {
    const scan = vi.fn(async () => daemonScan([[1, 1]], [{ pid: 20, ppid: 1, startedAt: 0, argv: [BIN], cwd: CX_ALICE }]));
    const src = await standard(undefined, { scan, cacheMs: 60_000 });
    await src.list();
    await src.listDormant();
    await src.get(tid(1));
    await src.get(tid(3));
    expect(scan).toHaveBeenCalledOnce();
  });

  it("watch reports changes", async () => {
    let scan = daemonScan([], []);
    const src = await standard(undefined, { scan: async () => scan, pollMs: 20, debounceMs: 5 });
    const seen: string[][] = [];
    const stop = src.watch((s) => seen.push(s.map((x) => x.id)));
    await vi.waitFor(() => expect(seen).toEqual([[]]));
    scan = daemonScan([[2, 1]], [{ pid: 30, ppid: 1, startedAt: 0, argv: [BIN], cwd: CX_BOB }]);
    await vi.waitFor(() => expect(seen.at(-1)).toEqual([tid(2)]));
    stop();
  });
});

describe("helpers", () => {
  it("resume command and default home", () => {
    expect(codexResumeCommand(tid(1))).toBe(`codex resume ${tid(1)}`);
    expect(defaultCodexDir({ CODEX_HOME: "/x/codex" })).toBe("/x/codex");
    expect(defaultCodexDir({})).toMatch(/\.codex$/);
  });
  it("reads the creation time of a v7 id", () => {
    expect(uuidV7Ms("01a15935-e3d1-71c2-9d74-39d8c583eef0")).toBe(Date.parse("2026-10-20T12:07:46.385Z"));
    expect(uuidV7Ms("0a1b2c3d-0000-4000-8000-000000000001")).toBeUndefined();
  });
});
