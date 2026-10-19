/**
 * Raise the desktop window that hosts a process (e.g. the terminal running a
 * herdr client), so focusing a pane also brings its terminal to the front.
 *
 * Walks each candidate pid's ancestors through a ProcessTable and acts on the
 * first ancestor that is a window / app:
 * - Linux + Hyprland: `hyprctl clients -j` → `hyprctl dispatch focuswindow address:<addr>`
 * - Linux + Sway: `swaymsg -t get_tree` → `swaymsg [pid=N] focus`
 * - macOS: first ancestor whose executable lives in an `.app` bundle →
 *   `open -a <bundle>` (activates the app; no Accessibility permission).
 *   Unverified on real hardware.
 * - anything else: no-op.
 * Never throws; raise() resolves false when nothing was raised.
 */
import { defaultExec, defaultLog, describeExecFailure, logOnce, type Exec, type Log } from "./exec.ts";
import { createProcessTable, type ProcessTable } from "./process-table.ts";

export { defaultExec, type Exec };

export type DesktopKind = "hyprland" | "sway" | "macos" | "none";

export interface Desktop {
  /** Which raise strategy is active (for the startup log). */
  readonly kind: DesktopKind;
  /** Bring the window of the first pid (or ancestor) that has one to the front. True if raised. */
  raise(pids: number[]): Promise<boolean>;
}

export interface DesktopOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  exec?: Exec;
  /** Defaults to createProcessTable({ platform, procRoot, exec }). */
  table?: ProcessTable;
  procRoot?: string;
  timeoutMs?: number;
  /** macOS: why a raise did nothing, reported once per cause (default: console.warn). */
  log?: Log;
}

/** pid, then its parents up to (excluding) init/launchd. */
async function ancestry(table: ProcessTable, pid: number): Promise<number[]> {
  const chain: number[] = [];
  const seen = new Set<number>();
  let cur: number | undefined = pid;
  while (cur !== undefined && cur > 1 && !seen.has(cur) && chain.length < 64) {
    seen.add(cur);
    chain.push(cur);
    cur = await table.parent(cur);
  }
  return chain;
}

/** Strategy: find a raise target for a pid (or undefined), then raise it. */
interface Raiser {
  /** Prepared once per raise() (e.g. one window listing). */
  prepare(): Promise<(pid: number) => Promise<string | undefined>>;
  focus(target: string): Promise<void>;
  /** Called with the ancestor chains when no target was found. */
  notFound?(chains: number[][]): Promise<void>;
  /** Called with the pids given (empty: no herdr client found). */
  noPids?(): void;
}

function windowManager(listWindows: () => Promise<Map<number, string>>, focus: (t: string) => Promise<void>): Raiser {
  return {
    async prepare() {
      const windows = await listWindows();
      return async (pid) => windows.get(pid);
    },
    focus,
  };
}

function hyprland(exec: Exec, timeout: number): Raiser {
  return windowManager(
    async () => {
      const { stdout } = await exec("hyprctl", ["clients", "-j"], { timeout });
      const out = new Map<number, string>();
      for (const c of JSON.parse(stdout) as { pid?: unknown; address?: unknown }[]) {
        if (typeof c.pid === "number" && typeof c.address === "string" && !out.has(c.pid)) out.set(c.pid, c.address);
      }
      return out;
    },
    async (address) => {
      await exec("hyprctl", ["dispatch", "focuswindow", `address:${address}`], { timeout });
    },
  );
}

interface SwayNode {
  pid?: unknown;
  nodes?: SwayNode[];
  floating_nodes?: SwayNode[];
}

function sway(exec: Exec, timeout: number): Raiser {
  return windowManager(
    async () => {
      const { stdout } = await exec("swaymsg", ["-t", "get_tree"], { timeout });
      const out = new Map<number, string>();
      const walk = (n: SwayNode) => {
        if (typeof n.pid === "number") out.set(n.pid, String(n.pid));
        for (const c of [...(n.nodes ?? []), ...(n.floating_nodes ?? [])]) walk(c);
      };
      walk(JSON.parse(stdout) as SwayNode);
      return out;
    },
    async (pid) => {
      await exec("swaymsg", [`[pid=${pid}]`, "focus"], { timeout });
    },
  );
}

/** Outermost `.app` bundle containing an executable path, e.g. /Applications/kitty.app. */
export function appBundleOf(exe: string): string | undefined {
  const m = /^(\/.*?\.app)\//.exec(exe);
  return m?.[1];
}

function macos(exec: Exec, timeout: number, table: ProcessTable, log: Log): Raiser {
  const once = logOnce(log);
  return {
    async prepare() {
      return async (pid) => {
        const exe = await table.exe(pid);
        return exe ? appBundleOf(exe) : undefined;
      };
    },
    async focus(bundle) {
      const args = ["-a", bundle];
      try {
        await exec("open", args, { timeout });
      } catch (e) {
        once(`open:${bundle}`, `raise: ${describeExecFailure("open", args, e)}`);
        throw e;
      }
    },
    async notFound(chains) {
      const shown = await Promise.all(
        chains.map(async (chain) =>
          (await Promise.all(chain.map(async (p) => `${p} ${(await table.exe(p)) ?? "?"}`))).join(" <- "),
        ),
      );
      once("no-app", `raise: no .app bundle among the ancestors of herdr client(s): ${shown.join("; ")}`);
    },
    noPids() {
      once("no-pids", "raise: no herdr client process found (is herdr running in a terminal on this Mac?)");
    },
  };
}

export function createDesktop(opts: DesktopOptions = {}): Desktop {
  const { platform = process.platform, env = process.env, exec = defaultExec, timeoutMs = 2000 } = opts;
  const table = opts.table ?? createProcessTable({ platform, procRoot: opts.procRoot, exec, timeoutMs, log: opts.log });
  const log = opts.log ?? defaultLog;
  const kind: DesktopKind =
    platform === "darwin"
      ? "macos"
      : platform === "linux" && env.HYPRLAND_INSTANCE_SIGNATURE
        ? "hyprland"
        : platform === "linux" && env.SWAYSOCK
          ? "sway"
          : "none";
  const raiser =
    kind === "macos"
      ? macos(exec, timeoutMs, table, log)
      : kind === "hyprland"
        ? hyprland(exec, timeoutMs)
        : kind === "sway"
          ? sway(exec, timeoutMs)
          : undefined;
  return {
    kind,
    async raise(pids) {
      if (!raiser) return false;
      if (pids.length === 0) {
        raiser.noPids?.();
        return false;
      }
      try {
        const targetOf = await raiser.prepare();
        const chains: number[][] = [];
        for (const pid of pids) {
          const chain = await ancestry(table, pid);
          chains.push(chain);
          for (const p of chain) {
            const target = await targetOf(p);
            if (target !== undefined) {
              await raiser.focus(target);
              return true;
            }
          }
        }
        await raiser.notFound?.(chains);
      } catch {
        // no compositor, timeout, bad output: just don't raise
      }
      return false;
    },
  };
}
