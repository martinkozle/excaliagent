import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptScanner } from "./transcript.ts";
import { ALICE, apiRequest, assistant, encodeTranscript, ms, seedClaudeHome, type SeededHome } from "./__fixtures__/seed.ts";

const HOUR = 3600_000;
const FIVE_MIN = 300_000;
const S = "0a1b2c3d-2222-4000-8000-000000000001";
const T = "2026-10-19T21:33:30.000Z";
let home: SeededHome | undefined;
afterEach(async () => {
  await home?.cleanup();
  home = undefined;
});

async function scanLines(lines: Parameters<typeof encodeTranscript>[0]) {
  home = await seedClaudeHome({});
  const p = join(home.dir, "t.jsonl");
  await writeFile(p, encodeTranscript(lines));
  return (await new TranscriptScanner({ log: () => {} }).scan(p))!;
}

describe("cache TTL from api-request cacheControl", () => {
  it("1h api-request beats a 5m usage report", async () => {
    const t = await scanLines([
      apiRequest(S, "2026-10-19T21:33:21.000Z", ["1h", "1h"]),
      assistant(S, T, ALICE, "main", { m5: 4000 }),
    ]);
    expect(t.cacheTtlMs).toBe(HOUR);
    expect(t.cacheExpiresAt).toBe(ms(T) + HOUR);
  });

  it("uses the max ttl over entries", async () => {
    const t = await scanLines([apiRequest(S, T, ["5m", "1h", undefined]), assistant(S, T, ALICE, "main", { m5: 1 })]);
    expect(t.cacheTtlMs).toBe(HOUR);
  });

  it("missing ttl means 5m", async () => {
    const t = await scanLines([apiRequest(S, T, [undefined, undefined]), assistant(S, T, ALICE, "main", { h1: 10 })]);
    expect(t.cacheTtlMs).toBe(FIVE_MIN);
  });

  it("the most recent main-thread api-request wins", async () => {
    const t = await scanLines([
      apiRequest(S, T, ["1h"]),
      apiRequest(S, T, ["5m"]),
      assistant(S, T, ALICE, "main", { m5: 1 }),
    ]);
    expect(t.cacheTtlMs).toBe(FIVE_MIN);
  });

  it("ignores other query sources when a main-thread request exists", async () => {
    const t = await scanLines([
      apiRequest(S, T, ["1h"]),
      apiRequest(S, T, ["5m"], "agent:custom"),
      apiRequest(S, T, [undefined], "compact"),
      assistant(S, T, ALICE, "main", { m5: 1 }),
    ]);
    expect(t.cacheTtlMs).toBe(HOUR);
  });

  it("uses other query sources when no main-thread request exists", async () => {
    const t = await scanLines([apiRequest(S, T, ["1h"], "agent:custom"), assistant(S, T, ALICE, "main", { m5: 1 })]);
    expect(t.cacheTtlMs).toBe(HOUR);
  });

  it("ignores api-request lines without a cacheControl array", async () => {
    const { cacheControl: _drop, ...noCc } = apiRequest(S, T, ["5m"]);
    const t = await scanLines([noCc, assistant(S, T, ALICE, "main", { h1: 5 })]);
    expect(t.cacheTtlMs).toBe(HOUR);
  });

  it("falls back to usage when there are no api-request lines", async () => {
    const t = await scanLines([assistant(S, T, ALICE, "main", { h1: 5 }), assistant(S, T, ALICE, "main")]);
    expect(t.cacheTtlMs).toBe(HOUR);
    const u = await scanLines([assistant(S, T, ALICE, "main", { m5: 5 })]);
    expect(u.cacheTtlMs).toBe(FIVE_MIN);
  });

  it("still reports 0 without an assistant line", async () => {
    const t = await scanLines([apiRequest(S, T, ["1h"])]);
    expect(t.cacheTtlMs).toBe(0);
    expect(t.cacheExpiresAt).toBe(0);
  });

  it("never keeps api-request payload", async () => {
    const t = await scanLines([apiRequest(S, T, ["1h"]), assistant(S, T, ALICE, "main")]);
    expect(JSON.stringify(t)).not.toContain("synthetic");
  });
});
