// Starter Kanban lanes: plain rectangles the user owns. The app creates them
// (with a fresh board, or on "Add starter lanes") and never patches them after;
// `customData.excaliagent = {kind:"lane"}` / `{kind:"lane-label"}` are markers only.
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { CARD_W, isInbox, makeArea, makeAreaLabel, makeInbox, type Gen } from "./cards.ts";
import { GAP } from "./inbox.ts";

export const LANE_W = CARD_W + 2 * GAP;
export const LANE_GAP = 40;
/** Empty string = untitled lane. */
export const LANE_TITLES = ["To Do", "In Progress", "Review", "Blocked", "Parked", "Done", "", ""] as const;

const isLane = (e: ExcalidrawElement) => !e.isDeleted && e.customData?.excaliagent?.kind === "lane";

export function hasLanes(elements: readonly ExcalidrawElement[]): boolean {
  return elements.some(isLane);
}

/** Lanes (and labels for titled ones) left to right from `at`. */
export function makeLanes(gen: Gen, now: number, at: { x: number; y: number }, height: number): ExcalidrawElement[] {
  const out: ExcalidrawElement[] = [];
  LANE_TITLES.forEach((title, i) => {
    const x = at.x + i * (LANE_W + LANE_GAP);
    out.push(makeArea(gen, now, { x, y: at.y, width: LANE_W, height }, { excaliagent: { kind: "lane" } }));
    if (title) out.push(makeAreaLabel(gen, now, { x, y: at.y }, title, { excaliagent: { kind: "lane-label" } }));
  });
  return out;
}

/** Lanes right of an inbox's current bounds, top-aligned, same height. */
export function lanesBeside(inbox: ExcalidrawElement, gen: Gen, now: number): ExcalidrawElement[] {
  return makeLanes(gen, now, { x: inbox.x + inbox.width + LANE_GAP, y: inbox.y }, inbox.height);
}

/** A new board: the tall inbox plus the lanes. */
export function makeStarterBoard(gen: Gen, now: number): ExcalidrawElement[] {
  const inbox = makeInbox(gen, now);
  return [...inbox, ...lanesBeside(inbox[0], gen, now)];
}

/** "Add starter lanes": the scene with lanes appended beside the inbox, or null without an inbox. */
export function appendLanes(elements: readonly ExcalidrawElement[], gen: Gen, now: number): ExcalidrawElement[] | null {
  const inbox = elements.find(isInbox);
  return inbox ? [...elements, ...lanesBeside(inbox, gen, now)] : null;
}
