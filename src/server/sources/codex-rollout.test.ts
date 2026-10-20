import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { isUserThread, RolloutScanner, rolloutThreadId, SessionIndex, TITLE_MAX } from "./codex-rollout.ts";
import {
  aborted, assistantItem, complete, CX_ALICE, legacyUser, meta, seedCodexHome, started, tid, userItem, type SeededCodexHome,
} from "./__fixtures__/codex-seed.ts";

const silent = (): void => {};
let home: SeededCodexHome | undefined;
afterEach(async () => {
  await home?.cleanup();
  home = undefined;
});

async function scanOf(lines: Array<Record<string, unknown> | string>) {
  home = await seedCodexHome({ rollouts: [{ id: tid(1), lines }] });
  const scanner = new RolloutScanner({ log: silent });
  return { scanner, path: home.rolloutPath(tid(1)), info: await scanner.scan(home.rolloutPath(tid(1))) };
}

describe("RolloutScanner", () => {
  it("reads the meta, the first user message as title, and the last line time", async () => {
    const { info } = await scanOf([
      meta(tid(1), CX_ALICE, { git: { branch: "feature/x" } }),
      started("2026-10-20T10:00:01.000Z"),
      userItem("2026-10-20T10:00:02.000Z", "Fix   the\nlogin bug"),
      assistantItem("2026-10-20T10:00:03.000Z"),
      complete("2026-10-20T10:00:04.000Z"),
      started("2026-10-20T10:05:00.000Z"),
      userItem("2026-10-20T10:05:00.000Z", "second prompt"),
    ]);
    expect(info).toEqual({
      id: tid(1),
      cwd: CX_ALICE,
      branch: "feature/x",
      source: "vscode",
      threadSource: "user",
      firstUserMessage: "Fix the login bug",
      turnOpen: true,
      lastTimestamp: Date.parse("2026-10-20T10:05:00.000Z"),
    });
  });

  it("a completed or aborted turn is closed", async () => {
    expect((await scanOf([meta(tid(1), CX_ALICE), started("2026-10-20T10:00:01Z"), complete("2026-10-20T10:00:02Z")])).info!.turnOpen).toBe(false);
    await home!.cleanup();
    expect((await scanOf([meta(tid(1), CX_ALICE), started("2026-10-20T10:00:01Z"), aborted("2026-10-20T10:00:02Z")])).info!.turnOpen).toBe(false);
  });

  it("accepts legacy user_message events, strips Codex's request prefix and cuts long titles", async () => {
    const long = "word ".repeat(100);
    const { info } = await scanOf([meta(tid(1), CX_ALICE), legacyUser("2026-10-20T10:00:01Z", `ctx\n## My request for Codex:\n${long}`)]);
    expect(info!.firstUserMessage!.startsWith("word word")).toBe(true);
    expect([...info!.firstUserMessage!]).toHaveLength(TITLE_MAX);
    expect(info!.firstUserMessage!.endsWith("…")).toBe(true);
  });

  it("reads appended lines incrementally and keeps a partial trailing line for later", async () => {
    const { scanner, path } = await scanOf([meta(tid(1), CX_ALICE)]);
    await appendFile(path, JSON.stringify(started("2026-10-20T11:00:00.000Z")).slice(0, 30));
    expect((await scanner.scan(path))!.turnOpen).toBe(false);
    await appendFile(path, JSON.stringify(started("2026-10-20T11:00:00.000Z")).slice(30) + "\n");
    const info = await scanner.scan(path);
    expect(info!.turnOpen).toBe(true);
    expect(info!.lastTimestamp).toBe(Date.parse("2026-10-20T11:00:00.000Z"));
  });

  it("skips malformed lines and keeps going", async () => {
    const warnings: string[] = [];
    home = await seedCodexHome({ rollouts: [{ id: tid(1), lines: [meta(tid(1), CX_ALICE), '{"type":"session_meta" broken\n', started("2026-10-20T10:00:01Z")] }] });
    const info = await new RolloutScanner({ log: (m) => warnings.push(m) }).scan(home.rolloutPath(tid(1)));
    expect(info!.turnOpen).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  const zstdCompress = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
  it.skipIf(!zstdCompress)("reads compressed (.jsonl.zst) rollouts whole", async () => {
    home = await seedCodexHome({});
    const path = join(home.dir, `rollout-2026-10-01T09-00-00-${tid(9)}.jsonl.zst`);
    const text = [meta(tid(9), CX_ALICE), userItem("2026-10-01T09:00:01Z", "old one")].map((l) => JSON.stringify(l)).join("\n") + "\n";
    await writeFile(path, zstdCompress!(Buffer.from(text)));
    const info = await new RolloutScanner({ log: silent }).scan(path);
    expect(info).toMatchObject({ id: tid(9), firstUserMessage: "old one" });
  });
});

describe("rolloutThreadId", () => {
  it("parses plain, compressed and reverted rollout names", () => {
    expect(rolloutThreadId(`rollout-2026-10-20T14-07-46-${tid(1)}.jsonl`)).toBe(tid(1));
    expect(rolloutThreadId(`rollout-2026-10-20T14-07-46-${tid(1)}.jsonl.zst`)).toBe(tid(1));
    expect(rolloutThreadId(`rollout-2026-10-20T14-07-46-${tid(1)}_${tid(2)}.jsonl`)).toBe(tid(1));
  });
  it("rejects anything else", () => {
    for (const n of ["rollout-x.jsonl", `${tid(1)}.jsonl`, `rollout-2026-10-20T14-07-46-${tid(1)}.json`, `rollout-2026-10-20T14-07-46-../../x.jsonl`]) {
      expect(rolloutThreadId(n)).toBeUndefined();
    }
  });
});

describe("isUserThread", () => {
  const base = { turnOpen: false, lastTimestamp: 0 };
  it("keeps TUI and CLI threads", () => {
    expect(isUserThread({ ...base, source: "vscode", threadSource: "user" })).toBe(true);
    expect(isUserThread({ ...base, source: "cli" })).toBe(true);
    expect(isUserThread(base)).toBe(true);
  });
  it("drops sub-agents, reviews, exec and MCP runs", () => {
    expect(isUserThread({ ...base, source: { subagent: "review" } })).toBe(false);
    expect(isUserThread({ ...base, threadSource: "subagent" })).toBe(false);
    expect(isUserThread({ ...base, threadSource: "guardian_review" })).toBe(false);
    expect(isUserThread({ ...base, parentThreadId: tid(1) })).toBe(false);
    expect(isUserThread({ ...base, source: "exec" })).toBe(false);
    expect(isUserThread({ ...base, source: "mcp" })).toBe(false);
  });
});

describe("SessionIndex", () => {
  it("the last name per id wins; re-read only when the file changes; torn lines are ignored", async () => {
    home = await seedCodexHome({
      index: [
        { id: tid(1), thread_name: "First name", updated_at: "x" },
        { id: tid(2), thread_name: "Other", updated_at: "x" },
        { id: tid(1), thread_name: "Renamed", updated_at: "x" },
        '{"id":"torn',
      ],
    });
    const index = new SessionIndex(join(home.dir, "session_index.jsonl"));
    const names = await index.read();
    expect(Object.fromEntries(names)).toEqual({ [tid(1)]: "Renamed", [tid(2)]: "Other" });
    expect(await index.read()).toBe(names);
    await appendFile(join(home.dir, "session_index.jsonl"), `\n${JSON.stringify({ id: tid(2), thread_name: "Again", updated_at: "y" })}\n`);
    expect((await index.read()).get(tid(2))).toBe("Again");
  });

  it("a missing index is empty", async () => {
    expect((await new SessionIndex("/nonexistent/session_index.jsonl").read()).size).toBe(0);
  });
});
