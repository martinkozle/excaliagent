// One board per state dir: two servers saving the same scene.json would
// overwrite each other's edits. A running server records its port and pid in
// <stateDir>/server.json; a second start finds it (pid alive, and it answers to
// this state dir's token) and opens that board instead of starting another.
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cookieName } from "./http.ts";

interface Record {
  port: number;
  pid: number;
}

const recordPath = (stateDir: string) => join(stateDir, "server.json");

export async function recordRunning(stateDir: string, port: number, pid = process.pid): Promise<void> {
  await writeFile(recordPath(stateDir), JSON.stringify({ port, pid } satisfies Record), { mode: 0o600 });
}

/** Removes the record if it is `pid`'s (a newer server may have replaced it). */
export async function clearRunning(stateDir: string, pid = process.pid): Promise<void> {
  const r = await readRecord(stateDir);
  if (r?.pid === pid) await rm(recordPath(stateDir), { force: true });
}

async function readRecord(stateDir: string): Promise<Record | undefined> {
  try {
    const r = JSON.parse(await readFile(recordPath(stateDir), "utf8")) as Partial<Record>;
    return Number.isInteger(r.port) && Number.isInteger(r.pid) ? (r as Record) : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The port of a live board serving this state dir, if any. */
export async function findRunning(stateDir: string, token: string): Promise<number | undefined> {
  const r = await readRecord(stateDir);
  if (!r || !alive(r.pid)) return undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${r.port}/api/sessions`, {
      headers: { cookie: `${cookieName(r.port)}=${token}` },
      signal: AbortSignal.timeout(1500),
    });
    await res.body?.cancel();
    return res.ok ? r.port : undefined;
  } catch {
    return undefined;
  }
}
