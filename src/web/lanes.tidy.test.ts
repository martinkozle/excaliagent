import { describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { AREA_HEADER, CARD_H, cardHeight, makeCard } from "./cards.ts";
import { GAP } from "./inbox.ts";
import { cardsInLane, draggedCard, dropLaneAt, laneAt, makeLanes, moveCards, slotBelow, tidyMoves } from "./lanes.ts";
import { NOW, session, testGen } from "./__fixtures__/helpers.ts";

const gen = testGen();
const lanes = makeLanes(gen, NOW, { x: 1000, y: 100 }, 1600).filter((e) => e.type === "rectangle");
const [todo, doing] = lanes as [ExcalidrawElement, ExcalidrawElement];
const card = (id: string, x: number, y: number) => makeCard(session({ id }), { x, y }, gen, NOW) as ExcalidrawElement[];
const rectOf = (els: readonly ExcalidrawElement[], id: string) =>
  els.find((e) => e.type === "rectangle" && e.customData?.excaliagent?.sessionId === id)!;
const H1 = cardHeight(1);

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

  it("below the lowest card in the lane (its actual height), ignoring the dragged one and other lanes", () => {
    const a = card("a", todo.x + 20, todo.y + 100);
    const b = card("b", todo.x + 40, todo.y + 700);
    const dragged = card("d", todo.x + 20, todo.y + 1200);
    const elsewhere = card("e", doing.x + 20, doing.y + 1400);
    const els = [...lanes, ...a, ...b, ...dragged, ...elsewhere];
    expect(slotBelow(els, todo, dragged[0]!.id)).toEqual({ x: todo.x + GAP, y: todo.y + 700 + H1 + GAP });
  });

  it("a full lane: still just below the lowest card, past the lane's bottom", () => {
    const low = card("low", todo.x + 20, todo.y + todo.height - 100);
    expect(slotBelow([...lanes, ...low], todo).y).toBe(todo.y + todo.height - 100 + H1 + GAP);
  });
});

describe("tidyMoves", () => {
  it("stacks the lane's cards top-down in their current vertical order, one column, GAP apart", () => {
    const a = card("a", todo.x + 5, todo.y + 900);
    const b = card("b", todo.x + 30, todo.y + 200);
    const tall = card("c", todo.x + 10, todo.y + 500).map((e, i) => (i === 0 ? { ...e, height: CARD_H + 40 } : e));
    const other = card("o", doing.x + 20, doing.y + 600);
    const els = [...lanes, ...a, ...b, ...tall, ...other];
    const moves = tidyMoves(els, todo);
    const x = todo.x + GAP;
    let y = todo.y + AREA_HEADER;
    const want = new Map<string, { x: number; y: number }>();
    for (const r of [b[0]!, tall[0]!, a[0]!]) {
      want.set(r.id, { x, y });
      y += (r.id === tall[0]!.id ? CARD_H + 40 : H1) + GAP;
    }
    expect(moves).toEqual(want);
  });

  it("leaves out cards already in place; nothing to do → empty", () => {
    const a = card("a", todo.x + GAP, todo.y + AREA_HEADER);
    const b = card("b", todo.x + GAP, todo.y + AREA_HEADER + H1 + GAP);
    expect(tidyMoves([...lanes, ...a, ...b], todo).size).toBe(0);
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
