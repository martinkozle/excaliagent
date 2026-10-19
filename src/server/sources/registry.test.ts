import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultIsAlive, isLive, readRegistry } from "./registry.ts";
import { BOB, type SeededHome, ms, seedClaudeHome, sid, standardSpec } from "./__fixtures__/seed.ts";

const silent = (): void => {};
let home: SeededHome;
beforeAll(async () => {
  home = await seedClaudeHome(standardSpec());
});
afterAll(() => home.cleanup());

describe("readRegistry", () => {
  it("reads every parseable *.json, skipping .key files and bad JSON", async () => {
    const logs: string[] = [];
    const entries = await readRegistry(join(home.dir, "sessions"), (m) => logs.push(m));
    expect(entries.map((e) => e.pid).sort()).toEqual([101, 102, 103, 104]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("105.json");
  });

  it("keeps only the fields we use", async () => {
    const entries = await readRegistry(join(home.dir, "sessions"), silent);
    expect(entries.find((e) => e.pid === 102)).toEqual({
      pid: 102,
      sessionId: sid(2),
      cwd: BOB,
      name: "other-lib-02",
      status: "waiting",
      waitingFor: "input needed",
      statusUpdatedAt: ms("2026-10-19T08:00:00.000Z"),
      updatedAt: ms("2026-10-19T08:00:00.000Z"),
    });
  });

  it("skips entries missing pid or sessionId", async () => {
    const h = await seedClaudeHome({
      registry: [
        { file: "1.json", content: { sessionId: sid(1), cwd: "/x", status: "idle" } },
        { file: "2.json", content: { pid: 2, cwd: "/x", status: "idle" } },
        { file: "3.json", content: "[]" },
      ],
    });
    try {
      const logs: string[] = [];
      expect(await readRegistry(join(h.dir, "sessions"), (m) => logs.push(m))).toEqual([]);
      expect(logs).toHaveLength(3);
    } finally {
      await h.cleanup();
    }
  });

  it("returns [] for a missing directory", async () => {
    expect(await readRegistry(join(home.dir, "nope"), silent)).toEqual([]);
  });
});

describe("liveness", () => {
  it("defaultIsAlive is true for this process and false for an impossible pid", () => {
    expect(defaultIsAlive(process.pid)).toBe(true);
    expect(defaultIsAlive(2 ** 22 + 12345)).toBe(false);
  });

  it("defaultIsAlive treats EPERM (pid 1 as non-root) as alive", () => {
    expect(defaultIsAlive(1)).toBe(true);
  });

  it("isLive requires a live pid and a non-exited status", () => {
    const alive = (pid: number) => pid !== 103;
    const base = { sessionId: "x", cwd: "/", status: "idle" };
    expect(isLive({ ...base, pid: 101 }, alive)).toBe(true);
    expect(isLive({ ...base, pid: 103 }, alive)).toBe(false);
    expect(isLive({ ...base, pid: 101, status: "exited" }, alive)).toBe(false);
  });
});
