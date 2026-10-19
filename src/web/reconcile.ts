// The single writer (docs/design.md "What the app may change"): sessions + scene → new scene.
//
// Pure. Never touches elements the app did not create. On app-owned cards:
// - rect: only colours and `link` (the session's last PR url) change. Exception, migration of an old bound-label card:
//   a fresh app group id is prepended to its groupIds, the bound text entry is
//   removed from boundElements, and its height grows (never shrinks) to CARD_H.
// - title/details texts: only text/originalText and their width/height (content
//   length) change, plus customData.cardId when re-pointed after a copy-paste.
//   They move with the card's group; the one exception: when the title's wrapped
//   line count changes, the details text is re-placed below it, relative to the
//   rect's current x/y (it is an app-owned element inside the card's group).
// A card whose session is absent from `sessions` is restyled dormant; its texts
// and link are left alone (nothing to regenerate them from).
//
// Continued sessions: a card whose session has `continuedIn = X` is retargeted
// to X (customData.sessionId on the rect and its texts) before spawning, unless
// X already has a card (then the old card stays as it is). Chains A→B→C resolve
// in one pass (stopping at a hop that already has a card).
import type { ExcalidrawElement, ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import type { Session } from "../shared/types.ts";
import {
  CARD_H,
  cardMeta,
  cardPartMeta,
  detailsText,
  prLink,
  estimateMeasure,
  lineCount,
  partOffset,
  wrapTitle,
  type Measure,
  isInbox,
  makeCard,
  makeCardPart,
  makeInbox,
  partBox,
  TITLE_SIZE,
  DETAIL_SIZE,
  statusStyle,
  titleText,
  type CardPartKind,
  type Gen,
} from "./cards.ts";
import { nextSlot } from "./inbox.ts";

export interface ReconcileResult {
  /** Full new element array; `=== input` when nothing changed. */
  elements: ExcalidrawElement[];
  changed: boolean;
  /** Session ids that got a new card. */
  spawned: string[];
  /** Session ids whose existing card(s) were patched, repaired or migrated. */
  patched: string[];
  /** Element ids created or modified. */
  touchedIds: string[];
  /** Cards moved over to a continuation session. */
  retargeted: Array<{ from: string; to: string }>;
}

function sessionMap(sessions: readonly Session[], add: readonly Session[] = []): Map<string, Session> {
  const byId = new Map<string, Session>();
  for (const s of add) byId.set(s.id, s);
  for (const s of sessions) byId.set(s.id, s);
  return byId;
}

const bumpWith =
  (gen: Gen, now: number) =>
  <T extends ExcalidrawElement>(e: T, changes: Partial<T>): T => ({
    ...e,
    ...changes,
    version: e.version + 1,
    versionNonce: gen.seed(),
    updated: now,
  });

/** Point cards of continued sessions at their continuation. */
function retarget(
  elements: readonly ExcalidrawElement[],
  byId: ReadonlyMap<string, Session>,
  now: number,
  gen: Gen,
): { elements: readonly ExcalidrawElement[]; touched: string[]; retargeted: Array<{ from: string; to: string }> } {
  const rects = elements.filter((e) => !e.isDeleted && cardMeta(e));
  const carded = new Set(rects.map((r) => cardMeta(r)!.sessionId));
  const bump = bumpWith(gen, now);
  let out: ExcalidrawElement[] | undefined;
  const touched: string[] = [];
  const retargeted: Array<{ from: string; to: string }> = [];
  for (const rect of rects) {
    const from = cardMeta(rect)!.sessionId;
    // Follow the chain to its end; stop if any hop already has a card.
    let to: string | undefined;
    const seen = new Set([from]);
    for (let next = byId.get(from)?.continuedIn; next && !seen.has(next); next = byId.get(next)?.continuedIn) {
      seen.add(next);
      to = next;
      if (carded.has(next)) break;
    }
    if (!to || carded.has(to)) continue;
    carded.add(to);
    retargeted.push({ from, to });
    out ??= elements.slice();
    elements.forEach((e, i) => {
      if (e.isDeleted) return;
      const m = e.customData?.excaliagent;
      const mine =
        e.id === rect.id ||
        (!!cardPartMeta(e) &&
          m.sessionId === from &&
          (m.cardId === rect.id || (!!rect.groupIds[0] && e.groupIds[0] === rect.groupIds[0])));
      if (!mine) return;
      out![i] = bump(e, { customData: { ...e.customData, excaliagent: { ...m, sessionId: to } } });
      touched.push(e.id);
    });
  }
  return { elements: out ?? elements, touched, retargeted };
}

export function reconcile(
  sessions: readonly Session[],
  elements: readonly ExcalidrawElement[],
  now: number,
  gen: Gen,
  opts: { add?: readonly Session[]; measure?: Measure } = {},
): ReconcileResult {
  const pre = retarget(elements, sessionMap(sessions, opts.add), now, gen);
  const r = reconcileCards(sessions, pre.elements, now, gen, opts);
  const touchedIds = [...new Set([...pre.touched, ...r.touchedIds])];
  const changed = touchedIds.length > 0;
  return {
    ...r,
    elements: changed ? r.elements : (elements as ExcalidrawElement[]),
    changed,
    touchedIds,
    patched: [...new Set([...pre.retargeted.map((t) => t.to), ...r.patched])],
    retargeted: pre.retargeted,
  };
}

const PARTS: CardPartKind[] = ["card-title", "card-details"];

function reconcileCards(
  sessions: readonly Session[],
  elements: readonly ExcalidrawElement[],
  now: number,
  gen: Gen,
  opts: { add?: readonly Session[]; measure?: Measure },
): Omit<ReconcileResult, "retargeted"> {
  const measure = opts.measure ?? estimateMeasure;
  const byId = sessionMap(sessions, opts.add);

  const out: ExcalidrawElement[] = elements.slice();
  const indexOf = new Map(elements.map((e, i) => [e.id, i]));
  const touched: string[] = [];
  const patched = new Set<string>();
  const inserts = new Map<number, ExcalidrawElement[]>();

  const bump = bumpWith(gen, now);
  const put = (e: ExcalidrawElement) => {
    out[indexOf.get(e.id)!] = e;
    touched.push(e.id);
  };

  // --- index cards and their parts -------------------------------------------
  const rects = elements.filter((e) => !e.isDeleted && cardMeta(e));
  const rectById = new Map(rects.map((r) => [r.id, r]));
  const parts = elements.filter((e): e is ExcalidrawTextElement => !e.isDeleted && !!cardPartMeta(e));
  const assigned = new Map<string, ExcalidrawTextElement>(); // `${rectId}|${kind}`
  const owner = new Map<string, string>(); // text id → rect id
  const assign = (t: ExcalidrawTextElement, r: ExcalidrawElement) => {
    const key = `${r.id}|${cardPartMeta(t)!.kind}`;
    if (assigned.has(key) || owner.has(t.id)) return false;
    assigned.set(key, t);
    owner.set(t.id, r.id);
    return true;
  };
  // 1) by innermost group (survives copy-paste, which re-ids elements and groups)
  for (const t of parts) {
    const g = t.groupIds[0];
    const m = cardPartMeta(t)!;
    if (!g) continue;
    const r = rects.find((r) => r.groupIds[0] === g && cardMeta(r)!.sessionId === m.sessionId && !assigned.has(`${r.id}|${m.kind}`));
    if (r) assign(t, r);
  }
  // 2) by cardId
  for (const t of parts) {
    if (owner.has(t.id)) continue;
    const m = cardPartMeta(t)!;
    const r = rectById.get(m.cardId);
    if (r && cardMeta(r)!.sessionId === m.sessionId) assign(t, r);
  }
  // 3) orphans (rect deleted, or duplicates) → soft-delete
  for (const t of parts) if (!owner.has(t.id)) put(bump(t, { isDeleted: true }));

  // --- patch / repair / migrate each card -------------------------------------
  for (const rect0 of rects) {
    const meta = cardMeta(rect0)!;
    const s = byId.get(meta.sessionId);
    const rectChanges: Partial<ExcalidrawElement> = {};
    let cardTouched = false;

    const style = statusStyle(s, now);
    for (const k of ["backgroundColor", "strokeColor", "strokeStyle", "fillStyle"] as const)
      if (rect0[k] !== style[k]) Object.assign(rectChanges, { [k]: style[k] });
    if (s && rect0.link !== prLink(s)) Object.assign(rectChanges, { link: prLink(s) });

    // Old card: bound text label → migrate.
    const legacyId = rect0.boundElements?.find((b) => b.type === "text")?.id;
    const legacyIdx = legacyId !== undefined ? indexOf.get(legacyId) : undefined;
    const legacy = legacyIdx !== undefined ? elements[legacyIdx] : undefined;
    let legacyLines: string[] | undefined;
    if (legacy && legacy.type === "text" && !legacy.isDeleted && legacy.containerId === rect0.id) {
      legacyLines = legacy.originalText.split("\n");
      put(bump(legacy, { isDeleted: true }));
      const rest = rect0.boundElements!.filter((b) => b.id !== legacy.id);
      Object.assign(rectChanges, {
        groupIds: [gen.id(), ...rect0.groupIds],
        boundElements: rest.length ? rest : null,
        ...(rect0.height < CARD_H ? { height: CARD_H } : {}),
      });
    }

    let rect = rect0;
    if (Object.keys(rectChanges).length) {
      rect = bump(rect0, rectChanges);
      put(rect);
      cardTouched = true;
    }

    let titleLines = 1;
    let titleLinesChanged = false;
    for (const kind of PARTS) {
      const t = assigned.get(`${rect.id}|${kind}`);
      const want = s ? (kind === "card-title" ? titleText(s, measure) : detailsText(s, now, measure)) : undefined;
      if (t) {
        const changes: { -readonly [K in keyof ExcalidrawTextElement]?: ExcalidrawTextElement[K] } = {};
        if (want !== undefined && t.originalText !== want) {
          Object.assign(changes, { text: want, originalText: want, ...partBox(kind, want, measure) });
        } else if (t.fontSize === (kind === "card-title" ? TITLE_SIZE : DETAIL_SIZE)) {
          // Same text, but measured differently (e.g. the real font loaded after the
          // first measure): re-fit the box so Excalidraw does not clip the text.
          const box = partBox(kind, t.originalText, measure);
          if (Math.abs(box.width - t.width) > 1 || Math.abs(box.height - t.height) > 1) Object.assign(changes, box);
        }
        if (kind === "card-title") {
          titleLines = lineCount(want ?? t.originalText);
          titleLinesChanged = titleLines !== lineCount(t.originalText);
        } else if (titleLinesChanged) {
          // Keep details just below the (re-wrapped) title, relative to the rect's current position.
          const { dx, dy } = partOffset(kind, titleLines);
          Object.assign(changes, { x: rect.x + dx, y: rect.y + dy });
        }
        const m = cardPartMeta(t)!;
        if (m.cardId !== rect.id) changes.customData = { ...t.customData, excaliagent: { ...m, cardId: rect.id } };
        if (Object.keys(changes).length) {
          put(bump(t, changes));
          cardTouched = true;
        }
        continue;
      }
      // Missing part: recreate from the session, or from the old label when migrating.
      const legacyText = legacyLines
        ? kind === "card-title"
          ? wrapTitle(legacyLines[0] ?? "", measure)
          : legacyLines.slice(1).join("\n")
        : undefined;
      const text = want ?? legacyText;
      if (!text) continue;
      if (kind === "card-title") titleLines = lineCount(text);
      const made = makeCardPart(kind, rect, meta.sessionId, text, gen, now, measure, titleLines);
      const at = indexOf.get(rect.id)!;
      inserts.set(at, [...(inserts.get(at) ?? []), made]);
      touched.push(made.id);
      cardTouched = true;
    }
    if (cardTouched) patched.add(meta.sessionId);
  }

  let result: ExcalidrawElement[] = out;
  if (inserts.size) {
    result = [];
    out.forEach((e, i) => {
      result.push(e);
      result.push(...(inserts.get(i) ?? []));
    });
  }

  // --- spawn ------------------------------------------------------------------
  const carded = new Set(rects.map((r) => cardMeta(r)!.sessionId));
  const spawned: string[] = [];
  let inbox = result.find(isInbox);
  for (const s of [...sessions.filter((s) => s.live), ...(opts.add ?? [])]) {
    if (carded.has(s.id)) continue;
    if (!inbox) {
      const made = makeInbox(gen, now);
      result.push(...made);
      touched.push(...made.map((e) => e.id));
      inbox = made[0];
    }
    const card = makeCard(byId.get(s.id) ?? s, nextSlot(inbox, result), gen, now, measure);
    result.push(...card);
    touched.push(...card.map((e) => e.id));
    carded.add(s.id);
    spawned.push(s.id);
  }

  const changed = touched.length > 0;
  return {
    elements: changed ? result : (elements as ExcalidrawElement[]),
    changed,
    spawned,
    patched: [...patched],
    touchedIds: touched,
  };
}
