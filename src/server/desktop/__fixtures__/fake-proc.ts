import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeProc {
  pid: number;
  ppid: number;
  comm: string;
  argv: string[];
  /** undefined: environ unreadable (absent). */
  env?: Record<string, string>;
  exe?: string;
}

/** A fake Linux /proc tree in a temp dir; call cleanup() when done. */
export function fakeProcRoot(procs: FakeProc[]): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "proc-"));
  mkdirSync(join(root, "self"));
  for (const p of procs) {
    const dir = join(root, String(p.pid));
    mkdirSync(dir);
    writeFileSync(join(dir, "stat"), `${p.pid} (${p.comm}) S ${p.ppid} ${p.pid} ${p.pid} 0 -1 4194560 1 2 3\n`);
    writeFileSync(join(dir, "comm"), p.comm + "\n");
    writeFileSync(join(dir, "cmdline"), p.argv.map((a) => a + "\0").join(""));
    if (p.env) writeFileSync(join(dir, "environ"), Object.entries(p.env).map(([k, v]) => `${k}=${v}\0`).join(""));
    if (p.exe) symlinkSync(p.exe, join(dir, "exe"));
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
