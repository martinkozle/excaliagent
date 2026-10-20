// A synthetic /proc for tests and the demo (EXCALIAGENT_PROC_ROOT), so the
// server never reads the machine's real processes: `stat` with a boot time,
// `locks`, and per dummy pid `cmdline`, `stat`, `exe`, `cwd` and `fd/*`. The
// pids are real dummy processes, so stopping a session is still a real
// SIGTERM; an entry is removed when its process exits.
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MockProcEntry {
  comm: string;
  argv: string[];
  exe: string;
  /** Need not exist (it is a symlink target). */
  cwd: string;
  /** Paths this process has open (fd/3, fd/4, ...). */
  fds?: string[];
  ppid?: number;
}

export interface MockProc {
  root: string;
  /** Adds the process's entry; removes it (and its locks) when the process exits. */
  add(child: ChildProcess, entry: MockProcEntry): void;
  /** A held flock on `inode` by `pid`, as /proc/locks lists it. */
  lock(pid: number, inode: number): void;
  /** Releases it. */
  unlock(pid: number, inode: number): void;
  /** Opens `path` in `pid` (a new fd/N). */
  openFd(pid: number, path: string): void;
  remove(pid: number): void;
}

const USER_HZ = 100;

export function createMockProc(root: string): MockProc {
  mkdirSync(root, { recursive: true });
  // Boot "an hour ago", so start ticks of processes started now fit.
  const btime = Math.floor(Date.now() / 1000) - 3600;
  writeFileSync(join(root, "stat"), `cpu  0 0 0 0\nbtime ${btime}\nprocesses 1\n`);
  const locks = new Map<number, number[]>();
  const writeLocks = () => {
    // A dummy may exit after teardown removed the tree.
    if (!existsSync(root)) return;
    writeFileSync(
      join(root, "locks"),
      [...locks].flatMap(([pid, inodes]) => inodes.map((ino, i) => `${i + 1}: FLOCK  ADVISORY  WRITE ${pid} 00:00:${ino} 0 EOF\n`)).join(""),
    );
  };
  writeLocks();

  const remove = (pid: number) => {
    rmSync(join(root, String(pid)), { recursive: true, force: true });
    if (locks.delete(pid)) writeLocks();
  };

  return {
    root,
    add(child, e) {
      const pid = child.pid;
      if (pid === undefined) return;
      const dir = join(root, String(pid));
      mkdirSync(join(dir, "fd"), { recursive: true });
      // Started "now" (rounded down, like the kernel's tick count).
      const ticks = Math.floor((Date.now() / 1000 - btime) * USER_HZ) - 1;
      writeFileSync(join(dir, "stat"), `${pid} (${e.comm}) S ${e.ppid ?? 1} ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 0 0`);
      writeFileSync(join(dir, "cmdline"), e.argv.join("\0") + "\0");
      symlinkSync(e.exe, join(dir, "exe"));
      symlinkSync(e.cwd, join(dir, "cwd"));
      (e.fds ?? []).forEach((f, i) => symlinkSync(f, join(dir, "fd", String(i + 3))));
      child.once("exit", () => remove(pid));
    },
    lock(pid, inode) {
      locks.set(pid, [...(locks.get(pid) ?? []), inode]);
      writeLocks();
    },
    unlock(pid, inode) {
      locks.set(pid, (locks.get(pid) ?? []).filter((i) => i !== inode));
      writeLocks();
    },
    openFd(pid, path) {
      const fd = join(root, String(pid), "fd");
      if (!existsSync(fd)) return;
      symlinkSync(path, join(fd, String(3 + readdirSync(fd).length)));
    },
    remove,
  };
}
