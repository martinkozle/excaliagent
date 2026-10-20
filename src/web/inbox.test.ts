import { describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { AREA_HEADER, CARD_H, CARD_W, cardHeight, makeCard, makeInbox } from "./cards.ts";
import { GAP, columnsOf, firstFree, nextSlot } from "./inbox.ts";
import { NOW, session, testGen } from "./__fixtures__/helpers.ts";

const gen = testGen();
const inbox = makeInbox(gen, NOW).find((e) => e.type === "rectangle")!;
const ONE = cardHeight(1);
/** A card rect, one title line tall unless `over` says otherwise. */
const card = (x: number, y: number, over: Partial<ExcalidrawElement> = {}) =>
  ({ ...makeCard(session(), { x, y }, gen, NOW)[0], ...over }) as ExcalidrawElement;
const col = (c: number) => inbox.x + GAP + c * (CARD_W + GAP);
const top = inbox.y + AREA_HEADER;

describe("nextSlot", () => {
  it("default inbox fits 2 columns × 8 two-line cards", () => {
    expect(columnsOf(inbox)).toEqual([col(0), col(1)]);
    expect(col(1) + CARD_W).toBeLessThanOrEqual(inbox.x + inbox.width);
    expect(top + 8 * CARD_H + 7 * GAP).toBeLessThanOrEqual(inbox.y + inbox.height);
  });

  it("first slot is the inbox's top-left corner, below its title", () => {
    expect(card(0, 0).height).toBe(ONE);
    expect(nextSlot(inbox, [])).toEqual({ x: col(0), y: top });
  });

  it("fills the top of each column, then GAP below the actual bottom of the card above", () => {
    expect(nextSlot(inbox, [card(col(0), top)])).toEqual({ x: col(1), y: top });
    expect(nextSlot(inbox, [0, 1].map((c) => card(col(c), top)))).toEqual({ x: col(0), y: top + ONE + GAP });
  });

  it("columns stack on their own: a one-line card leaves its column higher than a two-line one", () => {
    const cards = [card(col(0), top, { height: CARD_H }), card(col(1), top)];
    expect(nextSlot(inbox, cards)).toEqual({ x: col(1), y: top + ONE + GAP });
    const more = [...cards, card(col(1), top + ONE + GAP), card(col(1), top + 2 * (ONE + GAP))];
    expect(nextSlot(inbox, more)).toEqual({ x: col(0), y: top + CARD_H + GAP });
  });

  it("ignores deleted cards", () => {
    expect(nextSlot(inbox, [card(col(0), top, { isDeleted: true })])).toEqual({ x: col(0), y: top });
  });

  it("a partially overlapping card blocks both columns down to GAP below it", () => {
    const stray = card(inbox.x + 100, inbox.y + 100, { height: CARD_H });
    expect(nextSlot(inbox, [stray])).toEqual({ x: col(0), y: inbox.y + 100 + CARD_H + GAP });
  });

  it("takes the first hole a card fits fully, GAP clear above and below", () => {
    const hole = 2 * GAP + ONE; // exactly room for a one-line card
    const below = top + ONE + hole;
    const cards = [card(col(0), top), card(col(0), below), card(col(1), top, { height: 2000 })];
    expect(nextSlot(inbox, cards, ONE)).toEqual({ x: col(0), y: top + ONE + GAP });
    // A two-line card does not fit that hole: it goes below the lower card.
    expect(nextSlot(inbox, cards, CARD_H)).toEqual({ x: col(0), y: below + ONE + GAP });
  });

  it("a rotated card blocks by its rotated bounds", () => {
    const turned = card(col(0), top + 200, { angle: (Math.PI / 2) as ExcalidrawElement["angle"] });
    const cards = [turned, card(col(1), top, { height: 2000 }), card(col(0), top)];
    const bottom = turned.y + turned.height / 2 + turned.width / 2;
    expect(nextSlot(inbox, cards, CARD_H).y).toBeCloseTo(bottom + GAP);
  });

  it("keeps stacking below the inbox once it is full", () => {
    const cards: ExcalidrawElement[] = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 2; c++) cards.push(card(col(c), top + r * (CARD_H + GAP), { height: CARD_H }));
    const slot = nextSlot(inbox, cards);
    expect(slot).toEqual({ x: col(0), y: top + 8 * (CARD_H + GAP) });
    expect(slot.y).toBeGreaterThanOrEqual(inbox.y + inbox.height - GAP);
  });

  it("narrow inbox still gets one column", () => {
    const narrow = { ...inbox, width: 100 } as ExcalidrawElement;
    expect(nextSlot(narrow, [card(col(0), top)])).toEqual({ x: col(0), y: top + ONE + GAP });
  });
});

describe("firstFree", () => {
  it("a card exactly GAP below an obstacle is free (no float slack lost)", () => {
    const o = { x: 0, y: 0.1, width: 300, height: 123.456 };
    expect(firstFree([0], 0, { width: 300, height: 50 }, [o])).toEqual({ x: 0, y: 0.1 + 123.456 + GAP });
  });

  it("topmost spot wins, leftmost column on a tie", () => {
    expect(firstFree([0, 400], 0, { width: 300, height: 50 }, [])).toEqual({ x: 0, y: 0 });
    const o = { x: 0, y: 0, width: 300, height: 50 };
    expect(firstFree([0, 400], 0, { width: 300, height: 50 }, [o])).toEqual({ x: 400, y: 0 });
  });
});
