/**
 * Find herdr client processes (the TUI attached to a herdr server) by
 * scanning /proc: comm "herdr" and no "server" argument. Clients whose socket
 * (HERDR_SOCKET_PATH, else ~/.config/herdr/herdr.sock under their HOME) is
 * ours are returned. Clients whose socket cannot be read are a fallback only
 * when none match; a client known to be on another server is never returned.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function read(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function findHerdrClientPids(opts: { socketPath: string; procRoot?: string }): Promise<number[]> {
  const procRoot = opts.procRoot ?? "/proc";
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    return [];
  }
  const unknown: number[] = [];
  const ours: number[] = [];
  await Promise.all(
    entries
      .filter((e) => /^\d+$/.test(e))
      .map(async (e) => {
        const dir = join(procRoot, e);
        if ((await read(join(dir, "comm")))?.trim() !== "herdr") return;
        const argv = (await read(join(dir, "cmdline")))?.split("\0").filter(Boolean) ?? [];
        if (argv.slice(1).includes("server")) return;
        const pid = Number(e);
        const environ = await read(join(dir, "environ"));
        if (environ === undefined) {
          unknown.push(pid);
          return;
        }
        const env = new Map<string, string>();
        for (const kv of environ.split("\0")) {
          const i = kv.indexOf("=");
          if (i > 0) env.set(kv.slice(0, i), kv.slice(i + 1));
        }
        const home = env.get("HOME");
        const sock = env.get("HERDR_SOCKET_PATH") || (home ? join(home, ".config/herdr/herdr.sock") : undefined);
        if (sock === undefined) unknown.push(pid);
        else if (sock === opts.socketPath) ours.push(pid);
      }),
  );
  return (ours.length > 0 ? ours : unknown).sort((a, b) => a - b);
}
