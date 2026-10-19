import { afterEach, describe, expect, it } from "vitest";
import { createProcessTable } from "../desktop/process-table.ts";
import type { Exec } from "../desktop/exec.ts";
import { fakeProcRoot, type FakeProc } from "../desktop/__fixtures__/fake-proc.ts";
import { findHerdrClientPids, herdrSocketPath } from "./herdr-clients.ts";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function linux(procs: Omit<FakeProc, "ppid">[]) {
  const p = fakeProcRoot(procs.map((x) => ({ ppid: 1, ...x })));
  cleanups.push(p.cleanup);
  return createProcessTable({ platform: "linux", procRoot: p.root });
}

const SOCK = "/home/alice/.config/herdr/herdr.sock";

describe("herdrSocketPath", () => {
  it("is HERDR_SOCKET_PATH, else $XDG_CONFIG_HOME/herdr/herdr.sock, else ~/.config/herdr/herdr.sock", () => {
    expect(herdrSocketPath({ HERDR_SOCKET_PATH: "/x.sock", XDG_CONFIG_HOME: "/c" }, "/home/a")).toBe("/x.sock");
    expect(herdrSocketPath({ XDG_CONFIG_HOME: "/c" }, "/home/a")).toBe("/c/herdr/herdr.sock");
    expect(herdrSocketPath({ HOME: "/home/b" }, "/home/a")).toBe("/home/b/.config/herdr/herdr.sock");
    expect(herdrSocketPath({}, "/home/a")).toBe("/home/a/.config/herdr/herdr.sock");
    expect(herdrSocketPath({})).toBeUndefined();
  });
});

describe("findHerdrClientPids (linux /proc)", () => {
  it("finds herdr client processes and skips the server and other processes", async () => {
    const table = linux([
      { pid: 700, comm: "herdr", argv: ["herdr"], env: { HOME: "/home/alice" } },
      { pid: 701, comm: "herdr", argv: ["/opt/herdr/bin/herdr", "server"], env: { HOME: "/home/alice" } },
      { pid: 702, comm: "zsh", argv: ["herdr"] },
      { pid: 703, comm: "kitty", argv: ["kitty"] },
    ]);
    expect(await findHerdrClientPids({ table, socketPath: SOCK })).toEqual([700]);
  });

  it("prefers clients of our socket (HERDR_SOCKET_PATH, XDG_CONFIG_HOME, or the default under HOME)", async () => {
    const table = linux([
      { pid: 710, comm: "herdr", argv: ["herdr"], env: { HOME: "/home/alice" } },
      { pid: 711, comm: "herdr", argv: ["herdr"], env: { HOME: "/home/alice", HERDR_SOCKET_PATH: "/tmp/other.sock" } },
      { pid: 712, comm: "herdr", argv: ["herdr"], env: { HOME: "/home/bob", HERDR_SOCKET_PATH: SOCK } },
      { pid: 713, comm: "herdr", argv: ["herdr"], env: { HOME: "/home/alice", XDG_CONFIG_HOME: "/home/alice/.cfg" } },
    ]);
    expect(await findHerdrClientPids({ table, socketPath: SOCK })).toEqual([710, 712]);
    expect(await findHerdrClientPids({ table, socketPath: "/home/alice/.cfg/herdr/herdr.sock" })).toEqual([713]);
  });

  it("falls back to every client when none can be tied to our socket", async () => {
    const table = linux([
      { pid: 720, comm: "herdr", argv: ["herdr"] }, // environ unreadable
      { pid: 721, comm: "herdr", argv: ["herdr"], env: { HERDR_SOCKET_PATH: "/tmp/other.sock" } },
    ]);
    expect(await findHerdrClientPids({ table, socketPath: SOCK })).toEqual([720, 721]);
  });

  it("returns [] when /proc is missing", async () => {
    const table = createProcessTable({ platform: "linux", procRoot: "/nonexistent-proc" });
    expect(await findHerdrClientPids({ table, socketPath: SOCK })).toEqual([]);
  });
});

describe("findHerdrClientPids (darwin ps, unverified on real hardware)", () => {
  it("matches the executable basename and reads argv/env through ps", async () => {
    const responses: Record<string, string> = {
      "ps -axww -o pid=,ppid=,comm=": [
        "  1     0 /sbin/launchd",
        "800   710 /opt/homebrew/bin/herdr",
        "801     1 /opt/homebrew/bin/herdr",
        "802   710 /usr/local/bin/not-herdr",
      ].join("\n"),
      "ps -ww -o command= -p 800": "herdr\n",
      "ps -ww -o command= -p 801": "/opt/homebrew/bin/herdr server\n",
      "ps -E -ww -o command= -p 800": "herdr HOME=/Users/alice TERM=xterm\n",
    };
    const exec: Exec = async (file, args) => {
      const r = responses[[file, ...args].join(" ")];
      if (r === undefined) throw new Error("unexpected");
      return { stdout: r };
    };
    const table = createProcessTable({ platform: "darwin", exec, log: () => {} });
    expect(await findHerdrClientPids({ table, socketPath: "/Users/alice/.config/herdr/herdr.sock" })).toEqual([800]);
  });
});
