import { execFile } from "node:child_process";

/** execFile without a shell; rejects on non-zero exit or timeout (error carries `stderr`). */
export type Exec = (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>;

export const defaultExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeout, maxBuffer: 16 << 20, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout });
    });
  });

/** "`cmd args` failed: <stderr, else message>" for logs. */
export function describeExecFailure(file: string, args: string[], err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
  const detail = stderr || (typeof e?.message === "string" ? e.message : String(err));
  return `\`${[file, ...args].join(" ")}\` failed: ${detail}`;
}

export type Log = (message: string) => void;

export const defaultLog: Log = (m) => console.warn(`excaliagent: ${m}`);

/** Wraps a logger so each key is reported at most once. */
export function logOnce(log: Log): (key: string, message: string) => void {
  const seen = new Set<string>();
  return (key, message) => {
    if (seen.has(key)) return;
    seen.add(key);
    log(message);
  };
}
