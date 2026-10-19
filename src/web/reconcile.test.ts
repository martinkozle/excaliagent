import { describe, expect, it } from "vitest";
import type { ExcalidrawElement, ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import { reconcile } from "./reconcile.ts";
import { labelText } from "./cards.ts";
import { DAY, NOW, session, testGen } from "./__fixtures__/helpers.ts";
import userDrawingsJson from "./__fixtures__/user-drawings.json" with { type: "json" };
import movedCardJson from "./__fixtures__/moved-card.json" with { type: "json" };

const userDrawings = userDrawingsJson as unknown as ExcalidrawElement[];
const movedCard = movedCardJson as unknown as ExcalidrawElement[];
const clone = <T>(x: T): T => structuredClone(x);

const live = (els: readonly ExcalidrawElement[]) => els.filter((e) => !e.isDeleted);
const cardsOf = (els: readonly ExcalidrawElement[], sessionId?: string) =>
  live(els).filter(
    (e) => e.customData?.excaliagent?.kind === "card" && (!sessionId || e.customData.excaliagent.sessionId === sessionId),
  );
const inboxOf = (els: readonly ExcalidrawElement[]) => live(els).find((e) => e.customData?.excaliagent?.kind === "inbox");
const labelOf = (els: readonly ExcalidrawElement[], rect: ExcalidrawElement) =>
  els.find((e) => e.id === rect.boundElements?.[0]?.id) as ExcalidrawTextElement;

describe("reconcile", () => {
  it("spawns inbox and card into an empty scene", () => {
    const r = reconcile([session()], [], NOW, testGen());
    expect(r.changed).toBe(true);
    expect(r.spawned).toEqual(["s1"]);
    const inbox = inboxOf(r.elements)!;
    const [card] = cardsOf(r.elements, "s1");
    expect(card).toBeDefined();
    expect(card!.x).toBeGreaterThanOrEqual(inbox.x);
    expect(card!.y).toBeGreaterThanOrEqual(inbox.y);
    expect(card!.x + card!.width).toBeLessThanOrEqual(inbox.x + inbox.width);
    expect(labelOf(r.elements, card!).containerId).toBe(card!.id);
    expect(r.touchedIds).toEqual(expect.arrayContaining([card!.id, labelOf(r.elements, card!).id]));
  });

  it("is idempotent: second run is a no-op returning the same array", () => {
    const gen = testGen();
    const first = reconcile([session()], [], NOW, gen);
    const second = reconcile([session()], first.elements, NOW, gen);
    expect(second.changed).toBe(false);
    expect(second.elements).toBe(first.elements);
    expect(second.spawned).toEqual([]);
    expect(second.patched).toEqual([]);
    expect(second.touchedIds).toEqual([]);
  });

  it("dormant session without card spawns nothing", () => {
    const r = reconcile([session({ live: false, status: "dormant" })], [], NOW, testGen());
    expect(r.changed).toBe(false);
    expect(r.elements).toEqual([]);
  });

  it("leaves the user's own drawings untouched", () => {
    const els = clone(userDrawings);
    const r = reconcile([session()], els, NOW, testGen());
    expect(r.elements.slice(0, els.length)).toEqual(userDrawings);
    r.elements.slice(0, els.length).forEach((e, i) => expect(e).toBe(els[i]));
  });

  it("user moved/resized card: only colours and text are patched", () => {
    const els = clone(movedCard);
    const s = session({ status: "needs_user", waitingFor: "permission" });
    const r = reconcile([s], els, NOW, testGen());
    expect(r.changed).toBe(true);
    expect(r.patched).toEqual(["s1"]);
    expect(r.spawned).toEqual([]);
    const card = r.elements.find((e) => e.id === "card-s1")!;
    const before = movedCard[1]!;
    expect(card).toEqual({
      ...before,
      backgroundColor: "#ffc9c9",
      strokeColor: "#e03131",
      strokeStyle: "solid",
      version: before.version + 1,
      versionNonce: card.versionNonce,
      updated: NOW,
    });
    expect(card.versionNonce).not.toBe(before.versionNonce);
    const label = r.elements.find((e) => e.id === "label-s1") as ExcalidrawTextElement;
    const labelBefore = movedCard[2] as ExcalidrawTextElement;
    expect(label.text).toBe(labelText(s, NOW));
    expect(label.originalText).toBe(labelText(s, NOW));
    expect(label.x).toBe(labelBefore.x);
    expect(label.y).toBe(labelBefore.y);
    expect(label.width).toBe(labelBefore.width);
    expect(label.angle).toBe(labelBefore.angle);
    expect(label.version).toBe(labelBefore.version + 1);
    expect(r.elements[0]).toBe(els[0]); // inbox untouched
  });

  it("compares labels by originalText so Excalidraw's wrapping is not a change", () => {
    const s = session();
    const els = clone(movedCard).map((e) =>
      e.id === "label-s1"
        ? { ...e, text: labelText(s, NOW).replace("handoff", "\nhandoff"), originalText: labelText(s, NOW) }
        : e.id === "card-s1"
          ? { ...e, backgroundColor: "#a5d8ff", strokeColor: "#1971c2" }
          : e,
    ) as ExcalidrawElement[];
    const r = reconcile([s], els, NOW, testGen());
    expect(r.changed).toBe(false);
  });

  it("status busy → needs_user patches colours and label", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const b = reconcile([session({ status: "needs_user" })], a.elements, NOW, gen);
    expect(b.patched).toEqual(["s1"]);
    const [card] = cardsOf(b.elements, "s1");
    expect(card!.backgroundColor).toBe("#ffc9c9");
    expect(labelOf(b.elements, card!).text.split("\n")[2]).toBe("needs user · 2m");
  });

  it("deleted card for a live session respawns", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const deleted = a.elements.map((e) => (e.customData?.excaliagent?.kind === "card" || e.type === "text" && e.containerId ? { ...e, isDeleted: true } : e));
    const b = reconcile([session()], deleted, NOW, gen);
    expect(b.spawned).toEqual(["s1"]);
    expect(cardsOf(b.elements, "s1")).toHaveLength(1);
    expect(b.elements.length).toBe(deleted.length + 2);
  });

  it("deleted card for a dormant session stays gone", () => {
    const gen = testGen();
    const a = reconcile([session()], [], NOW, gen);
    const deleted = a.elements.map((e) => (e.customData?.excaliagent?.kind === "card" ? { ...e, isDeleted: true } : e));
    const b = reconcile([session({ live: false, status: "dormant" })], deleted, NOW, gen);
    expect(b.changed).toBe(false);
    expect(b.elements).toBe(deleted);
  });

  it("card whose session vanished is restyled dormant, text left alone", () => {
    const els = clone(movedCard);
    const r = reconcile([], els, NOW, testGen());
    expect(r.patched).toEqual(["s1"]);
    const card = r.elements.find((e) => e.id === "card-s1")!;
    expect(card).toMatchObject({ backgroundColor: "#f8f9fa", strokeColor: "#adb5bd", strokeStyle: "dashed" });
    expect(r.elements.find((e) => e.id === "label-s1")).toBe(els[2]);
    expect(reconcile([], r.elements, NOW, testGen()).changed).toBe(false);
  });

  it("known dormant session is styled dormant and labelled dormant", () => {
    const s = session({ live: false, status: "dormant", lastActivityAt: NOW - 3 * DAY });
    const r = reconcile([s], clone(movedCard), NOW, testGen());
    const card = r.elements.find((e) => e.id === "card-s1")!;
    expect(card.strokeStyle).toBe("dashed");
    expect((r.elements.find((e) => e.id === "label-s1") as ExcalidrawTextElement).text).toContain("dormant · 3d");
  });

  it("picker add spawns a dormant-styled card", () => {
    const s = session({ id: "old", live: false, status: "dormant" });
    const r = reconcile([], [], NOW, testGen(), { add: [s] });
    expect(r.spawned).toEqual(["old"]);
    const [card] = cardsOf(r.elements, "old");
    expect(card).toMatchObject({ backgroundColor: "#f8f9fa", strokeStyle: "dashed" });
  });

  it("picker add does not duplicate an existing card", () => {
    const r = reconcile([], clone(movedCard), NOW, testGen(), { add: [session({ live: false, status: "dormant" })] });
    expect(r.spawned).toEqual([]);
    expect(cardsOf(r.elements, "s1")).toHaveLength(1);
  });

  it("inbox moved by the user: new cards land inside the new bounds", () => {
    const els = clone(movedCard).map((e) => (e.id === "inbox-1" ? { ...e, x: 3000, y: -500, width: 620, height: 300 } : e));
    const r = reconcile([session(), session({ id: "s2" }), session({ id: "s3" })], els, NOW, testGen());
    expect(r.spawned).toEqual(["s2", "s3"]);
    const c2 = cardsOf(r.elements, "s2")[0]!;
    const c3 = cardsOf(r.elements, "s3")[0]!;
    expect([c2.x, c2.y]).toEqual([3020, -480]);
    expect([c3.x, c3.y]).toEqual([3320, -480]);
  });

  it("grid wraps to the next row", () => {
    const sessions = ["a", "b", "c", "d"].map((id) => session({ id }));
    const r = reconcile(sessions, [], NOW, testGen());
    const inbox = inboxOf(r.elements)!;
    const [a, , , d] = sessions.map((s) => cardsOf(r.elements, s.id)[0]!);
    expect(d!.x).toBe(a!.x);
    expect(d!.y).toBeGreaterThan(a!.y + a!.height);
    expect(d!.y + d!.height).toBeLessThanOrEqual(inbox.y + inbox.height);
  });

  it("recreates the inbox if the user deleted it", () => {
    const els = clone(movedCard).map((e) => (e.id === "inbox-1" ? { ...e, isDeleted: true } : e));
    const r = reconcile([session({ id: "s9" })], els, NOW, testGen());
    expect(inboxOf(r.elements)).toBeDefined();
    expect(r.spawned).toEqual(["s9"]);
  });

  it("duplicate cards for one session are both kept and both patched", () => {
    const els = clone(movedCard);
    const dupRect = { ...els[1]!, id: "card-s1-copy", x: 0, boundElements: [{ type: "text", id: "label-s1-copy" }] };
    const dupText = { ...els[2]!, id: "label-s1-copy", containerId: "card-s1-copy" };
    const r = reconcile([session({ status: "needs_user" })], [...els, dupRect, dupText] as ExcalidrawElement[], NOW, testGen());
    expect(r.spawned).toEqual([]);
    expect(r.patched).toEqual(["s1"]);
    expect(cardsOf(r.elements, "s1").map((c) => c.backgroundColor)).toEqual(["#ffc9c9", "#ffc9c9"]);
    expect(r.touchedIds).toHaveLength(4);
  });
});
