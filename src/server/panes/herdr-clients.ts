/**
 * Find herdr client processes (the TUI attached to a herdr server): processes
 * whose executable name is "herdr" and that have no "server" argument. Clients
 * whose socket is ours are preferred; if none can be tied to it (environment
 * unreadable), every client is returned.
 */
import { basename, join } from "node:path";
import type { ProcessTable } from "../desktop/process-table.ts";

/**
 * herdr's API socket for an environment (checked on herdr 0.9.0 / Linux):
 * HERDR_SOCKET_PATH, else $XDG_CONFIG_HOME/herdr/herdr.sock, else
 * $HOME/.config/herdr/herdr.sock. The binary has no macOS-specific path
 * (no ~/Library); assumed the same there (unverified on real hardware).
 */
export function herdrSocketPath(env: Record<string, string | undefined>, home?: string): string | undefined {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "herdr", "herdr.sock");
  const h = env.HOME || home;
  return h ? join(h, ".config", "herdr", "herdr.sock") : undefined;
}

export async function findHerdrClientPids(opts: { socketPath: string; table: ProcessTable }): Promise<number[]> {
  const { table } = opts;
  const candidates = (await table.list()).filter((p) => basename(p.comm) === "herdr");
  const all: number[] = [];
  const ours: number[] = [];
  await Promise.all(
    candidates.map(async ({ pid }) => {
      const argv = await table.argv(pid);
      if (argv?.slice(1).includes("server")) return;
      all.push(pid);
      const env = await table.env(pid);
      if (env && herdrSocketPath(env) === opts.socketPath) ours.push(pid);
    }),
  );
  return (ours.length > 0 ? ours : all).sort((a, b) => a - b);
}
