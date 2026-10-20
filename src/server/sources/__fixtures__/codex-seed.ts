// Builds a fake Codex home (sessions/YYYY/MM/DD rollouts, session_index.jsonl,
// thread-writer-locks/) in a temp dir. All data is synthetic, shaped like what
// codex-cli 0.163.0 wrote in throwaway runs; nothing here reads ~/.codex.
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CX_ALICE = "/home/alice/src/demo-app";
export const CX_BOB = "/home/alice/src/other-lib";
/** UUIDv7-shaped thread ids. */
export const tid = (n: number): string => `01a15935-0000-7000-8000-${String(n).padStart(12, "0")}`;

export const meta = (id: string, cwd: string, over: Record<string, unknown> = {}) => ({
  // Older than every other fixture line, so it never decides lastActivityAt.
  timestamp: "2026-10-01T00:00:00.000Z",
  type: "session_meta",
  payload: {
    session_id: id, id, timestamp: "2026-10-20T10:00:00.000Z", cwd, originator: "codex-tui", cli_version: "0.163.0",
    source: "vscode", thread_source: "user", model_provider: "openai", base_instructions: { text: "(synthetic)" },
    history_mode: "paginated", git: { branch: "main" }, ...over,
  },
});
export const ev = (at: string, payload: Record<string, unknown>) => ({ timestamp: at, type: "event_msg", payload });
export const started = (at: string) => ev(at, { type: "task_started", turn_id: "t" });
export const complete = (at: string) => ev(at, { type: "task_complete", turn_id: "t" });
export const aborted = (at: string) => ev(at, { type: "turn_aborted", turn_id: "t", reason: "interrupted" });
export const userItem = (at: string, text: string) =>
  ev(at, { type: "item_completed", thread_id: "x", turn_id: "t", item: { type: "UserMessage", id: "u", content: [{ type: "text", text, text_elements: [] }] } });
export const legacyUser = (at: string, message: string) => ev(at, { type: "user_message", message });
export const assistantItem = (at: string) =>
  ({ timestamp: at, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "(synthetic)" }] } });

export interface RolloutSpec {
  id: string;
  /** "2026/10/20"; default derived from nothing: "2026/10/20". */
  day?: string;
  /** File name stamp, default "2026-10-20T12-00-00". */
  stamp?: string;
  lines: Array<Record<string, unknown> | string>;
  mtimeMs?: number;
}

export interface CodexHomeSpec {
  rollouts?: RolloutSpec[];
  /** session_index.jsonl lines. */
  index?: Array<Record<string, unknown> | string>;
  /** Lock files to create (thread ids). */
  locks?: string[];
}

export interface SeededCodexHome {
  dir: string;
  rolloutPath(id: string): string;
  cleanup(): Promise<void>;
}

const encode = (lines: Array<Record<string, unknown> | string>) =>
  lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l) + "\n")).join("");

export async function seedCodexHome(spec: CodexHomeSpec): Promise<SeededCodexHome> {
  const dir = await mkdtemp(join(tmpdir(), "excaliagent-codex-"));
  const paths = new Map<string, string>();
  for (const r of spec.rollouts ?? []) {
    const day = join(dir, "sessions", ...(r.day ?? "2026/10/20").split("/"));
    await mkdir(day, { recursive: true });
    const p = join(day, `rollout-${r.stamp ?? "2026-10-20T12-00-00"}-${r.id}.jsonl`);
    await writeFile(p, encode(r.lines));
    if (r.mtimeMs !== undefined) await utimes(p, r.mtimeMs / 1000, r.mtimeMs / 1000);
    paths.set(r.id, p);
  }
  if (spec.index) await writeFile(join(dir, "session_index.jsonl"), encode(spec.index));
  await mkdir(join(dir, "thread-writer-locks"), { recursive: true });
  for (const id of spec.locks ?? []) await writeFile(join(dir, "thread-writer-locks", `${id}.lock`), "");
  return {
    dir,
    rolloutPath: (id) => paths.get(id)!,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
