import { afterEach, describe, expect, it } from "vitest";
import { createHerdrLink, HERDR_METHODS, HERDR_SUBSCRIPTIONS, isInside, parsePaneMap } from "./herdr.ts";
import { createNoPaneLink } from "./none.ts";
import { parseLine } from "./herdr-client.ts";
import {
  recorded,
  recordedResult,
  startFakeHerdr,
  type FakeHerdr,
  type FakeRequest,
} from "./__fixtures__/fake-herdr.ts";
import { sleep, tempSocketDir, waitFor } from "./__fixtures__/test-util.ts";
import { createProcessTable, type ProcessTable } from "../desktop/process-table.ts";
import { fakeProcRoot } from "../desktop/__fixtures__/fake-proc.ts";

/** Linux process table over a fake /proc: one herdr client (700) of socketPath and the server (701). */
function fakeProcWithClient(_dir: string, socketPath: string): ProcessTable {
  const p = fakeProcRoot([
    { pid: 700, ppid: 1, comm: "herdr", argv: ["herdr"], env: { HERDR_SOCKET_PATH: socketPath } },
    { pid: 701, ppid: 1, comm: "herdr", argv: ["herdr", "server"], env: { HERDR_SOCKET_PATH: socketPath } },
  ]);
  cleanups.push(p.cleanup);
  return createProcessTable({ platform: "linux", procRoot: p.root });
}

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup(): Promise<{ socketPath: string; fake: FakeHerdr; dir: string }> {
  const t = tempSocketDir();
  cleanups.push(t.cleanup);
  const fake = await startFakeHerdr(t.socketPath);
  cleanups.push(() => fake.close());
  return { socketPath: t.socketPath, fake, dir: t.dir };
}

function link(opts: Parameters<typeof createHerdrLink>[0]): ReturnType<typeof createHerdrLink> {
  const l = createHerdrLink({ retryMinMs: 10, retryMaxMs: 40, requestTimeoutMs: 200, ...opts });
  cleanups.push(() => l.close());
  return l;
}

const count = (fake: FakeHerdr, method: string) => fake.requests.filter((r) => r.method === method).length;

/** Fixture handler plus an extra pane w1:p4 running pid 4400. */
function withExtraPane(req: FakeRequest): unknown {
  const base = recordedResult(req) as { panes?: unknown[] };
  if (req.method === "pane.list") {
    return { ...base, panes: [...base.panes!, { pane_id: "w1:p4", workspace_id: "w1" }] };
  }
  if (req.method === "pane.process_info" && req.params.pane_id === "w1:p4") {
    return {
      type: "pane_process_info",
      process_info: {
        pane_id: "w1:p4",
        shell_pid: 4399,
        foreground_processes: [{ pid: 4400, name: ".claude-wrapped", argv: ["claude"] }],
      },
    };
  }
  return base;
}

describe("fixtures follow the herdr 0.9.0 schema", () => {
  it("uses only methods and subscription types that exist", () => {
    for (const m of HERDR_METHODS) expect(recorded.schema.methods).toContain(m);
    for (const s of HERDR_SUBSCRIPTIONS) expect(recorded.schema.subscriptionTypes).toContain(s.type);
  });

  it("subscribes to pane, tab and workspace lifecycle + rename events", () => {
    expect(HERDR_SUBSCRIPTIONS.map((s) => s.type)).toEqual([
      "pane.created",
      "pane.closed",
      "pane.exited",
      "pane.agent_detected",
      "workspace.created",
      "workspace.renamed",
      "workspace.closed",
      "tab.created",
      "tab.renamed",
      "tab.closed",
    ]);
  });

  it("synthetic responses carry every required field", () => {
    const { required } = recorded.schema;
    for (const p of JSON.parse(recorded.paneList.response).result.panes) {
      for (const k of required.PaneInfo) expect(p).toHaveProperty(k);
    }
    for (const ex of recorded.processInfo) {
      const info = JSON.parse(ex.response).result.process_info;
      for (const k of required.PaneProcessInfo) expect(info).toHaveProperty(k);
      for (const proc of info.foreground_processes) {
        for (const k of required.PaneProcessInfoProcess) expect(proc).toHaveProperty(k);
      }
    }
    for (const w of JSON.parse(recorded.workspaceList.response).result.workspaces) {
      for (const k of required.WorkspaceInfo) expect(w).toHaveProperty(k);
    }
    for (const t of JSON.parse(recorded.tabList.response).result.tabs) {
      for (const k of required.TabInfo) expect(t).toHaveProperty(k);
    }
  });

  it("event lines (isolated capture and synthetic) parse to known event kinds", () => {
    for (const line of [...recorded.isolatedEvents.lines, ...recorded.events.lines].slice(1)) {
      const msg = parseLine(line);
      if (msg?.kind !== "event") continue;
      expect(recorded.schema.eventKinds).toContain(msg.event.event);
    }
    expect(parseLine(recorded.events.lines[0]!)).toMatchObject({ kind: "response" });
  });
});

describe("parsePaneMap", () => {
  it("maps every foreground pid to its pane", () => {
    const infos = recorded.processInfo.map((ex) => JSON.parse(ex.response).result.process_info);
    const map = parsePaneMap(infos);
    expect(map.get(4210)).toEqual({ paneId: "w1:p1", workspaceId: "w1" });
    expect(map.get(4250)).toEqual({ paneId: "w1:p1", workspaceId: "w1" });
    expect(map.get(5310)).toEqual({ paneId: "w2:p3", workspaceId: "w2" });
    expect(map.get(4101)).toBeUndefined(); // shell pid, not in the foreground
  });
});

describe("createHerdrLink", () => {
  it("builds the pid → pane map from pane.list + pane.process_info", async () => {
    const { socketPath } = await setup();
    const l = link({ socketPath });
    await waitFor(() => l.match(4210) !== undefined, 2000, "map");
    expect(l.available()).toBe(true);
    expect(l.match(4210)).toMatchObject({ paneId: "w1:p1", workspaceId: "w1" });
    expect(l.match(5230)).toMatchObject({ paneId: "w2:p1", workspaceId: "w2" });
    expect(l.match(5310)).toMatchObject({ paneId: "w2:p3", workspaceId: "w2" });
    expect(l.match(99999)).toBeUndefined();
  });

  it("attaches workspace and tab labels", async () => {
    const { socketPath } = await setup();
    const l = link({ socketPath });
    await waitFor(() => l.match(4210) !== undefined, 2000, "map");
    expect(l.match(4210)).toEqual({ paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "demo-app", tabLabel: "editor" });
    expect(l.match(5230)).toEqual({ paneId: "w2:p1", workspaceId: "w2", workspaceLabel: "api-server", tabLabel: "1" });
    expect(l.match(5310)).toEqual({ paneId: "w2:p3", workspaceId: "w2", workspaceLabel: "api-server", tabLabel: "review" });
  });

  it("a tab rename event updates the label and fires onChange", async () => {
    const { socketPath, fake } = await setup();
    const l = link({ socketPath });
    await waitFor(() => l.match(5310) !== undefined);
    let changes = 0;
    l.onChange(() => changes++);
    fake.handler = (req) => {
      const res = recordedResult(req) as { tabs?: { tab_id: string; label: string }[] };
      if (req.method !== "tab.list") return res;
      return { ...res, tabs: res.tabs!.map((t) => (t.tab_id === "w2:t2" ? { ...t, label: "code review" } : t)) };
    };
    fake.emit(recorded.events.lines.find((x) => x.includes("tab_renamed"))!);
    await waitFor(() => l.match(5310)?.tabLabel === "code review", 2000, "renamed tab");
    expect(changes).toBe(1);
  });

  it("a workspace rename event updates the label", async () => {
    const { socketPath, fake } = await setup();
    const l = link({ socketPath });
    await waitFor(() => l.match(5310) !== undefined);
    fake.handler = (req) => {
      const res = recordedResult(req) as { workspaces?: { workspace_id: string; label: string }[] };
      if (req.method !== "workspace.list") return res;
      return { ...res, workspaces: res.workspaces!.map((w) => (w.workspace_id === "w2" ? { ...w, label: "api" } : w)) };
    };
    fake.emit(recorded.events.lines.find((x) => x.includes("workspace_renamed"))!);
    await waitFor(() => l.match(5310)?.workspaceLabel === "api", 2000, "renamed workspace");
    expect(l.match(5230)?.workspaceLabel).toBe("api");
  });

  it("maps panes without labels when workspace.list / tab.list fail", async () => {
    const { socketPath, fake } = await setup();
    fake.handler = (req) =>
      req.method === "workspace.list" || req.method === "tab.list"
        ? { error: { code: "internal", message: "boom" } }
        : recordedResult(req);
    const l = link({ socketPath });
    await waitFor(() => l.match(4210) !== undefined);
    expect(l.match(4210)).toEqual({ paneId: "w1:p1", workspaceId: "w1" });
  });

  it("subscribes before taking the snapshot", async () => {
    const { socketPath, fake } = await setup();
    const l = link({ socketPath });
    await waitFor(() => l.match(4210) !== undefined);
    expect(fake.requests[0]).toMatchObject({
      method: "events.subscribe",
      params: { subscriptions: HERDR_SUBSCRIPTIONS },
    });
    expect(fake.requests.slice(1, 4).map((r) => r.method).sort()).toEqual(["pane.list", "tab.list", "workspace.list"]);
  });

  it("focus() sends pane.focus with the pane id", async () => {
    const { socketPath, fake } = await setup();
    const l = link({ socketPath });
    await waitFor(() => l.available());
    await l.focus("w2:p3");
    expect(fake.requests.find((r) => r.method === "pane.focus")).toMatchObject({
      method: "pane.focus",
      params: { pane_id: "w2:p3" },
    });
  });

  it("focus() rejects when herdr reports an error", async () => {
    const { socketPath, fake } = await setup();
    const l = link({ socketPath });
    await waitFor(() => l.available());
    fake.handler = () => ({ error: { code: "pane_not_found", message: "pane not found" } });
    await expect(l.focus("w9:p9")).rejects.toMatchObject({ code: "pane_not_found" });
  });

  it("clientPids() finds herdr clients of our socket", async () => {
    const { socketPath, dir } = await setup();
    const l = link({ socketPath, processTable: fakeProcWithClient(dir, socketPath) });
    expect(await l.clientPids()).toEqual([700]);
  });

  it("focus() raises the terminal window of the herdr client after pane.focus", async () => {
    const { socketPath, fake, dir } = await setup();
    const raised: number[][] = [];
    const l = link({
      socketPath,
      processTable: fakeProcWithClient(dir, socketPath),
      desktop: {
        raise: async (pids) => {
          expect(fake.requests.some((r) => r.method === "pane.focus")).toBe(true);
          raised.push(pids);
          return true;
        },
      },
    });
    await waitFor(() => l.available());
    await l.focus("w1:p1");
    expect(raised).toEqual([[700]]);
  });

  it("focus() does not raise when pane.focus fails, and a failing raise is harmless", async () => {
    const { socketPath, fake, dir } = await setup();
    let raises = 0;
    const l = link({
      socketPath,
      processTable: fakeProcWithClient(dir, socketPath),
      desktop: {
        raise: async () => {
          raises++;
          throw new Error("compositor exploded");
        },
      },
    });
    await waitFor(() => l.available());
    await expect(l.focus("w1:p1")).resolves.toBeUndefined();
    expect(raises).toBe(1);
    fake.handler = () => ({ error: { code: "pane_not_found", message: "pane not found" } });
    await expect(l.focus("w9:p9")).rejects.toMatchObject({ code: "pane_not_found" });
    expect(raises).toBe(1);
  });

  it("rebuilds on a pane event and fires onChange when the map changed", async () => {
    const { socketPath, fake } = await setup();
    const l = link({ socketPath });
    await waitFor(() => l.match(4210) !== undefined);
    let changes = 0;
    l.onChange(() => changes++);
    fake.handler = withExtraPane;
    fake.emit(recorded.events.lines[1]!); // pane_created w1:p4
    await waitFor(() => l.match(4400) !== undefined, 2000, "new pane mapped");
    expect(l.match(4400)).toMatchObject({ paneId: "w1:p4", workspaceId: "w1" });
    expect(changes).toBe(1);
  });

  it("does not fire onChange when a rebuild finds the same map", async () => {
    const { socketPath, fake } = await setup();
    const l = link({ socketPath });
    await waitFor(() => l.match(4210) !== undefined);
    let changes = 0;
    const off = l.onChange(() => changes++);
    const lists = count(fake, "pane.list");
    fake.emit(recorded.events.lines[4]!); // pane_closed
    await waitFor(() => count(fake, "pane.list") > lists, 2000, "rebuild");
    await sleep(50);
    expect(changes).toBe(0);
    off();
  });

  it("onChange unsubscribe works", async () => {
    const { socketPath, fake } = await setup();
    const l = link({ socketPath });
    await waitFor(() => l.match(4210) !== undefined);
    let changes = 0;
    l.onChange(() => changes++)();
    fake.handler = withExtraPane;
    await l.refresh!();
    expect(l.match(4400)).toBeDefined();
    expect(changes).toBe(0);
  });

  it("resyncs on events_lost", async () => {
    const { socketPath, fake } = await setup();
    const l = link({ socketPath });
    await waitFor(() => l.match(4210) !== undefined);
    fake.handler = withExtraPane;
    const subId = fake.requests[0]!.id;
    fake.emit(JSON.stringify({ id: subId, error: { code: "events_lost", message: "lagged" } }));
    await waitFor(() => l.match(4400) !== undefined, 2000, "resync");
  });

  it("resyncs on a timer", async () => {
    const { socketPath, fake } = await setup();
    const l = link({ socketPath, resyncMs: 30 });
    await waitFor(() => l.match(4210) !== undefined);
    await waitFor(() => count(fake, "pane.list") >= 3, 2000, "periodic resync");
  });

  it("refresh() re-matches now", async () => {
    const { socketPath, fake } = await setup();
    const l = link({ socketPath });
    await waitFor(() => l.match(4210) !== undefined);
    fake.handler = withExtraPane;
    await l.refresh!();
    expect(l.match(4400)).toMatchObject({ paneId: "w1:p4", workspaceId: "w1" });
  });

  it("is unavailable without throwing when the socket is absent, and picks it up later", async () => {
    const t = tempSocketDir();
    cleanups.push(t.cleanup);
    const l = link({ socketPath: t.socketPath });
    await sleep(50);
    expect(l.available()).toBe(false);
    expect(l.match(4210)).toBeUndefined();
    await expect(l.focus("w1:p1")).resolves.toBeUndefined();
    await expect(l.refresh!()).resolves.toBeUndefined();
    const fake = await startFakeHerdr(t.socketPath);
    cleanups.push(() => fake.close());
    await waitFor(() => l.match(4210) !== undefined, 2000, "map after socket appears");
    expect(l.available()).toBe(true);
  });

  it("clears the map when herdr drops, then reconnects and rebuilds", async () => {
    const { socketPath, fake } = await setup();
    const l = link({ socketPath, retryMinMs: 150, retryMaxMs: 300 });
    await waitFor(() => l.match(4210) !== undefined);
    let changes = 0;
    l.onChange(() => changes++);
    fake.dropAll();
    await waitFor(() => !l.available(), 2000, "unavailable");
    expect(l.match(4210)).toBeUndefined();
    expect(changes).toBe(1);
    await waitFor(() => l.available() && l.match(4210) !== undefined, 2000, "rebuilt");
    expect(changes).toBe(2);
  });

  it("tolerates error responses: skips failing panes, keeps the map when pane.list fails", async () => {
    const { socketPath, fake } = await setup();
    fake.handler = (req) =>
      req.method === "pane.process_info" && req.params.pane_id === "w2:p1"
        ? { error: { code: "pane_not_found", message: "pane not found" } }
        : recordedResult(req);
    const l = link({ socketPath });
    await waitFor(() => l.match(4210) !== undefined);
    expect(l.match(5230)).toBeUndefined();
    expect(l.match(5310)).toMatchObject({ paneId: "w2:p3", workspaceId: "w2" });
    fake.handler = () => ({ error: { code: "internal", message: "boom" } });
    await expect(l.refresh!()).resolves.toBeUndefined();
    expect(l.match(4210)).toMatchObject({ paneId: "w1:p1", workspaceId: "w1" });
  });

  it("a hanging process_info times out and the rest of the map still builds", async () => {
    const { socketPath, fake } = await setup();
    fake.handler = (req) =>
      req.method === "pane.process_info" && req.params.pane_id === "w1:p2" ? "hang" : recordedResult(req);
    const l = link({ socketPath, requestTimeoutMs: 50 });
    await waitFor(() => l.match(4210) !== undefined, 2000, "map despite hang");
    expect(l.match(4102)).toBeUndefined();
  });

  it("close() releases everything", async () => {
    const { socketPath, fake } = await setup();
    const l = link({ socketPath, resyncMs: 20 });
    await waitFor(() => l.available());
    l.close();
    await waitFor(() => fake.subscribers() === 0);
    await sleep(30); // let lines written before close() reach the fake
    const n = fake.requests.length;
    await sleep(80);
    expect(fake.requests.length).toBe(n);
    expect(l.available()).toBe(false);
  });
});

describe("isInside", () => {
  it("matches on a separator boundary", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
    expect(isInside("/a/b/c", "/a/b/")).toBe(true);
    expect(isInside("/a/bc", "/a/b")).toBe(false);
    expect(isInside("/a", "/a/b")).toBe(false);
    expect(isInside("/anything", "/")).toBe(true);
  });
});

describe("createHerdrLink resume", () => {
  const REQ = { command: "claude --resume 0b6f3c1e-1111-4a2b-9c3d-123456789abc", label: "Fix login" };

  /** pane.list with the given [pane_id, cwd, focused] rows; everything else from fixtures. */
  const withPanes = (rows: [string, string, boolean][]) => (req: FakeRequest) =>
    req.method === "pane.list"
      ? {
          type: "pane_list",
          panes: rows.map(([id, cwd, focused]) => ({
            pane_id: id, workspace_id: id.split(":")[0], tab_id: id.split(":")[0] + ":t1", cwd, foreground_cwd: cwd, focused,
          })),
        }
      : recordedResult(req);

  async function resumeWith(handler: ((r: FakeRequest) => unknown) | undefined, req: Parameters<NonNullable<ReturnType<typeof createHerdrLink>["resume"]>>[0]) {
    const { socketPath, fake, dir } = await setup();
    if (handler) fake.handler = handler;
    const raised: number[][] = [];
    const l = link({
      socketPath,
      processTable: fakeProcWithClient(dir, socketPath),
      desktop: { raise: async (p) => (raised.push(p), true) },
    });
    await waitFor(() => l.available());
    const before = fake.requests.length;
    const result = await l.resume!(req);
    const calls = fake.requests.slice(before).filter((r) => r.method !== "pane.list" && r.method !== "pane.process_info" && !r.method.endsWith(".list"));
    return { result, calls, raised, fake, l };
  }

  it("opens a tab in the workspace whose pane is inside repoRoot, types the command, raises", async () => {
    const { result, calls, raised } = await resumeWith(undefined, {
      ...REQ,
      cwd: "/home/alice/src/demo-app/packages/web",
      repoRoot: "/home/alice/src/demo-app",
    });
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ["tab.create", { workspace_id: "w1", cwd: "/home/alice/src/demo-app/packages/web", label: "Fix login", focus: true }],
      ["pane.send_text", { pane_id: "w1:p9", text: "claude --resume 0b6f3c1e-1111-4a2b-9c3d-123456789abc\n" }],
    ]);
    expect(result).toEqual({ paneId: "w1:p9" });
    expect(raised).toEqual([[700]]);
  });

  it("matches on a path boundary: /a/b is not inside /a/bc", async () => {
    const { calls } = await resumeWith(
      withPanes([["w1:p1", "/a/bc", false], ["w2:p1", "/a/b/sub", false]]),
      { ...REQ, cwd: "/a/b" },
    );
    expect(calls[0]).toMatchObject({ method: "tab.create", params: { workspace_id: "w2" } });
  });

  it("an exact cwd match counts; foreground_cwd counts too", async () => {
    const exact = await resumeWith(withPanes([["w3:p1", "/a/b", false]]), { ...REQ, cwd: "/a/b" });
    expect(exact.calls[0]).toMatchObject({ method: "tab.create", params: { workspace_id: "w3" } });
    const fg = await resumeWith(
      (req) =>
        req.method === "pane.list"
          ? { type: "pane_list", panes: [{ pane_id: "w4:p1", workspace_id: "w4", cwd: "/elsewhere", foreground_cwd: "/a/b/x", focused: false }] }
          : recordedResult(req),
      { ...REQ, cwd: "/a/b" },
    );
    expect(fg.calls[0]).toMatchObject({ method: "tab.create", params: { workspace_id: "w4" } });
  });

  it("prefers the workspace holding the focused pane, else the first match", async () => {
    const focused = await resumeWith(
      withPanes([["w1:p1", "/a/b", false], ["w2:p1", "/a/b", true]]),
      { ...REQ, cwd: "/a/b" },
    );
    expect(focused.calls[0]).toMatchObject({ params: { workspace_id: "w2" } });
    const first = await resumeWith(
      withPanes([["w1:p1", "/a/b", false], ["w2:p1", "/a/b", false], ["w5:p1", "/zzz", true]]),
      { ...REQ, cwd: "/a/b" },
    );
    expect(first.calls[0]).toMatchObject({ params: { workspace_id: "w1" } });
  });

  it("creates a workspace named after the repo when no workspace matches", async () => {
    const { calls, result } = await resumeWith(withPanes([["w1:p1", "/a/bc", true]]), {
      ...REQ,
      cwd: "/a/b/pkg",
      repoRoot: "/a/b",
    });
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ["workspace.create", { cwd: "/a/b/pkg", label: "b", focus: true }],
      ["pane.send_text", { pane_id: "w9:p1", text: REQ.command + "\n" }],
    ]);
    expect(result).toEqual({ paneId: "w9:p1" });
  });

  it("rebuilds the pid map shortly after resuming", async () => {
    const { socketPath, fake } = await setup();
    const l = link({ socketPath, resumeRefreshMs: 20 });
    await waitFor(() => l.match(4210) !== undefined);
    const lists = count(fake, "pane.list");
    await l.resume!({ ...REQ, cwd: "/home/alice/src/demo-app" });
    await waitFor(() => count(fake, "pane.list") >= lists + 2, 2000, "rebuild after resume");
  });

  it("rejects when herdr is unavailable or errors, and does not type anything", async () => {
    const t = tempSocketDir();
    cleanups.push(t.cleanup);
    const off = link({ socketPath: t.socketPath });
    await expect(off.resume!({ ...REQ, cwd: "/a" })).rejects.toMatchObject({ code: "unavailable" });

    const { socketPath, fake } = await setup();
    const l = link({ socketPath });
    await waitFor(() => l.available());
    fake.handler = (req) =>
      req.method === "tab.create" ? { error: { code: "workspace_not_found", message: "gone" } } : recordedResult(req);
    await expect(l.resume!({ ...REQ, cwd: "/home/alice/src/demo-app" })).rejects.toMatchObject({ code: "workspace_not_found" });
    expect(fake.requests.some((r) => r.method === "pane.send_text")).toBe(false);
  });
});

describe("createNoPaneLink", () => {
  it("is never available and does nothing", async () => {
    const l = createNoPaneLink();
    expect(l.available()).toBe(false);
    expect(l.match(1)).toBeUndefined();
    await expect(l.focus("w1:p1")).resolves.toBeUndefined();
    const off = l.onChange(() => {});
    off();
    l.close();
  });
});
