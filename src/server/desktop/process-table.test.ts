import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessTable, parsePsList, parsePsEnv } from "./process-table.ts";
import type { Exec } from "./exec.ts";
import { fakeProcRoot as makeFakeProc, type FakeProc } from "./__fixtures__/fake-proc.ts";

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

function fakeProcRoot(procs: FakeProc[]): string {
  const p = makeFakeProc(procs);
  roots.push(p.root);
  return p.root;
}

function fakeExec(responses: Record<string, string | Error>): { exec: Exec; calls: string[] } {
  const calls: string[] = [];
  const exec: Exec = async (file, args) => {
    const key = [file, ...args].join(" ");
    calls.push(key);
    const r = responses[key];
    if (r instanceof Error) throw r;
    if (r === undefined) throw new Error(`unexpected exec ${key}`);
    return { stdout: r };
  };
  return { exec, calls };
}

describe("linux process table (/proc)", () => {
  const procRoot = () =>
    fakeProcRoot([
      { pid: 1, ppid: 0, comm: "systemd", argv: ["/sbin/init"] },
      { pid: 700, ppid: 1, comm: "kitty", argv: ["kitty"], exe: "/usr/bin/kitty" },
      { pid: 710, ppid: 700, comm: "weird ) (name", argv: ["zsh", "-l"] },
      { pid: 800, ppid: 710, comm: "herdr", argv: ["herdr"], env: { HOME: "/home/alice", A: "x=y" } },
    ]);

  it("lists processes with ppid and comm", async () => {
    const t = createProcessTable({ platform: "linux", procRoot: procRoot() });
    const list = await t.list();
    expect(list.sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 1, ppid: 0, comm: "systemd" },
      { pid: 700, ppid: 1, comm: "kitty" },
      { pid: 710, ppid: 700, comm: "weird ) (name" },
      { pid: 800, ppid: 710, comm: "herdr" },
    ]);
  });

  it("reads parent, argv, env and exe; undefined for missing processes", async () => {
    const t = createProcessTable({ platform: "linux", procRoot: procRoot() });
    expect(await t.parent(710)).toBe(700);
    expect(await t.parent(1)).toBeUndefined();
    expect(await t.argv(710)).toEqual(["zsh", "-l"]);
    expect(await t.env(800)).toEqual({ HOME: "/home/alice", A: "x=y" });
    expect(await t.exe(700)).toBe("/usr/bin/kitty");
    expect(await t.parent(4242)).toBeUndefined();
    expect(await t.argv(4242)).toBeUndefined();
    expect(await t.env(700)).toBeUndefined();
  });

  it("an absent /proc yields an empty table, not an error", async () => {
    const t = createProcessTable({ platform: "linux", procRoot: "/nonexistent-proc" });
    expect(await t.list()).toEqual([]);
  });
});

// macOS `ps` output shapes (unverified on real hardware): comm is the full
// executable path and may contain spaces; `ps -E` appends KEY=VALUE pairs.
const PS_LIST = [
  "    1     0 /sbin/launchd",
  "  700     1 /Applications/My Term.app/Contents/MacOS/My Term",
  "  710   700 -zsh",
  "  800   710 /opt/homebrew/bin/herdr",
  "  801     1 /opt/homebrew/bin/herdr",
  "",
].join("\n");

describe("darwin process table (ps)", () => {
  it("parses ps -axo pid=,ppid=,comm= including paths with spaces", () => {
    expect(parsePsList(PS_LIST)).toEqual([
      { pid: 1, ppid: 0, comm: "/sbin/launchd" },
      { pid: 700, ppid: 1, comm: "/Applications/My Term.app/Contents/MacOS/My Term" },
      { pid: 710, ppid: 700, comm: "-zsh" },
      { pid: 800, ppid: 710, comm: "/opt/homebrew/bin/herdr" },
      { pid: 801, ppid: 1, comm: "/opt/homebrew/bin/herdr" },
    ]);
  });

  it("parses the environment appended by ps -E (last occurrence wins)", () => {
    const line = "herdr --session x=1 TERM=xterm-256color HOME=/Users/alice HERDR_SOCKET_PATH=/Users/alice/h.sock\n";
    expect(parsePsEnv(line, ["herdr", "--session", "x=1"])).toEqual({
      TERM: "xterm-256color",
      HOME: "/Users/alice",
      HERDR_SOCKET_PATH: "/Users/alice/h.sock",
    });
  });

  it("uses one ps listing for list/parent/exe and ps for argv/env", async () => {
    const { exec, calls } = fakeExec({
      "ps -axww -o pid=,ppid=,comm=": PS_LIST,
      "ps -ww -o command= -p 801": "/opt/homebrew/bin/herdr server\n",
      "ps -E -ww -o command= -p 800": "herdr HOME=/Users/alice TERM=xterm\n",
      "ps -ww -o command= -p 800": "herdr\n",
    });
    const t = createProcessTable({ platform: "darwin", exec, log: () => {} });
    expect(await t.parent(710)).toBe(700);
    expect(await t.exe(700)).toBe("/Applications/My Term.app/Contents/MacOS/My Term");
    expect((await t.list()).map((p) => p.pid)).toEqual([1, 700, 710, 800, 801]);
    expect(await t.argv(801)).toEqual(["/opt/homebrew/bin/herdr", "server"]);
    expect(await t.env(800)).toEqual({ HOME: "/Users/alice", TERM: "xterm" });
    expect(calls.filter((c) => c.startsWith("ps -axww")).length).toBe(1);
  });

  it("fails soft when ps fails", async () => {
    const { exec } = fakeExec({});
    const t = createProcessTable({ platform: "darwin", exec, log: () => {} });
    expect(await t.list()).toEqual([]);
    expect(await t.parent(1)).toBeUndefined();
    expect(await t.argv(1)).toBeUndefined();
    expect(await t.env(1)).toBeUndefined();
  });

  it("other platforms get an empty table", async () => {
    const { exec, calls } = fakeExec({});
    const t = createProcessTable({ platform: "win32", exec });
    expect(await t.list()).toEqual([]);
    expect(await t.parent(1)).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
