import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootTime, parseStartTicks, procRootFromEnv, startedAt } from "./proc.ts";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("proc helpers", () => {
  it("parses the start ticks of /proc/<pid>/stat, even with spaces and parens in comm", () => {
    expect(parseStartTicks("4242 (a (b) c) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 9 0 7101526 1000 50")).toBe(7101526);
    expect(parseStartTicks("garbage")).toBeUndefined();
  });

  it("computes start times from btime and ticks; unknown without /proc", async () => {
    root = await mkdtemp(join(tmpdir(), "excaliagent-proc-"));
    await writeFile(join(root, "stat"), "cpu 1 2\nbtime 1792400000\n");
    await mkdir(join(root, "42"));
    await writeFile(join(root, "42", "stat"), "42 (x) S 1 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 250 0 0");
    const btime = await bootTime(root);
    expect(btime).toBe(1792400000);
    expect(await startedAt(root, 42, btime)).toBe(1792400002500);
    expect(await startedAt(root, 43, btime)).toBe(0);
    expect(await bootTime(join(root, "missing"))).toBeUndefined();
  });

  it("the proc root comes from EXCALIAGENT_PROC_ROOT only", () => {
    expect(procRootFromEnv({})).toBeUndefined();
    expect(procRootFromEnv({ EXCALIAGENT_PROC_ROOT: "/tmp/p" })).toBe("/tmp/p");
  });
});
