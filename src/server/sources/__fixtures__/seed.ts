// Builds a fake Claude home (sessions/ + projects/) in a temp dir from a
// declarative spec. All data is synthetic; nothing here reads ~/.claude.
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RegistrySpec {
  /** File name in sessions/, default `<pid>.json`. */
  file?: string;
  /** Object written as JSON, or a raw string written verbatim. */
  content: Record<string, unknown> | string;
}

export interface TranscriptSpec {
  /** Project dir name, e.g. "-home-alice-src-demo-app". */
  slug: string;
  sessionId: string;
  /** Objects become one JSON line each; strings are written verbatim (add your own "\n"). */
  lines: Array<Record<string, unknown> | string>;
  /** Optional mtime (epoch ms) to set on the file. */
  mtimeMs?: number;
}

export interface HomeSpec {
  registry?: RegistrySpec[];
  transcripts?: TranscriptSpec[];
  /** Extra raw files, path relative to the home. */
  extra?: Record<string, string>;
}

export interface SeededHome {
  dir: string;
  transcriptPath(slug: string, sessionId: string): string;
  cleanup(): Promise<void>;
}

export function encodeTranscript(lines: TranscriptSpec["lines"]): string {
  return lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l) + "\n")).join("");
}

export async function seedClaudeHome(spec: HomeSpec): Promise<SeededHome> {
  const dir = await mkdtemp(join(tmpdir(), "excaliagent-claude-"));
  await mkdir(join(dir, "sessions"), { recursive: true });
  await mkdir(join(dir, "projects"), { recursive: true });
  for (const r of spec.registry ?? []) {
    const content = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
    const file = r.file ?? `${(r.content as { pid?: number }).pid}.json`;
    await writeFile(join(dir, "sessions", file), content);
  }
  for (const t of spec.transcripts ?? []) {
    await mkdir(join(dir, "projects", t.slug), { recursive: true });
    const p = join(dir, "projects", t.slug, `${t.sessionId}.jsonl`);
    await writeFile(p, encodeTranscript(t.lines));
    if (t.mtimeMs !== undefined) await utimes(p, t.mtimeMs / 1000, t.mtimeMs / 1000);
  }
  for (const [rel, text] of Object.entries(spec.extra ?? {})) {
    const p = join(dir, rel);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, text);
  }
  return {
    dir,
    transcriptPath: (slug, sessionId) => join(dir, "projects", slug, `${sessionId}.jsonl`),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// ---- line builders mirroring real Claude Code line shapes ----

export const aiTitle = (sessionId: string, title: string) => ({ type: "ai-title", aiTitle: title, sessionId });
export const agentName = (sessionId: string, name: string) => ({ type: "agent-name", agentName: name, sessionId });
export const prLink = (sessionId: string, prNumber: number, repo: string, timestamp: string) => ({
  type: "pr-link",
  sessionId,
  prNumber,
  prUrl: `https://github.com/${repo}/pull/${prNumber}`,
  prRepository: repo,
  timestamp,
});
export const continuedIn = (sessionId: string, next: string, timestamp: string) => ({
  type: "continued-in",
  timestamp,
  sessionId,
  continuedInSessionId: next,
});
export const user = (sessionId: string, timestamp: string, cwd: string, gitBranch: string) => ({
  type: "user",
  sessionId,
  timestamp,
  cwd,
  gitBranch,
  isSidechain: false,
  message: { role: "user", content: "synthetic prompt text" },
});
export const assistant = (
  sessionId: string,
  timestamp: string,
  cwd: string,
  gitBranch: string,
  cache: { h1?: number; m5?: number } = {},
) => ({
  type: "assistant",
  sessionId,
  timestamp,
  cwd,
  gitBranch,
  isSidechain: false,
  message: {
    role: "assistant",
    content: [{ type: "text", text: "synthetic reply text" }],
    usage: {
      input_tokens: 2,
      cache_read_input_tokens: 1000,
      cache_creation: { ephemeral_1h_input_tokens: cache.h1 ?? 0, ephemeral_5m_input_tokens: cache.m5 ?? 0 },
    },
  },
});
export const registry = (e: {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  status: string;
  waitingFor?: string;
  statusUpdatedAt?: number;
  updatedAt?: number;
}) => ({
  kind: "interactive",
  entrypoint: "cli",
  nameSource: "derived",
  version: "2.1.303",
  messagingSocketPath: `/run/user/1000/cc-socks/${e.pid}.sock`,
  ...e,
});

// ---- the standard scenario set ----

export const ALICE = "/home/alice/src/demo-app";
export const BOB = "/home/alice/src/other-lib";
export const SLUG_A = "-home-alice-src-demo-app";
export const SLUG_B = "-home-alice-src-other-lib";
export const sid = (n: number): string => `0a1b2c3d-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const ms = (iso: string): number => Date.parse(iso);

/** pids 101 busy, 102 waiting, 103 idle (dead pid in tests), 104 exited; 105 is garbage JSON. */
export function standardSpec(): HomeSpec {
  return {
    registry: [
      { content: registry({ pid: 101, sessionId: sid(1), cwd: ALICE, name: "demo-app-01", status: "busy", statusUpdatedAt: ms("2026-10-19T10:05:00.000Z"), updatedAt: ms("2026-10-19T10:05:00.000Z") }) },
      { content: registry({ pid: 102, sessionId: sid(2), cwd: BOB, name: "other-lib-02", status: "waiting", waitingFor: "input needed", statusUpdatedAt: ms("2026-10-19T08:00:00.000Z"), updatedAt: ms("2026-10-19T08:00:00.000Z") }) },
      { content: registry({ pid: 103, sessionId: sid(3), cwd: ALICE, name: "demo-app-03", status: "idle", statusUpdatedAt: ms("2026-10-18T08:00:00.000Z") }) },
      { content: registry({ pid: 104, sessionId: sid(4), cwd: ALICE, name: "demo-app-04", status: "exited", statusUpdatedAt: ms("2026-10-17T08:00:00.000Z") }) },
      { file: "105.json", content: '{"pid":105,"sessionId":' },
      { file: "101.0f0f0f0f.key", content: "not-a-real-key" },
    ],
    transcripts: [
      {
        // busy: two ai-titles (last wins), agent-name, duplicate pr-links, 1h cache
        slug: SLUG_A,
        sessionId: sid(1),
        mtimeMs: ms("2026-10-19T10:02:00.000Z"),
        lines: [
          user(sid(1), "2026-10-19T10:00:00.000Z", ALICE, "main"),
          aiTitle(sid(1), "First title"),
          agentName(sid(1), "demo agent"),
          assistant(sid(1), "2026-10-19T10:00:05.000Z", ALICE, "main", { m5: 2000 }),
          prLink(sid(1), 12, "example/demo-app", "2026-10-19T10:00:06.000Z"),
          user(sid(1), "2026-10-19T10:01:00.000Z", ALICE, "feature/cards"),
          aiTitle(sid(1), "Second title"),
          prLink(sid(1), 12, "example/demo-app", "2026-10-19T10:01:01.000Z"),
          prLink(sid(1), 13, "example/demo-app", "2026-10-19T10:01:02.000Z"),
          assistant(sid(1), "2026-10-19T10:02:00.000Z", ALICE, "feature/cards", { h1: 1500 }),
          { type: "attachment", timestamp: "2026-10-19T11:00:00.000Z", content: "attachment body" },
        ],
      },
      {
        // waiting: 5m cache, malformed lines, partial trailing line, agent-name only
        slug: SLUG_B,
        sessionId: sid(2),
        mtimeMs: ms("2026-10-19T07:59:00.000Z"),
        lines: [
          user(sid(2), "2026-10-19T07:58:00.000Z", BOB, "dev"),
          agentName(sid(2), "lib agent"),
          '{"type":"assistant", this is not json\n',
          "garbage\n",
          "\n",
          assistant(sid(2), "2026-10-19T07:58:10.000Z", BOB, "dev", { m5: 900 }),
          `{"type":"ai-title","aiTitle":"Never finish`,
        ],
      },
      {
        // stale (dead pid): 1h write then a cache-read-only turn, continued-in
        slug: SLUG_A,
        sessionId: sid(3),
        mtimeMs: ms("2026-10-18T08:30:00.000Z"),
        lines: [
          user(sid(3), "2026-10-18T08:00:00.000Z", ALICE, "main"),
          assistant(sid(3), "2026-10-18T08:00:10.000Z", ALICE, "main", { h1: 3000 }),
          assistant(sid(3), "2026-10-18T08:20:00.000Z", ALICE, "main"),
          continuedIn(sid(3), sid(7), "2026-10-18T08:30:00.000Z"),
        ],
      },
      {
        // exited: no cache writes at all
        slug: SLUG_A,
        sessionId: sid(4),
        mtimeMs: ms("2026-10-17T08:00:10.000Z"),
        lines: [
          user(sid(4), "2026-10-17T08:00:00.000Z", ALICE, "main"),
          assistant(sid(4), "2026-10-17T08:00:10.000Z", ALICE, "main"),
        ],
      },
      {
        // dormant: title only, no turns, no cwd
        slug: SLUG_A,
        sessionId: sid(5),
        mtimeMs: ms("2026-10-16T08:00:00.000Z"),
        lines: [aiTitle(sid(5), "Never answered")],
      },
      {
        // dormant: user turn only
        slug: SLUG_B,
        sessionId: sid(6),
        mtimeMs: ms("2026-10-15T08:00:00.000Z"),
        lines: [user(sid(6), "2026-10-15T08:00:00.000Z", BOB, "main")],
      },
    ],
    extra: {
      // subagent transcripts live one level deeper and must be ignored
      [`projects/${SLUG_A}/${sid(1)}/subagents/agent-x.jsonl`]:
        JSON.stringify(assistant(sid(1), "2026-10-19T12:00:00.000Z", ALICE, "main")) + "\n",
    },
  };
}
