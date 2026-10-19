// Reads Claude Code's live-session registry: <claudeDir>/sessions/<pid>.json.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Warn } from "./log.ts";

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  /** Raw status string; may be one we do not know yet. */
  status: string;
  waitingFor?: string;
  statusUpdatedAt?: number;
  updatedAt?: number;
}

export type IsAlive = (pid: number) => boolean;

/** `kill -0`: success or EPERM means the process exists. */
export const defaultIsAlive: IsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export function isLive(entry: Pick<RegistryEntry, "pid" | "status">, isAlive: IsAlive): boolean {
  return entry.status !== "exited" && isAlive(entry.pid);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function parseEntry(raw: unknown): RegistryEntry | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const pid = num(o.pid);
  const sessionId = str(o.sessionId);
  if (pid === undefined || pid <= 0 || !sessionId) return undefined;
  const e: RegistryEntry = { pid, sessionId, cwd: str(o.cwd) ?? "", status: str(o.status) ?? "idle" };
  const name = str(o.name);
  const waitingFor = str(o.waitingFor);
  const statusUpdatedAt = num(o.statusUpdatedAt);
  const updatedAt = num(o.updatedAt);
  if (name !== undefined) e.name = name;
  if (waitingFor !== undefined) e.waitingFor = waitingFor;
  if (statusUpdatedAt !== undefined) e.statusUpdatedAt = statusUpdatedAt;
  if (updatedAt !== undefined) e.updatedAt = updatedAt;
  return e;
}

/**
 * All parseable registry entries (live or not). Missing dir → []. Bad files are
 * skipped and reported via `warn(message, key)`.
 */
export async function readRegistry(
  sessionsDir: string,
  warn: Warn,
): Promise<RegistryEntry[]> {
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return [];
  }
  const out: RegistryEntry[] = [];
  for (const f of files.sort()) {
    if (!f.endsWith(".json")) continue;
    const p = join(sessionsDir, f);
    let text: string;
    try {
      text = await readFile(p, "utf8");
    } catch {
      continue; // vanished between readdir and read: a session just exited
    }
    let entry: RegistryEntry | undefined;
    try {
      entry = parseEntry(JSON.parse(text));
    } catch {
      entry = undefined;
    }
    if (entry) out.push(entry);
    else warn(`excaliagent: skipping unreadable Claude registry file ${p}`, p);
  }
  return out;
}
