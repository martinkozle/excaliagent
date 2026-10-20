// Starter Kanban lanes: plain rectangles the user owns. The app creates them
// (with a fresh board, on "Add starter lanes", or one at a time with "+ Lane") and
// never patches them after;
// `customData.excaliagent = {kind:"lane"}` / `{kind:"lane-label"}` are markers only.
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { AREA_HEADER, CARD_W, INBOX_H, INBOX_ORIGIN, cardMeta, isInbox, makeInbox, makeTitledArea, type Gen, type Measure } from "./cards.ts";
import { GAP } from "./inbox.ts";

export const LANE_W = CARD_W + 2 * GAP;
export const LANE_GAP = 40;
/** Empty string = untitled lane. */
export const LANE_TITLES = ["To Do", "In Progress", "Review", "Blocked", "Parked", "Done", "", ""] as const;

const isLane = (e: ExcalidrawElement) => !e.isDeleted && e.customData?.excaliagent?.kind === "lane";

export function hasLanes(elements: readonly ExcalidrawElement[]): boolean {
  return elements.some(isLane);
}

const lane = (gen: Gen, now: number, box: { x: number; y: number; height: number }, title: string, measure?: Measure) =>
  makeTitledArea(gen, now, { ...box, width: LANE_W }, { excaliagent: { kind: "lane" } }, title, { excaliagent: { kind: "lane-label" } }, measure);

/** Lanes (titled ones with their bound title) left to right from `at`. */
export function makeLanes(
  gen: Gen,
  now: number,
  at: { x: number; y: number },
  height: number,
  measure?: Measure,
): ExcalidrawElement[] {
  return LANE_TITLES.flatMap((title, i) => lane(gen, now, { x: at.x + i * (LANE_W + LANE_GAP), y: at.y, height }, title, measure));
}

/** Lanes right of an inbox's current bounds, top-aligned, same height. */
export function lanesBeside(inbox: ExcalidrawElement, gen: Gen, now: number, measure?: Measure): ExcalidrawElement[] {
  return makeLanes(gen, now, { x: inbox.x + inbox.width + LANE_GAP, y: inbox.y }, inbox.height, measure);
}

/** A new board: the tall inbox plus the lanes. */
export function makeStarterBoard(gen: Gen, now: number, measure?: Measure): ExcalidrawElement[] {
  const inbox = makeInbox(gen, now, undefined, measure);
  return [...inbox, ...lanesBeside(inbox[0], gen, now, measure)];
}

/** "Add starter lanes": the scene with lanes appended beside the inbox, or null without an inbox. */
export function appendLanes(
  elements: readonly ExcalidrawElement[],
  gen: Gen,
  now: number,
  measure?: Measure,
): ExcalidrawElement[] | null {
  const inbox = elements.find(isInbox);
  return inbox ? [...elements, ...lanesBeside(inbox, gen, now, measure)] : null;
}

/**
 * The "+ Lane" button: one more lane right of the rightmost lane (or of the
 * inbox), top-aligned with it and as tall, titled "New lane" for renaming.
 */
export function addLane(
  elements: readonly ExcalidrawElement[],
  gen: Gen,
  now: number,
  measure?: Measure,
): { elements: ExcalidrawElement[]; lane: ExcalidrawElement } {
  const anchors = elements.filter((e) => isLane(e) || isInbox(e));
  const right = anchors.reduce<ExcalidrawElement | undefined>(
    (best, e) => (!best || e.x + e.width > best.x + best.width ? e : best),
    undefined,
  );
  const at = right ? { x: right.x + right.width + LANE_GAP, y: right.y } : INBOX_ORIGIN;
  const made = lane(gen, now, { ...at, height: right?.height ?? INBOX_H }, "New lane", measure);
  return { elements: [...elements, ...made], lane: made[0]! };
}

// --- Lining cards up in a lane (issue #11) ------------------------------------
// The one place the app moves cards, and only in direct response to a user
// gesture: dropping a card on a lane's title band, or "Tidy cards" on a lane.

type Box = Pick<ExcalidrawElement, "x" | "y" | "width" | "height">;
const inside = (b: Box, x: number, y: number) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;

/** Topmost non-deleted lane containing the scene point (rotation ignored). */
export function laneAt(elements: readonly ExcalidrawElement[], x: number, y: number): ExcalidrawElement | undefined {
  return elements.findLast((e) => isLane(e) && inside(e, x, y));
}

/** A lane's drop zone: its title band, the full width and `AREA_HEADER` tall. */
export function dropZone(lane: Box): Box {
  return { x: lane.x, y: lane.y, width: lane.width, height: Math.min(AREA_HEADER, lane.height) };
}

/** Topmost lane whose drop zone contains the scene point. */
export function dropLaneAt(elements: readonly ExcalidrawElement[], x: number, y: number): ExcalidrawElement | undefined {
  return elements.findLast((e) => isLane(e) && inside(dropZone(e), x, y));
}

/** Card rects whose centre is inside the lane, in scene order. */
export function cardsInLane(elements: readonly ExcalidrawElement[], lane: Box): ExcalidrawElement[] {
  return elements.filter((e) => !e.isDeleted && cardMeta(e) && inside(lane, e.x + e.width / 2, e.y + e.height / 2));
}

/**
 * Where a card dropped on the lane's title goes: the lane's column (`GAP` from
 * its left edge), below the lowest card already in the lane (`GAP` apart), or
 * right under the title in an empty lane. A full lane is not grown: the card
 * just goes below, past its bottom edge.
 */
export function slotBelow(elements: readonly ExcalidrawElement[], lane: Box, excludeId?: string): { x: number; y: number } {
  const bottom = cardsInLane(elements, lane)
    .filter((c) => c.id !== excludeId)
    .reduce((y, c) => Math.max(y, c.y + c.height + GAP), lane.y + AREA_HEADER);
  return { x: lane.x + GAP, y: bottom };
}

/**
 * "Tidy cards": the lane's cards stacked top-down in one column under the
 * title, in their current vertical order (then left to right), `GAP` apart.
 * Only cards that actually move are returned (rect id → new top-left).
 */
export function tidyMoves(elements: readonly ExcalidrawElement[], lane: Box): Map<string, { x: number; y: number }> {
  const cards = cardsInLane(elements, lane).sort((a, b) => a.y - b.y || a.x - b.x);
  const moves = new Map<string, { x: number; y: number }>();
  let y = lane.y + AREA_HEADER;
  for (const c of cards) {
    const to = { x: lane.x + GAP, y };
    if (to.x !== c.x || to.y !== c.y) moves.set(c.id, to);
    y += c.height + GAP;
  }
  return moves;
}

/** The elements of a card: its rect and everything in its (innermost) app group. */
const inCard = (rect: ExcalidrawElement, e: ExcalidrawElement) =>
  e.id === rect.id || (!!rect.groupIds[0] && e.groupIds[0] === rect.groupIds[0]);

/** Moves each card (rect id → new top-left) with its whole group; everything else is returned as is. */
export function moveCards(
  elements: readonly ExcalidrawElement[],
  moves: ReadonlyMap<string, { x: number; y: number }>,
  gen: Gen,
  now: number,
): ExcalidrawElement[] {
  const deltas = [...moves].flatMap(([id, to]) => {
    const rect = elements.find((e) => e.id === id && !e.isDeleted);
    return rect ? [{ rect, dx: to.x - rect.x, dy: to.y - rect.y }] : [];
  });
  return elements.map((e) => {
    if (e.isDeleted) return e;
    const d = deltas.find((d) => inCard(d.rect, e));
    if (!d || (d.dx === 0 && d.dy === 0)) return e;
    return { ...e, x: e.x + d.dx, y: e.y + d.dy, version: e.version + 1, versionNonce: gen.seed(), updated: now };
  });
}

/**
 * The card being dragged, if the selection is exactly one card: its rect, plus
 * any of its own parts. Anything else selected (another card, a note, a lane)
 * → undefined, so only lone cards are ever placed.
 */
export function draggedCard(
  elements: readonly ExcalidrawElement[],
  selectedIds: Readonly<Record<string, true | boolean>>,
): ExcalidrawElement | undefined {
  const selected = elements.filter((e) => !e.isDeleted && selectedIds[e.id]);
  const rects = selected.filter((e) => cardMeta(e));
  if (rects.length !== 1) return undefined;
  const rect = rects[0]!;
  return selected.every((e) => inCard(rect, e)) ? rect : undefined;
}
