/**
 * Starts a THROWAWAY herdr server: temp HOME/XDG dirs and its own socket, with
 * every inherited HERDR_* variable removed, so nothing reaches a herdr session
 * the user may be running. Used by the opt-in e2e test and record-isolated.ts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface IsolatedHerdr {
  dir: string;
  socketPath: string;
  stop(): Promise<void>;
}

export async function startIsolatedHerdr(opts: { shell?: string } = {}): Promise<IsolatedHerdr> {
  const dir = mkdtempSync("/tmp/hdr-"); // short: sun_path is ~107 bytes
  const socketPath = join(dir, "h.sock");
  const live = [process.env.HERDR_SOCKET_PATH, join(homedir(), ".config/herdr/herdr.sock")];
  if (live.includes(socketPath)) throw new Error("refusing to use a live herdr socket");

  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("HERDR_")) env[k] = v;
  Object.assign(env, {
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "home/.config"),
    XDG_STATE_HOME: join(dir, "home/.state"),
    XDG_DATA_HOME: join(dir, "home/.local/share"),
    XDG_RUNTIME_DIR: dir,
    HERDR_SOCKET_PATH: socketPath,
    SHELL: opts.shell ?? "/bin/sh",
  });
  const server: ChildProcess = spawn("herdr", ["server"], { env, stdio: "ignore" });
  const exited = new Promise<void>((r) => server.once("exit", () => r()));
  for (let i = 0; i < 100 && !existsSync(socketPath); i++) await new Promise((r) => setTimeout(r, 50));
  if (!existsSync(socketPath)) {
    server.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
    throw new Error("isolated herdr server did not create its socket");
  }
  return {
    dir,
    socketPath,
    async stop() {
      if (server.exitCode === null) {
        server.kill("SIGTERM");
        const t = setTimeout(() => server.kill("SIGKILL"), 2000);
        await exited;
        clearTimeout(t);
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
