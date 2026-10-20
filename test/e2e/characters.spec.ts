import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { seedDemo } from "../mock-claude.ts";
import { startBoard, type Board } from "./board.ts";

const ID = {
  busy: "11111111-0000-4000-8000-000000000001",
  needsUser: "11111111-0000-4000-8000-000000000002",
  waiting: "11111111-0000-4000-8000-000000000005",
};
/** A 2×2 PNG (synthetic). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwnwEIGGEMAEf/A/1Bv7ruAAAAAElFTkSuQmCC",
  "base64",
);

let board: Board;
test.beforeEach(async () => {
  board = await startBoard(seedDemo);
});
test.afterEach(() => board.stop());

async function open(page: Page) {
  await page.goto(board.url);
  await expect(page.locator(".excalidraw")).toBeVisible();
  await expect.poll(() => board.savedCards().length).toBe(5);
}

/** session id → the file id of its card's character, from the saved scene. */
function savedCharacters(): Record<string, string> {
  const els = board.savedElements();
  const out: Record<string, string> = {};
  for (const c of els.filter((e) => e.customData?.excaliagent?.kind === "card-character")) {
    const rect = els.find((e) => e.id === c.customData.excaliagent.cardId);
    if (rect) out[rect.customData.excaliagent.sessionId] = c.fileId;
  }
  return out;
}
const characterOf = (id: string) => savedCharacters()[id];
const stateFile = () => JSON.parse(readFileSync(join(board.stateDir, "characters.json"), "utf8"));

async function cardPoint(page: Page, sessionId: string) {
  return page.evaluate(async (sessionId) => {
    const { excalidraw } = (window as any).__excaliagent;
    const rect = excalidraw
      .getSceneElements()
      .find((e: any) => e.customData?.excaliagent?.kind === "card" && e.customData.excaliagent.sessionId === sessionId);
    excalidraw.scrollToContent(rect, { animate: false });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const s = excalidraw.getAppState();
    return { x: (rect.x + rect.width / 2 + s.scrollX) * s.zoom.value + s.offsetLeft, y: (rect.y + rect.height - 20 + s.scrollY) * s.zoom.value + s.offsetTop };
  }, sessionId);
}

async function openPicker(page: Page, sessionId: string) {
  const point = await cardPoint(page, sessionId);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.locator(".excaliagent-menu").getByRole("menuitem", { name: "Change character…" }).click();
  const dialog = page.getByRole("dialog", { name: "Change character" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("each card gets a distinct character from the Animals pack, remembered on the server", async ({ page }) => {
  await open(page);
  await expect.poll(() => Object.keys(savedCharacters()).length).toBe(5);
  const chars = savedCharacters();
  expect(new Set(Object.values(chars)).size).toBe(5);
  for (const f of Object.values(chars)) expect(f).toMatch(/^excaliagent-emoji-[0-9a-f-]+$/);
  await expect.poll(() => Object.keys(stateFile().assigned?.["@animals"] ?? {}).length).toBe(5);
  expect(stateFile().activePack).toBe("@animals");
  // Drawn from files the app makes itself, never stored with the board's images.
  const loaded = await page.evaluate(() => {
    const { excalidraw } = (window as any).__excaliagent;
    const files = excalidraw.getFiles();
    return excalidraw
      .getSceneElements()
      .filter((e: any) => e.customData?.excaliagent?.kind === "card-character")
      .every((e: any) => files[e.fileId]?.dataURL?.startsWith("data:image/svg+xml"));
  });
  expect(loaded).toBe(true);
  expect(existsSync(join(board.stateDir, "files"))).toBe(false);
  await page.screenshot({ path: "test-results/characters-board.png" });
});

test("a remembered character survives deleting the card and a server restart", async ({ page }) => {
  await open(page);
  await expect.poll(() => characterOf(ID.waiting)).toBeTruthy();
  const before = characterOf(ID.waiting);
  const cardId = board.savedCards().find((c) => c.sessionId === ID.waiting)!.id;
  await page.evaluate((sessionId) => {
    const { excalidraw, sync } = (window as any).__excaliagent;
    const els = excalidraw.getSceneElementsIncludingDeleted();
    const rect = els.find(
      (e: any) => e.customData?.excaliagent?.kind === "card" && e.customData.excaliagent.sessionId === sessionId && !e.isDeleted,
    );
    const inCard = (e: any) => e.id === rect.id || e.groupIds.includes(rect.groupIds[0]);
    excalidraw.updateScene({
      elements: els.map((e: any) => (inCard(e) ? { ...e, isDeleted: true, version: e.version + 1 } : e)),
      captureUpdate: "IMMEDIATELY",
    });
    sync();
  }, ID.waiting);
  await expect.poll(() => board.savedCards().find((c) => c.sessionId === ID.waiting)?.id).not.toBe(cardId);
  expect(characterOf(ID.waiting)).toBe(before);

  await board.restart();
  await page.goto(board.url);
  await page.waitForTimeout(1500);
  expect(characterOf(ID.waiting)).toBe(before);
});

test("right-click → Change character… overrides it from any pack; Reset to automatic restores it", async ({ page }) => {
  await open(page);
  await expect.poll(() => characterOf(ID.needsUser)).toBeTruthy();
  const auto = characterOf(ID.needsUser);
  const dialog = await openPicker(page, ID.needsUser);
  await page.screenshot({ path: "test-results/characters-picker.png" });
  await dialog.getByRole("button", { name: "Sea: 🐙" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => characterOf(ID.needsUser)).toBe("excaliagent-emoji-1f419");
  expect(stateFile().overrides[ID.needsUser]).toEqual({ pack: "@sea", id: "🐙" });

  const again = await openPicker(page, ID.needsUser);
  await expect(again.getByRole("button", { name: "Sea: 🐙" })).toHaveAttribute("aria-pressed", "true");
  await again.getByRole("button", { name: "Reset to automatic" }).click();
  await expect.poll(() => characterOf(ID.needsUser)).toBe(auto);
  expect(stateFile().overrides).toEqual({});

  const shuffle = await openPicker(page, ID.needsUser);
  await shuffle.getByRole("button", { name: "Shuffle" }).click();
  await expect.poll(() => characterOf(ID.needsUser)).not.toBe(auto);
  expect(new Set(Object.values(savedCharacters())).size).toBe(5); // Shuffle avoids characters on the board
});

test("a custom pack with an uploaded image becomes the active pack", async ({ page }) => {
  await open(page);
  await expect.poll(() => Object.keys(savedCharacters()).length).toBe(5);
  await page.getByTitle("Character packs for the cards").click();
  const panel = page.locator(".excaliagent-chars");
  await expect(panel.getByRole("radio", { name: "Use Animals" })).toBeChecked();
  await panel.getByLabel("New pack name").fill("mobs");
  await panel.getByRole("button", { name: "Create" }).click();
  await expect(panel.getByRole("radio", { name: "Use mobs" })).toBeVisible();
  // The add field: a short placeholder that fits, the long hint as its tooltip,
  // and the field and its Add button inside the panel.
  const field = panel.getByLabel("Add an emoji");
  await expect(field).toHaveAttribute("placeholder", "Emoji or image");
  await expect(field).toHaveAttribute("title", "Type or paste an emoji, or paste an image");
  const fits = await field.evaluate((el: HTMLInputElement) => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    const cs = getComputedStyle(el);
    ctx.font = cs.font;
    const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return ctx.measureText(el.placeholder).width <= inner;
  });
  expect(fits).toBe(true);
  const panelBox = (await panel.boundingBox())!;
  for (const box of [await field.boundingBox(), await panel.getByRole("button", { name: "Add", exact: true }).boundingBox()]) {
    expect(box!.x).toBeGreaterThanOrEqual(panelBox.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 0.5);
  }
  await panel.locator('input[type="file"]').setInputFiles({ name: "creeper face.png", mimeType: "image/png", buffer: PNG });
  await expect(panel.locator('[data-character="creeper-face.png"] img')).toBeVisible();
  await panel.getByLabel("Add an emoji").fill("🧟");
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(panel.locator('[data-character="🧟"]')).toBeVisible();
  await page.screenshot({ path: "test-results/characters-panel.png" });

  await panel.getByRole("radio", { name: "Use mobs" }).check();
  await expect.poll(() => stateFile().activePack).toBe("mobs");
  // Two characters, five cards: the pack is exhausted, so duplicates are allowed.
  await expect.poll(() => new Set(Object.values(savedCharacters())).size).toBe(2);
  const fileIds = Object.values(savedCharacters());
  expect(fileIds.some((f) => /^excaliagent-img-[0-9a-f]{24}$/.test(f))).toBe(true);
  expect(fileIds).toContain("excaliagent-emoji-1f9df");
  expect(readdirSync(join(board.stateDir, "packs", "mobs")).sort()).toEqual(["creeper-face.png", "pack.json"]);
  // The image lives once, in the pack folder: not in the scene, not in files/.
  expect(readFileSync(join(board.stateDir, "scene.json"), "utf8")).not.toContain("base64");
  expect(existsSync(join(board.stateDir, "files"))).toBe(false);
  const shown = await page.evaluate(() => {
    const { excalidraw } = (window as any).__excaliagent;
    const files = excalidraw.getFiles();
    const imgs = excalidraw
      .getSceneElements()
      .filter((e: any) => e.customData?.excaliagent?.kind === "card-character" && e.fileId.startsWith("excaliagent-img-"));
    return imgs.length > 0 && imgs.every((e: any) => files[e.fileId]?.dataURL?.startsWith("data:image/png"));
  });
  expect(shown).toBe(true);

  // Switching back restores each card's Animals character.
  const animals = stateFile().assigned["@animals"];
  await panel.getByRole("radio", { name: "Use Animals" }).check();
  await expect.poll(() => savedCharacters()[ID.busy]).toBe(
    `excaliagent-emoji-${[...animals[ID.busy]].map((c: string) => c.codePointAt(0)!.toString(16)).join("-")}`,
  );

  // After a reload, the pack image is fetched again for cards that show it.
  await panel.getByRole("radio", { name: "Use mobs" }).check();
  await expect.poll(() => stateFile().activePack).toBe("mobs");
  await page.reload();
  await expect(page.locator(".excalidraw")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { excalidraw } = (window as any).__excaliagent;
        const files = excalidraw.getFiles();
        const imgs = excalidraw
          .getSceneElements()
          .filter((e: any) => e.customData?.excaliagent?.kind === "card-character" && e.fileId.startsWith("excaliagent-img-"));
        return imgs.length > 0 && imgs.every((e: any) => files[e.fileId]?.dataURL?.startsWith("data:image/png"));
      }),
    )
    .toBe(true);

  // An image that cannot be fetched shows a placeholder, without a broken image or repeated errors.
  const warnings: string[] = [];
  page.on("console", (m) => m.type() === "warning" && warnings.push(m.text()));
  await page.route("**/api/packs/mobs/**", (route) => route.fulfill({ status: 404, body: "gone" }));
  await page.reload();
  await expect(page.locator(".excalidraw")).toBeVisible();
  const PLACEHOLDER = "excaliagent-emoji-2754";
  await expect
    .poll(() =>
      page.evaluate(
        (ph) =>
          (window as any).__excaliagent.excalidraw
            .getSceneElements()
            .some((e: any) => e.customData?.excaliagent?.kind === "card-character" && e.fileId === ph),
        PLACEHOLDER,
      ),
    )
    .toBe(true);
  await page.evaluate(() => (window as any).__excaliagent.sync());
  await page.waitForTimeout(500);
  expect(warnings.filter((w) => w.includes("could not be loaded")).length).toBeLessThanOrEqual(1);
  // The remembered pick is not changed by the placeholder.
  expect(Object.values(stateFile().assigned.mobs)).toContain("creeper-face.png");
});

test("Change character… → None removes the card's character for good; picking one brings it back", async ({ page }) => {
  await open(page);
  await expect.poll(() => characterOf(ID.busy)).toBeTruthy();
  const titleX = () =>
    board.savedElements().find((e) => e.customData?.excaliagent?.kind === "card-title" && e.customData.excaliagent.sessionId === ID.busy)?.x;
  const x0 = titleX();
  const dialog = await openPicker(page, ID.busy);
  await dialog.getByRole("button", { name: "None" }).click();
  await expect.poll(() => characterOf(ID.busy)).toBeUndefined();
  await page.evaluate(() => (window as any).__excaliagent.sync());
  await page.reload();
  await expect(page.locator(".excalidraw")).toBeVisible();
  await page.waitForTimeout(1500);
  expect(characterOf(ID.busy)).toBeUndefined();
  expect(titleX()).toBe(x0);

  const again = await openPicker(page, ID.busy);
  await expect(again.getByRole("button", { name: "None" })).toHaveAttribute("aria-pressed", "true");
  await again.getByRole("button", { name: "Food: 🍕" }).click();
  await expect.poll(() => characterOf(ID.busy)).toBe("excaliagent-emoji-1f355");
  expect(titleX()).toBe(x0);
});

test("the picker takes focus, keeps Tab inside, and closes on Escape", async ({ page }) => {
  await open(page);
  await expect.poll(() => characterOf(ID.waiting)).toBeTruthy();
  const dialog = await openPicker(page, ID.waiting);
  await expect(dialog.locator('.excaliagent-char[aria-pressed="true"]')).toBeFocused();
  for (let i = 0; i < 300; i++) {
    await page.keyboard.press("Tab");
    if (i % 50 === 0) expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("the Characters panel shows a pack without making it active", async ({ page }) => {
  await open(page);
  await page.getByTitle("Character packs for the cards").click();
  const panel = page.locator(".excaliagent-chars");
  await panel.getByRole("button", { name: "Show Sea" }).click();
  await expect(panel.locator('[data-character="🐙"]')).toBeVisible();
  await expect(panel.getByRole("radio", { name: "Use Animals" })).toBeChecked();
  await page.waitForTimeout(300);
  expect(stateFile().activePack).toBe("@animals");
});

test("the Characters panel keeps the radio and the preview in sync", async ({ page }) => {
  await open(page);
  await page.getByTitle("Character packs for the cards").click();
  const panel = page.locator(".excaliagent-chars");
  const viewed = panel.locator('.excaliagent-pack-row[data-viewing="true"]');
  await expect(panel.getByRole("radio", { name: "Use Animals" })).toBeChecked();
  await expect(viewed).toHaveText(/Animals/);

  // Show Sea (preview only), then activate Food by its radio: Food is checked and shown.
  await panel.getByRole("button", { name: "Show Sea" }).click();
  await expect(panel.locator('[data-character="🐙"]')).toBeVisible();
  await expect(viewed).toHaveText(/Sea/);
  await panel.getByRole("radio", { name: "Use Food" }).check();
  await expect(panel.getByRole("radio", { name: "Use Food" })).toBeChecked();
  await expect(panel.locator('[data-character="🍎"]')).toBeVisible();
  await expect(panel.locator('[data-character="🐙"]')).toHaveCount(0);
  await expect.poll(() => stateFile().activePack).toBe("@food");
  await expect(panel.locator('.excaliagent-pack-row[data-viewing="true"]')).toHaveText(/Food/);

  // Clicking anywhere on a row (here its count) shows that pack without activating it.
  await panel.locator(".excaliagent-pack-row", { hasText: "Fantasy" }).locator(".count").click();
  await expect(panel.locator('[data-character="🐉"]')).toBeVisible();
  await expect(panel.getByRole("radio", { name: "Use Food" })).toBeChecked();
  await expect(viewed).toHaveText(/Fantasy/);
  // No helper line: the highlighted row and the checked radio say it all.
  await expect(panel.getByText(/Preview only|Active:/)).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(stateFile().activePack).toBe("@food");
});
