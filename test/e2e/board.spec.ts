import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { seedDemo } from "../mock-claude.ts";
import { startBoard, type Board } from "./board.ts";
import { scrollToElement } from "./view.ts";

const ID = {
  busy: "11111111-0000-4000-8000-000000000001",
  needsUser: "11111111-0000-4000-8000-000000000002",
  idleWarm: "11111111-0000-4000-8000-000000000003",
  idleCold: "11111111-0000-4000-8000-000000000004",
  waiting: "11111111-0000-4000-8000-000000000005",
  dormantA: "22222222-0000-4000-8000-000000000001",
};
const RED = "#ffc9c9";
const YELLOW = "#ffec99";
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

/** Viewport point at the center of a card, scrolled into view. */
async function cardPoint(page: Page, sessionId: string) {
  return scrollToElement(page, { kind: "card", sessionId });
}

/** Our panel is fully in the viewport, beside Excalidraw's menu, top-aligned unless clamped. */
async function expectBeside(page: Page) {
  const ours = (await page.locator(".excaliagent-menu").boundingBox())!;
  const theirs = (await page.locator(".excalidraw .context-menu").boundingBox())!;
  const vp = page.viewportSize()!;
  expect(ours.x).toBeGreaterThanOrEqual(0);
  expect(ours.y).toBeGreaterThanOrEqual(0);
  expect(ours.x + ours.width).toBeLessThanOrEqual(vp.width);
  expect(ours.y + ours.height).toBeLessThanOrEqual(vp.height);
  const overlapX = ours.x < theirs.x + theirs.width && theirs.x < ours.x + ours.width;
  expect(overlapX).toBe(false);
  if (theirs.y + ours.height <= vp.height - 8) expect(Math.abs(ours.y - theirs.y)).toBeLessThanOrEqual(1);
}

const LANE_TITLES = ["To Do", "In Progress", "Review", "Blocked", "Parked", "Done"];
const lanes = () => board.savedElements().filter((e) => e.customData?.excaliagent?.kind === "lane");
const laneTitles = () =>
  board
    .savedElements()
    .filter((e) => e.customData?.excaliagent?.kind === "lane-label")
    .map((e) => e.text);

test("live sessions spawn as colored cards in the inbox; dormant ones do not", async ({ page }) => {
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(5);
  expect(card(ID.busy)?.backgroundColor).toBe(YELLOW);
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


test("cards fit their title: one-line titles get short cards, a long title a tall one; resized cards stay", async ({ page }) => {
  const LONG = "11111111-0000-4000-8000-0000000000aa";
  board.mock.add({
    id: LONG,
    cwd: "/home/alice/src/demo-app",
    title: "Investigate the intermittent checkout timeout on staging",
    status: "busy",
  });
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(6);
  const short = card(ID.busy)!;
  const tall = card(LONG)!;
  expect(tall.label).toContain("Investigate the");
  expect(tall.height - short.height).toBe(25); // one title line (20 px × 1.25)
  expect(short.appHeight).toBe(short.height);
  expect(tall.appHeight).toBe(tall.height);

  // The user resizes one card; a longer title later grows only the other.
  await page.evaluate((sessionId) => {
    const { excalidraw } = (window as any).__excaliagent;
    const els = excalidraw.getSceneElementsIncludingDeleted();
    excalidraw.updateScene({
      elements: els.map((e: any) =>
        e.customData?.excaliagent?.kind === "card" && e.customData.excaliagent.sessionId === sessionId
          ? { ...e, height: 300, version: e.version + 1, versionNonce: e.versionNonce + 1 }
          : e,
      ),
      captureUpdate: "IMMEDIATELY",
    });
  }, ID.idleCold);
  await expect.poll(() => card(ID.idleCold)?.height).toBe(300);
  const longer = "Bump every dependency and fix whatever breaks along the way";
  board.mock.setTitle(ID.idleCold, longer);
  board.mock.setTitle(ID.busy, longer);
  await expect.poll(() => card(ID.busy)?.height).toBe(tall.height);
  expect(card(ID.busy)).toMatchObject({ x: short.x, y: short.y, appHeight: tall.height });
  await expect.poll(() => card(ID.idleCold)?.label).toContain("Bump every dependency");
  expect(card(ID.idleCold)?.height).toBe(300);
  await page.screenshot({ path: "test-results/board-fit-title.png" });
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

test("every card carries the Claude logo, from built-in files that are never stored", async ({ page }) => {
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(5);
  const logos = await page.evaluate(() => {
    const { excalidraw } = (window as any).__excaliagent;
    const els = excalidraw.getSceneElements();
    const logos = els.filter((e: any) => e.customData?.excaliagent?.kind === "card-logo");
    const files = excalidraw.getFiles();
    return {
      count: logos.length,
      inCardGroups: logos.every((l: any) =>
        els.some((r: any) => r.customData?.excaliagent?.kind === "card" && r.groupIds[0] === l.groupIds[0]),
      ),
      loaded: logos.every((l: any) => files[l.fileId]?.dataURL?.startsWith("data:image/svg+xml")),
    };
  });
  expect(logos).toEqual({ count: 5, inCardGroups: true, loaded: true });
  expect(existsSync(join(board.stateDir, "files"))).toBe(false);
});

test("a pasted image survives a page reload and a server restart", async ({ page }) => {
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(5);
  // A 1×1 PNG, added the way a paste adds it: file data plus an image element.
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await page.evaluate((dataURL) => {
    const { excalidraw } = (window as any).__excaliagent;
    excalidraw.addFiles([{ id: "e2epastedimage", mimeType: "image/png", dataURL, created: 1 }]);
    const els = excalidraw.getSceneElementsIncludingDeleted();
    const logo = els.find((e: any) => e.customData?.excaliagent?.kind === "card-logo");
    const pasted = { ...logo, id: "pasted1", fileId: "e2epastedimage", groupIds: [], customData: undefined, x: -400, y: 0, width: 80, height: 80 };
    excalidraw.updateScene({ elements: [...els, pasted], captureUpdate: "IMMEDIATELY" });
  }, PNG);
  await expect.poll(() => existsSync(join(board.stateDir, "files", "e2epastedimage.json"))).toBe(true);
  const savedScene = () => readFileSync(join(board.stateDir, "scene.json"), "utf8");
  await expect.poll(() => savedScene().includes('"pasted1"')).toBe(true);
  expect(savedScene()).not.toContain("base64"); // image data lives in files/, not in the scene

  const imageAfterLoad = () =>
    page.evaluate(() => {
      const { excalidraw } = (window as any).__excaliagent;
      const el = excalidraw.getSceneElements().find((e: any) => e.id === "pasted1");
      return el ? excalidraw.getFiles()[el.fileId]?.dataURL ?? "missing" : "no element";
    });
  await page.reload();
  await expect(page.locator(".excalidraw")).toBeVisible();
  await expect.poll(imageAfterLoad).toBe(PNG);

  await board.restart();
  await open(page);
  await expect.poll(imageAfterLoad).toBe(PNG);
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
  // The texts follow once the board has looked the exited session up (the restyle comes first).
  await expect.poll(() => card(ID.idleCold)?.label).toContain("dormant");

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

  const point = await cardPoint(page, ID.dormantA);
  await page.mouse.dblclick(point.x, point.y);
  await expect(page.getByText(/claude --resume 22222222-0000-4000-8000-000000000001/)).toBeVisible();
  // Did not enter text editing on the card.
  await expect(page.locator("textarea.excalidraw-wysiwyg")).toHaveCount(0);
});

test("a card links to its last PR", async ({ page }) => {
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(5);
  expect(card(ID.needsUser)?.link).toBe("https://github.com/example/demo-app/pull/12");
  expect(card(ID.busy)?.link).toBeNull();
});

test("right-clicking a card adds our section beside Excalidraw's menu", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(5);
  const point = await cardPoint(page, ID.needsUser);
  await page.mouse.click(point.x, point.y, { button: "right" });

  const theirs = page.locator(".excalidraw .context-menu");
  const ours = page.locator(".excaliagent-menu");
  await expect(theirs).toBeVisible();
  await expect(ours).toBeVisible();
  await expect(ours.getByRole("menuitem")).toHaveText(["Copy resume command", "Copy resume command with cd", "Open PR #12", "Stop session…"]);
  await expectBeside(page);
  await page.screenshot({ path: "test-results/board-card-menu.png" });

  await ours.getByRole("menuitem", { name: "Copy resume command", exact: true }).click();
  await expect(ours).toHaveCount(0);
  await expect(theirs).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`claude --resume ${ID.needsUser}`);
});

test("Stop session ends a running session after confirming; its card turns dormant", async ({ page }) => {
  await open(page);
  await expect.poll(() => card(ID.idleCold)?.backgroundColor).toBe(GREY);
  const point = await cardPoint(page, ID.idleCold);

  // Cancelling the confirm leaves it running.
  page.once("dialog", (d) => void d.dismiss());
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.locator(".excaliagent-menu").getByRole("menuitem", { name: "Stop session…" }).click();
  await page.waitForTimeout(1000);
  expect(card(ID.idleCold)?.backgroundColor).toBe(GREY);

  let message = "";
  page.once("dialog", (d) => {
    message = d.message();
    void d.accept();
  });
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.locator(".excaliagent-menu").getByRole("menuitem", { name: "Stop session…" }).click();
  await expect.poll(() => card(ID.idleCold)?.backgroundColor, { timeout: 10_000 }).toBe(DORMANT);
  expect(message).toContain("The conversation is kept");
});

test("right-clicking empty canvas shows only Excalidraw's menu", async ({ page }) => {
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(5);
  // Scroll far away from every element, then right-click the middle of the canvas.
  await page.evaluate(() => (window as any).__excaliagent.excalidraw.updateScene({ appState: { scrollX: 1e5, scrollY: 1e5 } }));
  await page.mouse.click(700, 450, { button: "right" });
  await expect(page.locator(".excalidraw .context-menu")).toBeVisible();
  await expect(page.locator(".excaliagent-menu")).toHaveCount(0);
});

test("on a 1920×1080 screen our menu sits beside Excalidraw's tall menu, fully visible", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(5);
  for (const id of [ID.needsUser, ID.busy]) {
    const point = await cardPoint(page, id);
    await page.mouse.click(point.x, point.y, { button: "right" });
    await expect(page.locator(".excaliagent-menu")).toBeVisible();
    await expectBeside(page);
    if (id === ID.needsUser) await page.screenshot({ path: "test-results/board-card-menu-1080p.png" });
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 540);
    await expect(page.locator(".excaliagent-menu")).toHaveCount(0);
  }
});

test("a fresh board starts with the inbox and the starter lanes", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(5);
  await expect.poll(() => lanes().length).toBe(8);
  expect(laneTitles()).toEqual(LANE_TITLES);
  const inbox = board.savedElements().find((e) => e.customData?.excaliagent?.kind === "inbox")!;
  expect(inbox.width).toBe(660);
  expect(lanes()[0]).toMatchObject({ x: inbox.x + inbox.width + 40, y: inbox.y, height: inbox.height });
  await page.evaluate(() => (window as any).__excaliagent.excalidraw.scrollToContent(undefined, { fitToContent: true, animate: false }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/board-lanes.png" });
});

test("a lane is renamed by double-clicking it: its title is bound inside", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  await expect.poll(() => lanes().length).toBe(8);
  const point = await scrollToElement(page, { kind: "lane" });
  await page.mouse.dblclick(point.x, point.y);
  const editor = page.locator("textarea.excalidraw-wysiwyg");
  await expect(editor).toHaveValue("To Do");
  await editor.fill("Today");
  await page.keyboard.press("Escape");
  await expect.poll(() => laneTitles()[0]).toBe("Today");
});

test("+ Lane adds one lane at the right end, undoably", async ({ page }) => {
  await open(page);
  await expect.poll(() => lanes().length).toBe(8);
  const last = lanes().at(-1)!;
  await page.getByRole("button", { name: "+ Lane" }).click();
  await expect.poll(() => lanes().length).toBe(9);
  expect(lanes().at(-1)).toMatchObject({ x: last.x + last.width + 40, y: last.y, width: last.width, height: last.height });
  expect(laneTitles().at(-1)).toBe("New lane");
  await page.locator(".excalidraw").focus();
  await page.keyboard.press("Control+z");
  await expect.poll(() => lanes().length).toBe(8);
});

test("Reset the canvas starts a fresh board at once: inbox, lanes, live cards", async ({ page }) => {
  await open(page);
  await expect.poll(() => lanes().length).toBe(8);
  await page.getByRole("button", { name: "+ Lane" }).click();
  await expect.poll(() => lanes().length).toBe(9);
  await page.getByTestId("main-menu-trigger").click();
  await page.getByText("Reset the canvas").click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => lanes().length, { timeout: 5000 }).toBe(8);
  await expect.poll(() => board.savedCards().length, { timeout: 5000 }).toBe(5);
});

test.describe("an existing board with an inbox and no lanes", () => {
  const inbox = {
    id: "old-inbox", type: "rectangle", x: 100, y: 50, width: 980, height: 824, angle: 0,
    strokeColor: "#868e96", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1,
    strokeStyle: "dashed", roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 },
    seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null,
    locked: false, index: "a0", customData: { excaliagent: { kind: "inbox" } },
  };
  test.beforeEach(async () => {
    board.stop();
    board = await startBoard(seedDemo, { scene: { elements: [inbox] } });
  });

  test("keeps its inbox and gets lanes from the main menu", async ({ page }) => {
    await open(page);
    await expect.poll(() => board.savedCards().length).toBe(5);
    expect(lanes()).toHaveLength(0);
    await page.getByTestId("main-menu-trigger").click();
    await page.getByText("Add starter lanes").click();
    await expect.poll(() => lanes().length).toBe(8);
    expect(laneTitles()).toEqual(LANE_TITLES);
    expect(lanes()[0]).toMatchObject({ x: 100 + 980 + 40, y: 50, height: 824 });
    const inboxes = board.savedElements().filter((e) => e.customData?.excaliagent?.kind === "inbox");
    expect(inboxes).toHaveLength(1);
    expect(inboxes[0]).toMatchObject({ width: 980, height: 824 });
    // A normal, undoable edit.
    await page.locator(".excalidraw").focus();
    await page.keyboard.press("Control+z");
    await expect.poll(() => lanes().length).toBe(0);
  });
});

test("the API refuses requests without the token cookie", async ({ request }) => {
  const res = await request.get(`${board.origin}/api/sessions`);
  expect(res.status()).toBe(401);
});
