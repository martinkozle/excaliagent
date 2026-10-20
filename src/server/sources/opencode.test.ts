import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockOpenCode, type MockOpenCode } from "../../../test/mock-opencode.ts";
import { createMockProc } from "../../../test/mock-proc.ts";
import type { OpenCodeProcess } from "./opencode-live.ts";
import {
  createOpenCodeSource, defaultOpenCodeDataDir, defaultOpenCodeDbPath, isDefaultTitle, openCodeSession, openCodeStatus,
  type OpenCodeSourceOptions,
} from "./opencode.ts";

const silent = (): void => {};
const BIN = "/usr/local/bin/opencode";
const A = "/home/alice/src/demo-app";
const B = "/home/alice/src/other-lib";
const sid = (n: number) => `ses_${String(n).padStart(12, "0")}abcdefghijklmn`;

let mock: MockOpenCode | undefined;
let procDir: string | undefined;
afterEach(() => {
  mock?.teardown();
  mock = undefined;
  if (procDir) rmSync(procDir, { recursive: true, force: true });
  procDir = undefined;
});

/** sid(1) in A (titled), sid(2) in B (default title), sid(3) in A, older. All dormant in the db (no processes). */
function seeded(procs: OpenCodeProcess[] | undefined, extra: Partial<OpenCodeSourceOptions> = {}) {
  // Only dormant sessions here (no processes); the scan is injected.
  procDir = mkdtempSync(join(tmpdir(), "excaliagent-proc-"));
  mock = createMockOpenCode(createMockProc(procDir));
  mock.add({ id: sid(1), directory: A, title: "Fix the login form", live: false, lastMinutesAgo: 2 });
  mock.add({ id: sid(2), directory: B, live: false, lastMinutesAgo: 30 });
  mock.add({ id: sid(3), directory: A, title: "Older idea", live: false, lastMinutesAgo: 600 });
  return createOpenCodeSource({ dataDir: mock.dir, scan: async () => procs, log: silent, cacheMs: 0, ...extra });
}

const tui = (pid: number, argv: string[], cwd: string, startedAt = Date.now() - 3_600_000): OpenCodeProcess => ({
  pid, ppid: 1, argv: [BIN, ...argv], cwd, startedAt,
});

describe("opencode source", () => {
  it("lists the sessions running TUIs show, idle when the last reply finished", async () => {
    const src = seeded([tui(20, [], A), tui(30, ["-s", sid(2)], "/")]);
    const list = await src.list();
    expect(list.map((s) => [s.id, s.status, s.pid, s.title, s.repo, s.live])).toEqual([
      [sid(1), "idle", 20, "Fix the login form", "demo-app", true],
      [sid(2), "idle", 30, undefined, "other-lib", true],
    ]);
    expect(list[0]).toMatchObject({ source: "opencode", cwd: A, resumeCommand: `opencode -s ${sid(1)}`, cacheExpiresAt: 0, prLinks: [] });
  });

  it("busy while a prompt waits or a reply is unfinished", async () => {
    const src = seeded([tui(20, [], A)]);
    mock!.setBusy(sid(1), true);
    expect((await src.list())[0]!.status).toBe("busy");
    mock!.setBusy(sid(1), false);
    expect((await src.list())[0]!.status).toBe("idle");
  });

  it("no live sessions when liveness is unknown (no /proc) or no TUI runs", async () => {
    expect(await seeded(undefined).list()).toEqual([]);
    mock!.teardown();
    expect(await seeded([]).list()).toEqual([]);
  });

  it("the picker lists the others, newest first", async () => {
    const src = seeded([tui(20, [], A)]);
    expect((await src.listDormant()).map((s) => [s.id, s.status, s.live])).toEqual([
      [sid(2), "dormant", false],
      [sid(3), "dormant", false],
    ]);
  });

  it("get finds live and dormant sessions; refuses other ids", async () => {
    const src = seeded([tui(20, [], A)]);
    expect((await src.get(sid(1)))?.live).toBe(true);
    expect((await src.get(sid(3)))?.status).toBe("dormant");
    expect(await src.get(sid(9))).toBeUndefined();
    expect(await src.get("0a1b2c3d-0000-4000-8000-000000000001")).toBeUndefined();
    expect(await src.get("ses_x'; drop table session; --")).toBeUndefined();
  });

  it("a missing database is no sessions", async () => {
    const src = createOpenCodeSource({ dataDir: "/nonexistent/opencode", scan: async () => [], log: silent });
    expect(await src.listDormant()).toEqual([]);
  });

  it("only a TUI started on the session (-s) is offered Stop; a directory match is unsupported", async () => {
    const kill = vi.fn();
    const src = seeded([tui(20, [], A), tui(30, ["-s", sid(2)], "/")], { kill, isOpenCodeTui: async () => true });
    const [one, two] = await src.list();
    expect([one!.id, one!.canEnd]).toEqual([sid(1), undefined]);
    expect([two!.id, two!.canEnd]).toEqual([sid(2), true]);
    expect(await src.end!(sid(1))).toBe("unsupported");
    expect(kill).not.toHaveBeenCalled();
  });

  it("rows whose id is not a valid OpenCode id are dropped before any session or command", async () => {
    const src = seeded([tui(20, [], A)]);
    mock!.add({ id: "ses_bad'; rm -rf ~", directory: B, title: "Bad", live: false, lastMinutesAgo: 1 });
    const all = [...(await src.list()), ...(await src.listDormant())];
    expect(all.map((s) => s.title)).not.toContain("Bad");
    expect(all.every((s) => /^opencode -s ses_[0-9a-zA-Z]{26}$/.test(s.resumeCommand!))).toBe(true);
  });

  it("one look at processes and the database is shared by list, listDormant and get for cacheMs", async () => {
    const scan = vi.fn(async () => [tui(20, [], A)]);
    const src = seeded(undefined, { scan, cacheMs: 60_000 });
    await src.list();
    await src.listDormant();
    await src.get(sid(1));
    await src.get(sid(3));
    expect(scan).toHaveBeenCalledOnce();
  });

  it("end sends SIGTERM to the TUI, only while it is still an OpenCode TUI", async () => {
    const kill = vi.fn();
    let isTui = true;
    const src = seeded([tui(20, ["-s", sid(1)], A)], { kill, isOpenCodeTui: async () => isTui });
    expect(await src.end!(sid(3))).toBe("not-live");
    isTui = false;
    expect(await src.end!(sid(1))).toBe("not-live");
    isTui = true;
    expect(await src.end!(sid(1))).toBe("ended");
    expect(kill).toHaveBeenCalledExactlyOnceWith(20, "SIGTERM");
  });

  it("watch reports changes", async () => {
    let procs: OpenCodeProcess[] = [];
    const src = seeded(undefined, { scan: async () => procs, pollMs: 20 });
    const seen: string[][] = [];
    const stop = src.watch((s) => seen.push(s.map((x) => x.id)));
    await vi.waitFor(() => expect(seen).toEqual([[]]));
    procs = [tui(30, ["-s", sid(3)], A)];
    await vi.waitFor(() => expect(seen.at(-1)).toEqual([sid(3)]));
    stop();
  });
});

describe("helpers", () => {
  it("status counts only messages since the TUI started", () => {
    expect(openCodeStatus(undefined, 0)).toBe("idle");
    expect(openCodeStatus({ role: "user", completed: null, created: 10 }, 5)).toBe("busy");
    expect(openCodeStatus({ role: "assistant", completed: null, created: 10 }, 5)).toBe("busy");
    expect(openCodeStatus({ role: "assistant", completed: 12, created: 10 }, 5)).toBe("idle");
    // A reply left unfinished by a crash before this TUI started.
    expect(openCodeStatus({ role: "assistant", completed: null, created: 1 }, 5)).toBe("idle");
  });

  it("activity time: time_updated (epoch ms), else time_created, else 0 (never a non-number)", () => {
    const row = { id: "ses_x", directory: "/home/alice/src/demo-app", title: "t", parent_id: null, time_archived: null };
    expect(openCodeSession({ ...row, time_updated: 1_792_498_206_499, time_created: 1_792_498_203_192 }, {}).lastActivityAt).toBe(1_792_498_206_499);
    expect(openCodeSession({ ...row, time_updated: 0, time_created: 1_792_498_203_192 }, {}).lastActivityAt).toBe(1_792_498_203_192);
    const bad = { ...row, time_updated: null, time_created: "x" } as unknown as Parameters<typeof openCodeSession>[0];
    expect(openCodeSession(bad, {}).lastActivityAt).toBe(0);
  });

  it("default titles", () => {
    expect(isDefaultTitle("New session - 2026-10-20T12:13:48.177Z")).toBe(true);
    expect(isDefaultTitle("Child session - 2026-10-20T12:13:48.177Z")).toBe(true);
    expect(isDefaultTitle("New session ideas")).toBe(false);
  });

  it("data dir and database path", () => {
    expect(defaultOpenCodeDataDir({ XDG_DATA_HOME: "/x/data" })).toBe("/x/data/opencode");
    expect(defaultOpenCodeDataDir({})).toMatch(/\.local\/share\/opencode$/);
    expect(defaultOpenCodeDbPath("/d", {})).toBe("/d/opencode.db");
    expect(defaultOpenCodeDbPath("/d", { OPENCODE_DB: "other.db" })).toBe("/d/other.db");
    expect(defaultOpenCodeDbPath("/d", { OPENCODE_DB: "/abs/x.db" })).toBe("/abs/x.db");
  });
});
