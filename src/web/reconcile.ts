// The single writer (DESIGN.md "Single writer"): sessions + scene → new scene.
//
// Pure. Never touches elements the app did not create, and on app-owned cards
// only colours (rect) and text/originalText/height (bound label). Position, size,
// angle, groups and frames stay as the user left them.
//
// A card whose session is absent from `sessions` is restyled dormant, but its
// label is left alone: we have no data to regenerate it from.
import type { ExcalidrawElement, ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import type { Session } from "../shared/types.ts";
import { cardMeta, isInbox, labelText, makeCard, makeInbox, statusStyle, textHeight, type Gen } from "./cards.ts";
import { nextSlot } from "./inbox.ts";

export interface ReconcileResult {
  /** Full new element array; `=== input` when nothing changed. */
  elements: ExcalidrawElement[];
  changed: boolean;
  /** Session ids that got a new card. */
  spawned: string[];
  /** Session ids whose existing card(s) were patched. */
  patched: string[];
  /** Element ids created or modified (cards, labels, inbox). */
  touchedIds: string[];
}

export function reconcile(
  sessions: readonly Session[],
  elements: readonly ExcalidrawElement[],
  now: number,
  gen: Gen,
  opts: { add?: readonly Session[] } = {},
): ReconcileResult {
  const byId = new Map<string, Session>();
  for (const s of opts.add ?? []) byId.set(s.id, s);
  for (const s of sessions) byId.set(s.id, s);

  const elById = new Map(elements.map((e) => [e.id, e]));
  const out: ExcalidrawElement[] = elements.slice();
  const touched: string[] = [];
  const patched = new Set<string>();
  const carded = new Set<string>();

  const bump = <T extends ExcalidrawElement>(e: T, changes: Partial<T>): T => ({
    ...e,
    ...changes,
    version: e.version + 1,
    versionNonce: gen.seed(),
    updated: now,
  });

  elements.forEach((el, i) => {
    if (el.isDeleted) return;
    const meta = cardMeta(el);
    if (!meta) return;
    carded.add(meta.sessionId);
    const s = byId.get(meta.sessionId);

    const style = statusStyle(s, now);
    if (
      el.backgroundColor !== style.backgroundColor ||
      el.strokeColor !== style.strokeColor ||
      el.strokeStyle !== style.strokeStyle ||
      el.fillStyle !== style.fillStyle
    ) {
      out[i] = bump(el, style);
      touched.push(el.id);
      patched.add(meta.sessionId);
    }

    if (!s) return;
    const textId = el.boundElements?.find((b) => b.type === "text")?.id;
    const text = textId ? elById.get(textId) : undefined;
    if (!text || text.type !== "text" || text.isDeleted || text.containerId !== el.id) return;
    const label = labelText(s, now);
    // Compare originalText: Excalidraw may have re-wrapped `text`.
    if (text.originalText === label) return;
    out[elements.indexOf(text)] = bump<ExcalidrawTextElement>(text, {
      text: label,
      originalText: label,
      height: textHeight(label, text.fontSize, text.lineHeight),
    });
    touched.push(text.id);
    patched.add(meta.sessionId);
  });

  const spawned: string[] = [];
  const toSpawn = [...sessions.filter((s) => s.live), ...(opts.add ?? [])];
  let inbox = out.find(isInbox);
  for (const s of toSpawn) {
    if (carded.has(s.id)) continue;
    if (!inbox) {
      const made = makeInbox(gen, now);
      out.push(...made);
      touched.push(...made.map((e) => e.id));
      inbox = made[0];
    }
    const card = makeCard(byId.get(s.id) ?? s, nextSlot(inbox, out), gen, now);
    out.push(...card);
    touched.push(...card.map((e) => e.id));
    carded.add(s.id);
    spawned.push(s.id);
  }

  const changed = touched.length > 0;
  return {
    elements: changed ? out : (elements as ExcalidrawElement[]),
    changed,
    spawned,
    patched: [...patched],
    touchedIds: touched,
  };
}
