import { afterEach, describe, expect, it } from "vitest";
import { createHerdrClient, herdrRequest, HerdrError, type HerdrClient, type HerdrEvent } from "./herdr-client.ts";
import { recorded, startFakeHerdr, type FakeHerdr } from "./__fixtures__/fake-herdr.ts";
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

function client(opts: Parameters<typeof createHerdrClient>[0]): HerdrClient {
  const c = createHerdrClient({ retryMinMs: 10, retryMaxMs: 40, ...opts });
  cleanups.push(() => c.close());
  return c;
}

describe("herdrRequest", () => {
  it("sends {id, method, params} and resolves the result", async () => {
    const { socketPath, fake } = await setup();
    const result = (await herdrRequest(socketPath, "pane.list", {})) as { panes: unknown[] };
    expect(result.panes).toHaveLength(4);
    expect(fake.requests[0]).toMatchObject({ method: "pane.list", params: {} });
    expect(typeof fake.requests[0]!.id).toBe("string");
  });

  it("rejects with HerdrError carrying the herdr error code", async () => {
    const { socketPath } = await setup();
    const err = await herdrRequest(socketPath, "pane.process_info", { pane_id: "w9:p9" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("pane_not_found");
  });

  it("accepts an uncorrelated error with id \"\" (herdr's reply to a malformed request)", async () => {
    const { socketPath, fake } = await setup();
    const line = recorded.isolatedExchanges.at(-1)!.response; // {"id":"","error":{"code":"invalid_request",...}}
    fake.handler = () => ({ error: JSON.parse(line).error });
    const err = await herdrRequest(socketPath, "pane.list", {}).catch((e: unknown) => e);
    expect((err as HerdrError).code).toBe("invalid_request");
  });

  it("times out when herdr never answers", async () => {
    const { socketPath, fake } = await setup();
    fake.handler = () => "hang";
    const start = Date.now();
    const err = await herdrRequest(socketPath, "pane.list", {}, { timeoutMs: 60 }).catch((e: unknown) => e);
    expect((err as HerdrError).code).toBe("timeout");
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("rejects (does not throw synchronously) when the socket is absent", async () => {
    const t = tempSocketDir();
    cleanups.push(t.cleanup);
    const err = await herdrRequest(t.socketPath, "pane.list", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("unavailable");
  });
});

describe("createHerdrClient subscription", () => {
  it("subscribes, reports connected after the ack, and delivers events", async () => {
    const { socketPath, fake } = await setup();
    const events: HerdrEvent[] = [];
    let connects = 0;
    const c = client({
      socketPath,
      subscriptions: [{ type: "pane.created" }],
      onConnect: () => connects++,
      onEvent: (e) => events.push(e),
    });
    await waitFor(() => c.connected(), 2000, "connected");
    expect(connects).toBe(1);
    expect(fake.requests[0]).toMatchObject({
      method: "events.subscribe",
      params: { subscriptions: [{ type: "pane.created" }] },
    });
    const lines = recorded.isolatedEvents.lines.slice(1);
    for (const line of lines) fake.emit(line);
    await waitFor(() => events.length === lines.length, 2000, "events");
    expect(events.map((e) => e.event)).toEqual(lines.map((l) => JSON.parse(l).event));
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(["pane_created", "pane_exited", "pane_closed", "tab_renamed", "workspace_renamed"]),
    );
    expect(events.find((e) => e.event === "tab_renamed")!.data).toMatchObject({ tab_id: "w2:t2", label: "renamed tab" });
  });

  it("reports events_lost (error form and event form)", async () => {
    const { socketPath, fake } = await setup();
    let lost = 0;
    const c = client({ socketPath, subscriptions: [], onEventsLost: () => lost++ });
    await waitFor(() => c.connected());
    const subId = fake.requests[0]!.id;
    fake.emit(JSON.stringify({ id: subId, error: { code: "events_lost", message: "subscriber lagged" } }));
    fake.emit(JSON.stringify({ event: "events_lost", data: { type: "events_lost" } }));
    await waitFor(() => lost === 2);
  });

  it("is disconnected (no throw) while the socket is absent, then connects when it appears", async () => {
    const t = tempSocketDir();
    cleanups.push(t.cleanup);
    const c = client({ socketPath: t.socketPath, subscriptions: [] });
    await sleep(60);
    expect(c.connected()).toBe(false);
    const fake = await startFakeHerdr(t.socketPath);
    cleanups.push(() => fake.close());
    await waitFor(() => c.connected(), 2000, "connected after socket appears");
  });

  it("reconnects with backoff after the server drops the connection", async () => {
    const { socketPath, fake } = await setup();
    let connects = 0;
    let disconnects = 0;
    const c = client({
      socketPath,
      subscriptions: [],
      onConnect: () => connects++,
      onDisconnect: () => disconnects++,
    });
    await waitFor(() => c.connected());
    fake.dropAll();
    await waitFor(() => disconnects === 1, 2000, "disconnect");
    await waitFor(() => connects === 2 && c.connected(), 2000, "reconnect");
  });

  it("treats an error reply to events.subscribe as a failed connection", async () => {
    const t = tempSocketDir();
    cleanups.push(t.cleanup);
    const net = await import("node:net");
    let attempts = 0;
    const server = net.createServer((s) => {
      attempts++;
      // The client may hang up before the reply is written (EPIPE); that is the point.
      s.on("error", () => {});
      s.on("data",() => s.end(JSON.stringify({ id: "", error: { code: "invalid_request", message: "no" } }) + "\n"));
    });
    await new Promise<void>((r) => server.listen(t.socketPath, r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const c = client({ socketPath: t.socketPath, subscriptions: [] });
    await waitFor(() => attempts >= 2, 2000, "retry");
    expect(c.connected()).toBe(false);
    c.close();
  });

  it("close() stops reconnecting and closes the subscription", async () => {
    const { socketPath, fake } = await setup();
    const c = client({ socketPath, subscriptions: [] });
    await waitFor(() => c.connected());
    c.close();
    await waitFor(() => fake.subscribers() === 0);
    await sleep(80);
    expect(fake.subscribers()).toBe(0);
    expect(c.connected()).toBe(false);
    await expect(c.request("pane.list", {})).rejects.toMatchObject({ code: "closed" });
  });
});
