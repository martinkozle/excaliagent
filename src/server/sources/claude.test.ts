import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types.ts";
import { createClaudeSource } from "./claude.ts";
import {
  ALICE, BOB, SLUG_A, type SeededHome, aiTitle, ms, registry, seedClaudeHome, sid, standardSpec, user,
} from "./__fixtures__/seed.ts";

const HOUR = 3600_000;
const FIVE_MIN = 300_000;
const silent = (): void => {};
const aliveSet = (...pids: number[]) => (pid: number) => pids.includes(pid);

let home: SeededHome | undefined;
afterEach(async () => {
  await home?.cleanup();
  home = undefined;
});

async function standard(alive = aliveSet(101, 102, 104)) {
  home = await seedClaudeHome(standardSpec());
  return createClaudeSource({ claudeDir: home.dir, isAlive: alive, log: silent });
}

describe("list", () => {
  it("returns live sessions only: drops dead pids and exited status", async () => {
    const src = await standard();
    const ids = (await src.list()).map((s) => s.id);
    expect(ids.sort()).toEqual([sid(1), sid(2)]);
  });

  it("merges a busy session from registry and transcript", async () => {
    const src = await standard();
    const s = (await src.list()).find((x) => x.id === sid(1));
    expect(s).toEqual<Session>({
      id: sid(1),
      source: "claude",
      cwd: ALICE,
      repo: "demo-app",
      branch: "feature/cards",
      title: "Second title",
      name: "demo-app-01",
      status: "busy",
      lastActivityAt: ms("2026-10-19T10:05:00.000Z"),
      cacheTtlMs: HOUR,
      cacheExpiresAt: ms("2026-10-19T10:02:00.000Z") + HOUR,
      live: true,
      pid: 101,
      prLinks: ["https://github.com/example/demo-app/pull/12", "https://github.com/example/demo-app/pull/13"],
    });
  });

  it("carries waitingFor and falls back to agent-name for the title", async () => {
    const src = await standard();
    const s = (await src.list()).find((x) => x.id === sid(2))!;
    expect(s.status).toBe("waiting");
    expect(s.waitingFor).toBe("input needed");
    expect(s.title).toBe("lib agent");
    expect(s.repo).toBe("other-lib");
    expect(s.cacheTtlMs).toBe(FIVE_MIN);
    expect(s.lastActivityAt).toBe(ms("2026-10-19T08:00:00.000Z"));
  });

  it("uses the transcript timestamp when it is newer than statusUpdatedAt", async () => {
    home = await seedClaudeHome({
      registry: [{ content: registry({ pid: 7, sessionId: sid(1), cwd: ALICE, status: "idle", statusUpdatedAt: 1000 }) }],
      transcripts: [{ slug: SLUG_A, sessionId: sid(1), lines: [user(sid(1), "2026-10-19T10:00:00.000Z", ALICE, "main")] }],
    });
    const [s] = await createClaudeSource({ claudeDir: home.dir, isAlive: () => true, log: silent }).list();
    expect(s!.lastActivityAt).toBe(ms("2026-10-19T10:00:00.000Z"));
  });

  it("registry fields win over transcript fields", async () => {
    home = await seedClaudeHome({
      registry: [{ content: registry({ pid: 7, sessionId: sid(1), cwd: "/home/alice/src/renamed", status: "idle", statusUpdatedAt: 1 }) }],
      transcripts: [{ slug: SLUG_A, sessionId: sid(1), lines: [user(sid(1), "2026-10-19T10:00:00.000Z", ALICE, "main")] }],
    });
    const [s] = await createClaudeSource({ claudeDir: home.dir, isAlive: () => true, log: silent }).list();
    expect(s!.cwd).toBe("/home/alice/src/renamed");
    expect(s!.repo).toBe("renamed");
  });

  it("handles a live session with no transcript yet", async () => {
    home = await seedClaudeHome({
      registry: [{ content: registry({ pid: 7, sessionId: sid(9), cwd: ALICE, name: "demo-app-09", status: "idle", statusUpdatedAt: 5 }) }],
    });
    const [s] = await createClaudeSource({ claudeDir: home.dir, isAlive: () => true, log: silent }).list();
    expect(s).toEqual<Session>({
      id: sid(9), source: "claude", cwd: ALICE, repo: "demo-app", name: "demo-app-09", status: "idle",
      lastActivityAt: 5, cacheTtlMs: 0, cacheExpiresAt: 0, live: true, pid: 7, prLinks: [],
    });
  });

  it("maps an unknown status to idle and dedupes a session id across pid files", async () => {
    home = await seedClaudeHome({
      registry: [
        { content: registry({ pid: 7, sessionId: sid(1), cwd: ALICE, status: "pondering", updatedAt: 10 }) },
        { content: registry({ pid: 8, sessionId: sid(1), cwd: ALICE, status: "needs_user", updatedAt: 20 }) },
      ],
    });
    const list = await createClaudeSource({ claudeDir: home.dir, isAlive: () => true, log: silent }).list();
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe("needs_user");
    expect(list[0]!.pid).toBe(8);
    const one = await createClaudeSource({ claudeDir: home.dir, isAlive: (p) => p === 7, log: silent }).list();
    expect(one[0]!.status).toBe("idle");
  });

  it("fails soft on a missing claude dir", async () => {
    const src = createClaudeSource({ claudeDir: "/nonexistent/excaliagent-test", log: silent });
    expect(await src.list()).toEqual([]);
    expect(await src.listDormant()).toEqual([]);
    expect(await src.get(sid(1))).toBeUndefined();
  });
});

describe("listDormant", () => {
  it("lists non-live transcripts newest first, ignoring subagent transcripts", async () => {
    const src = await standard();
    const list = await src.listDormant();
    expect(list.map((s) => s.id)).toEqual([sid(3), sid(4), sid(5), sid(6)]);
    for (const s of list) {
      expect(s.status).toBe("dormant");
      expect(s.live).toBe(false);
      expect(s.pid).toBeUndefined();
      expect(s.name).toBeUndefined();
    }
  });

  it("maps transcript data onto a dormant session", async () => {
    const src = await standard();
    const s = (await src.listDormant()).find((x) => x.id === sid(3))!;
    expect(s).toEqual<Session>({
      id: sid(3), source: "claude", cwd: ALICE, repo: "demo-app", branch: "main", status: "dormant",
      lastActivityAt: ms("2026-10-18T08:20:00.000Z"), cacheTtlMs: HOUR,
      cacheExpiresAt: ms("2026-10-18T08:20:00.000Z") + HOUR, live: false, prLinks: [], continuedIn: sid(7),
    });
  });

  it("falls back to a sibling transcript's cwd and to mtime for activity", async () => {
    const src = await standard();
    const s = (await src.listDormant()).find((x) => x.id === sid(5))!;
    expect(s.title).toBe("Never answered");
    expect(s.cwd).toBe(ALICE);
    expect(s.repo).toBe("demo-app");
    expect(s.lastActivityAt).toBe(ms("2026-10-16T08:00:00.000Z"));
  });

  it("caps at 200", async () => {
    const transcripts = Array.from({ length: 205 }, (_, i) => ({
      slug: SLUG_A,
      sessionId: `0a1b2c3d-1111-4000-8000-${String(i).padStart(12, "0")}`,
      mtimeMs: 1_700_000_000_000 + i * 1000,
      lines: [aiTitle("x", `t${i}`)],
    }));
    home = await seedClaudeHome({ transcripts });
    const list = await createClaudeSource({ claudeDir: home.dir, log: silent }).listDormant();
    expect(list).toHaveLength(200);
    expect(list[0]!.title).toBe("t204");
  });
});

describe("get", () => {
  it("returns live, dormant, or undefined", async () => {
    const src = await standard();
    expect((await src.get(sid(1)))!.live).toBe(true);
    expect((await src.get(sid(5)))!.status).toBe("dormant");
    expect(await src.get(sid(9))).toBeUndefined();
  });
});

describe("watch", () => {
  let children: ChildProcess[] = [];
  let unsubs: Array<() => void> = [];
  beforeEach(() => {
    children = [];
    unsubs = [];
  });
  afterEach(() => {
    for (const u of unsubs) u();
    for (const c of children) c.kill("SIGKILL");
  });

  function track(src: ReturnType<typeof createClaudeSource>) {
    const calls: Session[][] = [];
    unsubs.push(src.watch((s) => calls.push(s)));
    return calls;
  }

  it("emits once initially, on registry changes, and on transcript appends; not when nothing changed", async () => {
    home = await seedClaudeHome(standardSpec());
    const source = createClaudeSource({ claudeDir: home.dir, isAlive: aliveSet(101, 102, 104, 110), log: silent, pollMs: 40, debounceMs: 10 });
    const calls = track(source);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toHaveLength(1);

    await writeFile(join(home!.dir, "sessions", "110.json"), JSON.stringify(registry({ pid: 110, sessionId: sid(8), cwd: BOB, status: "busy", statusUpdatedAt: 1 })));
    await vi.waitFor(() => expect(calls.at(-1)!.map((s) => s.id)).toContain(sid(8)));

    const n = calls.length;
    await appendFile(home!.transcriptPath(SLUG_A, sid(1)), JSON.stringify(aiTitle(sid(1), "Third title")) + "\n");
    await vi.waitFor(() => expect(calls.at(-1)!.find((s) => s.id === sid(1))!.title).toBe("Third title"));
    expect(calls.length).toBe(n + 1);
  });

  it("stops emitting after unsubscribe", async () => {
    home = await seedClaudeHome(standardSpec());
    const source = createClaudeSource({ claudeDir: home.dir, isAlive: () => true, log: silent, pollMs: 30, debounceMs: 5 });
    const calls: Session[][] = [];
    const unsub = source.watch((s) => calls.push(s));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    unsub();
    await rm(join(home.dir, "sessions", "101.json"));
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toHaveLength(1);
  });

  it("uses real liveness: a session drops out when its process dies", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], { stdio: "ignore" });
    children.push(child);
    home = await seedClaudeHome({
      registry: [{ content: registry({ pid: child.pid!, sessionId: sid(1), cwd: ALICE, status: "idle", statusUpdatedAt: 1 }) }],
    });
    const calls = track(createClaudeSource({ claudeDir: home.dir, log: silent, pollMs: 30, debounceMs: 5 }));
    await vi.waitFor(() => expect(calls.at(-1)?.map((s) => s.id)).toEqual([sid(1)]));
    child.kill("SIGKILL");
    await vi.waitFor(() => expect(calls.at(-1)).toEqual([]), { timeout: 3000 });
  });

  it("works when the sessions dir appears later (poll fallback)", async () => {
    home = await seedClaudeHome({});
    await rm(join(home.dir, "sessions"), { recursive: true });
    const calls = track(createClaudeSource({ claudeDir: home.dir, isAlive: () => true, log: silent, pollMs: 30, debounceMs: 5 }));
    await vi.waitFor(() => expect(calls).toEqual([[]]));
    await mkdir(join(home.dir, "sessions"));
    await writeFile(join(home.dir, "sessions", "5.json"), JSON.stringify(registry({ pid: 5, sessionId: sid(2), cwd: ALICE, status: "busy" })));
    await vi.waitFor(() => expect(calls.at(-1)!.map((s) => s.id)).toEqual([sid(2)]));
  });

  it("logs a bad registry file at most once across polls", async () => {
    home = await seedClaudeHome(standardSpec());
    const logs: string[] = [];
    const calls = track(createClaudeSource({ claudeDir: home.dir, isAlive: () => true, log: (m) => logs.push(m), pollMs: 20, debounceMs: 5 }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 150));
    expect(logs.filter((l) => l.includes("105.json"))).toHaveLength(1);
  });
});
