// Full chain against a throwaway, isolated herdr server (never the user's):
// a mock Claude session whose pid runs in a herdr pane gets the pane id on its
// card, and double-clicking the card focuses that pane.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { herdrRequest } from "../../src/server/panes/herdr-client.ts";
import { startIsolatedHerdr, type IsolatedHerdr } from "../../src/server/panes/__fixtures__/isolated-herdr.ts";
import { startBoard, type Board } from "./board.ts";

const hasHerdr = (() => {
  try {
    execFileSync("herdr", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test.skip(!hasHerdr, "herdr is not installed");

const SESSION = "33333333-0000-4000-8000-000000000001";
let herdr: IsolatedHerdr;
let board: Board;
let fakeDir: string | undefined;

async function untilFile(path: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path) && readFileSync(path, "utf8").trim()) return readFileSync(path, "utf8").trim();
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${path}`);
}

/** Run a dummy foreground process in a pane; returns its pid. */
async function dummyIn(paneId: string, name: string): Promise<number> {
  const pidFile = join(herdr.dir, `${name}.pid`);
  await herdrRequest(herdr.socketPath, "pane.send_text", {
    pane_id: paneId,
    text: `sh -c 'echo $$ > ${pidFile}; exec sleep 300'\n`,
  });
  return Number(await untilFile(pidFile));
}

async function focusedPane(): Promise<string | undefined> {
  const res = (await herdrRequest(herdr.socketPath, "pane.list", {})) as {
    panes: { pane_id: string; focused: boolean }[];
  };
  return res.panes.find((p) => p.focused)?.pane_id;
}

test.afterEach(async () => {
  board?.stop();
  await herdr?.stop();
  if (fakeDir) rmSync(fakeDir, { recursive: true, force: true });
  fakeDir = undefined;
});

test("a card shows its herdr workspace and tab, and double-click focuses the pane", async ({ page }) => {
  herdr = await startIsolatedHerdr();
  const ws = (await herdrRequest(herdr.socketPath, "workspace.create", { cwd: herdr.dir, focus: true, label: "demo-app" })) as {
    root_pane: { pane_id: string };
    tab: { tab_id: string };
  };
  await herdrRequest(herdr.socketPath, "tab.rename", { tab_id: ws.tab.tab_id, label: "oauth" });
  const paneA = ws.root_pane.pane_id;
  const pid = await dummyIn(paneA, "a");
  // A second pane takes focus, so focusing A is observable.
  const split = (await herdrRequest(herdr.socketPath, "pane.split", {
    target_pane_id: paneA,
    direction: "right",
    focus: true,
  })) as { pane: { pane_id: string } };

  board = await startBoard(
    (mock) => mock.add({ id: SESSION, cwd: "/home/alice/src/demo-app", title: "In a pane", status: "busy", pid }),
    { herdrSocket: herdr.socketPath },
  );
  await page.goto(board.url);
  await expect
    .poll(() => board.savedCards().find((c) => c.sessionId === SESSION)?.label, { timeout: 15_000 })
    .toContain("herdr: demo-app › oauth");

  // Make sure focus starts elsewhere; skip the assertion if herdr has no notion of focus without a client.
  const before = await focusedPane();
  expect(before).not.toBe(paneA);

  const point = await page.evaluate(async (sessionId) => {
    const { excalidraw } = (window as any).__excaliagent;
    const rect = excalidraw.getSceneElements().find((e: any) => e.customData?.excaliagent?.kind === "card" && e.customData.excaliagent.sessionId === sessionId);
    // Center it, so Excalidraw's selection panel (top-left) does not cover it.
    excalidraw.scrollToContent(rect, { animate: false });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const s = excalidraw.getAppState();
    return {
      x: (rect.x + rect.width / 2 + s.scrollX) * s.zoom.value + s.offsetLeft,
      y: (rect.y + rect.height / 2 + s.scrollY) * s.zoom.value + s.offsetTop,
    };
  }, SESSION);
  const focusCall = page.waitForResponse((r) => r.url().endsWith("/api/focus"));
  await page.mouse.dblclick(point.x, point.y);
  expect((await focusCall).status()).toBe(204);
  await expect.poll(focusedPane).toBe(paneA);
  void split;
});

test("double-clicking a dormant card resumes it in a new tab of the matching herdr workspace", async ({ page }) => {
  // The isolated herdr's shells must not find the real `claude`: put a fake one
  // first on PATH (inherited by the server and its panes) that only records its args.
  fakeDir = mkdtempSync(join(tmpdir(), "excaliagent-fake-claude-"));
  const argsFile = join(fakeDir, "claude-args");
  writeFileSync(join(fakeDir, "claude"), `#!/bin/sh\necho "$@" > ${argsFile}\n`);
  chmodSync(join(fakeDir, "claude"), 0o755);
  const realPath = process.env.PATH;
  process.env.PATH = `${fakeDir}:${realPath}`;
  try {
    herdr = await startIsolatedHerdr();
  } finally {
    process.env.PATH = realPath;
  }

  const repo = join(herdr.dir, "demo-app");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await herdrRequest(herdr.socketPath, "workspace.create", { cwd: repo, label: "demo-app", focus: true });

  const id = "44444444-0000-4000-8000-000000000001";
  board = await startBoard(
    (mock) => mock.add({ id, cwd: repo, title: "Parked work", live: false, lastTurnMinutesAgo: 60 }),
    { herdrSocket: herdr.socketPath },
  );
  await page.goto(board.url);
  await page.getByTitle("Add a dormant session to the board").click();
  await page.locator(".excaliagent-picker-row", { hasText: "Parked work" }).getByRole("button", { name: "Add" }).click();
  await expect.poll(() => board.savedCards().find((c) => c.sessionId === id)).toBeTruthy();
  await page.keyboard.press("Escape");

  const point = await page.evaluate(async (sessionId) => {
    const { excalidraw } = (window as any).__excaliagent;
    const rect = excalidraw.getSceneElements().find((e: any) => e.customData?.excaliagent?.kind === "card" && e.customData.excaliagent.sessionId === sessionId);
    excalidraw.scrollToContent(rect, { animate: false });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const s = excalidraw.getAppState();
    return {
      x: (rect.x + rect.width / 2 + s.scrollX) * s.zoom.value + s.offsetLeft,
      y: (rect.y + rect.height / 2 + s.scrollY) * s.zoom.value + s.offsetTop,
    };
  }, id);
  const resumeCall = page.waitForResponse((r) => r.url().endsWith("/api/resume"));
  await page.mouse.dblclick(point.x, point.y);
  expect((await resumeCall).status()).toBe(204);

  expect(await untilFile(argsFile)).toBe(`--resume ${id}`);
  const tabs = (await herdrRequest(herdr.socketPath, "tab.list", {})) as { tabs: { label: string; workspace_id: string }[] };
  const workspaces = (await herdrRequest(herdr.socketPath, "workspace.list", {})) as {
    workspaces: { workspace_id: string; label: string }[];
  };
  const tab = tabs.tabs.find((t) => t.label === "Parked work");
  expect(tab).toBeTruthy();
  expect(workspaces.workspaces.find((w) => w.workspace_id === tab!.workspace_id)?.label).toBe("demo-app");
  expect(workspaces.workspaces).toHaveLength(1);
});
