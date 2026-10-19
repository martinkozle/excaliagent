import { appendFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TranscriptScanner } from "./transcript.ts";
import { SLUG_A, SLUG_B, type SeededHome, ms, seedClaudeHome, sid, standardSpec } from "./__fixtures__/seed.ts";

const silent = (): void => {};
let home: SeededHome;
beforeAll(async () => {
  home = await seedClaudeHome(standardSpec());
});
afterAll(() => home.cleanup());

async function tempDir() {
  const h = await seedClaudeHome({});
  return { dir: h.dir, cleanup: h.cleanup };
}

const HOUR = 3600_000;
const FIVE_MIN = 300_000;
const alpha = (n: number) => home.transcriptPath(SLUG_A, sid(n));
const beta = (n: number) => home.transcriptPath(SLUG_B, sid(n));

describe("TranscriptScanner on the standard scenario", () => {
  it("keeps the last ai-title and agent-name, dedupes pr links, uses the last branch and cwd", async () => {
    const t = await new TranscriptScanner({ log: silent }).scan(alpha(1));
    expect(t).toBeDefined();
    expect(t!.aiTitle).toBe("Second title");
    expect(t!.agentName).toBe("demo agent");
    expect(t!.prLinks).toEqual(["https://github.com/example/demo-app/pull/12", "https://github.com/example/demo-app/pull/13"]);
    expect(t!.gitBranch).toBe("feature/cards");
    expect(t!.cwd).toBe("/home/alice/src/demo-app");
    // attachment line timestamps do not count as activity
    expect(t!.lastTimestamp).toBe(ms("2026-10-19T10:02:00.000Z"));
  });

  it("picks a 1h TTL when the last cache write was 1h", async () => {
    const t = await new TranscriptScanner({ log: silent }).scan(alpha(1));
    expect(t!.cacheTtlMs).toBe(HOUR);
    expect(t!.cacheExpiresAt).toBe(ms("2026-10-19T10:02:00.000Z") + HOUR);
  });

  it("picks a 5m TTL when the last cache write was 5m", async () => {
    const t = await new TranscriptScanner({ log: silent }).scan(beta(2));
    expect(t!.cacheTtlMs).toBe(FIVE_MIN);
    expect(t!.cacheExpiresAt).toBe(ms("2026-10-19T07:58:10.000Z") + FIVE_MIN);
  });

  it("does not downgrade a 1h cache on a cache-read-only turn, but extends from its timestamp", async () => {
    const t = await new TranscriptScanner({ log: silent }).scan(alpha(3));
    expect(t!.cacheTtlMs).toBe(HOUR);
    expect(t!.cacheExpiresAt).toBe(ms("2026-10-18T08:20:00.000Z") + HOUR);
    expect(t!.continuedIn).toBe(sid(7));
  });

  it("defaults to 5m when no assistant turn ever wrote cache", async () => {
    const t = await new TranscriptScanner({ log: silent }).scan(alpha(4));
    expect(t!.cacheTtlMs).toBe(FIVE_MIN);
  });

  it("reports 0 TTL and expiry without an assistant turn", async () => {
    const t = await new TranscriptScanner({ log: silent }).scan(alpha(5));
    expect(t!.aiTitle).toBe("Never answered");
    expect(t!.cacheTtlMs).toBe(0);
    expect(t!.cacheExpiresAt).toBe(0);
    expect(t!.lastTimestamp).toBe(0);
    expect(t!.cwd).toBeUndefined();
  });

  it("skips malformed lines and holds back a partial trailing line", async () => {
    const logs: string[] = [];
    const t = await new TranscriptScanner({ log: (m) => logs.push(m) }).scan(beta(2));
    expect(t!.agentName).toBe("lib agent");
    expect(t!.aiTitle).toBeUndefined(); // the unterminated ai-title line is not parsed yet
    expect(t!.lastTimestamp).toBe(ms("2026-10-19T07:58:10.000Z"));
    expect(logs.length).toBeLessThanOrEqual(1); // at most once per file
  });

  it("returns undefined for a missing file", async () => {
    expect(await new TranscriptScanner({ log: silent }).scan(alpha(9))).toBeUndefined();
  });

  it("never keeps message content", async () => {
    const t = await new TranscriptScanner({ log: silent }).scan(alpha(1));
    expect(JSON.stringify(t)).not.toContain("synthetic");
    expect(JSON.stringify(t)).not.toContain("attachment body");
    expect(Object.keys(t!).sort()).toEqual(
      [
        "agentName", "aiTitle", "cacheExpiresAt", "cacheTtlMs", "cwd",
        "gitBranch", "lastAssistantAt", "lastTimestamp", "prLinks",
      ].sort(),
    );
  });
});

describe("TranscriptScanner incremental reads", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  const line = (o: object) => JSON.stringify(o) + "\n";
  const asst = (ts: string, h1: number, m5: number) =>
    line({ type: "assistant", timestamp: ts, cwd: "/w", gitBranch: "main", message: { content: [{ type: "text", text: "secret" }], usage: { cache_creation: { ephemeral_1h_input_tokens: h1, ephemeral_5m_input_tokens: m5 } } } });

  async function setup() {
    const t = await tempDir();
    cleanup = t.cleanup;
    const file = join(t.dir, "s.jsonl");
    return { dir: t.dir, file };
  }

  it("parses only appended bytes and completes a partial line on the next read", async () => {
    const { file } = await setup();
    const scanner = new TranscriptScanner({ log: silent });
    await writeFile(file, line({ type: "ai-title", aiTitle: "one" }) + asst("2026-10-19T10:00:00.000Z", 10, 0));
    let t = await scanner.scan(file);
    expect(t!.aiTitle).toBe("one");
    expect(scanner.stats(file)!.bytesRead).toBe(scanner.stats(file)!.offset);

    const before = scanner.stats(file)!.bytesRead;
    const half = line({ type: "ai-title", aiTitle: "two" });
    await appendFile(file, half.slice(0, 10));
    t = await scanner.scan(file);
    expect(t!.aiTitle).toBe("one");
    await appendFile(file, half.slice(10));
    t = await scanner.scan(file);
    expect(t!.aiTitle).toBe("two");
    // total bytes read equals file size: nothing was re-read
    expect(scanner.stats(file)!.bytesRead).toBe(before + half.length);
    expect(t!.cacheTtlMs).toBe(HOUR);
  });

  it("keeps state across appends (1h tier survives a later read-only turn appended)", async () => {
    const { file } = await setup();
    const scanner = new TranscriptScanner({ log: silent });
    await writeFile(file, asst("2026-10-19T10:00:00.000Z", 10, 0));
    await scanner.scan(file);
    await appendFile(file, asst("2026-10-19T10:30:00.000Z", 0, 0));
    const t = await scanner.scan(file);
    expect(t!.cacheTtlMs).toBe(HOUR);
    expect(t!.cacheExpiresAt).toBe(ms("2026-10-19T10:30:00.000Z") + HOUR);
  });

  it("does not re-read an unchanged file", async () => {
    const { file } = await setup();
    const scanner = new TranscriptScanner({ log: silent });
    await writeFile(file, asst("2026-10-19T10:00:00.000Z", 0, 5));
    await scanner.scan(file);
    const n = scanner.stats(file)!.bytesRead;
    await scanner.scan(file);
    expect(scanner.stats(file)!.bytesRead).toBe(n);
  });

  it("rescans from 0 when the file shrinks", async () => {
    const { file } = await setup();
    const scanner = new TranscriptScanner({ log: silent });
    await writeFile(file, line({ type: "ai-title", aiTitle: "long title here" }) + asst("2026-10-19T10:00:00.000Z", 10, 0));
    await scanner.scan(file);
    await writeFile(file, line({ type: "agent-name", agentName: "n" }));
    const t = await scanner.scan(file);
    expect(t!.aiTitle).toBeUndefined();
    expect(t!.agentName).toBe("n");
    expect(t!.cacheTtlMs).toBe(0);
  });

  it("rescans from 0 when the file is replaced by a bigger one", async () => {
    const { dir, file } = await setup();
    const scanner = new TranscriptScanner({ log: silent });
    await writeFile(file, line({ type: "ai-title", aiTitle: "a" }));
    await scanner.scan(file);
    const other = join(dir, "other.jsonl");
    await writeFile(other, line({ type: "agent-name", agentName: "replaced" }) + line({ type: "pr-link", prUrl: "https://x/pull/1" }));
    await rename(other, file);
    const t = await scanner.scan(file);
    expect(t!.aiTitle).toBeUndefined();
    expect(t!.agentName).toBe("replaced");
    expect(t!.prLinks).toEqual(["https://x/pull/1"]);
  });

  it("handles a multi-byte character split across reads", async () => {
    const { file } = await setup();
    const scanner = new TranscriptScanner({ log: silent });
    const full = Buffer.from(line({ type: "ai-title", aiTitle: "Ünïcødé ✓" }));
    const cut = full.indexOf(Buffer.from("✓")) + 1;
    await writeFile(file, full.subarray(0, cut));
    await scanner.scan(file);
    await appendFile(file, full.subarray(cut));
    const t = await scanner.scan(file);
    expect(t!.aiTitle).toBe("Ünïcødé ✓");
  });

  it("reads files larger than one chunk", async () => {
    const { dir } = await setup();
    const file = join(dir, "big.jsonl");
    const pad = "x".repeat(200_000);
    let text = "";
    for (let i = 0; i < 20; i++) text += line({ type: "user", timestamp: `2026-10-19T10:00:${String(i).padStart(2, "0")}.000Z`, message: { content: pad } });
    text += line({ type: "ai-title", aiTitle: "end" });
    await writeFile(file, text);
    const t = await new TranscriptScanner({ log: silent }).scan(file);
    expect(t!.aiTitle).toBe("end");
    expect(t!.lastTimestamp).toBe(ms("2026-10-19T10:00:19.000Z"));
  });

  it("concurrent scans of the same file do not double-read", async () => {
    const { file } = await setup();
    const scanner = new TranscriptScanner({ log: silent });
    await writeFile(file, line({ type: "pr-link", prUrl: "https://x/pull/2" }));
    const [a, b] = await Promise.all([scanner.scan(file), scanner.scan(file)]);
    expect(a!.prLinks).toEqual(["https://x/pull/2"]);
    expect(b!.prLinks).toEqual(["https://x/pull/2"]);
    expect(scanner.stats(file)!.bytesRead).toBe(scanner.stats(file)!.offset);
  });
});
