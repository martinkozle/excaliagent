import { describe, expect, it } from "vitest";
import { topBarLayout } from "./topbar.ts";

describe("topBarLayout", () => {
  it("shows labels on a wide canvas", () => {
    expect(topBarLayout(1400, false, 3)).toBe("labels");
    expect(topBarLayout(1920, false, 4)).toBe("labels");
  });

  it("drops the labels before the buttons crowd the toolbar", () => {
    expect(topBarLayout(1000, false, 3)).toBe("icons");
    expect(topBarLayout(1200, false, 4)).toBe("icons");
  });

  it("moves the buttons below the top bar when even icons do not fit", () => {
    expect(topBarLayout(800, false, 3)).toBe("column");
  });

  it("always uses the column in Excalidraw's phone layout", () => {
    expect(topBarLayout(600, true, 3)).toBe("column");
    expect(topBarLayout(1900, true, 3)).toBe("column");
  });

  it("needs more room for more buttons", () => {
    const widths = [700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500];
    const order = ["column", "icons", "labels"];
    for (const w of widths) {
      expect(order.indexOf(topBarLayout(w, false, 4))).toBeLessThanOrEqual(order.indexOf(topBarLayout(w, false, 3)));
    }
  });
});
