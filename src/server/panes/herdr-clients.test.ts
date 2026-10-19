import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findHerdrClientPids } from "./herdr-clients.ts";

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

interface FakeProc {
  pid: number;
  comm: string;
  argv: string[];
  env?: Record<string, string>; // undefined: environ unreadable (missing)
}

function fakeProc(procs: FakeProc[]): string {
  const root = mkdtempSync(join(tmpdir(), "proc-"));
  roots.push(root);
  mkdirSync(join(root, "self"));
  for (const p of procs) {
    const dir = join(root, String(p.pid));
    mkdirSync(dir);
    writeFileSync(join(dir, "comm"), p.comm + "\n");
    writeFileSync(join(dir, "cmdline"), p.argv.map((a) => a + "\0").join(""));
    if (p.env) {
      writeFileSync(join(dir, "environ"), Object.entries(p.env).map(([k, v]) => `${k}=${v}\0`).join(""));
    }
  }
  return root;
}

const SOCK = "/home/alice/.config/herdr/herdr.sock";

describe("findHerdrClientPids", () => {
  it("finds herdr client processes and skips the server and other processes", async () => {
    const procRoot = fakeProc([
      { pid: 700, comm: "herdr", argv: ["herdr"], env: { HOME: "/home/alice" } },
      { pid: 701, comm: "herdr", argv: ["/opt/herdr/bin/herdr", "server"], env: { HOME: "/home/alice" } },
      { pid: 702, comm: "zsh", argv: ["herdr"] },
      { pid: 703, comm: "kitty", argv: ["kitty"] },
    ]);
    expect(await findHerdrClientPids({ procRoot, socketPath: SOCK })).toEqual([700]);
  });

  it("prefers clients of our socket (explicit HERDR_SOCKET_PATH or the default under HOME)", async () => {
    const procRoot = fakeProc([
      { pid: 710, comm: "herdr", argv: ["herdr"], env: { HOME: "/home/alice" } },
      { pid: 711, comm: "herdr", argv: ["herdr"], env: { HOME: "/home/alice", HERDR_SOCKET_PATH: "/tmp/other.sock" } },
      { pid: 712, comm: "herdr", argv: ["herdr"], env: { HOME: "/home/bob", HERDR_SOCKET_PATH: SOCK } },
    ]);
    expect(await findHerdrClientPids({ procRoot, socketPath: SOCK })).toEqual([710, 712]);
  });

  it("falls back to clients with an unknown socket when none is ours", async () => {
    const procRoot = fakeProc([
      { pid: 720, comm: "herdr", argv: ["herdr"] }, // environ unreadable
      { pid: 721, comm: "herdr", argv: ["herdr"], env: { HERDR_SOCKET_PATH: "/tmp/other.sock" } },
    ]);
    expect(await findHerdrClientPids({ procRoot, socketPath: SOCK })).toEqual([720]);
  });

  it("never returns a client known to be on another server (e.g. an isolated test server)", async () => {
    const procRoot = fakeProc([
      { pid: 730, comm: "herdr", argv: ["herdr"], env: { HOME: "/home/alice" } },
    ]);
    expect(await findHerdrClientPids({ procRoot, socketPath: "/tmp/hdr-x/h.sock" })).toEqual([]);
  });

  it("returns [] when /proc is missing", async () => {
    expect(await findHerdrClientPids({ procRoot: "/nonexistent-proc", socketPath: SOCK })).toEqual([]);
  });
});
