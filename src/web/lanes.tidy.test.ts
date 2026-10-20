import { describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { AREA_HEADER, CARD_H, CARD_W, makeCard, makeInbox } from "./cards.ts";
import { GAP } from "./inbox.ts";
import {
  cardsInLane,
  draggedCard,
  dropLaneAt,
  isFixedCard,
  laneAt,
  laneTargetAt,
  lanesOf,
  zonesInView,
  makeLanes,
  moveCards,
  slotBelow,
  tidyAllMoves,
  tidyMoves,
} from "./lanes.ts";
import { NOW, session, testGen } from "./__fixtures__/helpers.ts";

const gen = testGen();
const lanes = makeLanes(gen, NOW, { x: 1000, y: 100 }, 1600).filter((e) => e.type === "rectangle");
const [todo, doing] = lanes as [ExcalidrawElement, ExcalidrawElement];
const card = (id: string, x: number, y: number) => makeCard(session({ id }), { x, y }, gen, NOW) as ExcalidrawElement[];
const rectOf = (els: readonly ExcalidrawElement[], id: string) =>
  els.find((e) => e.type === "rectangle" && e.customData?.excaliagent?.sessionId === id)!;
/** The card with its rect changed. */
const with_ = (c: ExcalidrawElement[], over: Partial<ExcalidrawElement>) =>
  c.map((e, i) => (i === 0 ? ({ ...e, ...over } as ExcalidrawElement) : e));

describe("laneAt / dropLaneAt", () => {
  it("finds the lane containing a point, topmost first; not the inbox, not deleted lanes", () => {
    expect(laneAt(lanes, todo.x + 10, todo.y + 500)?.id).toBe(todo.id);
    expect(laneAt(lanes, doing.x + 10, doing.y + 10)?.id).toBe(doing.id);
    expect(laneAt(lanes, todo.x - 5, todo.y + 10)).toBeUndefined();
    expect(laneAt(lanes.map((l) => (l.id === todo.id ? { ...l, isDeleted: true } : l)), todo.x + 10, todo.y + 10)).toBeUndefined();
    const over = { ...doing, id: "over", x: todo.x, y: todo.y };
    expect(laneAt([...lanes, over], todo.x + 10, todo.y + 10)?.id).toBe("over");
  });

  it("the drop zone is the lane's title band: full width, AREA_HEADER tall", () => {
    expect(dropLaneAt(lanes, todo.x + 1, todo.y + 1)?.id).toBe(todo.id);
    expect(dropLaneAt(lanes, todo.x + todo.width - 1, todo.y + AREA_HEADER - 1)?.id).toBe(todo.id);
    expect(dropLaneAt(lanes, todo.x + 10, todo.y + AREA_HEADER + 1)).toBeUndefined();
    expect(dropLaneAt(lanes, todo.x + 10, todo.y - 1)).toBeUndefined();
  });
});

describe("cardsInLane / slotBelow", () => {
  it("a card is in a lane when its centre is inside", () => {
    const a = card("a", todo.x + 20, todo.y + 300);
    const b = card("b", todo.x + 250, todo.y + 300); // centre right of the lane
    const els = [...lanes, ...a, ...b];
    expect(cardsInLane(els, todo).map((r) => r.id)).toEqual([a[0]!.id]);
  });

  it("an empty lane: the first slot under the title, GAP from the left edge", () => {
    expect(slotBelow(lanes, todo)).toEqual({ x: todo.x + GAP, y: todo.y + AREA_HEADER });
  });

  it("below the lowest card in the lane, ignoring the dragged one and other lanes", () => {
    const a = card("a", todo.x + 20, todo.y + 100);
    const b = card("b", todo.x + 40, todo.y + 700);
    const dragged = card("d", todo.x + 20, todo.y + 1200);
    const elsewhere = card("e", doing.x + 20, doing.y + 1400);
    const els = [...lanes, ...a, ...b, ...dragged, ...elsewhere];
    // GAP below b's actual (one-line) bottom: no room is reserved for a second title line.
    expect(b[0]!.height).toBeLessThan(CARD_H);
    expect(slotBelow(els, todo, dragged[0]!.id)).toEqual({ x: todo.x + GAP, y: todo.y + 700 + b[0]!.height + GAP });
  });

  it("a card the user resized counts with its own height", () => {
    const b = with_(card("b", todo.x + 40, todo.y + 700), { height: 120 });
    expect(slotBelow([...lanes, ...b], todo).y).toBe(todo.y + 700 + 120 + GAP);
    const tall = with_(card("t", todo.x + 40, todo.y + 700), { height: CARD_H + 60 });
    expect(slotBelow([...lanes, ...tall], todo).y).toBe(todo.y + 700 + CARD_H + 60 + GAP);
  });

  it("a fixed card counts as an obstacle too; a rotated one by its rotated bounds", () => {
    const quarter = with_(card("r", todo.x + 20, todo.y + 700), { angle: (Math.PI / 2) as ExcalidrawElement["angle"] });
    const r = quarter[0]!;
    // Turned 90°: as tall as it was wide, around the same centre.
    expect(slotBelow([...lanes, ...quarter], todo).y).toBeCloseTo(r.y + r.height / 2 + r.width / 2 + GAP);
  });

  it("a full lane: still just below the lowest card, past the lane's bottom", () => {
    const low = card("low", todo.x + 20, todo.y + todo.height - 100);
    expect(slotBelow([...lanes, ...low], todo).y).toBe(todo.y + todo.height - 100 + low[0]!.height + GAP);
  });
});

describe("fixed cards", () => {
  const FIXED: Array<[string, Partial<ExcalidrawElement>]> = [
    ["locked", { locked: true }],
    ["rotated", { angle: 0.2 as ExcalidrawElement["angle"] }],
    ["bound to an arrow", { boundElements: [{ type: "arrow", id: "user-arrow" }] }],
    ["in a user group", { groupIds: ["card-grp", "user-grp"] }],
  ];

  it("a plain card is movable", () => {
    expect(isFixedCard(card("a", 0, 0)[0]!)).toBe(false);
  });

  for (const [what, over] of FIXED) {
    it(`a card ${what} is fixed: tidy and drops flow around it, never move it`, () => {
      const top = todo.y + AREA_HEADER;
      const f = with_(card("f", todo.x + 60, top + 50), over);
      expect(isFixedCard(f[0]!)).toBe(true);
      const a = card("a", todo.x + 5, todo.y + 900);
      const b = card("b", todo.x + 30, todo.y + 10 + AREA_HEADER);
      const els = [...lanes, ...a, ...b, ...f];
      const moves = tidyMoves(els, todo);
      expect(moves.has(f[0]!.id)).toBe(false);
      // b would overlap f at the top: it goes GAP below f's actual bottom instead; a follows b.
      const fBottom = what === "rotated" ? undefined : f[0]!.y + f[0]!.height;
      const bY = moves.get(b[0]!.id)!.y;
      if (fBottom !== undefined) expect(bY).toBe(fBottom + GAP);
      else expect(bY).toBeGreaterThan(f[0]!.y + f[0]!.height);
      expect(moves.get(a[0]!.id)).toEqual({ x: todo.x + GAP, y: bY + b[0]!.height + GAP });
      // A dragged fixed card is never placed.
      const sel = Object.fromEntries(f.map((e) => [e.id, true as const]));
      expect(draggedCard(els, sel)).toBeUndefined();
    });
  }

  it("a movable card that fits above a fixed one stays above it", () => {
    const top = todo.y + AREA_HEADER;
    const f = with_(card("f", todo.x + GAP, top + CARD_H + GAP + 300), { locked: true });
    const b = card("b", todo.x + 30, todo.y + 900);
    const moves = tidyMoves([...lanes, ...b, ...f], todo);
    expect(moves.get(b[0]!.id)).toEqual({ x: todo.x + GAP, y: top });
    expect(moves.has(f[0]!.id)).toBe(false);
  });

  it("a card that would come within GAP of a fixed card below it goes below that card", () => {
    const top = todo.y + AREA_HEADER;
    const b = card("b", todo.x + 30, todo.y + 900);
    const f = with_(card("f", todo.x + GAP, top + b[0]!.height + GAP - 1), { locked: true });
    const moves = tidyMoves([...lanes, ...b, ...f], todo);
    expect(moves.get(b[0]!.id)).toEqual({ x: todo.x + GAP, y: f[0]!.y + f[0]!.height + GAP });
  });
});

describe("tidyMoves", () => {
  it("stacks the lane's cards top-down in their current vertical order, one column, GAP apart", () => {
    const a = card("a", todo.x + 5, todo.y + 900);
    const b = card("b", todo.x + 30, todo.y + 200);
    const tall = with_(card("c", todo.x + 10, todo.y + 500), { height: CARD_H + 40 });
    const other = card("o", doing.x + 20, doing.y + 600);
    const els = [...lanes, ...a, ...b, ...tall, ...other];
    const moves = tidyMoves(els, todo);
    const x = todo.x + GAP;
    let y = todo.y + AREA_HEADER;
    const want = new Map<string, { x: number; y: number }>();
    for (const r of [b[0]!, tall[0]!, a[0]!]) {
      want.set(r.id, { x, y });
      // Always GAP below the actual bottom of the card above: one-line, two-line or resized.
      y += r.height + GAP;
    }
    expect(moves).toEqual(want);
  });

  it("the gap stays GAP after a two-line card too", () => {
    const two = with_(card("two", todo.x + 5, todo.y + 200), { height: CARD_H });
    const one = card("one", todo.x + 5, todo.y + 800);
    const moves = tidyMoves([...lanes, ...two, ...one], todo);
    expect(moves.get(one[0]!.id)!.y - (moves.get(two[0]!.id)!.y + CARD_H)).toBe(GAP);
  });

  it("leaves out cards already in place; nothing to do → empty", () => {
    const a = card("a", todo.x + GAP, todo.y + AREA_HEADER);
    const b = card("b", todo.x + GAP, todo.y + AREA_HEADER + a[0]!.height + GAP);
    expect(tidyMoves([...lanes, ...a, ...b], todo).size).toBe(0);
  });
});

describe("tidyMoves on the inbox / tidyAllMoves", () => {
  const [box, boxLabel] = makeInbox(gen, NOW, { x: 0, y: 100 });
  const ib = box!;
  const cols = [ib.x + GAP, ib.x + GAP + CARD_W + GAP];
  const top = ib.y + AREA_HEADER;

  it("compacts the inbox in reading order: two columns, each stacked GAP apart by actual heights", () => {
    const a = card("a", ib.x + 300, ib.y + 900); // last
    const b = with_(card("b", ib.x + 40, ib.y + 300), { height: CARD_H }); // first (two lines)
    const c = card("c", ib.x + 330, ib.y + 310); // second
    const d = card("d", ib.x + 10, ib.y + 600); // third
    const moves = tidyMoves([ib, boxLabel!, ...a, ...b, ...c, ...d], ib);
    const one = c[0]!.height;
    expect(moves.get(b[0]!.id)).toEqual({ x: cols[0], y: top });
    expect(moves.get(c[0]!.id)).toEqual({ x: cols[1], y: top });
    // Column 1 (one-line card) ends higher than column 0 (two lines): d goes there.
    expect(moves.get(d[0]!.id)).toEqual({ x: cols[1], y: top + one + GAP });
    expect(moves.get(a[0]!.id)).toEqual({ x: cols[0], y: top + CARD_H + GAP });
  });

  it("the inbox's fixed cards stay put as obstacles", () => {
    const f = with_(card("f", cols[0]!, top + 10), { locked: true });
    const a = card("a", ib.x + 20, ib.y + 900);
    const moves = tidyMoves([ib, ...f, ...a], ib);
    expect(moves.has(f[0]!.id)).toBe(false);
    expect(moves.get(a[0]!.id)).toEqual({ x: cols[1], y: top });
  });

  it("tidyAllMoves: every lane and the inbox in one map, fixed cards left out", () => {
    const inInbox = card("i", ib.x + 30, ib.y + 500);
    const inTodo = card("t", todo.x + 5, todo.y + 600);
    const inDoing = card("d", doing.x + 5, doing.y + 900);
    const fixed = with_(card("f", doing.x + 5, doing.y + 300), { locked: true });
    const els = [ib, ...lanes, ...inInbox, ...inTodo, ...inDoing, ...fixed];
    const moves = tidyAllMoves(els);
    expect(moves).toEqual(
      new Map([
        [inInbox[0]!.id, { x: cols[0], y: top }],
        [inTodo[0]!.id, { x: todo.x + GAP, y: todo.y + AREA_HEADER }],
        [inDoing[0]!.id, { x: doing.x + GAP, y: doing.y + AREA_HEADER }],
      ]),
    );
    expect(tidyAllMoves(moveCards(els, moves, testGen(), NOW)).size).toBe(0);
  });
});

describe("laneTargetAt (right-click → Tidy cards)", () => {
  const label = { ...lanes[0]!, id: "label", type: "text", customData: { excaliagent: { kind: "lane-label" } }, containerId: todo.id, x: todo.x + 100, y: todo.y + 5, width: 80, height: 35 } as unknown as ExcalidrawElement;
  const note = { ...lanes[0]!, id: "note", customData: undefined, x: todo.x + 50, y: todo.y + 400, width: 100, height: 100 } as ExcalidrawElement;
  const arrow = {
    ...lanes[0]!, id: "arrow", type: "arrow", customData: undefined,
    x: todo.x + 200, y: todo.y + 800, width: 100, height: 100, points: [[0, 0], [-100, 100]],
  } as unknown as ExcalidrawElement;
  const backdrop = { ...note, id: "backdrop", x: todo.x - 500, y: todo.y - 500, width: 5000, height: 5000 } as ExcalidrawElement;

  it("the lane, when only the lane or its title is under the pointer", () => {
    const els = [backdrop, ...lanes, label, note, arrow];
    expect(laneTargetAt(els, todo.x + 30, todo.y + 1200)?.id).toBe(todo.id);
    expect(laneTargetAt(els, todo.x + 120, todo.y + 20)?.id).toBe(todo.id);
  });

  it("the inbox is a target too (Tidy cards compacts it)", () => {
    const [ib] = makeInbox(testGen(), NOW, { x: 0, y: 100 });
    expect(laneTargetAt([ib!, ...lanes], 50, 500)?.id).toBe(ib!.id);
  });

  it("nothing over a user's note or arrow inside the lane (elements drawn below the lane do not count)", () => {
    const els = [backdrop, ...lanes, label, note, arrow];
    expect(laneTargetAt(els, todo.x + 60, todo.y + 450)).toBeUndefined();
    expect(laneTargetAt(els, todo.x + 150, todo.y + 850)).toBeUndefined();
    expect(laneTargetAt(els, todo.x - 5, todo.y + 450)).toBeUndefined(); // not in a lane
  });
});

describe("moveCards", () => {
  it("moves each card's whole group by the same delta, bumps versions, touches nothing else", () => {
    const a = card("a", 10, 20);
    const b = card("b", 500, 20);
    const note = { ...b[1]!, id: "note", groupIds: [], customData: undefined } as ExcalidrawElement;
    const els = [...lanes, ...a, ...b, note];
    const out = moveCards(els, new Map([[a[0]!.id, { x: 110, y: 70 }]]), testGen(), NOW);
    a.forEach((e) => {
      const moved = out.find((o) => o.id === e.id)!;
      expect([moved.x - e.x, moved.y - e.y]).toEqual([100, 50]);
      expect(moved.version).toBe(e.version + 1);
      expect([moved.width, moved.height]).toEqual([e.width, e.height]);
    });
    els.filter((e) => !a.includes(e)).forEach((e) => expect(out.find((o) => o.id === e.id)).toBe(e));
  });
});

describe("draggedCard", () => {
  const a = card("a", 10, 20);
  const b = card("b", 500, 20);
  const els = [...lanes, ...a, ...b];
  const sel = (xs: ExcalidrawElement[]) => Object.fromEntries(xs.map((e) => [e.id, true as const]));

  it("one whole card selected → its rect", () => {
    expect(draggedCard(els, sel(a))?.id).toBe(a[0]!.id);
    expect(draggedCard(els, sel([a[0]!]))?.id).toBe(a[0]!.id);
  });

  it("two cards, a card plus anything else, or nothing → undefined", () => {
    expect(draggedCard(els, sel([...a, ...b]))).toBeUndefined();
    expect(draggedCard(els, sel([...a, todo]))).toBeUndefined();
    expect(draggedCard(els, {})).toBeUndefined();
    expect(draggedCard(els, sel([a[1]!]))).toBeUndefined(); // a lone title text is not the card
  });
});

describe("drag hints: lanesOf / zonesInView", () => {
  it("lists the non-deleted lanes, in scene order", () => {
    const gone = { ...doing, id: "gone", isDeleted: true };
    const a = card("a", 0, 0);
    expect(lanesOf([...lanes, gone, ...a]).map((l) => l.id)).toEqual(lanes.map((l) => l.id));
  });

  it("keeps the title bands that intersect the view, with their lane id", () => {
    // A view covering the first two lanes' bands only.
    const view = { x: todo.x - 10, y: todo.y - 10, width: doing.x + 10 - todo.x + 10, height: 500 };
    const zones = zonesInView(lanes, view);
    expect(zones.map((z) => z.laneId)).toEqual([todo.id, doing.id]);
    expect(zones[0]!.zone).toEqual({ x: todo.x, y: todo.y, width: todo.width, height: AREA_HEADER });
    // Scrolled down past the bands: none, even though the lanes themselves are in view.
    expect(zonesInView(lanes, { ...view, y: todo.y + 300 })).toEqual([]);
  });
});
