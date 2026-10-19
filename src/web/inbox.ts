// Inbox placement: a wrapping grid inside the inbox rectangle.
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { CARD_H, CARD_W, cardMeta } from "./cards.ts";

export const GAP = 20;

type Box = Pick<ExcalidrawElement, "x" | "y" | "width" | "height">;

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * First free grid slot (row-major, `CARD_W`×`CARD_H` cells with `GAP`) inside
 * `inbox` that overlaps no non-deleted card. When the inbox is full, rows keep
 * going below it in the same columns.
 */
export function nextSlot(inbox: Box, elements: readonly ExcalidrawElement[]): { x: number; y: number } {
  const cards = elements.filter((e) => !e.isDeleted && cardMeta(e));
  const cols = Math.max(1, Math.floor((inbox.width - GAP) / (CARD_W + GAP)));
  for (let i = 0; ; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const slot = { x: inbox.x + GAP + c * (CARD_W + GAP), y: inbox.y + GAP + r * (CARD_H + GAP), width: CARD_W, height: CARD_H };
    if (!cards.some((k) => overlaps(slot, k))) return { x: slot.x, y: slot.y };
  }
}
