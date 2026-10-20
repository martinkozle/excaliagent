import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  argvSessionId, assignOpenCodeLive, isOpenCodeTui, looksLikeOpenCode, openCodeSubcommand,
  scanOpenCodeProcesses, type CandidateSession, type OpenCodeProcess,
} from "./opencode-live.ts";

const BIN = "/usr/local/bin/opencode";
const A = "/home/alice/src/demo-app";
const B = "/home/alice/src/other-lib";
const sid = (n: number) => `ses_${String(n).padStart(12, "0")}abcdefghijklmn`;

describe("process classification", () => {
  it("recognises the native binary, the nix wrapper and the npm shim", () => {
    expect(looksLikeOpenCode([BIN], BIN)).toBe(true);
    expect(looksLikeOpenCode(["/nix/store/x-opencode/bin/opencode"], "/nix/store/x-opencode/bin/.opencode-wrapped")).toBe(true);
    expect(looksLikeOpenCode(["node", "/usr/lib/node_modules/opencode-ai/bin/opencode", "-s", sid(1)], "/usr/bin/node")).toBe(true);
    expect(looksLikeOpenCode(["node", "server.js"], "/usr/bin/node")).toBe(false);
    expect(looksLikeOpenCode(["vim", "opencode.json"], "/usr/bin/vim")).toBe(false);
  });

  it("the TUI is `opencode [project]` and `opencode pr`; not run, serve, attach, ...", () => {
    expect(isOpenCodeTui([BIN])).toBe(true);
    expect(isOpenCodeTui([BIN, "-s", sid(1)])).toBe(true);
    expect(isOpenCodeTui([BIN, "--model", "x/y", "/home/alice/src/demo-app"])).toBe(true);
    expect(isOpenCodeTui([BIN, "pr", "12"])).toBe(true);
    for (const sub of ["run", "serve", "web", "attach", "acp", "session", "export", "db"]) expect(isOpenCodeTui([BIN, sub])).toBe(false);
    expect(openCodeSubcommand([BIN, "--port", "4096", "serve"])).toBe("serve");
  });

  it("reads -s / --session / --session= ids, but not with --fork", () => {
    expect(argvSessionId([BIN, "-s", sid(1)])).toBe(sid(1));
    expect(argvSessionId([BIN, "--session", sid(2)])).toBe(sid(2));
    expect(argvSessionId([BIN, `--session=${sid(3)}`])).toBe(sid(3));
    expect(argvSessionId([BIN, "-s", sid(1), "--fork"])).toBeUndefined();
    expect(argvSessionId([BIN, "-s", "ses_bad"])).toBeUndefined();
    expect(argvSessionId([BIN, "-c"])).toBeUndefined();
  });

});

const proc = (pid: number, argv: string[], cwd: string | undefined, startedAt: number, ppid = 1): OpenCodeProcess => ({
  pid, ppid, argv, startedAt, ...(cwd ? { cwd } : {}),
});
const cand = (n: number, directory: string, updatedAt: number): CandidateSession => ({ id: sid(n), directory, updatedAt });

describe("assignOpenCodeLive", () => {
  const sessions = [cand(1, A, 100), cand(2, A, 300), cand(3, B, 500), cand(4, A, 50)];
  const byId = (id: string) => sessions.find((s) => s.id === id);
  const inDir = (dir: string) => sessions.filter((s) => s.directory === dir);

  it("a TUI started with -s shows that session, whenever it was last updated", () => {
    expect(assignOpenCodeLive([proc(20, [BIN, "-s", sid(4)], B, 1000)], byId, inDir)).toEqual([{ id: sid(4), pid: 20, since: 1000, exact: true }]);
  });

  it("else the newest session of its directory updated since it started", () => {
    expect(assignOpenCodeLive([proc(20, [BIN], A, 200)], byId, inDir)).toEqual([{ id: sid(2), pid: 20, since: 200, exact: false }]);
  });

  it("a TUI on its home screen (nothing updated since it started) claims nothing", () => {
    expect(assignOpenCodeLive([proc(20, [BIN], A, 400)], byId, inDir)).toEqual([]);
  });

  it("two TUIs in one directory take different sessions; an explicit -s goes first", () => {
    const procs = [proc(20, [BIN], A, 10), proc(30, [BIN, "-s", sid(2)], A, 10)];
    expect(assignOpenCodeLive(procs, byId, inDir)).toEqual([
      { id: sid(2), pid: 30, since: 10, exact: true },
      { id: sid(1), pid: 20, since: 10, exact: false },
    ]);
  });

  it("non-TUI commands and the shim's native child are not counted (the shim is)", () => {
    const procs = [proc(20, ["node", "/x/bin/opencode"], A, 10), proc(21, [BIN], A, 10, 20), proc(22, [BIN, "serve"], B, 10)];
    expect(assignOpenCodeLive(procs, byId, inDir)).toEqual([{ id: sid(2), pid: 20, since: 10, exact: false }]);
  });

  it("a TUI that names its session never falls back to the directory rule (unknown or already taken)", () => {
    expect(assignOpenCodeLive([proc(20, [BIN, "-s", sid(9)], B, 10)], byId, inDir)).toEqual([]);
    const procs = [proc(20, [BIN, "-s", sid(3)], B, 10, 1), proc(30, [BIN, "-s", sid(3)], B, 20, 1)];
    expect(assignOpenCodeLive(procs, byId, inDir)).toEqual([{ id: sid(3), pid: 30, since: 20, exact: true }]);
  });

  it("orders TUIs by start time, not pid (pids wrap)", () => {
    const procs = [proc(900, [BIN], A, 100), proc(20, [BIN], A, 120)];
    expect(assignOpenCodeLive(procs, byId, inDir)).toEqual([
      { id: sid(2), pid: 20, since: 120, exact: false },
      { id: sid(1), pid: 900, since: 100, exact: false },
    ]);
  });
});

describe("scanOpenCodeProcesses (fake /proc)", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("is undefined without /proc", async () => {
    expect(await scanOpenCodeProcesses("/nonexistent-proc")).toBeUndefined();
  });

  it("lists OpenCode processes with argv, cwd and start time", async () => {
    root = await mkdtemp(join(tmpdir(), "excaliagent-proc-"));
    await writeFile(join(root, "stat"), "cpu 1 2 3\nbtime 1792400000\nprocesses 5\n");
    const fake = async (pid: number, comm: string, argv: string[], exe: string, cwd: string) => {
      const d = join(root!, String(pid));
      await mkdir(d, { recursive: true });
      await writeFile(join(d, "stat"), `${pid} (${comm}) S 7 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0`);
      await writeFile(join(d, "cmdline"), argv.join("\0") + "\0");
      await symlink(exe, join(d, "exe"));
      await symlink(cwd, join(d, "cwd"));
    };
    await fake(20, ".opencode-wrapp", ["/nix/store/x/bin/opencode", "-s", sid(1)], "/nix/store/x/bin/.opencode-wrapped", A);
    await fake(21, "MainThread", ["node", "/x/bin/opencode"], "/usr/bin/node", B);
    await fake(22, "MainThread", ["node", "server.js"], "/usr/bin/node", B);
    await fake(23, "bash", ["bash"], "/usr/bin/bash", A);
    const procs = await scanOpenCodeProcesses(root);
    expect(procs!.sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 20, ppid: 7, argv: ["/nix/store/x/bin/opencode", "-s", sid(1)], cwd: A, startedAt: (1792400000 + 123.45) * 1000 },
      { pid: 21, ppid: 7, argv: ["node", "/x/bin/opencode"], cwd: B, startedAt: (1792400000 + 123.45) * 1000 },
    ]);
  });
});
