// Guard: test data must be synthetic. Fails if any fixture or test file mentions
// the current machine's home directory or user name (i.e. real recordings).
import { readdir, readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

describe("privacy", () => {
  it("no fixture or test file contains this machine's home dir or user name", async () => {
    const needles = [homedir(), userInfo().username].filter((n) => n.length >= 4);
    const offenders: string[] = [];
    const roots = [import.meta.dirname, join(import.meta.dirname, "..", "test"), join(import.meta.dirname, "..", "scripts")];
    for (const root of roots) for await (const file of walk(root)) {
      if (!/__fixtures__|\.test\.tsx?$|seed|\/test\/|\/scripts\//.test(file) || file === import.meta.filename) continue;
      const text = await readFile(file, "utf8").catch(() => "");
      for (const n of needles) if (text.includes(n)) offenders.push(`${file}: ${n}`);
    }
    expect(offenders).toEqual([]);
  });
});
