// Card placement in stacked columns: new cards in the inbox, and the column
// rule Tidy uses. Cards in a column are always `GAP` apart, measured from the
// actual bottom of the card above (a one-line card is shorter than a two-line one).
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { AREA_HEADER, CARD_H, CARD_W, cardMeta } from "./cards.ts";
import { elementBounds, overlaps, type Box } from "./geometry.ts";

export const GAP = 20;
/** Float slack, so a card exactly `GAP` below another does not count as too close. */
const EPS = 0.01;

/** Left x of each card column of an area: what fits its width (at least one), `GAP` from its left edge and apart. */
export function columnsOf(area: Box): number[] {
  const cols = Math.max(1, Math.floor((area.width - GAP) / (CARD_W + GAP)));
  return Array.from({ length: cols }, (_, c) => area.x + GAP + c * (CARD_W + GAP));
}

/**
 * Top-left of the first free spot for a `size` card in one of `columns`, at or
 * below `top`: a spot is free when it is at least `GAP` clear of every
 * obstacle above and below it. Each column stacks on its own; the topmost
 * spot wins, the leftmost column on a tie. Candidates are `top` and `GAP`
 * below each obstacle in the column, so there is always one (below the lowest).
 */
export function firstFree(
  columns: readonly number[],
  top: number,
  size: { width: number; height: number },
  obstacles: readonly Box[],
): { x: number; y: number } {
  let best: { x: number; y: number } | undefined;
  for (const x of columns) {
    const inColumn = obstacles.filter((o) => o.x < x + size.width && x < o.x + o.width);
    const ys = [top, ...inColumn.map((o) => o.y + o.height + GAP)].filter((y) => y >= top).sort((a, b) => a - b);
    for (const y of ys) {
      if (best && y >= best.y) break;
      const clear = { x, y: y - GAP + EPS, width: size.width, height: size.height + 2 * GAP - 2 * EPS };
      if (!inColumn.some((o) => overlaps(clear, o))) {
        best = { x, y };
        break;
      }
    }
  }
  return best!;
}

/**
 * Where a new card of `height` goes in the inbox: the first free spot (see
 * `firstFree`) in the inbox's columns below its title (`AREA_HEADER`), clear
 * of every non-deleted card by `GAP`. When the inbox is full, the columns keep
 * going below it.
 */
export function nextSlot(inbox: Box, elements: readonly ExcalidrawElement[], height: number = CARD_H): { x: number; y: number } {
  const cards = elements.filter((e) => !e.isDeleted && cardMeta(e)).map(elementBounds);
  return firstFree(columnsOf(inbox), inbox.y + AREA_HEADER, { width: CARD_W, height }, cards);
}
