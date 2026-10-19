// Small pure helpers the React shell uses around reconcile.
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
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
  | { action: "open"; label: string; url: string };

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
  return items;
}

/** Header + items, in px; only used to decide whether the panel fits above the menu. */
const MENU_HEADER_H = 32;
const MENU_ITEM_H = 30;

export type Placement = { left: number; width: number } & ({ bottom: number } | { top: number });

/**
 * Glue our panel to Excalidraw's context menu (viewport coords): directly above
 * it (CSS `bottom` = viewport height − menu top), or below it when there is no
 * room above.
 */
export function menuPlacement(
  menu: { left: number; top: number; bottom: number; width: number },
  itemCount: number,
  viewportHeight: number,
): Placement {
  const height = MENU_HEADER_H + itemCount * MENU_ITEM_H;
  return menu.top - height >= 8
    ? { left: menu.left, width: menu.width, bottom: viewportHeight - menu.top }
    : { left: menu.left, width: menu.width, top: menu.bottom };
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
