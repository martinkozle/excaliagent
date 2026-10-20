// `npm run screenshots`: README images from the synthetic demo cast, never real
// sessions. Needs a built web bundle (`npm run build:web`) and Playwright's
// chromium (the Nix shell provides it).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { seedDemo } from "../test/mock-claude.ts";
import { seedCodexDemo } from "../test/mock-codex.ts";
import { seedOpenCodeDemo } from "../test/mock-opencode.ts";
import { startBoard } from "../test/e2e/board.ts";

const out = join(import.meta.dirname, "..", "docs", "images");
mkdirSync(out, { recursive: true });

const ID = {
  oauth: "11111111-0000-4000-8000-000000000001",
  flaky: "11111111-0000-4000-8000-000000000002",
  grill: "11111111-0000-4000-8000-000000000003",
  deps: "11111111-0000-4000-8000-000000000004",
  design: "11111111-0000-4000-8000-000000000005",
  migration: "22222222-0000-4000-8000-000000000001",
};

/** Move a card (rect + its group) into the lane whose title is `lane`. */
async function moveToLane(page: Page, sessionId: string, lane: string, slot = 0) {
  await page.evaluate(
    ({ sessionId, lane, slot }) => {
      const { excalidraw } = (window as any).__excaliagent;
      const els = excalidraw.getSceneElementsIncludingDeleted();
      const label = els.find((e: any) => !e.isDeleted && e.type === "text" && e.originalText === lane);
      const laneRect = els
        .filter((e: any) => !e.isDeleted && e.type === "rectangle" && e.customData?.excaliagent?.kind === "lane")
        .find((e: any) => e.id === label.containerId);
      const rect = els.find(
        (e: any) => e.customData?.excaliagent?.kind === "card" && e.customData.excaliagent.sessionId === sessionId && !e.isDeleted,
      );
      const dx = laneRect.x + 20 - rect.x;
      const dy = laneRect.y + 56 + slot * (rect.height + 20) - rect.y; // below the lane title (AREA_HEADER)
      const group = rect.groupIds[0];
      excalidraw.updateScene({
        elements: els.map((e: any) =>
          e.id === rect.id || (group && e.groupIds.includes(group))
            ? { ...e, x: e.x + dx, y: e.y + dy, version: e.version + 1, versionNonce: e.versionNonce + 1 }
            : e,
        ),
        captureUpdate: "IMMEDIATELY",
      });
    },
    { sessionId, lane, slot },
  );
}

let codexIds = { busy: "", idle: "", parked: "" };
let opencodeIds = { live: "", parked: "" };
const board = await startBoard(seedDemo, {
  codexSeed: (codex) => void (codexIds = seedCodexDemo(codex)),
  opencodeSeed: (opencode) => void (opencodeIds = seedOpenCodeDemo(opencode)),
});
const cards = 8;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(board.url);
  // Excalidraw's onboarding hint ("To move canvas…") is noise in a screenshot.
  await page.addStyleTag({ content: ".HintViewer { display: none !important; }" });
  await page.waitForFunction((n) => (window as any).__excaliagent?.excalidraw.getSceneElements().filter((e: any) => e.customData?.excaliagent?.kind === "card").length >= n, cards, { timeout: 10_000 });

  // Add a dormant session from the picker, then triage the cast into lanes.
  await page.getByTitle("Add a dormant session to the board").click();
  await page.locator(".excaliagent-picker-row", { hasText: "Old migration spike" }).getByRole("button", { name: "Add" }).click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await moveToLane(page, ID.oauth, "In Progress");
  await moveToLane(page, codexIds.busy, "In Progress", 1);
  await moveToLane(page, opencodeIds.live, "In Progress", 2);
  await moveToLane(page, ID.flaky, "Review");
  await moveToLane(page, ID.design, "Blocked");
  await moveToLane(page, ID.migration, "Parked");
  // Overview: the inbox and the first lanes, cards readable.
  await page.setViewportSize({ width: 1600, height: 640 });
  await page.evaluate(() => {
    const { excalidraw } = (window as any).__excaliagent;
    const inbox = excalidraw.getSceneElements().find((e: any) => e.customData?.excaliagent?.kind === "inbox");
    const zoom = 0.62;
    excalidraw.updateScene({
      appState: {
        selectedElementIds: {},
        zoom: { value: zoom },
        scrollX: -inbox.x + 30 / zoom,
        scrollY: -inbox.y + 110 / zoom,
      },
    });
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, "board.png") });

  // Close-up of a few cards and the right-click menu.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.evaluate(async (id) => {
    const { excalidraw } = (window as any).__excaliagent;
    const rect = excalidraw.getSceneElements().find((e: any) => e.customData?.excaliagent?.kind === "card" && e.customData.excaliagent.sessionId === id);
    const zoom = 1.2;
    const { width, height } = excalidraw.getAppState();
    // Card in the left third, so the menu and our panel fit to its right.
    excalidraw.updateScene({
      appState: {
        zoom: { value: zoom },
        scrollX: -rect.x + (width * 0.2) / zoom,
        scrollY: -rect.y + (height * 0.25) / zoom,
      },
    });
  }, ID.flaky);
  await page.waitForTimeout(500);
  const point = await page.evaluate((id) => {
    const { excalidraw } = (window as any).__excaliagent;
    const rect = excalidraw.getSceneElements().find((e: any) => e.customData?.excaliagent?.kind === "card" && e.customData.excaliagent.sessionId === id);
    const s = excalidraw.getAppState();
    return { x: (rect.x + rect.width / 2 + s.scrollX) * s.zoom.value + s.offsetLeft, y: (rect.y + 40 + s.scrollY) * s.zoom.value + s.offsetTop };
  }, ID.flaky);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, "card-menu.png") });

  // The Characters panel beside the cards it draws on.
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 500);
  await page.setViewportSize({ width: 1600, height: 820 });
  await page.evaluate((id) => {
    const { excalidraw } = (window as any).__excaliagent;
    const rect = excalidraw.getSceneElements().find((e: any) => e.customData?.excaliagent?.kind === "card" && e.customData.excaliagent.sessionId === id);
    const zoom = 1.1;
    excalidraw.updateScene({ appState: { selectedElementIds: {}, zoom: { value: zoom }, scrollX: -rect.x + 40 / zoom, scrollY: -rect.y + 120 / zoom } });
  }, ID.grill);
  await page.getByTitle("Character packs for the cards").click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, "characters.png") });
  console.log(`wrote ${join(out, "board.png")}, card-menu.png and characters.png`);
} finally {
  await browser.close();
  board.stop();
}
