import { describe, expect, it, vi } from "vitest";
import type { Session } from "../shared/types.ts";
import { createHub } from "./hub.ts";
import type { PaneLink } from "./panes/types.ts";
import type { Source } from "./sources/types.ts";

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1", source: "claude", cwd: "/r/app", repo: "app", status: "busy", lastActivityAt: 1,
    cacheTtlMs: 0, cacheExpiresAt: 0, live: true, pid: 100, prLinks: [], ...over,
  };
}

function fakeSource(initial: Session[], dormant: Session[] = []) {
  let cb: ((s: Session[]) => void) | undefined;
  let current = initial;
  const source: Source = {
    list: async () => current,
    watch: (fn) => { cb = fn; return () => { cb = undefined; }; },
    listDormant: async () => dormant,
    get: async (id) => [...current, ...dormant].find((s) => s.id === id),
  };
  return { source, emit: (s: Session[]) => { current = s; cb?.(s); }, watching: () => cb !== undefined };
}

function fakePanes(map: Record<number, { paneId: string; workspaceId: string }> = {}) {
  const listeners = new Set<() => void>();
  const link: PaneLink & { set(m: typeof map): void; refresh: ReturnType<typeof vi.fn> } = {
    available: () => true,
    match: (pid) => map[pid],
    focus: vi.fn(async () => {}),
    onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    refresh: vi.fn(async () => {}),
    close: () => {},
    set(m) { map = m; for (const l of listeners) l(); },
  };
  return link;
}

describe("hub", () => {
  it("loads live sessions and attaches matching panes", async () => {
    const { source } = fakeSource([session(), session({ id: "s2", pid: 200 })]);
    const hub = createHub({ source, panes: fakePanes({ 100: { paneId: "w1:p1", workspaceId: "w1" } }) });
    await hub.start();
    expect(hub.sessions().map((s) => [s.id, s.pane?.paneId])).toEqual([["s1", "w1:p1"], ["s2", undefined]]);
    hub.stop();
  });

  it("notifies subscribers when the source changes, and refreshes panes on membership change", async () => {
    const src = fakeSource([session()]);
    const panes = fakePanes();
    const hub = createHub({ source: src.source, panes });
    await hub.start();
    const seen: string[][] = [];
    hub.subscribe((s) => seen.push(s.map((x) => x.id)));
    src.emit([session(), session({ id: "s3", pid: 300 })]);
    expect(seen).toEqual([["s1", "s3"]]);
    expect(panes.refresh).toHaveBeenCalled();
    hub.stop();
    expect(src.watching()).toBe(false);
  });

  it("re-emits when the pane map changes, but not when nothing changed", async () => {
    const { source } = fakeSource([session()]);
    const panes = fakePanes();
    const hub = createHub({ source, panes });
    await hub.start();
    const cb = vi.fn();
    hub.subscribe(cb);
    panes.set({});
    expect(cb).not.toHaveBeenCalled();
    panes.set({ 100: { paneId: "w2:p3", workspaceId: "w2" } });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0][0].pane).toEqual({ paneId: "w2:p3", workspaceId: "w2" });
    hub.stop();
  });

  it("lookup returns live sessions first, then dormant ones from the source", async () => {
    const dormant = session({ id: "d1", live: false, status: "dormant", pid: undefined });
    const { source } = fakeSource([session()], [dormant]);
    const hub = createHub({ source, panes: fakePanes() });
    await hub.start();
    expect((await hub.lookup(["s1", "d1", "missing"])).map((s) => s.id)).toEqual(["s1", "d1"]);
    hub.stop();
  });

  it("picker lists dormant sessions only", async () => {
    const dormant = session({ id: "d1", live: false, status: "dormant" });
    const { source } = fakeSource([session()], [dormant, session({ id: "s1" })]);
    const hub = createHub({ source, panes: fakePanes() });
    await hub.start();
    expect((await hub.picker()).map((s) => s.id)).toEqual(["d1"]);
    hub.stop();
  });

  it("focus resolves the pane for a live session", async () => {
    const { source } = fakeSource([session()]);
    const panes = fakePanes({ 100: { paneId: "w1:p1", workspaceId: "w1" } });
    const hub = createHub({ source, panes });
    await hub.start();
    expect(await hub.focus("s1")).toBe(true);
    expect(panes.focus).toHaveBeenCalledWith("w1:p1");
    expect(await hub.focus("nope")).toBe(false);
    hub.stop();
  });
});
