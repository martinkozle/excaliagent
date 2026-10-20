// Small /proc helpers shared by the adapters that find their sessions among
// running processes (Codex, OpenCode). Every reader takes the proc root, so
// tests and the demo point it at a synthetic tree (EXCALIAGENT_PROC_ROOT) and
// never read the machine's real processes.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Where the server reads processes from: the real /proc unless overridden (tests, demo). */
export function procRootFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.EXCALIAGENT_PROC_ROOT || undefined;
}

/** Field 22 of /proc/<pid>/stat: start time in clock ticks since boot. */
export function parseStartTicks(stat: string): number | undefined {
  const close = stat.lastIndexOf(")");
  const ticks = Number(stat.slice(close + 1).trim().split(/\s+/)[19]);
  return close > 0 && Number.isFinite(ticks) ? ticks : undefined;
}

/** Linux clock ticks per second (USER_HZ); 100 on every mainstream architecture. */
export const USER_HZ = 100;

/** Boot time (epoch s) from <procRoot>/stat, or undefined (not Linux). */
export async function bootTime(procRoot: string): Promise<number | undefined> {
  const stat = await readFile(join(procRoot, "stat"), "utf8").catch(() => undefined);
  const btime = stat ? Number(/^btime (\d+)$/m.exec(stat)?.[1]) : NaN;
  return Number.isFinite(btime) && btime > 0 ? btime : undefined;
}

/**
 * Epoch ms a process started (btime is whole seconds, so this can be up to 1 s
 * early), or 0 when unknown.
 */
export async function startedAt(procRoot: string, pid: number, btime: number | undefined): Promise<number> {
  if (btime === undefined) return 0;
  const ticks = parseStartTicks(await readFile(join(procRoot, String(pid), "stat"), "utf8").catch(() => ""));
  return ticks === undefined ? 0 : Math.floor((btime + ticks / USER_HZ) * 1000);
}
