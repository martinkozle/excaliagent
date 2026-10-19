import { describe, expect, it } from "vitest";
import type { ExcalidrawElement, ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import { reconcile } from "./reconcile.ts";
import { CARD_H, PAD, TITLE_GAP, TITLE_H, detailsText, titleText, type Measure } from "./cards.ts";
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
const partOf = (els: readonly ExcalidrawElement[], rect: ExcalidrawElement, k: "card-title" | "card-details") => {
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
    expect([title.x, title.y]).toEqual([card.x + PAD, card.y + PAD]);
    expect([details.x, details.y]).toEqual([card.x + PAD, card.y + PAD + 2 * TITLE_H + TITLE_GAP]);
    expect(reconcile([long], b.elements, NOW, gen, { measure: mono }).changed).toBe(false);

    const c = reconcile([session({ title: "short" })], b.elements, NOW, gen, { measure: mono });
    expect(partOf(c.elements, card, "card-details").y).toBe(card.y + PAD + TITLE_H + TITLE_GAP);
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
    expect([title.x, title.y]).toEqual([card.x + PAD, card.y + PAD]);
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
    expect([c2.x, c2.y]).toEqual([3020, -480]);
    expect([c3.x, c3.y]).toEqual([3340, -480]);
    expect(partOf(r.elements, c3, "card-title").x).toBe(3340 + PAD);
  });

  it("grid wraps to the next row inside the default inbox", () => {
    const sessions = ["a", "b", "c", "d"].map((id) => session({ id }));
    const r = reconcile(sessions, [], NOW, testGen());
    const inbox = inboxOf(r.elements)!;
    const [a, , , d] = sessions.map((s) => cardsOf(r.elements, s.id)[0]!);
    expect(d!.x).toBe(a!.x);
    expect(d!.y).toBeGreaterThan(a!.y + a!.height);
    expect(d!.y + d!.height).toBeLessThanOrEqual(inbox.y + inbox.height);
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
    const s = session();

    it("upgrades in place: bound label soft-deleted, title+details at the rect, new group prepended, height grown", () => {
      const els = clone(legacyCard);
      const r = reconcile([s], els, NOW, testGen());
      expect(r.changed).toBe(true);
      expect(r.spawned).toEqual([]);
      expect(r.patched).toEqual(["s1"]);

      const before = legacyCard[1]!;
      const card = r.elements.find((e) => e.id === "card-s1")!;
      expect([card.x, card.y, card.width, card.angle]).toEqual([before.x, before.y, before.width, before.angle]);
      expect(card.height).toBe(CARD_H);
      expect(card.groupIds).toHaveLength(2);
      expect(card.groupIds[1]).toBe("user-grp");
      expect(card.boundElements).toEqual([{ type: "arrow", id: "user-arrow-2" }]);
      expect(card.version).toBe(before.version + 1);

      const oldLabel = r.elements.find((e) => e.id === "label-s1")!;
      expect(oldLabel.isDeleted).toBe(true);
      expect(oldLabel.version).toBe(legacyCard[2]!.version + 1);

      const title = partOf(r.elements, card, "card-title");
      const details = partOf(r.elements, card, "card-details");
      expect([title.x, title.y]).toEqual([before.x + PAD, before.y + PAD]);
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
