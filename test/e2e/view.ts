// Viewport helpers for e2e tests that point the mouse at scene elements.
import type { Page } from "@playwright/test";

export interface Match {
  /** customData.excaliagent.kind of the element. */
  kind: string;
  /** customData.excaliagent.sessionId, when given. */
  sessionId?: string;
}

export interface At {
  /** Fractions of the element's box (default 0.5: its center). */
  fx?: number;
  fy?: number;
  /** Then this far in scene units. */
  dx?: number;
  dy?: number;
}

/**
 * Scroll so the first element matching `match` is centered in the viewport,
 * and return the viewport point `at` on it.
 *
 * Waits until Excalidraw's state has the scroll: getAppState() is React state,
 * and a loaded machine can put the commit off past a frame or two. A point
 * computed from the old scroll is stale the moment the scroll lands, and the
 * mouse then misses the element.
 */
export async function scrollToElement(page: Page, match: Match, at: At = {}): Promise<{ x: number; y: number }> {
  return page.evaluate(
    async ({ match, at }) => {
      const { excalidraw } = (window as any).__excaliagent;
      const el = excalidraw
        .getSceneElements()
        .find(
          (e: any) =>
            e.customData?.excaliagent?.kind === match.kind &&
            (match.sessionId === undefined || e.customData.excaliagent.sessionId === match.sessionId),
        );
      if (!el) throw new Error(`no ${match.kind} element ${match.sessionId ?? ""}`);
      excalidraw.scrollToContent(el, { animate: false });
      const cx = el.x + el.width / 2;
      const cy = el.y + el.height / 2;
      const t0 = performance.now();
      for (;;) {
        const s = excalidraw.getAppState();
        const z = s.zoom.value;
        if (Math.abs((cx + s.scrollX) * z - s.width / 2) < 1 && Math.abs((cy + s.scrollY) * z - s.height / 2) < 1) break;
        if (performance.now() - t0 > 5000) throw new Error("the scroll to the element never landed");
        await new Promise((r) => requestAnimationFrame(r));
      }
      const s = excalidraw.getAppState();
      const sx = el.x + el.width * (at.fx ?? 0.5) + (at.dx ?? 0);
      const sy = el.y + el.height * (at.fy ?? 0.5) + (at.dy ?? 0);
      return { x: (sx + s.scrollX) * s.zoom.value + s.offsetLeft, y: (sy + s.scrollY) * s.zoom.value + s.offsetTop };
    },
    { match, at },
  );
}
