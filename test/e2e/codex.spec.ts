// Codex sessions on the board, from a synthetic Codex home whose "live"
// threads are held by real dummy processes, as the synthetic /proc the server
// reads says (see test/mock-codex.ts, test/mock-proc.ts). Ids are random per run.
import { expect, test, type Page } from "@playwright/test";
import { mockThreadId, seedCodexDemo } from "../mock-codex.ts";
import { startBoard, type Board } from "./board.ts";
import { scrollToElement } from "./view.ts";

let BUSY = "";
let IDLE = "";
let PARKED = "";
const YELLOW = "#ffec99";
const GREY = "#e9ecef";
const DORMANT = "#f8f9fa";

let board: Board;
test.beforeEach(async () => {
  board = await startBoard(() => {}, {
    codexSeed: (codex) => ({ busy: BUSY, idle: IDLE, parked: PARKED } = seedCodexDemo(codex)),
  });
});
test.afterEach(() => board?.stop());

async function open(page: Page) {
  await page.goto(board.url);
  await expect(page.locator(".excalidraw")).toBeVisible();
}

const card = (id: string) => board.savedCards().find((c) => c.sessionId === id);

async function cardPoint(page: Page, sessionId: string) {
  return scrollToElement(page, { kind: "card", sessionId });
}

test("live Codex sessions spawn as cards with the Codex logo; status follows the rollout", async ({ page }) => {
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(2);
  expect(card(BUSY)?.backgroundColor).toBe(YELLOW);
  expect(card(BUSY)?.label.replace(/\s+/g, " ")).toContain("Add pagination to the orders endpoint");
  expect(card(BUSY)?.label).toContain("api-server · feat/pagination");
  expect(card(IDLE)?.backgroundColor).toBe(GREY);
  expect(card(IDLE)?.label.replace(/\s+/g, " ")).toContain("Tidy the landing page CSS");
  expect(card(PARKED)).toBeUndefined();

  const logos = await page.evaluate(() => {
    const { excalidraw } = (window as any).__excaliagent;
    const els = excalidraw.getSceneElements();
    const files = excalidraw.getFiles();
    return els
      .filter((e: any) => e.customData?.excaliagent?.kind === "card-logo")
      .map((l: any) => [l.fileId, !!files[l.fileId]?.dataURL?.startsWith("data:image/svg+xml")]);
  });
  expect(logos).toEqual([
    ["excaliagent-logo-codex", true],
    ["excaliagent-logo-codex", true],
  ]);
  const rects = board.savedElements().filter((e) => e.customData?.excaliagent?.kind === "card");
  expect(rects.map((r) => r.customData.excaliagent.source)).toEqual(["codex", "codex"]);
  // Codex cards get a character like any other card (same hash over the session id).
  await expect
    .poll(() => board.savedElements().filter((e) => e.customData?.excaliagent?.kind === "card-character").map((e) => e.customData.excaliagent.sessionId).sort())
    .toEqual([BUSY, IDLE].sort());
  await page.screenshot({ path: "test-results/codex-cards.png" });

  board.codex.setBusy(IDLE, true);
  await expect.poll(() => card(IDLE)?.backgroundColor, { timeout: 4000 }).toBe(YELLOW);
});

test("the menu copies `codex resume <id>`, and Stop ends the Codex process", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  await expect.poll(() => card(IDLE)?.backgroundColor).toBe(GREY);
  const point = await cardPoint(page, IDLE);
  await page.mouse.click(point.x, point.y, { button: "right" });
  const ours = page.locator(".excaliagent-menu");
  await expect(ours.getByRole("menuitem")).toHaveText(["Copy resume command", "Copy resume command with cd", "Change character…", "Stop session…"]);
  await ours.getByRole("menuitem", { name: "Copy resume command", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`codex resume ${IDLE}`);

  let message = "";
  page.once("dialog", (d) => {
    message = d.message();
    void d.accept();
  });
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.locator(".excaliagent-menu").getByRole("menuitem", { name: "Stop session…" }).click();
  await expect.poll(() => card(IDLE)?.backgroundColor, { timeout: 10_000 }).toBe(DORMANT);
  expect(message).toContain("Codex exits");
});

test("the picker offers a parked Codex session with its logo; double-click offers its resume command", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(2);
  await page.getByTitle("Add a dormant session to the board").click();
  const row = page.locator(".excaliagent-picker-row", { hasText: "Explain the deploy pipeline" });
  await expect(row).toBeVisible();
  await expect(row.getByRole("img", { name: "Codex" })).toBeVisible();
  await row.getByRole("button", { name: "Add" }).click();
  await expect.poll(() => card(PARKED)?.backgroundColor).toBe(DORMANT);
  await page.keyboard.press("Escape");

  const point = await cardPoint(page, PARKED);
  await page.mouse.dblclick(point.x, point.y);
  await expect(page.getByText(new RegExp(`codex resume ${PARKED}`))).toBeVisible();
});

test("a TUI opened but not prompted yet (no rollout) dates from its thread id, not from 1970", async ({ page }) => {
  const fresh = mockThreadId();
  board.codex.add({ id: fresh, cwd: "/home/alice/src/scratch", rollout: false });
  await open(page);
  await expect.poll(() => card(fresh)?.backgroundColor).toBe(GREY);
  expect(card(fresh)?.label).toContain("idle · now");
});

// The real sequence (verified on codex-cli 0.163.0, docs/design.md "Liveness"):
// a TUI closed before its first prompt leaves its thread loaded in the daemon
// with no rollout; a new TUI in the same directory runs ~1 s before its own
// thread exists. The board must not show the old thread as the new TUI's in
// between (it spawned a second card that then went dormant), nor later, while
// Codex's sandbox helper (its own binary, the repo as cwd) runs a command.
test("a fresh TUI beside a closed TUI's unprompted thread spawns one card, and keeps it", async ({ page }) => {
  const dir = "/home/alice/src/course-app";
  const closed = mockThreadId(Date.now() - 60_000);
  board.codex.add({ id: closed, cwd: dir, rollout: false, holder: "daemon" });
  await open(page);
  await expect.poll(() => board.savedCards().length).toBe(2);

  const tui = board.codex.tui(dir);
  await page.waitForTimeout(4_500); // two polls before Codex creates the TUI's thread
  const mine = mockThreadId();
  board.codex.add({ id: mine, cwd: dir, rollout: false, holder: "daemon" });
  await expect.poll(() => card(mine)?.backgroundColor).toBe(GREY);
  expect(card(closed)).toBeUndefined();

  // A command runs: `codex-linux-sandbox` under bwrap (not a Codex parent).
  board.codex.spawn(["codex-linux-sandbox", "--sandbox-policy-cwd", dir, "--command-cwd", dir, "--", "bash", "-lc", "sleep 8"], dir, 4242);
  await page.waitForTimeout(4_500);
  expect(card(mine)?.backgroundColor).toBe(GREY);
  expect(card(closed)).toBeUndefined();
  expect(board.savedCards().length).toBe(3);
  tui.kill();
});
