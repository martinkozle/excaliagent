// Small pure helpers the React shell uses around reconcile.
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { Session } from "../shared/types.ts";
import { cardMeta, isDormant, prLink, shortPr } from "./cards.ts";

/** Session ids that currently have a (non-deleted) card. */
export function cardSessionIds(elements: readonly ExcalidrawElement[]): Set<string> {
  const ids = new Set<string>();
  for (const e of elements) {
    const meta = !e.isDeleted ? cardMeta(e) : undefined;
    if (meta) ids.add(meta.sessionId);
  }
  return ids;
}

/** Live sessions plus last-known data for carded non-live ones (forced non-live). */
export function mergeSessions(live: readonly Session[], known: ReadonlyMap<string, Session>): Session[] {
  const liveIds = new Set(live.map((s) => s.id));
  const rest = [...known.values()].filter((s) => !liveIds.has(s.id)).map((s) => ({ ...s, live: false }));
  return [...live, ...rest];
}

/** Carded sessions that are neither live, known, nor already asked for. */
export function idsToLookup(
  carded: ReadonlySet<string>,
  live: readonly Session[],
  known: ReadonlyMap<string, Session>,
  asked: ReadonlySet<string>,
): string[] {
  const liveIds = new Set(live.map((s) => s.id));
  return [...carded].filter((id) => !liveIds.has(id) && !known.has(id) && !asked.has(id));
}

/** Session id of the topmost card containing the scene point (rotation ignored). */
export function cardAt(elements: readonly ExcalidrawElement[], x: number, y: number): string | undefined {
  for (let i = elements.length - 1; i >= 0; i--) {
    const e = elements[i]!;
    if (e.isDeleted) continue;
    const meta = cardMeta(e);
    if (meta && x >= e.x && x <= e.x + e.width && y >= e.y && y <= e.y + e.height) return meta.sessionId;
  }
  return undefined;
}

const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export function resumeCommand(s: Pick<Session, "id" | "cwd">): string {
  return `cd ${shellQuote(s.cwd)} && claude --resume ${s.id}`;
}

export function resumeCommandPlain(sessionId: string): string {
  return `claude --resume ${sessionId}`;
}

export type MenuItem =
  | { action: "focus"; label: string }
  | { action: "resume"; label: string }
  | { action: "copy"; label: string; text: string }
  | { action: "open"; label: string; url: string }
  | { action: "end"; label: string }
  | { action: "tidy"; label: string }
  | { action: "character"; label: string };

/** Our lane section of the right-click menu. */
export function laneMenuItems(): MenuItem[] {
  return [{ action: "tidy", label: "Tidy cards" }];
}

/** The parts of `Storage` the settings use; absent when the browser blocks it. */
export type SettingsStore = Pick<Storage, "getItem" | "setItem">;
const LANE_DROP_KEY = "excaliagent.laneDrop";

/** "Drop on a lane title to stack": on unless turned off in this browser. Unreadable storage → on. */
export function readLaneDrop(store: SettingsStore | undefined): boolean {
  try {
    return store?.getItem(LANE_DROP_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Remember the setting per browser; a storage that throws (private mode, blocked) is ignored. */
export function writeLaneDrop(on: boolean, store: SettingsStore | undefined): void {
  try {
    store?.setItem(LANE_DROP_KEY, on ? "on" : "off");
  } catch {
    // not remembered; the toggle still applies until the page reloads
  }
}

/** Our card section of the right-click menu. `s` undefined = session not known (yet). */
export function menuItems(sessionId: string, s: Session | undefined): MenuItem[] {
  const items: MenuItem[] = [];
  if (s && !isDormant(s) && s.pane) items.push({ action: "focus", label: "Focus pane" });
  if (s && isDormant(s)) items.push({ action: "resume", label: "Resume in herdr" });
  items.push({ action: "copy", label: "Copy resume command", text: resumeCommandPlain(sessionId) });
  if (s) items.push({ action: "copy", label: "Copy resume command with cd", text: resumeCommand({ id: sessionId, cwd: s.cwd }) });
  const url = s && prLink(s);
  if (url) {
    const short = shortPr(url);
    items.push({ action: "open", label: /^(PR|MR) /.test(short) ? `Open ${short}` : "Open PR", url });
  }
  items.push({ action: "character", label: "Change character…" });
  if (s && !isDormant(s)) items.push({ action: "end", label: "Stop session…" });
  return items;
}

/** Estimated panel height (header + items) until the real one is measured. */
export function estimatePanelHeight(itemCount: number): number {
  return 36 + itemCount * 30;
}

export type Placement = { left: number; top: number; width: number; side: "left" | "right" };
const SIDE_GAP = 4;
const EDGE = 8;

/**
 * Put our panel beside Excalidraw's context menu (viewport coords), top-aligned
 * with it: on the right if it fits, else on the left; then clamped so it stays
 * fully inside the viewport. (Above/below does not work: on a 1080p screen
 * Excalidraw's own menu is ~730px tall.)
 */
export function menuPlacement(
  menu: { left: number; top: number; right: number; bottom: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
): Placement {
  const right = menu.right + SIDE_GAP;
  const fitsRight = right + panel.width <= viewport.width - EDGE;
  const side = fitsRight ? "right" : "left";
  const rawLeft = fitsRight ? right : menu.left - SIDE_GAP - panel.width;
  const left = Math.max(EDGE, Math.min(rawLeft, viewport.width - EDGE - panel.width));
  const top = Math.max(EDGE, Math.min(menu.top, viewport.height - EDGE - panel.height));
  return { left, top, width: panel.width, side };
}

/** Cheap change detector over element ids + versions. */
export function saveHash(elements: readonly ExcalidrawElement[]): string {
  let h = 0;
  for (const e of elements) {
    const key = `${e.id}:${e.version}:${e.isDeleted ? 1 : 0};`;
    for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  }
  return `${elements.length}:${h}`;
}

/** File ids of the live image elements, each once. */
export function imageFileIds(elements: readonly ExcalidrawElement[]): string[] {
  const ids = new Set<string>();
  for (const e of elements) if (!e.isDeleted && e.type === "image" && e.fileId) ids.add(e.fileId);
  return [...ids];
}

/** Image data the board shows that the server has not stored yet; the app's own files (logos, characters) never go up. */
export function filesToUpload(
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
  stored: ReadonlySet<string>,
  isAppFile: (id: string) => boolean,
): BinaryFileData[] {
  return imageFileIds(elements)
    .filter((id) => !stored.has(id) && !isAppFile(id))
    .map((id) => files[id])
    .filter((f): f is BinaryFileData => f !== undefined);
}
