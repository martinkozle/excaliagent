import { describe, expect, it } from "vitest";
import type { ExcalidrawElement, ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import { CARD_H, CARD_W, INBOX_ORIGIN, makeInbox } from "./cards.ts";
import { GAP, nextSlot } from "./inbox.ts";
import { LANE_GAP, LANE_TITLES, LANE_W, addLane, appendLanes, makeLanes, makeStarterBoard } from "./lanes.ts";
import { NOW, testGen } from "./__fixtures__/helpers.ts";

const kind = (e: ExcalidrawElement) => e.customData?.excaliagent?.kind as string | undefined;
const lanesOf = (els: readonly ExcalidrawElement[]) => els.filter((e) => kind(e) === "lane");
const labelsOf = (els: readonly ExcalidrawElement[]) =>
  els.filter((e): e is ExcalidrawTextElement => kind(e) === "lane-label").map((t) => t.text);

describe("starter board", () => {
  const els = makeStarterBoard(testGen(), NOW);
  const inbox = els.find((e) => kind(e) === "inbox")!;

  it("has a two-cards-wide tall inbox at the usual origin", () => {
    expect([inbox.x, inbox.y]).toEqual([INBOX_ORIGIN.x, INBOX_ORIGIN.y]);
    expect(inbox.width).toBe(2 * CARD_W + 3 * GAP);
    expect(inbox.height).toBeGreaterThanOrEqual(1600);
    expect(els.some((e) => kind(e) === "inbox-label")).toBe(true);
  });

  it("has eight one-card lanes to the right, top-aligned, same height", () => {
    const lanes = lanesOf(els);
    expect(lanes).toHaveLength(8);
    lanes.forEach((l, i) => {
      expect(l).toMatchObject({
        type: "rectangle",
        x: inbox.x + inbox.width + LANE_GAP + i * (LANE_W + LANE_GAP),
        y: inbox.y,
        width: CARD_W + 2 * GAP,
        height: inbox.height,
        backgroundColor: "transparent",
        strokeStyle: "dashed",
        customData: { excaliagent: { kind: "lane" } },
      });
    });
  });

  it("titles the first six lanes, Excalifont, above the lane", () => {
    expect(labelsOf(els)).toEqual(["To Do", "In Progress", "Review", "Blocked", "Parked", "Done"]);
    expect(LANE_TITLES.filter(Boolean)).toHaveLength(6);
    const lanes = lanesOf(els);
    const labels = els.filter((e): e is ExcalidrawTextElement => kind(e) === "lane-label");
    labels.forEach((t, i) => {
      expect(t.fontFamily).toBe(5);
      expect(t.x).toBe(lanes[i]!.x);
      expect(t.y + t.height).toBeLessThanOrEqual(lanes[i]!.y);
    });
  });

  it("the inbox grid wraps at two columns and grows downwards", () => {
    const col = (c: number) => inbox.x + GAP + c * (CARD_W + GAP);
    const row = (r: number) => inbox.y + GAP + r * (CARD_H + GAP);
    expect(col(1) + CARD_W).toBeLessThanOrEqual(inbox.x + inbox.width);
    expect(row(7) + CARD_H).toBeLessThanOrEqual(inbox.y + inbox.height);
    expect(nextSlot(inbox, [])).toEqual({ x: col(0), y: row(0) });
  });
});

describe("appendLanes", () => {
  it("adds lanes right of the current inbox bounds, top-aligned, no second inbox", () => {
    const gen = testGen();
    const [inbox0, label] = makeInbox(gen, NOW);
    const inbox = { ...inbox0, x: 500, y: -200, width: 980, height: 824 };
    const before: ExcalidrawElement[] = [inbox, label];
    const after = appendLanes(before, gen, NOW)!;
    expect(after.slice(0, 2)).toEqual(before);
    expect(after.filter((e) => kind(e) === "inbox")).toHaveLength(1);
    const lanes = lanesOf(after);
    expect(lanes).toHaveLength(8);
    expect(lanes[0]).toMatchObject({ x: 500 + 980 + LANE_GAP, y: -200, height: 824 });
    expect(labelsOf(after)).toHaveLength(6);
  });

  it("returns null without an inbox", () => {
    expect(appendLanes([], testGen(), NOW)).toBeNull();
  });

  it("makeLanes places from a given point", () => {
    const lanes = lanesOf(makeLanes(testGen(), NOW, { x: 0, y: 0 }, 100));
    expect(lanes.map((l) => l.x)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => i * (LANE_W + LANE_GAP)));
  });
});

describe("addLane", () => {
  it("appends one lane right of the rightmost lane, top-aligned with it and as tall, with a renamable title", () => {
    const board = makeStarterBoard(testGen(), NOW);
    const last = lanesOf(board).at(-1)!;
    // The user moved and stretched their last lane.
    const moved = board.map((e) => (e.id === last.id ? { ...e, x: e.x + 500, y: 300, height: 900 } : e));
    const r = addLane(moved, testGen(), NOW);
    expect(r.elements.slice(0, moved.length)).toEqual(moved); // nothing else touched
    expect(r.lane).toMatchObject({ x: last.x + 500 + LANE_W + LANE_GAP, y: 300, width: LANE_W, height: 900 });
    expect(r.elements).toContain(r.lane);
    expect(lanesOf(r.elements)).toHaveLength(9);
    expect(labelsOf(r.elements).at(-1)).toBe("New lane");
  });

  it("goes beside the inbox when there are no lanes, ignores deleted lanes, and starts at the origin on an empty board", () => {
    const [inbox, label] = makeInbox(testGen(), NOW);
    const deletedLane = { ...lanesOf(makeStarterBoard(testGen(), NOW))[0]!, x: 9000, isDeleted: true };
    const r = addLane([inbox, label, deletedLane], testGen(), NOW);
    expect(r.lane).toMatchObject({ x: inbox.x + inbox.width + LANE_GAP, y: inbox.y, height: inbox.height });
    expect(addLane([], testGen(), NOW).lane).toMatchObject({ x: INBOX_ORIGIN.x, y: INBOX_ORIGIN.y });
  });
});
