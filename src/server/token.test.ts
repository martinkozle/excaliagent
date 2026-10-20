import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateToken } from "./token.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "excaliagent-token-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadOrCreateToken", () => {
  it("creates a random token once, readable only by the user, and reuses it", async () => {
    const state = join(dir, "nested", "state");
    const a = await loadOrCreateToken(state);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await stat(join(state, "token"))).mode & 0o777).toBe(0o600);
    expect(await loadOrCreateToken(state)).toBe(a);
    expect(await loadOrCreateToken(join(dir, "other"))).not.toBe(a);
  });

  it("replaces a token file that is too short or malformed", async () => {
    await writeFile(join(dir, "token"), "weak\n");
    const t = await loadOrCreateToken(dir);
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await readFile(join(dir, "token"), "utf8")).trim()).toBe(t);
  });
});
