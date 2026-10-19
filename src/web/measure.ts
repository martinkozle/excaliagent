// Browser-only: measure text with a canvas, using Excalidraw's font stacks.
// Pass `canvasMeasure()` as `reconcile(..., { measure })`. Not used in node tests.
import type { Measure } from "./cards.ts";

/** Excalidraw 0.18 FONT_FAMILY ids → CSS family stacks (as its getFontFamilyString builds them). */
const FAMILIES: Record<number, string> = {
  1: "Virgil, Segoe UI Emoji",
  2: "Helvetica, Segoe UI Emoji",
  3: "Cascadia, Segoe UI Emoji",
  5: "Excalifont, Xiaolai, Segoe UI Emoji",
  6: "Nunito, Segoe UI Emoji",
  7: "Lilita One, Segoe UI Emoji",
  8: "Comic Shanns, Segoe UI Emoji",
  9: "Liberation Sans, Segoe UI Emoji",
};

export function fontStack(fontFamily: number): string {
  return `${FAMILIES[fontFamily] ?? "Segoe UI Emoji"}, sans-serif`;
}

/**
 * A `Measure` backed by one shared 2D canvas context. Measure only after the
 * fonts have loaded (e.g. `await document.fonts.load("20px Excalifont")` and
 * `"14px Nunito"`), or the fallback font's widths are used and titles may
 * re-wrap once when the real font arrives.
 */
export function canvasMeasure(): Measure {
  let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  return (text, fontFamily, fontSize) => {
    ctx ??=
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(1, 1).getContext("2d")
        : document.createElement("canvas").getContext("2d");
    if (!ctx) return text.length * fontSize * 0.6;
    ctx.font = `${fontSize}px ${fontStack(fontFamily)}`;
    return ctx.measureText(text).width;
  };
}
