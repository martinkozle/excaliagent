// Plain box geometry shared by inbox placement and lanes.
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export type Box = Pick<ExcalidrawElement, "x" | "y" | "width" | "height">;

export const inside = (b: Box, x: number, y: number) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;

export const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

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
