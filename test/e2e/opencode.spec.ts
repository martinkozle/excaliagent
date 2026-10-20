// OpenCode sessions on the board, from a synthetic data dir (opencode.db) and
// real dummy processes the synthetic /proc shows as `opencode -s <id>` (see
// test/mock-opencode.ts, test/mock-proc.ts). Ids are random per run.
import { expect, test, type Page } from "@playwright/test";
import { seedOpenCodeDemo } from "../mock-opencode.ts";
import { startBoard, type Board } from "./board.ts";

let LIVE = "";
let PARKED = "";
const YELLOW = "#ffec99";
const GREY = "#e9ecef";
const DORMANT = "#f8f9fa";

let board: Board;
test.beforeEach(async () => {
  board = await startBoard(() => {}, {
    opencodeSeed: (opencode) => ({ live: LIVE, parked: PARKED } = seedOpenCodeDemo(opencode)),
  });
});
test.afterEach(() => board?.stop());

async function open(page: Page) {
  await page.goto(board.url);
  await expect(page.locator(".excalidraw")).toBeVisible();
}

const card = (id: string) => board.savedCards().find((c) => c.sessionId === id);

async function cardPoint(page: Page, sessionId: string) {
  return page.evaluate(async (sessionId) => {
    const { excalidraw } = (window as any).__excaliagent;
    const rect = excalidraw
      .getSceneElements()
      .find((e: any) => e.customData?.excaliagent?.kind === "card" && e.customData.excaliagent.sessionId === sessionId);
    excalidraw.scrollToContent(rect, { animate: false });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const s = excalidraw.getAppState();
    return {
      x: (rect.x + rect.width / 2 + s.scrollX) * s.zoom.value + s.offsetLeft,
      y: (rect.y + rect.height / 2 + s.scrollY) * s.zoom.value + s.offsetTop,
    };
  }, sessionId);
}

test("a running OpenCode session spawns a card with the OpenCode logo; status follows the database", async ({ page }) => {
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(1);
  expect(card(LIVE)?.backgroundColor).toBe(YELLOW);
  expect(card(LIVE)?.label.replace(/\s+/g, " ")).toContain("Rewrite the getting-started guide");
  expect(card(LIVE)?.label).toContain("docs-site");
  const logo = board.savedElements().find((e) => e.customData?.excaliagent?.kind === "card-logo");
  expect(logo?.fileId).toBe("excaliagent-logo-opencode");
  // OpenCode cards get a character like any other card (same hash over the session id).
  await expect
    .poll(() => board.savedElements().filter((e) => e.customData?.excaliagent?.kind === "card-character").map((e) => e.customData.excaliagent.sessionId))
    .toEqual([LIVE]);
  await page.screenshot({ path: "test-results/opencode-card.png" });

  board.opencode.setBusy(LIVE, false);
  await expect.poll(() => card(LIVE)?.backgroundColor, { timeout: 4000 }).toBe(GREY);
});

test("the menu copies `opencode -s <id>`; Stop ends the process", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  await expect.poll(() => card(LIVE)?.backgroundColor).toBe(YELLOW);
  const point = await cardPoint(page, LIVE);
  await page.mouse.click(point.x, point.y, { button: "right" });
  const ours = page.locator(".excaliagent-menu");
  await ours.getByRole("menuitem", { name: "Copy resume command", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`opencode -s ${LIVE}`);

  let message = "";
  page.once("dialog", (d) => {
    message = d.message();
    void d.accept();
  });
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.locator(".excaliagent-menu").getByRole("menuitem", { name: "Stop session…" }).click();
  await expect.poll(() => card(LIVE)?.backgroundColor, { timeout: 10_000 }).toBe(DORMANT);
  expect(message).toContain("OpenCode exits");
});

test("the picker offers a parked OpenCode session with its logo", async ({ page }) => {
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(1);
  await page.getByTitle("Add a dormant session to the board").click();
  const row = page.locator(".excaliagent-picker-row", { hasText: "Profile the slow search query" });
  await expect(row.getByRole("img", { name: "OpenCode" })).toBeVisible();
  await row.getByRole("button", { name: "Add" }).click();
  await expect.poll(() => card(PARKED)?.backgroundColor).toBe(DORMANT);
});
