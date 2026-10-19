import { describe, expect, it } from "vitest";
import { CARD_H, CARD_W, makeCard, makeInbox } from "./cards.ts";
import { GAP, nextSlot } from "./inbox.ts";
import { NOW, session, testGen } from "./__fixtures__/helpers.ts";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

const gen = testGen();
const inbox = makeInbox(gen, NOW).find((e) => e.type === "rectangle")!;
const card = (x: number, y: number, over: Partial<ExcalidrawElement> = {}) =>
  ({ ...makeCard(session(), { x, y }, gen, NOW)[0], ...over }) as ExcalidrawElement;

describe("nextSlot", () => {
  it("first slot is the inbox's top-left corner plus gap", () => {
    expect(nextSlot(inbox, [])).toEqual({ x: inbox.x + GAP, y: inbox.y + GAP });
  });

  it("skips occupied slots and wraps rows", () => {
    const row = [0, 1, 2].map((c) => card(inbox.x + GAP + c * (CARD_W + GAP), inbox.y + GAP));
    expect(nextSlot(inbox, row)).toEqual({ x: inbox.x + GAP, y: inbox.y + GAP + CARD_H + GAP });
  });

  it("ignores deleted cards", () => {
    expect(nextSlot(inbox, [card(inbox.x + GAP, inbox.y + GAP, { isDeleted: true })])).toEqual({
      x: inbox.x + GAP,
      y: inbox.y + GAP,
    });
  });

  it("a partially overlapping card blocks the slot", () => {
    expect(nextSlot(inbox, [card(inbox.x + 100, inbox.y + 50)])).toEqual({
      x: inbox.x + GAP + 2 * (CARD_W + GAP),
      y: inbox.y + GAP,
    });
  });

  it("keeps stacking below the inbox once it is full", () => {
    const cards: ExcalidrawElement[] = [];
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 3; c++) cards.push(card(inbox.x + GAP + c * (CARD_W + GAP), inbox.y + GAP + r * (CARD_H + GAP)));
    const slot = nextSlot(inbox, cards);
    expect(slot.x).toBe(inbox.x + GAP);
    expect(slot.y).toBeGreaterThanOrEqual(inbox.y + inbox.height);
  });

  it("narrow inbox still gets one column", () => {
    const narrow = { ...inbox, width: 100 } as ExcalidrawElement;
    expect(nextSlot(narrow, [card(narrow.x + GAP, narrow.y + GAP)])).toEqual({
      x: narrow.x + GAP,
      y: narrow.y + GAP + CARD_H + GAP,
    });
  });
});
