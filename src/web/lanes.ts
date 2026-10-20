// Starter Kanban lanes: plain rectangles the user owns. The app creates them
// (with a fresh board, on "Add starter lanes", or one at a time with "+ Lane") and
// never patches them after;
// `customData.excaliagent = {kind:"lane"}` / `{kind:"lane-label"}` are markers only.
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { CARD_W, INBOX_H, INBOX_ORIGIN, isInbox, makeInbox, makeTitledArea, type Gen, type Measure } from "./cards.ts";
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
