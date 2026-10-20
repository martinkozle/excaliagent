import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types.ts";
import { combineSources } from "./multi.ts";
import type { Source } from "./types.ts";

const s = (id: string, source: Session["source"], over: Partial<Session> = {}): Session => ({
  id, source, cwd: "/home/alice/src/demo-app", repo: "demo-app", status: "idle", lastActivityAt: 0,
  cacheTtlMs: 0, cacheExpiresAt: 0, live: true, prLinks: [], ...over,
});

function fake(live: Session[], dormant: Session[] = [], end?: Source["end"]) {
  let cb: ((x: Session[]) => void) | undefined;
  const source: Source = {
    list: async () => live,
    watch: (fn) => {
      cb = fn;
      return () => (cb = undefined);
    },
    listDormant: async () => dormant,
    get: async (id) => [...live, ...dormant].find((x) => x.id === id),
    ...(end ? { end } : {}),
  };
  return { source, emit: (x: Session[]) => cb?.(x), watching: () => cb !== undefined };
}

describe("combineSources", () => {
  it("is the source itself when there is one", () => {
    const a = fake([]).source;
    expect(combineSources([a])).toBe(a);
  });

  it("merges live lists (by id) and dormant lists (newest first)", async () => {
    const a = fake([s("b", "claude")], [s("d1", "claude", { live: false, lastActivityAt: 1 })]);
    const b = fake([s("a", "codex")], [s("d2", "codex", { live: false, lastActivityAt: 2 })]);
    const all = combineSources([a.source, b.source], () => {});
    expect((await all.list()).map((x) => x.id)).toEqual(["a", "b"]);
    expect((await all.listDormant()).map((x) => x.id)).toEqual(["d2", "d1"]);
  });

  it("one failing source does not hide the others", async () => {
    const warn = vi.fn();
    const broken: Source = { ...fake([]).source, list: async () => { throw new Error("boom"); } };
    const all = combineSources([broken, fake([s("a", "codex")]).source], warn);
    expect((await all.list()).map((x) => x.id)).toEqual(["a"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("watch emits the union whenever one source changes, and unsubscribes all", () => {
    const a = fake([]);
    const b = fake([]);
    const seen: string[][] = [];
    const off = combineSources([a.source, b.source]).watch((x) => seen.push(x.map((y) => y.id)));
    a.emit([s("z", "claude")]);
    b.emit([s("y", "codex")]);
    a.emit([]);
    expect(seen).toEqual([["z"], ["y", "z"], ["y"]]);
    off();
    expect(a.watching() || b.watching()).toBe(false);
  });

  it("get and end go to the source that knows the id", async () => {
    const endA = vi.fn(async () => "ended" as const);
    const a = fake([s("a1", "claude")], [], endA);
    const b = fake([s("b1", "codex")]);
    const all = combineSources([a.source, b.source]);
    expect((await all.get("b1"))?.source).toBe("codex");
    expect(await all.get("zz")).toBeUndefined();
    expect(await all.end!("a1")).toBe("ended");
    expect(await all.end!("b1")).toBe("unsupported");
    expect(await all.end!("zz")).toBe("not-live");
    expect(endA).toHaveBeenCalledExactlyOnceWith("a1");
  });
});
