import { expect, test, type Page } from "@playwright/test";
import { seedDemo } from "../mock-claude.ts";
import { startBoard, type Board } from "./board.ts";

const ID = {
  busy: "11111111-0000-4000-8000-000000000001",
  needsUser: "11111111-0000-4000-8000-000000000002",
  idleWarm: "11111111-0000-4000-8000-000000000003",
  idleCold: "11111111-0000-4000-8000-000000000004",
  waiting: "11111111-0000-4000-8000-000000000005",
  dormantA: "22222222-0000-4000-8000-000000000001",
};
const RED = "#ffc9c9";
const BLUE = "#a5d8ff";
const GREEN = "#b2f2bb";
const GREY = "#e9ecef";
const DORMANT = "#f8f9fa";

let board: Board;
test.beforeEach(async () => {
  board = await startBoard(seedDemo);
});
test.afterEach(() => board.stop());

async function open(page: Page) {
  await page.goto(board.url);
  await expect(page.locator(".excalidraw")).toBeVisible();
}

const card = (id: string) => board.savedCards().find((c) => c.sessionId === id);

/** Move a card like a user drag would: through Excalidraw, as an undoable edit. */
async function moveCard(page: Page, sessionId: string, x: number, y: number) {
  await page.evaluate(
    ({ sessionId, x, y }) => {
      const { excalidraw } = (window as any).__excaliagent;
      const els = excalidraw.getSceneElementsIncludingDeleted();
      const rect = els.find(
        (e: any) => e.customData?.excaliagent?.kind === "card" && e.customData.excaliagent.sessionId === sessionId && !e.isDeleted,
      );
      const inCard = (e: any) => e.id === rect.id || e.groupIds.includes(rect.groupIds[0]);
      const dx = x - rect.x;
      const dy = y - rect.y;
      const moved = els.map((e: any) =>
        inCard(e)
          ? { ...e, x: e.x + dx, y: e.y + dy, version: e.version + 1, versionNonce: e.versionNonce + 1 }
          : e,
      );
      excalidraw.updateScene({ elements: moved, captureUpdate: "IMMEDIATELY" });
    },
    { sessionId, x, y },
  );
}

test("live sessions spawn as colored cards in the inbox; dormant ones do not", async ({ page }) => {
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(5);
  expect(card(ID.busy)?.backgroundColor).toBe(BLUE);
  expect(card(ID.needsUser)?.backgroundColor).toBe(RED);
  expect(card(ID.waiting)?.backgroundColor).toBe(RED);
  expect(card(ID.idleWarm)?.backgroundColor).toBe(GREEN);
  expect(card(ID.idleCold)?.backgroundColor).toBe(GREY);
  expect(card(ID.dormantA)).toBeUndefined();
  expect(card(ID.needsUser)?.label).toContain("Fix flaky checkout test");
  expect(card(ID.needsUser)?.label).toContain("demo-app · fix/flaky");
  expect(card(ID.needsUser)?.label).toContain("input needed");
  expect(card(ID.needsUser)?.label).toContain("PR #12");
  expect(card(ID.busy)?.label).toContain("not in herdr");
  await page.screenshot({ path: "test-results/board-spawned.png" });
});

test("status changes recolor the card within 2 s, without moving it", async ({ page }) => {
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(5);
  await moveCard(page, ID.busy, 1500, 900);
  await expect.poll(() => card(ID.busy)?.x).toBe(1500);

  board.mock.setStatus(ID.busy, "needs_user", "input needed");
  await expect.poll(() => card(ID.busy)?.backgroundColor, { timeout: 2500 }).toBe(RED);
  expect(card(ID.busy)).toMatchObject({ x: 1500, y: 900 });
  expect(card(ID.busy)?.label).toContain("needs user: input needed");
});

test("layout survives a page reload and a server restart without duplicates", async ({ page }) => {
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(5);
  await moveCard(page, ID.idleWarm, -600, 300);
  await expect.poll(() => card(ID.idleWarm)?.x).toBe(-600);

  await page.reload();
  await expect(page.locator(".excalidraw")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(board.savedCards()).toHaveLength(5);

  await board.restart();
  await open(page);
  await page.waitForTimeout(1500);
  expect(board.savedCards()).toHaveLength(5);
  expect(card(ID.idleWarm)).toMatchObject({ x: -600, y: 300 });
});

test("a deleted card of a live session respawns", async ({ page }) => {
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(5);
  const before = card(ID.waiting)!.id;
  await page.evaluate((sessionId) => {
    const { excalidraw } = (window as any).__excaliagent;
    const els = excalidraw.getSceneElementsIncludingDeleted();
    const rect = els.find(
        (e: any) => e.customData?.excaliagent?.kind === "card" && e.customData.excaliagent.sessionId === sessionId && !e.isDeleted,
      );
      const inCard = (e: any) => e.id === rect.id || e.groupIds.includes(rect.groupIds[0]);
    excalidraw.updateScene({
      elements: els.map((e: any) =>
        inCard(e) ? { ...e, isDeleted: true, version: e.version + 1 } : e,
      ),
      captureUpdate: "IMMEDIATELY",
    });
    (window as any).__excaliagent.sync();
  }, ID.waiting);
  await expect.poll(() => card(ID.waiting)?.id).not.toBe(before);
  expect(board.savedCards()).toHaveLength(5);
});

test("an exited session's card turns dormant and comes back live on resume", async ({ page }) => {
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(5);
  board.mock.exit(ID.idleCold);
  await expect.poll(() => card(ID.idleCold)?.backgroundColor).toBe(DORMANT);
  expect(card(ID.idleCold)?.strokeStyle).toBe("dashed");
  expect(card(ID.idleCold)?.label).toContain("dormant");

  board.mock.resume(ID.idleCold);
  await expect.poll(() => card(ID.idleCold)?.strokeStyle).toBe("solid");
  expect(board.savedCards()).toHaveLength(5);
});

test("a crashed session (stale registry file, dead pid) is not live", async ({ page }) => {
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(5);
  board.mock.crash(ID.busy);
  await expect.poll(() => card(ID.busy)?.backgroundColor, { timeout: 8000 }).toBe(DORMANT);
});

test("the picker adds a dormant session as a dormant card and then hides it", async ({ page }) => {
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(5);
  await page.getByTitle("Add a dormant session to the board").click();
  const row = page.locator(".excaliagent-picker-row", { hasText: "Old migration spike" });
  await expect(row).toBeVisible();
  await expect(page.locator(".excaliagent-picker-row")).toHaveCount(2);
  await row.getByRole("button", { name: "Add" }).click();
  await expect.poll(() => card(ID.dormantA)?.backgroundColor).toBe(DORMANT);
  expect(card(ID.dormantA)?.label).toContain("Old migration spike");
  await expect(row).toHaveCount(0);
  await page.screenshot({ path: "test-results/board-picker.png" });
});

test("double-clicking a dormant card offers the resume command", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(5);
  await page.getByTitle("Add a dormant session to the board").click();
  await page.locator(".excaliagent-picker-row", { hasText: "Old migration spike" }).getByRole("button", { name: "Add" }).click();
  await expect.poll(() => card(ID.dormantA)).toBeTruthy();
  await page.keyboard.press("Escape");

  const point = await page.evaluate(async (sessionId) => {
    const { excalidraw } = (window as any).__excaliagent;
    const rect = excalidraw
      .getSceneElements()
      .find((e: any) => e.customData?.excaliagent?.kind === "card" && e.customData.excaliagent.sessionId === sessionId);
    // Center it, so Excalidraw's selection panel (top-left) does not cover it.
    excalidraw.scrollToContent(rect, { animate: false });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const s = excalidraw.getAppState();
    const sx = rect.x + rect.width / 2;
    const sy = rect.y + rect.height / 2;
    return { x: (sx + s.scrollX) * s.zoom.value + s.offsetLeft, y: (sy + s.scrollY) * s.zoom.value + s.offsetTop };
  }, ID.dormantA);
  await page.mouse.dblclick(point.x, point.y);
  await expect(page.getByText(/claude --resume 22222222-0000-4000-8000-000000000001/)).toBeVisible();
  // Did not enter text editing on the card.
  await expect(page.locator("textarea.excalidraw-wysiwyg")).toHaveCount(0);
});

test("the API refuses requests without the token cookie", async ({ request }) => {
  const res = await request.get(`${board.origin}/api/sessions`);
  expect(res.status()).toBe(401);
});
