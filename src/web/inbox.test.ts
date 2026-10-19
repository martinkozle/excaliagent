import { describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { CARD_H, CARD_W, makeCard, makeInbox } from "./cards.ts";
import { GAP, nextSlot } from "./inbox.ts";
import { NOW, session, testGen } from "./__fixtures__/helpers.ts";

const gen = testGen();
const inbox = makeInbox(gen, NOW).find((e) => e.type === "rectangle")!;
const card = (x: number, y: number, over: Partial<ExcalidrawElement> = {}) =>
  ({ ...makeCard(session(), { x, y }, gen, NOW)[0], ...over }) as ExcalidrawElement;
const col = (c: number) => inbox.x + GAP + c * (CARD_W + GAP);
const row = (r: number) => inbox.y + GAP + r * (CARD_H + GAP);

describe("nextSlot", () => {
  it("default inbox fits 3 columns × 4 rows of cards", () => {
    expect(col(2) + CARD_W).toBeLessThanOrEqual(inbox.x + inbox.width);
    expect(row(3) + CARD_H).toBeLessThanOrEqual(inbox.y + inbox.height);
  });

  it("first slot is the inbox's top-left corner plus gap", () => {
    expect(nextSlot(inbox, [])).toEqual({ x: col(0), y: row(0) });
  });

  it("skips occupied slots and wraps rows", () => {
    expect(nextSlot(inbox, [0, 1, 2].map((c) => card(col(c), row(0))))).toEqual({ x: col(0), y: row(1) });
  });

  it("ignores deleted cards", () => {
    expect(nextSlot(inbox, [card(col(0), row(0), { isDeleted: true })])).toEqual({ x: col(0), y: row(0) });
  });

  it("a partially overlapping card blocks the slot", () => {
    expect(nextSlot(inbox, [card(inbox.x + 100, inbox.y + 50)])).toEqual({ x: col(2), y: row(0) });
  });

  it("keeps stacking below the inbox once it is full", () => {
    const cards: ExcalidrawElement[] = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) cards.push(card(col(c), row(r)));
    const slot = nextSlot(inbox, cards);
    expect(slot.x).toBe(col(0));
    expect(slot.y).toBeGreaterThanOrEqual(inbox.y + inbox.height);
  });

  it("narrow inbox still gets one column", () => {
    const narrow = { ...inbox, width: 100 } as ExcalidrawElement;
    expect(nextSlot(narrow, [card(col(0), row(0))])).toEqual({ x: col(0), y: row(1) });
  });
});
