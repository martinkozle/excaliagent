import { afterEach, describe, expect, it } from "vitest";
import { createHerdrLink, HERDR_METHODS, HERDR_SUBSCRIPTIONS, parsePaneMap } from "./herdr.ts";
import { createNoPaneLink } from "./none.ts";
import type { PaneLink } from "./types.ts";
import { parseLine } from "./herdr-client.ts";
import {
  recorded,
  recordedResult,
  startFakeHerdr,
  type FakeHerdr,
  type FakeRequest,
} from "./__fixtures__/fake-herdr.ts";
import { sleep, tempSocketDir, waitFor } from "./__fixtures__/test-util.ts";

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup(): Promise<{ socketPath: string; fake: FakeHerdr }> {
  const t = tempSocketDir();
  cleanups.push(t.cleanup);
  const fake = await startFakeHerdr(t.socketPath);
  cleanups.push(() => fake.close());
  return { socketPath: t.socketPath, fake };
}

function link(opts: Parameters<typeof createHerdrLink>[0]): PaneLink {
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
    expect(l.match(4210)).toEqual({ paneId: "w1:p1", workspaceId: "w1" });
    expect(l.match(5230)).toEqual({ paneId: "w2:p1", workspaceId: "w2" });
    expect(l.match(5310)).toEqual({ paneId: "w2:p3", workspaceId: "w2" });
    expect(l.match(99999)).toBeUndefined();
  });

  it("subscribes before taking the snapshot", async () => {
    const { socketPath, fake } = await setup();
    const l = link({ socketPath });
    await waitFor(() => l.match(4210) !== undefined);
    expect(fake.requests[0]).toMatchObject({
      method: "events.subscribe",
      params: { subscriptions: HERDR_SUBSCRIPTIONS },
    });
    expect(fake.requests[1]!.method).toBe("pane.list");
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

  it("rebuilds on a pane event and fires onChange when the map changed", async () => {
    const { socketPath, fake } = await setup();
    const l = link({ socketPath });
    await waitFor(() => l.match(4210) !== undefined);
    let changes = 0;
    l.onChange(() => changes++);
    fake.handler = withExtraPane;
    fake.emit(recorded.events.lines[1]!); // pane_created w1:p4
    await waitFor(() => l.match(4400) !== undefined, 2000, "new pane mapped");
    expect(l.match(4400)).toEqual({ paneId: "w1:p4", workspaceId: "w1" });
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
    expect(l.match(4400)).toEqual({ paneId: "w1:p4", workspaceId: "w1" });
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
    expect(l.match(5310)).toEqual({ paneId: "w2:p3", workspaceId: "w2" });
    fake.handler = () => ({ error: { code: "internal", message: "boom" } });
    await expect(l.refresh!()).resolves.toBeUndefined();
    expect(l.match(4210)).toEqual({ paneId: "w1:p1", workspaceId: "w1" });
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
