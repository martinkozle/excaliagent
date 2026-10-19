// Small pure helpers the React shell uses around reconcile.
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { Session } from "../shared/types.ts";
import { cardMeta } from "./cards.ts";

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

/** Cheap change detector over element ids + versions. */
export function saveHash(elements: readonly ExcalidrawElement[]): string {
  let h = 0;
  for (const e of elements) {
    const key = `${e.id}:${e.version}:${e.isDeleted ? 1 : 0};`;
    for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  }
  return `${elements.length}:${h}`;
}
