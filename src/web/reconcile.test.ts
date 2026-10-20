import { describe, expect, it } from "vitest";
import type { ExcalidrawElement, ExcalidrawImageElement, ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import { reconcile } from "./reconcile.ts";
import { AREA_HEADER, CARD_H, CARD_W, cardHeight, LOGO_SIZE, PAD, TITLE_X, AVATAR_SIZE, TITLE_GAP, TITLE_H, detailsText, titleText, type Measure } from "./cards.ts";
import { LOGOS } from "./logos.ts";
import { DAY, NOW, session, testGen } from "./__fixtures__/helpers.ts";
import userDrawingsJson from "./__fixtures__/user-drawings.json" with { type: "json" };
import legacyCardJson from "./__fixtures__/legacy-card.json" with { type: "json" };

const userDrawings = userDrawingsJson as unknown as ExcalidrawElement[];
const legacyCard = legacyCardJson as unknown as ExcalidrawElement[];
const clone = <T>(x: T): T => structuredClone(x);

const kind = (e: ExcalidrawElement) => e.customData?.excaliagent?.kind as string | undefined;
const live = (els: readonly ExcalidrawElement[]) => els.filter((e) => !e.isDeleted);
const cardsOf = (els: readonly ExcalidrawElement[], sessionId?: string) =>
  live(els).filter((e) => kind(e) === "card" && (!sessionId || e.customData!.excaliagent.sessionId === sessionId));
const inboxOf = (els: readonly ExcalidrawElement[]) => live(els).find((e) => kind(e) === "inbox");
const partOf = (els: readonly ExcalidrawElement[], rect: ExcalidrawElement, k: "card-title" | "card-details" | "card-logo" | "card-character") => {
  const found = live(els).filter((e) => kind(e) === k && e.customData!.excaliagent.cardId === rect.id);
  expect(found).toHaveLength(1);
  return found[0] as ExcalidrawTextElement;
};
/** Simulate the user dragging a whole card group. */
const moveGroup = (els: readonly ExcalidrawElement[], groupId: string, dx: number, dy: number) =>
  els.map((e) => (e.groupIds.includes(groupId) ? { ...e, x: e.x + dx, y: e.y + dy, version: e.version + 1 } : e));

describe("reconcile", () => {
  it("spawns inbox and a three-part grouped card into an empty scene", () => {
    const r = reconcile([session()], [], NOW, testGen());
    expect(r.changed).toBe(true);
    expect(r.spawned).toEqual(["s1"]);
    const inbox = inboxOf(r.elements)!;
    const [card] = cardsOf(r.elements, "s1");
    expect(card!.x + card!.width).toBeLessThanOrEqual(inbox.x + inbox.width);
    expect(card!.y).toBeGreaterThanOrEqual(inbox.y);
    const title = partOf(r.elements, card!, "card-title");
    const details = partOf(r.elements, card!, "card-details");
    expect(title.groupIds[0]).toBe(card!.groupIds[0]);
    expect(details.groupIds[0]).toBe(card!.groupIds[0]);
    expect(r.touchedIds).toEqual(expect.arrayContaining([card!.id, title.id, details.id]));
  });

  it("is idempotent: second run is a no-op returning the same array", () => {
    const gen = testGen();
    const first = reconcile([session()], [], NOW, gen);
    const second = reconcile([session()], first.elements, NOW, gen);
    expect(second.changed).toBe(false);
    expect(second.elements).toBe(first.elements);
    expect(second.touchedIds).toEqual([]);
  });

  it("dormant session without card spawns nothing", () => {
    const r = reconcile([session({ live: false, status: "dormant" })], [], NOW, testGen());
    expect(r.changed).toBe(false);
  });

  it("leaves the user's own drawings untouched", () => {
    const els = clone(userDrawings);
    const r = reconcile([session()], els, NOW, testGen());
    expect(r.elements.slice(0, els.length)).toEqual(userDrawings);
    r.elements.slice(0, els.length).forEach((e, i) => expect(e).toBe(els[i]));
  });

  it("user moved and resized a card: only colours and texts are patched", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const card0 = cardsOf(a.elements, "s1")[0]!;
    const moved = moveGroup(a.elements, card0.groupIds[0]!, 700, 300).map((e) =>
      e.id === card0.id ? { ...e, width: 500, height: 300, groupIds: [...e.groupIds, "user-grp"] } : e,
    );
    const s = session({ status: "needs_user", waitingFor: "permission" });
    const r = reconcile([s], moved, NOW, gen);
    expect(r.patched).toEqual(["s1"]);
    expect(r.spawned).toEqual([]);
    const before = moved.find((e) => e.id === card0.id)!;
    const card = r.elements.find((e) => e.id === card0.id)!;
    expect(card).toEqual({
      ...before,
      backgroundColor: "#ffc9c9",
      strokeColor: "#e03131",
      version: before.version + 1,
      versionNonce: card.versionNonce,
      updated: NOW,
    });
    const details = partOf(r.elements, card, "card-details");
    const detailsBefore = moved.find((e) => e.id === details.id)!;
    expect(details.originalText).toBe(detailsText(s, NOW));
    expect(details.text).toBe(detailsText(s, NOW));
    expect([details.x, details.y, details.groupIds]).toEqual([detailsBefore.x, detailsBefore.y, detailsBefore.groupIds]);
    // Title did not change → same reference.
    const title = partOf(r.elements, card, "card-title");
    expect(title).toBe(moved.find((e) => e.id === title.id));
  });

  it("text box size follows content length", () => {
    const gen = testGen();
    const a = reconcile([session({ title: "x" })], [], NOW, gen);
    const t0 = partOf(a.elements, cardsOf(a.elements)[0]!, "card-title");
    const b = reconcile([session({ title: "a much longer title" })], a.elements, NOW, gen);
    const t1 = partOf(b.elements, cardsOf(b.elements)[0]!, "card-title");
    expect(t1.width).toBeGreaterThan(t0.width);
    expect([t1.x, t1.y]).toEqual([t0.x, t0.y]);
  });

  it("title wrap change moves the details relative to the rect's current position; idempotent", () => {
    const mono: Measure = (t) => t.length * 10;
    const gen = testGen();
    const a = reconcile([session({ title: "short" })], [], NOW, gen, { measure: mono });
    const card0 = cardsOf(a.elements)[0]!;
    const moved = moveGroup(a.elements, card0.groupIds[0]!, 500, 250);
    const card = moved.find((e) => e.id === card0.id)!;
    expect(partOf(moved, card, "card-details").y).toBe(card.y + PAD + TITLE_H + TITLE_GAP);

    const long = session({ title: "Node.js first slices setup on NixOS" });
    const b = reconcile([long], moved, NOW, gen, { measure: mono });
    const title = partOf(b.elements, card, "card-title");
    const details = partOf(b.elements, card, "card-details");
    expect(title.text.split("\n")).toHaveLength(2);
    expect(title.height).toBe(2 * TITLE_H);
    expect([title.x, title.y]).toEqual([card.x + TITLE_X, card.y + PAD]);
    expect([details.x, details.y]).toEqual([card.x + PAD, card.y + PAD + 2 * TITLE_H + TITLE_GAP]);
    expect(reconcile([long], b.elements, NOW, gen, { measure: mono }).changed).toBe(false);

    const c = reconcile([session({ title: "short" })], b.elements, NOW, gen, { measure: mono });
    expect(partOf(c.elements, card, "card-details").y).toBe(card.y + PAD + TITLE_H + TITLE_GAP);
  });

  describe("card height follows the title's line count (issue #8)", () => {
    const mono: Measure = (t) => t.length * 10;
    const LONG = "Node.js first slices setup on NixOS";
    const heightOf = (els: readonly ExcalidrawElement[], id: string) => els.find((e) => e.id === id)!;

    it("grows a card the app sized when the title wraps, shrinks it back; idempotent, position kept", () => {
      const gen = testGen();
      const a = reconcile([session({ title: "short" })], [], NOW, gen, { measure: mono });
      const card0 = cardsOf(a.elements)[0]!;
      expect(card0.height).toBe(cardHeight(1));
      const moved = moveGroup(a.elements, card0.groupIds[0]!, 500, 250);
      const at = heightOf(moved, card0.id);

      const b = reconcile([session({ title: LONG })], moved, NOW, gen, { measure: mono });
      const grown = heightOf(b.elements, card0.id);
      expect(grown).toMatchObject({ x: at.x, y: at.y, width: at.width, height: CARD_H, angle: at.angle, groupIds: at.groupIds });
      expect(grown.customData!.excaliagent.appHeight).toBe(CARD_H);
      expect(b.touchedIds).toContain(card0.id);
      expect(reconcile([session({ title: LONG })], b.elements, NOW, gen, { measure: mono }).changed).toBe(false);

      const c = reconcile([session({ title: "short" })], b.elements, NOW, gen, { measure: mono });
      expect(heightOf(c.elements, card0.id)).toMatchObject({ x: at.x, y: at.y, height: cardHeight(1) });
    });

    it("never resizes a card the user resized (height differs from the app-set one)", () => {
      const gen = testGen();
      const a = reconcile([session({ title: "short" })], [], NOW, gen, { measure: mono });
      const card0 = cardsOf(a.elements)[0]!;
      for (const h of [400, cardHeight(1) - 30]) {
        const resized = a.elements.map((e) => (e.id === card0.id ? { ...e, height: h, version: e.version + 1 } : e));
        const b = reconcile([session({ title: LONG })], resized, NOW, gen, { measure: mono });
        expect(heightOf(b.elements, card0.id).height).toBe(h);
        expect(heightOf(b.elements, card0.id).customData!.excaliagent.appHeight).toBe(cardHeight(1));
      }
    });

    /** The card as boards from before fitting stored it: no appHeight, at `height`. */
    const preFitting = (els: readonly ExcalidrawElement[], id: string, height: number) =>
      els.map((e) => {
        if (e.id !== id) return e;
        const { appHeight: _, ...meta } = e.customData!.excaliagent;
        return { ...e, height, customData: { excaliagent: meta } };
      });

    it("a card from before fitting at the old fixed height (CARD_H) counts as app-sized and gets fitted", () => {
      const gen = testGen();
      const a = reconcile([session({ title: "short" })], [], NOW, gen, { measure: mono });
      const card0 = cardsOf(a.elements)[0]!;
      const old = preFitting(a.elements, card0.id, CARD_H);
      const r = reconcile([session({ title: "short" })], old, NOW, gen, { measure: mono });
      const fitted = heightOf(r.elements, card0.id);
      expect(fitted).toMatchObject({ x: card0.x, y: card0.y, height: cardHeight(1) });
      expect(fitted.customData!.excaliagent.appHeight).toBe(cardHeight(1));
      expect(reconcile([session({ title: "short" })], r.elements, NOW, gen, { measure: mono }).changed).toBe(false);
      // Two-line title at CARD_H: already fits, nothing to patch.
      expect(reconcile([session({ title: LONG })], preFitting(a.elements, card0.id, CARD_H), NOW, gen, { measure: mono }).elements.find((e) => e.id === card0.id)!.height).toBe(CARD_H);
    });

    it("a card from before fitting at any other height was resized by the user: left alone", () => {
      const gen = testGen();
      const a = reconcile([session({ title: "short" })], [], NOW, gen, { measure: mono });
      const card0 = cardsOf(a.elements)[0]!;
      const old = preFitting(a.elements, card0.id, 240);
      expect(reconcile([session({ title: "short" })], old, NOW, gen, { measure: mono }).changed).toBe(false);
      expect(heightOf(reconcile([session({ title: LONG })], old, NOW, gen, { measure: mono }).elements, card0.id).height).toBe(240);
    });

    it("never fits a rotated card (its rotation centre would shift)", () => {
      const gen = testGen();
      const a = reconcile([session({ title: "short" })], [], NOW, gen, { measure: mono });
      const card0 = cardsOf(a.elements)[0]!;
      const rotated = a.elements.map((e) => (e.id === card0.id ? { ...e, angle: 0.3 as ExcalidrawElement["angle"] } : e));
      expect(heightOf(reconcile([session({ title: LONG })], rotated, NOW, gen, { measure: mono }).elements, card0.id).height).toBe(cardHeight(1));
      const old = preFitting(rotated, card0.id, CARD_H);
      expect(heightOf(reconcile([session({ title: "short" })], old, NOW, gen, { measure: mono }).elements, card0.id).height).toBe(CARD_H);
    });

    it("a card whose session vanished keeps fitting its current title", () => {
      const gen = testGen();
      const a = reconcile([session({ title: LONG })], [], NOW, gen, { measure: mono });
      const card0 = cardsOf(a.elements)[0]!;
      expect(card0.height).toBe(CARD_H);
      expect(reconcile([], a.elements, NOW, gen, { measure: mono }).elements.find((e) => e.id === card0.id)!.height).toBe(CARD_H);
    });
  });

  it("uses the injected measurer for wrapping and box widths", () => {
    const calls: number[] = [];
    const m: Measure = (t, f) => (calls.push(f), t.length * 4);
    const r = reconcile([session({ title: "Node.js first slices setup on NixOS" })], [], NOW, testGen(), { measure: m });
    const title = partOf(r.elements, cardsOf(r.elements)[0]!, "card-title");
    expect(title.text).toBe("Node.js first slices setup on NixOS");
    expect(title.width).toBe(35 * 4);
    expect(calls).toContain(5);
    expect(calls).toContain(6);
  });

  it("tolerates sub-pixel re-measuring, but re-fits a box that drifted", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const nudged = a.elements.map((e) => (e.type === "text" ? { ...e, width: e.width + 0.7, height: e.height + 0.5 } : e));
    expect(reconcile([session()], nudged, NOW, gen).changed).toBe(false);
    const drifted = a.elements.map((e) => (e.type === "text" ? { ...e, width: e.width + 3.7 } : e));
    const b = reconcile([session()], drifted, NOW, gen);
    expect(b.changed).toBe(true);
    const cardTextWidths = (els: readonly ExcalidrawElement[]) =>
      els.filter((e) => kind(e) === "card-title" || kind(e) === "card-details").map((e) => e.width);
    expect(cardTextWidths(b.elements)).toEqual(cardTextWidths(a.elements));
  });

  it("status busy → needs_user patches colours and details", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const b = reconcile([session({ status: "needs_user" })], a.elements, NOW, gen);
    expect(b.patched).toEqual(["s1"]);
    const [card] = cardsOf(b.elements, "s1");
    expect(card!.backgroundColor).toBe("#ffc9c9");
    expect(partOf(b.elements, card!, "card-details").text.split("\n")[1]).toBe("needs user · 2m");
  });

  it("deleted card for a live session respawns, and orphan texts are soft-deleted", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const old = cardsOf(a.elements)[0]!;
    const deleted = a.elements.map((e) => (e.id === old.id ? { ...e, isDeleted: true } : e));
    const b = reconcile([session()], deleted, NOW, gen);
    expect(b.spawned).toEqual(["s1"]);
    const cards = cardsOf(b.elements, "s1");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).not.toBe(old.id);
    expect(live(b.elements).filter((e) => kind(e) === "card-title")).toHaveLength(1);
    expect(live(b.elements).filter((e) => kind(e) === "card-details")).toHaveLength(1);
    expect(reconcile([session()], b.elements, NOW, gen).changed).toBe(false);
  });

  it("deleted card for a dormant session stays gone (its texts too)", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const deleted = a.elements.map((e) => (kind(e)?.startsWith("card") ? { ...e, isDeleted: true } : e));
    const b = reconcile([session({ live: false, status: "dormant" })], deleted, NOW, gen);
    expect(b.changed).toBe(false);
    expect(b.elements).toBe(deleted);
  });

  it("user deleted the title: it is recreated at the rect's position in the same group", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const card0 = cardsOf(a.elements)[0]!;
    const moved = moveGroup(a.elements, card0.groupIds[0]!, 100, 50);
    const card = moved.find((e) => e.id === card0.id)!;
    const titleId = partOf(moved, card, "card-title").id;
    const deleted = moved.map((e) => (e.id === titleId ? { ...e, isDeleted: true } : e));
    const r = reconcile([session()], deleted, NOW, gen);
    const title = partOf(r.elements, card, "card-title");
    expect(title.id).not.toBe(titleId);
    expect([title.x, title.y]).toEqual([card.x + TITLE_X, card.y + PAD]);
    expect(title.groupIds).toEqual(card.groupIds);
    expect(title.text).toBe(titleText(session()));
    // inserted right after its rect (z-order above it)
    const ids = r.elements.map((e) => e.id);
    expect(ids.indexOf(title.id)).toBe(ids.indexOf(card.id) + 1);
    expect(reconcile([session()], r.elements, NOW, gen).changed).toBe(false);
  });

  it("card whose session vanished is restyled dormant, texts left alone", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const r = reconcile([], a.elements, NOW, gen);
    expect(r.patched).toEqual(["s1"]);
    const card = cardsOf(r.elements)[0]!;
    expect(card).toMatchObject({ backgroundColor: "#f8f9fa", strokeColor: "#adb5bd", strokeStyle: "dashed" });
    const texts = r.elements.filter((e) => e.type === "text" && kind(e)?.startsWith("card-"));
    texts.forEach((t) => expect(t).toBe(a.elements.find((e) => e.id === t.id)));
    expect(reconcile([], r.elements, NOW, gen).changed).toBe(false);
  });

  it("known dormant session is styled and labelled dormant", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const s = session({ live: false, status: "dormant", lastActivityAt: NOW - 3 * DAY });
    const r = reconcile([s], a.elements, NOW, gen);
    const card = cardsOf(r.elements)[0]!;
    expect(card.strokeStyle).toBe("dashed");
    expect(partOf(r.elements, card, "card-details").text).toContain("dormant · 3d");
  });

  it("picker add spawns a dormant-styled card and does not duplicate", () => {
    const gen = testGen();
    const s = session({ id: "old", live: false, status: "dormant" });
    const r = reconcile([], [], NOW, gen, { add: [s] });
    expect(r.spawned).toEqual(["old"]);
    expect(cardsOf(r.elements, "old")[0]).toMatchObject({ backgroundColor: "#f8f9fa", strokeStyle: "dashed" });
    const again = reconcile([], r.elements, NOW, gen, { add: [s] });
    expect(again.spawned).toEqual([]);
    expect(cardsOf(again.elements, "old")).toHaveLength(1);
  });

  it("inbox moved by the user: new cards land inside the new bounds", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const els = a.elements.map((e) => (kind(e) === "inbox" ? { ...e, x: 3000, y: -500, width: 680, height: 400 } : e));
    const r = reconcile([session(), session({ id: "s2" }), session({ id: "s3" })], els, NOW, gen);
    expect(r.spawned).toEqual(["s2", "s3"]);
    const c2 = cardsOf(r.elements, "s2")[0]!;
    const c3 = cardsOf(r.elements, "s3")[0]!;
    expect([c2.x, c2.y]).toEqual([3020, -500 + AREA_HEADER]);
    expect([c3.x, c3.y]).toEqual([3340, -500 + AREA_HEADER]);
    expect(partOf(r.elements, c3, "card-title").x).toBe(3340 + TITLE_X);
  });

  it("fills the inbox's two columns, each card GAP below the actual bottom of the one above", () => {
    const sessions = ["a", "b", "d"].map((id) => session({ id }));
    const r = reconcile(sessions, [], NOW, testGen());
    const inbox = inboxOf(r.elements)!;
    const [a, b, d] = sessions.map((s) => cardsOf(r.elements, s.id)[0]!);
    expect(b!.y).toBe(a!.y);
    expect(d!.x).toBe(a!.x);
    expect(d!.y).toBe(a!.y + a!.height + 20);
    expect(d!.y + d!.height).toBeLessThanOrEqual(inbox.y + inbox.height);
  });

  it("a new two-line card does not squeeze into a hole only a one-line card fits", () => {
    const long = "A deliberately long session title that wraps onto a second line of the card";
    const gen = testGen();
    const first = reconcile([session({ id: "a", title: "Short" }), session({ id: "b", title: "Short" })], [], NOW, gen);
    // A hole in column 0 exactly as tall as a one-line card plus the gaps.
    const a = cardsOf(first.elements, "a")[0]!;
    const blocker = { ...a, id: "blocker", y: a.y + 2 * a.height + 40, groupIds: [], customData: { excaliagent: { kind: "card", source: "claude", sessionId: "x" } } };
    const tallB = cardsOf(first.elements, "b")[0]!;
    const els = first.elements.map((e) => (e.id === tallB.id ? { ...e, height: 2000 } : e));
    const r = reconcile([session({ id: "c", title: long })], [...els, blocker as typeof a], NOW, gen);
    const c = cardsOf(r.elements, "c")[0]!;
    expect(c.height).toBe(CARD_H);
    expect([c.x, c.y]).toEqual([a.x, blocker.y + blocker.height + 20]);
  });

  it("a fresh board gets the starter lanes with its inbox", () => {
    const r = reconcile([session()], [], NOW, testGen());
    expect(live(r.elements).filter((e) => kind(e) === "lane")).toHaveLength(8);
    expect(live(r.elements).filter((e) => kind(e) === "lane-label")).toHaveLength(6);
    // lanes are never patched
    expect(reconcile([session({ status: "needs_user" })], r.elements, NOW, testGen()).touchedIds.some((id) =>
      r.elements.some((e) => e.id === id && kind(e)?.startsWith("lane")),
    )).toBe(false);
  });

  it("recreating a deleted inbox does not add lanes when the board has some", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const els = a.elements.map((e) => (kind(e) === "inbox" ? { ...e, isDeleted: true } : e));
    const r = reconcile([session(), session({ id: "s9" })], els, NOW, gen);
    expect(live(r.elements).filter((e) => kind(e) === "inbox")).toHaveLength(1);
    expect(live(r.elements).filter((e) => kind(e) === "lane")).toHaveLength(8);
  });

  it("recreates the inbox if the user deleted it", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const els = a.elements.map((e) => (kind(e) === "inbox" ? { ...e, isDeleted: true } : e));
    const r = reconcile([session(), session({ id: "s9" })], els, NOW, gen);
    expect(inboxOf(r.elements)).toBeDefined();
    expect(r.spawned).toEqual(["s9"]);
  });

  it("copy-pasted card (new ids and group, stale cardId) keeps its own texts; both patched", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const parts = a.elements.filter((e) => kind(e)?.startsWith("card"));
    const gid = parts[0]!.groupIds[0]!;
    // Excalidraw paste: fresh ids and group ids, customData copied verbatim.
    const pasted = parts.map((e) => ({ ...e, id: `p-${e.id}`, x: e.x + 1000, groupIds: e.groupIds.map((g) => (g === gid ? "pasted-g" : g)) }));
    const r = reconcile([session({ status: "needs_user" })], [...a.elements, ...pasted], NOW, gen);
    expect(r.spawned).toEqual([]);
    const cards = cardsOf(r.elements, "s1");
    expect(cards.map((c) => c.backgroundColor)).toEqual(["#ffc9c9", "#ffc9c9"]);
    for (const c of cards) {
      const t = partOf(r.elements, c, "card-title");
      const d = partOf(r.elements, c, "card-details");
      expect(t.groupIds[0]).toBe(c.groupIds[0]);
      expect(d.text).toContain("needs user");
    }
    expect(live(r.elements).filter((e) => e.type === "text" && kind(e)?.startsWith("card-"))).toHaveLength(4);
    expect(reconcile([session({ status: "needs_user" })], r.elements, NOW, gen).changed).toBe(false);
  });

  describe("migration of old bound-label cards", () => {
    const s = session({ title: "Handoff" });

    it("upgrades in place: bound label soft-deleted, title+details at the rect, new group prepended, height grown", () => {
      const els = clone(legacyCard);
      const r = reconcile([s], els, NOW, testGen());
      expect(r.changed).toBe(true);
      expect(r.spawned).toEqual([]);
      expect(r.patched).toEqual(["s1"]);

      const before = legacyCard[1]!;
      const card = r.elements.find((e) => e.id === "card-s1")!;
      expect([card.x, card.y, card.width, card.angle]).toEqual([before.x, before.y, before.width, before.angle]);
      // Grown to the old fixed height, which counts as app-sized: fitted to its one-line title at once.
      expect(card.height).toBe(cardHeight(1));
      expect(card.customData!.excaliagent.appHeight).toBe(cardHeight(1));
      expect(card.groupIds).toHaveLength(2);
      expect(card.groupIds[1]).toBe("user-grp");
      expect(card.boundElements).toEqual([{ type: "arrow", id: "user-arrow-2" }]);
      expect(card.version).toBe(before.version + 1);

      const oldLabel = r.elements.find((e) => e.id === "label-s1")!;
      expect(oldLabel.isDeleted).toBe(true);
      expect(oldLabel.version).toBe(legacyCard[2]!.version + 1);

      const title = partOf(r.elements, card, "card-title");
      const details = partOf(r.elements, card, "card-details");
      expect([title.x, title.y]).toEqual([before.x + TITLE_X, before.y + PAD]);
      expect(details.x).toBe(before.x + PAD);
      expect(title.groupIds).toEqual(card.groupIds);
      expect(details.groupIds).toEqual(card.groupIds);
      expect(title.text).toBe(titleText(s));
      expect(details.text).toBe(detailsText(s, NOW));

      // the user's other group member and the inbox are untouched
      expect(r.elements.find((e) => e.id === "user-note")).toBe(els[3]);
      expect(r.elements.find((e) => e.id === "inbox-1")).toBe(els[0]);
      expect(reconcile([s], r.elements, NOW, testGen()).changed).toBe(false);
    });

    it("does not shrink a rect that is already tall enough", () => {
      const els = clone(legacyCard).map((e) => (e.id === "card-s1" ? { ...e, height: 400 } : e));
      const r = reconcile([s], els, NOW, testGen());
      expect(r.elements.find((e) => e.id === "card-s1")!.height).toBe(400);
    });

    it("vanished session: texts are split from the old label", () => {
      const r = reconcile([], clone(legacyCard), NOW, testGen());
      const card = r.elements.find((e) => e.id === "card-s1")!;
      expect(card.strokeStyle).toBe("dashed");
      expect(partOf(r.elements, card, "card-title").text).toBe("Old title");
      expect(partOf(r.elements, card, "card-details").text).toBe("excaliagent · main\nbusy · 2m\ncache warm 41m · herdr w7:p1");
      expect(reconcile([], r.elements, NOW, testGen()).changed).toBe(false);
    });
  });
});

describe("late font loads", () => {
  // First measured with a fallback font (narrow), then the real font arrives (wider).
  const narrow: Measure = (t, _f, size) => t.length * size * 0.4;
  const wide: Measure = (t, _f, size) => t.length * size * 0.5;

  it("re-fits a card text box when the measured size drifts, without touching its text or position", () => {
    const s = session({ title: "Add OAuth login" });
    const first = reconcile([s], [], NOW, testGen(), { measure: narrow }).elements;
    const before = partOf(first, cardsOf(first)[0]!, "card-title") as ExcalidrawTextElement;

    const r = reconcile([s], first, NOW, testGen(), { measure: wide });
    expect(r.changed).toBe(true);
    const after = partOf(r.elements, cardsOf(r.elements)[0]!, "card-title") as ExcalidrawTextElement;
    expect(after.width).toBe(Math.ceil("Add OAuth login".length * 20 * 0.5));
    expect(after.originalText).toBe(before.originalText);
    expect([after.x, after.y]).toEqual([before.x, before.y]);

    expect(reconcile([s], r.elements, NOW, testGen(), { measure: wide }).changed).toBe(false);
  });

  it("ignores sub-pixel differences", () => {
    const s = session({ title: "Add OAuth login" });
    const first = reconcile([s], [], NOW, testGen(), { measure: narrow }).elements;
    const nudged: Measure = (t, f, size) => narrow(t, f, size) + 0.4;
    expect(reconcile([s], first, NOW, testGen(), { measure: nudged }).changed).toBe(false);
  });

  it("leaves texts the user scaled (font size changed) alone", () => {
    const s = session({ title: "Add OAuth login" });
    const first = reconcile([s], [], NOW, testGen(), { measure: narrow }).elements;
    const scaled = first.map((e) =>
      e.type === "text" ? ({ ...e, fontSize: (e as ExcalidrawTextElement).fontSize * 2, width: 999 } as ExcalidrawElement) : e,
    );
    expect(reconcile([s], scaled, NOW, testGen(), { measure: wide }).changed).toBe(false);
  });
});

describe("reconcile: PR link", () => {
  it("patches the rect link when a PR appears, keeps it when the session vanishes", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    expect(cardsOf(a.elements)[0]!.link).toBeNull();
    const withPr = session({ prLinks: ["https://github.com/me/x/pull/9"] });
    const b = reconcile([withPr], a.elements, NOW, gen);
    expect(b.patched).toEqual(["s1"]);
    expect(cardsOf(b.elements)[0]!.link).toBe("https://github.com/me/x/pull/9");
    expect(reconcile([withPr], b.elements, NOW, gen).changed).toBe(false);
    const c = reconcile([], b.elements, NOW, gen);
    expect(cardsOf(c.elements)[0]!.link).toBe("https://github.com/me/x/pull/9");
  });
});

describe("reconcile: continued-in", () => {
  const sessionIdsOf = (els: readonly ExcalidrawElement[], rectId: string) =>
    live(els)
      .filter((e) => e.id === rectId || e.customData?.excaliagent?.cardId === rectId)
      .map((e) => e.customData!.excaliagent.sessionId);

  it("retargets the card (rect and texts) to the continuation, and does not spawn it again", () => {
    const gen = testGen();
    const a = reconcile([session({ id: "A" })], [], NOW, gen);
    const rect = cardsOf(a.elements, "A")[0]!;
    const sessions = [session({ id: "A", live: false, status: "dormant", continuedIn: "B" }), session({ id: "B", title: "Next" })];
    const r = reconcile(sessions, a.elements, NOW, gen);
    expect(r.spawned).toEqual([]);
    expect(r.retargeted).toEqual([{ from: "A", to: "B" }]);
    expect(sessionIdsOf(r.elements, rect.id)).toEqual(["B", "B", "B", "B"]); // rect, title, details, logo
    expect(cardsOf(r.elements)).toHaveLength(1);
    const card = cardsOf(r.elements, "B")[0]!;
    expect([card.x, card.y]).toEqual([rect.x, rect.y]);
    expect(partOf(r.elements, card, "card-title").text).toBe("Next");
    expect(card.backgroundColor).toBe("#ffec99");
    expect(reconcile(sessions, r.elements, NOW, gen).changed).toBe(false);
  });

  it("retargets even when the continuation is unknown yet (styled dormant until looked up)", () => {
    const gen = testGen();
    const a = reconcile([session({ id: "A" })], [], NOW, gen);
    const r = reconcile([session({ id: "A", live: false, status: "dormant", continuedIn: "B" })], a.elements, NOW, gen);
    expect(cardsOf(r.elements, "B")).toHaveLength(1);
    expect(cardsOf(r.elements, "B")[0]!.strokeStyle).toBe("dashed");
  });

  it("leaves the old card alone when the continuation already has a card", () => {
    const gen = testGen();
    const a = reconcile([session({ id: "A" }), session({ id: "B" })], [], NOW, gen);
    const sessions = [session({ id: "A", live: false, status: "dormant", continuedIn: "B" }), session({ id: "B" })];
    const r = reconcile(sessions, a.elements, NOW, gen);
    expect(r.retargeted).toEqual([]);
    expect(cardsOf(r.elements, "A")).toHaveLength(1);
    expect(cardsOf(r.elements, "B")).toHaveLength(1);
  });

  it("chains resolve to the last continuation in one pass", () => {
    const gen = testGen();
    const a = reconcile([session({ id: "A" })], [], NOW, gen);
    const sessions = [
      session({ id: "A", live: false, status: "dormant", continuedIn: "B" }),
      session({ id: "B", live: false, status: "dormant", continuedIn: "C" }),
      session({ id: "C" }),
    ];
    const b = reconcile(sessions, a.elements, NOW, gen);
    expect(b.spawned).toEqual([]);
    expect(b.retargeted).toEqual([{ from: "A", to: "C" }]);
    expect(cardsOf(b.elements).map((e) => e.customData!.excaliagent.sessionId)).toEqual(["C"]);
    expect(reconcile(sessions, b.elements, NOW, gen).changed).toBe(false);
  });
});

describe("reconcile: continued-in chain with a carded hop", () => {
  it("stops at a hop that already has a card", () => {
    const gen = testGen();
    const a = reconcile([session({ id: "A" }), session({ id: "B" })], [], NOW, gen);
    const sessions = [
      session({ id: "A", live: false, status: "dormant", continuedIn: "B" }),
      session({ id: "B", live: false, status: "dormant", continuedIn: "C" }),
    ];
    const r = reconcile(sessions, a.elements, NOW, gen);
    expect(r.retargeted).toEqual([{ from: "B", to: "C" }]);
    const ids = r.elements.filter((e) => !e.isDeleted && e.customData?.excaliagent?.kind === "card").map((e) => e.customData!.excaliagent.sessionId);
    expect(ids.sort()).toEqual(["A", "C"]);
  });
});

describe("reconcile: harness logo", () => {
  const logoOf = (els: readonly ExcalidrawElement[], rect: ExcalidrawElement) =>
    partOf(els, rect, "card-logo") as unknown as ExcalidrawImageElement;

  it("a new card carries its logo; a card from before logos gets one at its rect's current corner", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const card0 = cardsOf(a.elements)[0]!;
    expect(logoOf(a.elements, card0).fileId).toBe(LOGOS.claude.fileId);

    // A 0.2.0 card: no logo, moved and widened by the user.
    const noLogo = a.elements.filter((e) => kind(e) !== "card-logo");
    const moved = moveGroup(noLogo, card0.groupIds[0]!, 100, 50).map((e) =>
      e.id === card0.id ? { ...e, width: CARD_W + 60 } : e,
    );
    const card = moved.find((e) => e.id === card0.id)!;
    const r = reconcile([session()], moved, NOW, gen);
    expect(r.patched).toEqual(["s1"]);
    const logo = logoOf(r.elements, card);
    expect([logo.x, logo.y]).toEqual([card.x + card.width - PAD - LOGO_SIZE, card.y + PAD + (TITLE_H - LOGO_SIZE) / 2]);
    expect(logo.groupIds).toEqual(card.groupIds);
    // Never resized or moved the user's rect.
    expect(r.elements.find((e) => e.id === card.id)).toMatchObject({ x: card.x, y: card.y, width: card.width });
    expect(reconcile([session()], r.elements, NOW, gen).changed).toBe(false);
  });

  it("a moved logo stays where the user put it; a deleted one is recreated", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const card = cardsOf(a.elements)[0]!;
    const logo0 = logoOf(a.elements, card);
    const nudged = a.elements.map((e) => (e.id === logo0.id ? { ...e, x: e.x - 30, version: e.version + 1 } : e));
    expect(reconcile([session()], nudged, NOW, gen).changed).toBe(false);
    const deleted = a.elements.map((e) => (e.id === logo0.id ? { ...e, isDeleted: true } : e));
    const r = reconcile([session()], deleted, NOW, gen);
    expect(logoOf(r.elements, card).id).not.toBe(logo0.id);
  });

  it("follows the card when it is retargeted to a continuation", () => {
    const gen = testGen();
    const a = reconcile([session({ id: "A" })], [], NOW, gen);
    const r = reconcile([session({ id: "A", live: false, status: "dormant", continuedIn: "B" }), session({ id: "B" })], a.elements, NOW, gen);
    const [card] = cardsOf(r.elements, "B");
    expect(logoOf(r.elements, card!).customData!.excaliagent.sessionId).toBe("B");
    expect(live(r.elements).filter((e) => kind(e) === "card-logo")).toHaveLength(1);
  });
});

describe("reconcile: character", () => {
  const CAT = "excaliagent-emoji-1f431";
  const DOG = "excaliagent-emoji-1f436";
  const chars = (m: Record<string, string>) => ({ characters: new Map(Object.entries(m)) });
  const charOf = (els: readonly ExcalidrawElement[], rect: ExcalidrawElement) =>
    partOf(els, rect, "card-character") as unknown as ExcalidrawImageElement;
  const charsOf = (els: readonly ExcalidrawElement[]) => live(els).filter((e) => kind(e) === "card-character");
  const rectOf = (els: readonly ExcalidrawElement[], id: string) => els.find((e) => e.id === id)!;
  const SHORT = session({ title: "Short" });

  /** A ≤ 0.3 card: no character, title at the old left offset, moved by the user to (dx, dy). */
  function oldCard(gen: ReturnType<typeof testGen>, dx = 100, dy = 50) {
    const a = reconcile([SHORT], [], NOW, gen);
    const card0 = cardsOf(a.elements)[0]!;
    const old = a.elements.map((e) => (kind(e) === "card-title" ? { ...e, x: card0.x + PAD } : e));
    const els = moveGroup(old, card0.groupIds[0]!, dx, dy);
    return { els, card: els.find((e) => e.id === card0.id)! };
  }

  it("a spawned card carries its session's character top-left in its group, marked as laid out", () => {
    const r = reconcile([session()], [], NOW, testGen(), chars({ s1: CAT }));
    const card = cardsOf(r.elements)[0]!;
    const c = charOf(r.elements, card);
    expect(c).toMatchObject({ fileId: CAT, x: card.x + PAD, y: card.y + PAD, width: AVATAR_SIZE, groupIds: card.groupIds });
    expect(card.customData!.excaliagent.charLayout).toBe(1);
    expect(r.touchedIds).toContain(c.id);
  });

  it("without character data, characters are neither created nor removed", () => {
    const gen = testGen();
    const plain = reconcile([session()], [], NOW, gen);
    expect(charsOf(plain.elements)).toHaveLength(0);
    const withChar = reconcile([session()], [], NOW, testGen(), chars({ s1: CAT }));
    expect(reconcile([session()], withChar.elements, NOW, gen).changed).toBe(false);
  });

  it("a card from before characters gets one at its rect's current corner; only a title still at the old spot moves", () => {
    const gen = testGen();
    const { els, card } = oldCard(gen);
    const details0 = partOf(els, card, "card-details");
    const r = reconcile([SHORT], els, NOW, gen, chars({ s1: CAT }));
    expect(r.patched).toEqual(["s1"]);
    const c = charOf(r.elements, card);
    expect([c.x, c.y]).toEqual([card.x + PAD, card.y + PAD]);
    expect([partOf(r.elements, card, "card-title").x, partOf(r.elements, card, "card-title").y]).toEqual([card.x + TITLE_X, card.y + PAD]);
    expect(partOf(r.elements, card, "card-details")).toMatchObject({ x: details0.x, y: details0.y });
    expect(rectOf(r.elements, card.id)).toMatchObject({ x: card.x, y: card.y, width: card.width, height: card.height });
    expect(rectOf(r.elements, card.id).customData!.excaliagent.charLayout).toBe(1);
    expect(reconcile([SHORT], r.elements, NOW, gen, chars({ s1: CAT })).changed).toBe(false);
  });

  it("a title the user moved is left where it is", () => {
    const gen = testGen();
    const { els, card } = oldCard(gen);
    const title0 = partOf(els, card, "card-title");
    const nudged = els.map((e) => (e.id === title0.id ? { ...e, x: e.x + 3, y: e.y + 7 } : e));
    const r = reconcile([SHORT], nudged, NOW, gen, chars({ s1: CAT }));
    expect(charsOf(r.elements)).toHaveLength(1);
    expect(partOf(r.elements, card, "card-title")).toMatchObject({ x: title0.x + 3, y: title0.y + 7 });
  });

  it("a card whose session is unknown: texts untouched, no character while it would cover the old title", () => {
    const gen = testGen();
    const { els, card } = oldCard(gen);
    const r = reconcile([], els, NOW, gen, chars({ s1: CAT }));
    expect(charsOf(r.elements)).toHaveLength(0);
    for (const k of ["card-title", "card-details"] as const)
      expect(partOf(r.elements, card, k)).toMatchObject({ x: partOf(els, card, k).x, y: partOf(els, card, k).y, text: partOf(els, card, k).text });
    expect(rectOf(r.elements, card.id).customData!.excaliagent.charLayout).toBeUndefined();
    // Known later: migrated then.
    const later = reconcile([SHORT], r.elements, NOW, gen, chars({ s1: CAT }));
    expect(partOf(later.elements, card, "card-title").x).toBe(card.x + TITLE_X);
    expect(charsOf(later.elements)).toHaveLength(1);
  });

  it("a card whose session is unknown gets its character when nothing has to move", () => {
    const gen = testGen();
    const a = reconcile([SHORT], [], NOW, gen); // new layout, made before characters loaded
    const card = cardsOf(a.elements)[0]!;
    const r = reconcile([], a.elements, NOW, gen, chars({ s1: CAT }));
    expect(charOf(r.elements, card).fileId).toBe(CAT);
    expect(partOf(r.elements, card, "card-title").x).toBe(partOf(a.elements, card, "card-title").x);
  });

  it("a character the user deleted stays deleted, and the title does not snap back", () => {
    const gen = testGen();
    const { els, card } = oldCard(gen);
    const migrated = reconcile([SHORT], els, NOW, gen, chars({ s1: CAT })).elements;
    const c0 = charOf(migrated, card);
    const deleted = migrated.map((e) => (e.id === c0.id ? { ...e, isDeleted: true, version: e.version + 1 } : e));
    const r = reconcile([SHORT], deleted, NOW, gen, chars({ s1: DOG }));
    expect(r.changed).toBe(false);
    expect(charsOf(r.elements)).toHaveLength(0);
    expect(partOf(r.elements, card, "card-title").x).toBe(card.x + TITLE_X);
  });

  it("a new assignment changes only the image's file, where the user left it", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen, chars({ s1: CAT }));
    const card = cardsOf(a.elements)[0]!;
    const c0 = charOf(a.elements, card);
    const nudged = a.elements.map((e) => (e.id === c0.id ? { ...e, x: e.x + 5, width: 60, height: 60, version: e.version + 1 } : e));
    expect(reconcile([session()], nudged, NOW, gen, chars({ s1: CAT })).changed).toBe(false);
    const r = reconcile([session()], nudged, NOW, gen, chars({ s1: DOG }));
    const c = charOf(r.elements, card);
    expect(c).toMatchObject({ id: c0.id, fileId: DOG, x: c0.x + 5, width: 60, height: 60 });
    expect(r.touchedIds).toEqual([c0.id]);
  });

  it("no character for the session (empty pack): removed, and back once there is one", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen, chars({ s1: CAT }));
    const card = cardsOf(a.elements)[0]!;
    const r = reconcile([session()], a.elements, NOW, gen, chars({}));
    expect(charsOf(r.elements)).toHaveLength(0);
    expect(rectOf(r.elements, card.id).customData!.excaliagent.charLayout).toBeUndefined();
    expect(reconcile([session()], r.elements, NOW, gen, chars({})).changed).toBe(false);
    const back = reconcile([session()], r.elements, NOW, gen, chars({ s1: DOG }));
    expect(charOf(back.elements, card).fileId).toBe(DOG);
    expect(partOf(back.elements, card, "card-title").x).toBe(card.x + TITLE_X);
  });

  it("a lone copy of a character, or one whose card is gone, is soft-deleted", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen, chars({ s1: CAT }));
    const card = cardsOf(a.elements)[0]!;
    const c0 = charOf(a.elements, card);
    const copy = { ...c0, id: "pasted-char", x: c0.x + 500, groupIds: ["other-g"] };
    const r = reconcile([session()], [...a.elements, copy], NOW, gen, chars({ s1: CAT }));
    expect(r.elements.find((e) => e.id === "pasted-char")!.isDeleted).toBe(true);
    expect(charOf(r.elements, card).id).toBe(c0.id);

    const noRect = a.elements.map((e) => (e.id === card.id ? { ...e, isDeleted: true } : e));
    const gone = reconcile([session({ live: false, status: "dormant" })], noRect, NOW, gen, chars({ s1: CAT }));
    expect(charsOf(gone.elements)).toHaveLength(0);
  });

  it("a pasted copy of a card keeps its own character, re-derived from its session", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen, chars({ s1: CAT }));
    const parts = a.elements.filter((e) => kind(e)?.startsWith("card"));
    const gid = parts[0]!.groupIds[0]!;
    const pasted = parts.map((e) => ({ ...e, id: `p-${e.id}`, x: e.x + 1000, groupIds: e.groupIds.map((g) => (g === gid ? "pasted-g" : g)) }));
    const r = reconcile([session()], [...a.elements, ...pasted], NOW, gen, chars({ s1: DOG }));
    const cards = cardsOf(r.elements, "s1");
    expect(cards).toHaveLength(2);
    for (const c of cards) expect(charOf(r.elements, c).fileId).toBe(DOG);
  });

  it("a character from before the layout flag just gets the flag", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen, chars({ s1: CAT }));
    const card = cardsOf(a.elements)[0]!;
    const unflagged = a.elements.map((e) =>
      e.id === card.id ? { ...e, customData: { excaliagent: { ...e.customData!.excaliagent, charLayout: undefined } } } : e,
    );
    const r = reconcile([session()], unflagged, NOW, gen, chars({ s1: CAT }));
    expect(r.touchedIds).toEqual([card.id]);
    expect(rectOf(r.elements, card.id).customData!.excaliagent.charLayout).toBe(1);
  });

  it("follows the card when it is retargeted to a continuation", () => {
    const gen = testGen();
    const a = reconcile([session({ id: "A" })], [], NOW, gen, chars({ A: CAT }));
    const r = reconcile(
      [session({ id: "A", live: false, status: "dormant", continuedIn: "B" }), session({ id: "B" })],
      a.elements,
      NOW,
      gen,
      chars({ A: CAT, B: CAT }),
    );
    const [card] = cardsOf(r.elements, "B");
    expect(charOf(r.elements, card!)).toMatchObject({ fileId: CAT, customData: { excaliagent: { sessionId: "B" } } });
    expect(charsOf(r.elements)).toHaveLength(1);
  });
});
