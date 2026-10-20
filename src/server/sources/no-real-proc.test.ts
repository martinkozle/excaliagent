// Guard (maintainer's hard rule): given a proc root, the process-scanning
// sources never read the real /proc. Every file access is recorded while they
// list, look up and stop sessions against a synthetic tree.
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tid } from "./__fixtures__/codex-seed.ts";

const touched: string[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const spy =
    <F extends (...a: any[]) => any>(f: F) =>
    (...a: Parameters<F>): ReturnType<F> => {
      touched.push(String(a[0]));
      return f(...a);
    };
  return {
    ...real,
    readFile: spy(real.readFile),
    readdir: spy(real.readdir),
    readlink: spy(real.readlink),
    stat: spy(real.stat),
    realpath: spy(real.realpath),
    open: spy(real.open),
  };
});

const { createCodexSource } = await import("./codex.ts");
const { createOpenCodeSource } = await import("./opencode.ts");
const { createMockOpenCode } = await import("../../../test/mock-opencode.ts");
const { createMockProc } = await import("../../../test/mock-proc.ts");

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const realProc = () => touched.filter((p) => p === "/proc" || p.startsWith("/proc/"));

describe("no real /proc under test", () => {
  it("the Codex source reads only the given proc root", async () => {
    root = await mkdtemp(join(tmpdir(), "excaliagent-noproc-"));
    const proc = join(root, "proc");
    const codex = join(root, "codex");
    const lockDir = join(codex, "thread-writer-locks");
    await mkdir(lockDir, { recursive: true });
    const lock = join(lockDir, `${tid(1)}.lock`);
    await writeFile(lock, "");
    // A daemon holds the lock, so the source also lists every process (the widest scan).
    await mkdir(join(proc, "10", "fd"), { recursive: true });
    await writeFile(join(proc, "stat"), "btime 1792400000\n");
    await writeFile(join(proc, "locks"), `1: FLOCK  ADVISORY  WRITE 10 00:00:${(await stat(lock)).ino} 0 EOF\n`);
    await writeFile(join(proc, "10", "stat"), "10 (codex) S 1 10 10 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5 0 0");
    await writeFile(join(proc, "10", "cmdline"), ["/x/codex", "app-server", "--managed-daemon"].join("\0"));
    await symlink("/x/codex", join(proc, "10", "exe"));
    await symlink("/", join(proc, "10", "cwd"));
    await symlink(lock, join(proc, "10", "fd", "3"));
    // A TUI that resumed it, so Stop goes as far as the process check.
    await mkdir(join(proc, "20"), { recursive: true });
    await writeFile(join(proc, "20", "stat"), "20 (codex) S 1 20 20 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 6 0 0");
    await writeFile(join(proc, "20", "cmdline"), ["/x/codex", "resume", tid(1)].join("\0"));
    await symlink("/x/codex", join(proc, "20", "exe"));
    await symlink("/home/alice/src/demo-app", join(proc, "20", "cwd"));

    touched.length = 0;
    const kill = vi.fn();
    const src = createCodexSource({ codexDir: codex, procRoot: proc, log: () => {}, cacheMs: 0, kill });
    await src.list();
    await src.listDormant();
    await src.get(tid(1));
    expect(await src.end!(tid(1))).toBe("ended");
    expect(kill).toHaveBeenCalledExactlyOnceWith(20, "SIGTERM");
    expect(touched.some((p) => p.startsWith(proc))).toBe(true);
    expect(realProc()).toEqual([]);
  });

  it("the OpenCode source reads only the given proc root", async () => {
    root = await mkdtemp(join(tmpdir(), "excaliagent-noproc-"));
    const procs = createMockProc(join(root, "proc"));
    const mock = createMockOpenCode(procs, join(root, "opencode"));
    const id = `ses_${"0".repeat(12)}abcdefghijklmn`;
    mock.add({ id, directory: "/home/alice/src/demo-app", title: "Live one" });
    try {
      touched.length = 0;
      const kill = vi.fn();
      const src = createOpenCodeSource({ dataDir: mock.dir, procRoot: procs.root, log: () => {}, cacheMs: 0, kill });
      expect((await src.list()).map((s) => [s.id, s.canEnd])).toEqual([[id, true]]);
      await src.listDormant();
      await src.get(id);
      expect(await src.end!(id)).toBe("ended");
      expect(kill).toHaveBeenCalledOnce();
      expect(touched.some((p) => p.startsWith(procs.root))).toBe(true);
      expect(realProc()).toEqual([]);
    } finally {
      mock.teardown();
    }
  });
});
