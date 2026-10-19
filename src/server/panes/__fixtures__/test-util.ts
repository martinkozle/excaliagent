import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A short temp dir (Unix socket paths are limited to ~107 bytes). */
export function tempSocketDir(): { dir: string; socketPath: string; cleanup(): void } {
  const base = tmpdir().length < 60 ? tmpdir() : "/tmp";
  const dir = mkdtempSync(join(base, "hd-"));
  return { dir, socketPath: join(dir, "h.sock"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function waitFor(cond: () => boolean, timeoutMs = 2000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
