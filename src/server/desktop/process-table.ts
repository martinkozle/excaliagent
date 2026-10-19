/**
 * Minimal process information, portable across Linux and macOS.
 *
 * - linux: /proc (stat, comm, cmdline, environ, exe). No subprocesses.
 * - darwin: `ps -axww -o pid=,ppid=,comm=` (comm is the full executable path
 *   on macOS), `ps -ww -o command= -p N` for argv and `ps -E -ww -o command= -p N`
 *   for the environment (own-user processes only; -E = "display the environment"). argv/env are split on
 *   whitespace, so arguments or values containing spaces are approximate.
 *   Unverified on real hardware; CI runs the parsers against fixtures.
 * - anything else: an empty table.
 * Every method fails soft (empty / undefined).
 */
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { defaultExec, defaultLog, describeExecFailure, logOnce, type Exec, type Log } from "./exec.ts";

export interface ProcEntry {
  pid: number;
  ppid: number;
  /** linux: /proc comm (short name); darwin: executable path. */
  comm: string;
}

export interface ProcessTable {
  list(): Promise<ProcEntry[]>;
  parent(pid: number): Promise<number | undefined>;
  argv(pid: number): Promise<string[] | undefined>;
  env(pid: number): Promise<Record<string, string> | undefined>;
  /** Executable path, when known. */
  exe(pid: number): Promise<string | undefined>;
}

export interface ProcessTableOptions {
  platform?: NodeJS.Platform;
  procRoot?: string;
  exec?: Exec;
  timeoutMs?: number;
  /** darwin: how long one `ps` listing is reused. */
  cacheMs?: number;
  /** darwin: `ps` failures are reported here once each (default: console.warn). */
  log?: Log;
}

const read = (p: string) => readFile(p, "utf8").catch(() => undefined);

function parseStat(stat: string): { comm: string; ppid: number } | undefined {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const ppid = Number(stat.slice(close + 1).trim().split(/\s+/)[1]);
  return Number.isInteger(ppid) ? { comm: stat.slice(open + 1, close), ppid } : undefined;
}

function linuxTable(procRoot: string): ProcessTable {
  const stat = async (pid: number) => {
    const s = await read(join(procRoot, String(pid), "stat"));
    return s === undefined ? undefined : parseStat(s);
  };
  return {
    async list() {
      let entries: string[];
      try {
        entries = await readdir(procRoot);
      } catch {
        return [];
      }
      const out = await Promise.all(
        entries
          .filter((e) => /^\d+$/.test(e))
          .map(async (e) => {
            const s = await stat(Number(e));
            return s ? { pid: Number(e), ppid: s.ppid, comm: s.comm } : undefined;
          }),
      );
      return out.filter((p): p is ProcEntry => p !== undefined);
    },
    async parent(pid) {
      const ppid = (await stat(pid))?.ppid;
      return ppid !== undefined && ppid > 0 ? ppid : undefined;
    },
    async argv(pid) {
      return (await read(join(procRoot, String(pid), "cmdline")))?.split("\0").filter(Boolean);
    },
    async env(pid) {
      const environ = await read(join(procRoot, String(pid), "environ"));
      if (environ === undefined) return undefined;
      const env: Record<string, string> = {};
      for (const kv of environ.split("\0")) {
        const i = kv.indexOf("=");
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      return env;
    },
    async exe(pid) {
      return readlink(join(procRoot, String(pid), "exe")).catch(() => undefined);
    },
  };
}

/** Lines of `ps -o pid=,ppid=,comm=`; comm runs to end of line (may contain spaces). */
export function parsePsList(out: string): ProcEntry[] {
  const list: ProcEntry[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3]!.trim() });
  }
  return list;
}

/**
 * Environment from `ps -E -ww -o command=`: the command line followed by
 * KEY=VALUE pairs. The known argv prefix is skipped; a token that is not
 * KEY=VALUE continues the previous value (values with spaces).
 */
export function parsePsEnv(out: string, argv: string[] = []): Record<string, string> {
  let rest = out.trim();
  const cmd = argv.join(" ");
  if (cmd && rest.startsWith(cmd)) rest = rest.slice(cmd.length);
  else if (argv.length > 0) return {};
  const env: Record<string, string> = {};
  let last: string | undefined;
  for (const tok of rest.split(/\s+/).filter(Boolean)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tok);
    if (m) {
      last = m[1]!;
      env[last] = m[2]!;
    } else if (last !== undefined) {
      env[last] += " " + tok;
    }
  }
  return env;
}

function darwinTable(exec: Exec, timeout: number, cacheMs: number, log: Log): ProcessTable {
  const once = logOnce(log);
  const ps = async (args: string[], key: string): Promise<string | undefined> => {
    try {
      return (await exec("ps", args, { timeout })).stdout;
    } catch (e) {
      once(key, `process table: ${describeExecFailure("ps", args, e)}`);
      return undefined;
    }
  };
  let cached: { at: number; list: Promise<ProcEntry[]> } | undefined;
  const list = () => {
    if (!cached || Date.now() - cached.at > cacheMs) {
      const listing = ps(["-axww", "-o", "pid=,ppid=,comm="], "list").then((out) => (out === undefined ? [] : parsePsList(out)));
      cached = { at: Date.now(), list: listing };
    }
    return cached.list;
  };
  // A process that exited meanwhile also makes ps fail: not worth a log line each.
  const argv = async (pid: number) => {
    const out = await ps(["-ww", "-o", "command=", "-p", String(pid)], "argv");
    const parts = out?.trim().split(/\s+/).filter(Boolean) ?? [];
    return parts.length > 0 ? parts : undefined;
  };
  return {
    list,
    async parent(pid) {
      const ppid = (await list()).find((p) => p.pid === pid)?.ppid;
      return ppid !== undefined && ppid > 0 ? ppid : undefined;
    },
    argv,
    async env(pid) {
      const args = await argv(pid);
      if (!args) return undefined;
      const out = await ps(["-E", "-ww", "-o", "command=", "-p", String(pid)], "env");
      return out === undefined ? undefined : parsePsEnv(out, args);
    },
    async exe(pid) {
      const comm = (await list()).find((p) => p.pid === pid)?.comm;
      return comm?.startsWith("/") ? comm : undefined;
    },
  };
}

const emptyTable: ProcessTable = {
  list: async () => [],
  parent: async () => undefined,
  argv: async () => undefined,
  env: async () => undefined,
  exe: async () => undefined,
};

export function createProcessTable(opts: ProcessTableOptions = {}): ProcessTable {
  const { platform = process.platform, procRoot = "/proc", exec = defaultExec, timeoutMs = 2000, cacheMs = 1000 } = opts;
  const log = opts.log ?? defaultLog;
  if (platform === "linux") return linuxTable(procRoot);
  if (platform === "darwin") return darwinTable(exec, timeoutMs, cacheMs, log);
  return emptyTable;
}
