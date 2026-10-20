// Starter Kanban lanes: plain rectangles the user owns. The app creates them
// (with a fresh board, on "Add starter lanes", or one at a time with "+ Lane") and
// never patches them after;
// `customData.excaliagent = {kind:"lane"}` / `{kind:"lane-label"}` are markers only.
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { AREA_HEADER, CARD_H, CARD_W, INBOX_H, INBOX_ORIGIN, cardMeta, isInbox, makeInbox, makeTitledArea, type Gen, type Measure } from "./cards.ts";
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
// Fixed cards (see isFixedCard) are never moved; the column flows around them.

type Box = Pick<ExcalidrawElement, "x" | "y" | "width" | "height">;
const inside = (b: Box, x: number, y: number) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Axis-aligned bounds of an element: rotation and line/arrow points included. */
export function elementBounds(e: ExcalidrawElement): Box {
  if ("points" in e && Array.isArray(e.points) && e.points.length) {
    const xs = e.points.map((p) => p[0]);
    const ys = e.points.map((p) => p[1]);
    const box = { x: e.x + Math.min(...xs), y: e.y + Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    if (!e.angle) return box;
    e = { ...e, ...box } as ExcalidrawElement;
  }
  if (!e.angle) return { x: e.x, y: e.y, width: e.width, height: e.height };
  const cos = Math.abs(Math.cos(e.angle));
  const sin = Math.abs(Math.sin(e.angle));
  const w = e.width * cos + e.height * sin;
  const h = e.width * sin + e.height * cos;
  const cx = e.x + e.width / 2;
  const cy = e.y + e.height / 2;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

/** Topmost non-deleted lane containing the scene point (rotation ignored). */
export function laneAt(elements: readonly ExcalidrawElement[], x: number, y: number): ExcalidrawElement | undefined {
  return elements.findLast((e) => isLane(e) && inside(e, x, y));
}

/**
 * The lane to offer "Tidy cards" for: the topmost lane at the point, but only
 * when nothing drawn above it (a note, an arrow, a card) is under the pointer
 * except the lane's own title.
 */
export function laneTargetAt(elements: readonly ExcalidrawElement[], x: number, y: number): ExcalidrawElement | undefined {
  const lane = laneAt(elements, x, y);
  if (!lane) return undefined;
  const above = elements.slice(elements.indexOf(lane) + 1);
  const blocked = above.some(
    (e) => !e.isDeleted && !(e.type === "text" && e.containerId === lane.id) && inside(elementBounds(e), x, y),
  );
  return blocked ? undefined : lane;
}

/** A lane's drop zone: its title band, the full width and `AREA_HEADER` tall. */
export function dropZone(lane: Box): Box {
  return { x: lane.x, y: lane.y, width: lane.width, height: Math.min(AREA_HEADER, lane.height) };
}

/** Topmost lane whose drop zone contains the scene point. */
export function dropLaneAt(elements: readonly ExcalidrawElement[], x: number, y: number): ExcalidrawElement | undefined {
  return elements.findLast((e) => isLane(e) && inside(dropZone(e), x, y));
}

/** The non-deleted lanes, in scene order (taken once when a drag starts). */
export function lanesOf(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  return elements.filter(isLane);
}

/** Drop zones of `lanes` that intersect the visible scene area `view`: the hints shown while dragging a card. */
export function zonesInView(lanes: readonly ExcalidrawElement[], view: Box): Array<{ laneId: string; zone: Box }> {
  return lanes.map((l) => ({ laneId: l.id, zone: dropZone(l) })).filter(({ zone }) => overlaps(zone, view));
}

/** Card rects whose centre is inside the lane, in scene order. */
export function cardsInLane(elements: readonly ExcalidrawElement[], lane: Box): ExcalidrawElement[] {
  return elements.filter((e) => !e.isDeleted && cardMeta(e) && inside(lane, e.x + e.width / 2, e.y + e.height / 2));
}

/**
 * A card the app must not move: locked, rotated, bound to an arrow (the
 * user's arrow would be left behind, and the app never edits user drawings),
 * or grouped by the user with something else.
 */
export function isFixedCard(rect: ExcalidrawElement): boolean {
  return (
    rect.locked ||
    rect.angle !== 0 ||
    rect.groupIds.length > 1 ||
    !!rect.boundElements?.some((b) => b.type === "arrow")
  );
}

/**
 * Height a card takes in a column. A card that still has the height the app
 * gave it may grow to two title lines, so it reserves `CARD_H` (as the inbox
 * grid does); a card the user resized takes its own height.
 */
function columnHeight(rect: ExcalidrawElement): number {
  const app = cardMeta(rect)?.appHeight;
  const appSized = typeof app === "number" && Math.abs(rect.height - app) < 0.5;
  return appSized ? Math.max(rect.height, CARD_H) : rect.height;
}

/** Bottom of a card's footprint in a column: fixed ones by their (rotated) bounds. */
function footprintBottom(rect: ExcalidrawElement): number {
  if (isFixedCard(rect)) {
    const b = elementBounds(rect);
    return b.y + Math.max(b.height, rect.angle === 0 ? columnHeight(rect) : 0);
  }
  return rect.y + columnHeight(rect);
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
    .reduce((y, c) => Math.max(y, footprintBottom(c) + GAP), lane.y + AREA_HEADER);
  return { x: lane.x + GAP, y: bottom };
}

/**
 * "Tidy cards": the lane's movable cards stacked top-down in one column under
 * the title, in their current vertical order (then left to right), `GAP`
 * apart. Fixed cards stay put; a card whose slot would overlap one goes below
 * it instead. Only cards that actually move are returned (rect id → new top-left).
 */
export function tidyMoves(elements: readonly ExcalidrawElement[], lane: Box): Map<string, { x: number; y: number }> {
  const cards = cardsInLane(elements, lane).sort((a, b) => a.y - b.y || a.x - b.x);
  const fixed = cards.filter(isFixedCard).map((c) => ({ ...elementBounds(c), bottom: footprintBottom(c) }));
  const moves = new Map<string, { x: number; y: number }>();
  let y = lane.y + AREA_HEADER;
  for (const c of cards) {
    if (isFixedCard(c)) continue;
    const h = columnHeight(c);
    for (;;) {
      const slot = { x: lane.x + GAP, y, width: c.width, height: h };
      const hit = fixed.filter((f) => overlaps(slot, { ...f, height: f.bottom - f.y + GAP }));
      if (!hit.length) break;
      y = Math.max(...hit.map((f) => f.bottom)) + GAP;
    }
    const to = { x: lane.x + GAP, y };
    if (to.x !== c.x || to.y !== c.y) moves.set(c.id, to);
    y += h + GAP;
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
 * The card being dragged, if the selection is exactly one movable card: its
 * rect, plus any of its own parts. Anything else selected (another card, a
 * note, a lane), or a fixed card → undefined, so only lone free cards are placed.
 */
export function draggedCard(
  elements: readonly ExcalidrawElement[],
  selectedIds: Readonly<Record<string, true | boolean>>,
): ExcalidrawElement | undefined {
  const selected = elements.filter((e) => !e.isDeleted && selectedIds[e.id]);
  const rects = selected.filter((e) => cardMeta(e));
  if (rects.length !== 1) return undefined;
  const rect = rects[0]!;
  return !isFixedCard(rect) && selected.every((e) => inCard(rect, e)) ? rect : undefined;
}
