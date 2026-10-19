import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { describe, expect, it } from "vitest";
import { makeCard } from "./cards.ts";
import { cardAt, cardSessionIds, idsToLookup, mergeSessions, resumeCommand, saveHash } from "./board.ts";
import { NOW, session, testGen } from "./__fixtures__/helpers.ts";

const card = (id: string, x = 0, y = 0, deleted = false) => {
  const [rect, text] = makeCard(session({ id }), { x, y }, testGen(), NOW);
  return [{ ...rect, id: `r-${id}`, isDeleted: deleted }, { ...text, id: `t-${id}`, containerId: `r-${id}` }] as ExcalidrawElement[];
};

describe("cardSessionIds", () => {
  it("collects session ids of non-deleted cards only", () => {
    const els = [...card("a"), ...card("b", 0, 0, true), ...card("c")];
    expect([...cardSessionIds(els)].sort()).toEqual(["a", "c"]);
  });
});

describe("mergeSessions", () => {
  it("live wins over known, known are forced non-live", () => {
    const live = [session({ id: "a", status: "busy" })];
    const known = new Map([
      ["a", session({ id: "a", status: "dormant", live: false })],
      ["b", session({ id: "b", status: "idle", live: true })],
    ]);
    const merged = mergeSessions(live, known);
    expect(merged.map((s) => [s.id, s.status, s.live])).toEqual([
      ["a", "busy", true],
      ["b", "idle", false],
    ]);
  });
});

describe("idsToLookup", () => {
  it("asks only for carded sessions we know nothing about", () => {
    const ids = idsToLookup(new Set(["a", "b", "c", "d"]), [session({ id: "a" })], new Map([["b", session({ id: "b" })]]), new Set(["c"]));
    expect(ids).toEqual(["d"]);
  });
});

describe("cardAt", () => {
  it("finds the topmost card under a scene point, via the card or its label", () => {
    const els = [...card("a", 0, 0), ...card("b", 100, 50)];
    expect(cardAt(els, 150, 100)).toBe("b");
    expect(cardAt(els, 10, 10)).toBe("a");
    expect(cardAt(els, 5000, 5000)).toBeUndefined();
  });
  it("ignores deleted cards", () => {
    expect(cardAt(card("a", 0, 0, true), 10, 10)).toBeUndefined();
  });
});

describe("resumeCommand", () => {
  it("quotes the cwd for the shell", () => {
    expect(resumeCommand(session({ id: "abc", cwd: "/home/me/it's here" }))).toBe(
      "cd '/home/me/it'\\''s here' && claude --resume abc",
    );
  });
});

describe("saveHash", () => {
  it("changes when any element version changes, not otherwise", () => {
    const els = card("a");
    const h = saveHash(els);
    expect(saveHash(els.map((e) => ({ ...e })))).toBe(h);
    expect(saveHash([{ ...els[0]!, version: els[0]!.version + 1 }, els[1]!])).not.toBe(h);
  });
});
