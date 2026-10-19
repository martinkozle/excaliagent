/**
 * Raise the desktop window that hosts a process (e.g. the terminal running a
 * herdr client), so focusing a pane also brings its terminal to the front.
 *
 * Walks each candidate pid's ancestors via /proc/<pid>/stat and focuses the
 * first ancestor that owns a window. Supported: Hyprland (hyprctl) and Sway
 * (swaymsg). Anything else is a no-op. Never throws.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type Exec = (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>;

export const defaultExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeout, maxBuffer: 16 << 20, encoding: "utf8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });

export interface Desktop {
  /** Focus the window of the first pid (or ancestor) that has one. True if raised. */
  raise(pids: number[]): Promise<boolean>;
}

export interface DesktopOptions {
  env?: Record<string, string | undefined>;
  exec?: Exec;
  procRoot?: string;
  timeoutMs?: number;
}

/** ppid from /proc/<pid>/stat; comm (field 2) may contain spaces and parens. */
export async function parentPid(procRoot: string, pid: number): Promise<number | undefined> {
  try {
    const stat = await readFile(join(procRoot, String(pid), "stat"), "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    const ppid = Number(rest[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/** pid, then its parents up to (excluding) init. */
async function ancestry(procRoot: string, pid: number): Promise<number[]> {
  const chain: number[] = [];
  const seen = new Set<number>();
  let cur: number | undefined = pid;
  while (cur !== undefined && cur > 1 && !seen.has(cur) && chain.length < 64) {
    seen.add(cur);
    chain.push(cur);
    cur = await parentPid(procRoot, cur);
  }
  return chain;
}

interface WindowManager {
  /** pid → focus argument, for every window. */
  windows(): Promise<Map<number, string>>;
  focus(target: string): Promise<void>;
}

function hyprland(exec: Exec, timeout: number): WindowManager {
  return {
    async windows() {
      const { stdout } = await exec("hyprctl", ["clients", "-j"], { timeout });
      const out = new Map<number, string>();
      for (const c of JSON.parse(stdout) as { pid?: unknown; address?: unknown }[]) {
        if (typeof c.pid === "number" && typeof c.address === "string" && !out.has(c.pid)) out.set(c.pid, c.address);
      }
      return out;
    },
    async focus(address) {
      await exec("hyprctl", ["dispatch", "focuswindow", `address:${address}`], { timeout });
    },
  };
}

interface SwayNode {
  pid?: unknown;
  nodes?: SwayNode[];
  floating_nodes?: SwayNode[];
}

function sway(exec: Exec, timeout: number): WindowManager {
  return {
    async windows() {
      const { stdout } = await exec("swaymsg", ["-t", "get_tree"], { timeout });
      const out = new Map<number, string>();
      const walk = (n: SwayNode) => {
        if (typeof n.pid === "number") out.set(n.pid, String(n.pid));
        for (const c of [...(n.nodes ?? []), ...(n.floating_nodes ?? [])]) walk(c);
      };
      walk(JSON.parse(stdout) as SwayNode);
      return out;
    },
    async focus(pid) {
      await exec("swaymsg", [`[pid=${pid}]`, "focus"], { timeout });
    },
  };
}

export function createDesktop(opts: DesktopOptions = {}): Desktop {
  const { env = process.env, exec = defaultExec, procRoot = "/proc", timeoutMs = 2000 } = opts;
  const wm = env.HYPRLAND_INSTANCE_SIGNATURE
    ? hyprland(exec, timeoutMs)
    : env.SWAYSOCK
      ? sway(exec, timeoutMs)
      : undefined;
  return {
    async raise(pids) {
      if (!wm || pids.length === 0) return false;
      try {
        const windows = await wm.windows();
        for (const pid of pids) {
          for (const p of await ancestry(procRoot, pid)) {
            const target = windows.get(p);
            if (target !== undefined) {
              await wm.focus(target);
              return true;
            }
          }
        }
      } catch {
        // no compositor, timeout, bad output: just don't raise
      }
      return false;
    },
  };
}
