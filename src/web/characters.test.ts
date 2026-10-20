import { describe, expect, it } from "vitest";
import { emojiFileId, type CharactersData, type Pack } from "../shared/packs.ts";
import {
  allowCharacter,
  assignCharacters,
  boardSessionIds,
  CharacterSync,
  characterHash,
  emojiFile,
  inheritMap,
  removeCharacter,
  shuffleCharacter,
  type AssignInput,
} from "./characters.ts";
import { makeCard } from "./cards.ts";
import { session, testGen } from "./__fixtures__/helpers.ts";

const pack = (id: string, ids: string[]): Pack => ({
  id,
  name: id,
  builtIn: false,
  characters: ids.map((c) => ({ id: c, kind: "emoji", fileId: emojiFileId(c) })),
});
const ABCD = pack("p", ["🐶", "🐱", "🐭", "🐹"]);
const OTHER = pack("q", ["🐙", "🦑"]);

/** Session ids whose hash lands on index `i` of a pack of size `n`. */
function idsAt(i: number, n: number, count: number): string[] {
  const out: string[] = [];
  for (let k = 0; out.length < count; k++) {
    const id = `00000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
    if (characterHash(id) % n === i) out.push(id);
  }
  return out;
}

function run(over: Partial<AssignInput>) {
  return assignCharacters({
    pack: ABCD,
    packs: new Map([ABCD, OTHER].map((p) => [p.id, p])),
    sessionIds: [],
    remembered: {},
    overrides: {},
    ...over,
  });
}
const ids = (r: ReturnType<typeof run>, sids: string[]) => sids.map((s) => r.chars.get(s)?.id);

describe("characterHash", () => {
  it("is a stable unsigned 32-bit FNV-1a", () => {
    expect(characterHash("")).toBe(0x811c9dc5);
    expect(characterHash("a")).toBe(0xe40c292c);
    expect(characterHash("s1")).toBe(characterHash("s1"));
  });
});

describe("assignCharacters", () => {
  it("gives every harness's sessions a character through the same hash and probe (Claude, Codex, OpenCode)", () => {
    const claude = "0a1b2c3d-0000-4000-8000-000000000001";
    const codex = "01a15935-e3d1-71c2-9d74-39d8c583eef0";
    const opencode = "ses_ea6c805c8ffeyswcuMvpFmOFAL";
    const r = run({ sessionIds: [claude, codex, opencode] });
    expect(new Set([claude, codex, opencode].map((s) => r.chars.get(s)?.id)).size).toBe(3);
    expect(r.chars.get(claude)?.id).toBe(ABCD.characters[characterHash(claude) % 4]!.id);
    const codexStart = characterHash(codex) % 4;
    const expected = [0, 1, 2, 3].map((k) => ABCD.characters[(codexStart + k) % 4]!.id).find((c) => c !== r.chars.get(claude)?.id);
    expect(r.chars.get(codex)?.id).toBe(expected);
    expect(Object.keys(r.remember).sort()).toEqual([claude, codex, opencode].sort());
  });

  it("starts at hash(session id) in the active pack and remembers the pick", () => {
    const [a] = idsAt(2, 4, 1);
    const r = run({ sessionIds: [a!] });
    expect(r.chars.get(a!)?.id).toBe("🐭");
    expect(r.remember).toEqual({ [a!]: "🐭" });
    expect(r.overrides).toEqual({});
  });

  it("probes linearly past characters used by other cards on the board", () => {
    const [a, b, c] = idsAt(1, 4, 3);
    const r = run({ sessionIds: [a!, b!, c!] });
    expect(ids(r, [a!, b!, c!])).toEqual(["🐱", "🐭", "🐹"]);
  });

  it("wraps around the end of the pack", () => {
    const [a, b, c] = idsAt(3, 4, 3);
    const r = run({ sessionIds: [a!, b!, c!] });
    expect(ids(r, [a!, b!, c!])).toEqual(["🐹", "🐶", "🐱"]);
  });

  it("allows duplicates once the pack is exhausted, at the hash slot", () => {
    const sids = [...idsAt(0, 4, 4), ...idsAt(2, 4, 1)];
    const r = run({ sessionIds: sids });
    expect(new Set(ids(r, sids.slice(0, 4)))).toEqual(new Set(["🐶", "🐱", "🐭", "🐹"]));
    expect(r.chars.get(sids[4]!)?.id).toBe("🐭");
    expect(r.remember[sids[4]!]).toBe("🐭");
  });

  it("remembered characters win, and count as used before anyone probes", () => {
    const [a] = idsAt(0, 4, 1);
    const [b] = idsAt(0, 4, 2).slice(1);
    // b is earlier on the board but a remembers 🐶; b must not take it.
    const r = run({ sessionIds: [b!, a!], remembered: { [a!]: "🐶" } });
    expect(ids(r, [b!, a!])).toEqual(["🐱", "🐶"]);
    expect(r.remember).toEqual({ [b!]: "🐱" });
  });

  it("does not shift when a collider leaves the board", () => {
    const [a, b] = idsAt(0, 4, 2);
    const first = run({ sessionIds: [a!, b!] });
    expect(ids(first, [a!, b!])).toEqual(["🐶", "🐱"]);
    const later = run({ sessionIds: [b!], remembered: first.remember });
    expect(later.chars.get(b!)?.id).toBe("🐱");
    expect(later.remember).toEqual({});
  });

  it("re-assigns when the remembered character left the pack", () => {
    const [a] = idsAt(1, 4, 1);
    const r = run({ sessionIds: [a!], remembered: { [a!]: "🦄" } });
    expect(r.chars.get(a!)?.id).toBe("🐱");
    expect(r.remember).toEqual({ [a!]: "🐱" });
  });

  it("an override wins over the remembered character, from any pack", () => {
    const [a] = idsAt(0, 4, 1);
    const r = run({ sessionIds: [a!], remembered: { [a!]: "🐶" }, overrides: { [a!]: { pack: "q", id: "🦑" } } });
    expect(r.chars.get(a!)).toMatchObject({ id: "🦑", fileId: emojiFileId("🦑") });
    expect(r.remember).toEqual({});
  });

  it("an override into the active pack blocks that character for automatic picks", () => {
    const [a, b] = idsAt(0, 4, 2);
    const r = run({ sessionIds: [b!, a!], overrides: { [a!]: { pack: "p", id: "🐶" } } });
    expect(ids(r, [b!, a!])).toEqual(["🐱", "🐶"]);
  });

  it("ignores an override whose pack or character is gone", () => {
    const [a] = idsAt(0, 4, 1);
    for (const ref of [{ pack: "gone", id: "🐶" }, { pack: "q", id: "🐶" }]) {
      const r = run({ sessionIds: [a!], overrides: { [a!]: ref } });
      expect(r.chars.get(a!)?.id).toBe("🐶");
    }
  });

  it("gives nothing from an empty or missing pack, but still honours overrides", () => {
    const [a, b] = idsAt(0, 4, 2);
    for (const p of [pack("e", []), undefined]) {
      const r = run({ pack: p, sessionIds: [a!, b!], overrides: { [b!]: { pack: "q", id: "🐙" } } });
      expect(r.chars.has(a!)).toBe(false);
      expect(r.chars.get(b!)?.id).toBe("🐙");
      expect(r.remember).toEqual({});
    }
  });

  it("each pack remembers its own pick; switching back restores it", () => {
    const [a] = idsAt(1, 4, 1);
    const inP = run({ sessionIds: [a!] });
    const inQ = run({ pack: OTHER, sessionIds: [a!] });
    expect(inQ.chars.get(a!)?.id).toBe(OTHER.characters[characterHash(a!) % 2]!.id);
    const back = run({ sessionIds: [a!], remembered: inP.remember });
    expect(back.chars.get(a!)?.id).toBe(inP.chars.get(a!)?.id);
  });

  it("a continuation inherits the remembered character and override of the session it continues", () => {
    const [a] = idsAt(0, 4, 1);
    const [b, c] = idsAt(3, 4, 2);
    // c continues b continues a; only a has history.
    const inherit = new Map([
      [b!, a!],
      [c!, b!],
    ]);
    const r = run({ sessionIds: [c!], remembered: { [a!]: "🐶" }, inherit });
    expect(r.chars.get(c!)?.id).toBe("🐶");
    expect(r.remember).toEqual({ [c!]: "🐶" });
    const o = run({ sessionIds: [c!], overrides: { [a!]: { pack: "q", id: "🐙" } }, inherit });
    expect(o.chars.get(c!)?.id).toBe("🐙");
    expect(o.overrides).toEqual({ [c!]: { pack: "q", id: "🐙" } });
  });

  it("survives an inheritance cycle", () => {
    const [a, b] = idsAt(0, 4, 2);
    const r = run({ sessionIds: [a!], inherit: new Map([[a!, b!], [b!, a!]]) });
    expect(r.chars.get(a!)?.id).toBe("🐶");
  });

  it("lists each session once even if given twice", () => {
    const [a] = idsAt(0, 4, 1);
    const r = run({ sessionIds: [a!, a!] });
    expect(r.chars.get(a!)?.id).toBe("🐶");
  });
});

describe("boardSessionIds", () => {
  it("lists carded sessions in element order, then live ones without a card, then picker adds; once each", () => {
    const gen = testGen();
    const els = [
      ...makeCard(session({ id: "b" }), { x: 0, y: 0 }, gen, 0),
      ...makeCard(session({ id: "a" }), { x: 0, y: 0 }, gen, 0),
      { ...makeCard(session({ id: "gone" }), { x: 0, y: 0 }, gen, 0)[0], isDeleted: true },
    ];
    const sessions = [session({ id: "a" }), session({ id: "c" }), session({ id: "d", live: false, status: "dormant" })];
    expect(boardSessionIds(els, sessions, [session({ id: "e", live: false })])).toEqual(["b", "a", "c", "e"]);
  });
});

describe("inheritMap", () => {
  it("maps each continuation to the session it continues", () => {
    const m = inheritMap([session({ id: "a", continuedIn: "b" }), session({ id: "b" }), session({ id: "c" })]);
    expect([...m]).toEqual([["b", "a"]]);
  });
});

describe("shuffleCharacter", () => {
  it("picks an unused character of the active pack, never the current one", () => {
    for (let i = 0; i < 20; i++) {
      const pick = shuffleCharacter(ABCD, new Set(["🐶", "🐱"]), { pack: "p", id: "🐭" }, Math.random);
      expect(pick).toEqual({ pack: "p", id: "🐹" });
    }
  });
  it("falls back to any other character when all are used", () => {
    const pick = shuffleCharacter(ABCD, new Set(["🐶", "🐱", "🐭", "🐹"]), { pack: "p", id: "🐶" }, () => 0);
    expect(pick).toEqual({ pack: "p", id: "🐱" });
  });
  it("is undefined for an empty pack", () => {
    expect(shuffleCharacter(pack("e", []), new Set(), undefined, Math.random)).toBeUndefined();
  });
});

describe("emojiFile", () => {
  it("is an SVG data URL with the emoji, under its emoji file id", () => {
    const f = emojiFile("🐱", 5);
    expect(f.id).toBe("excaliagent-emoji-1f431");
    expect(f.mimeType).toBe("image/svg+xml");
    const svg = new TextDecoder().decode(Uint8Array.from(atob(f.dataURL.split(",")[1]!), (c) => c.charCodeAt(0)));
    expect(svg).toContain("🐱");
    expect(svg).toMatch(/^<svg /);
  });
});

describe("assignCharacters: duplicates after a card comes back", () => {
  it("re-probes the later-assigned of two cards sharing a remembered character while the pack has room", () => {
    const [a, b] = idsAt(0, 4, 2);
    // a was assigned 🐶 first; its card left, b probed onto 🐶 too; a came back.
    const r = run({ sessionIds: [b!, a!], remembered: { [a!]: "🐶", [b!]: "🐶" } });
    expect(r.chars.get(a!)?.id).toBe("🐶");
    expect(r.chars.get(b!)?.id).not.toBe("🐶");
    expect(r.remember).toEqual({ [b!]: r.chars.get(b!)!.id });
  });

  it("keeps remembered duplicates once the pack is exhausted", () => {
    const sids = idsAt(0, 4, 5);
    const remembered = Object.fromEntries(sids.map((s, i) => [s, ["🐶", "🐱", "🐭", "🐹", "🐶"][i]!]));
    const r = run({ sessionIds: sids, remembered });
    expect(sids.map((s) => r.chars.get(s)?.id)).toEqual(["🐶", "🐱", "🐭", "🐹", "🐶"]);
    expect(r.remember).toEqual({});
  });

  it("never re-probes an override", () => {
    const [a, b] = idsAt(0, 4, 2);
    const r = run({ sessionIds: [a!, b!], remembered: { [a!]: "🐶" }, overrides: { [b!]: { pack: "p", id: "🐶" } } });
    expect(r.chars.get(b!)?.id).toBe("🐶");
    expect(r.chars.get(a!)?.id).not.toBe("🐶"); // the remembered pick gives way
  });
});

describe("CharacterSync", () => {
  const data = (assigned: Record<string, Record<string, string>> = {}, activePack = "@animals"): CharactersData => ({
    activePack,
    assigned,
    overrides: {},
    packs: [],
  });
  /** A fake server: each call returns a promise the test resolves or rejects. */
  function fakeApi() {
    const calls: Array<{ pack: string; picks: Record<string, string>; resolve: (d: CharactersData) => void; reject: (e: Error) => void }> = [];
    return {
      calls,
      assign: (pack: string, picks: Record<string, string>) =>
        new Promise<CharactersData>((resolve, reject) => calls.push({ pack, picks, resolve, reject })),
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("remembered picks count at once, and are sent once while in flight", async () => {
    const api = fakeApi();
    const sync = new CharacterSync(api, () => {});
    sync.set(data());
    sync.remember("@animals", { a: "🐱" });
    sync.remember("@animals", { b: "🐶" });
    expect(sync.remembered("@animals")).toEqual({ a: "🐱", b: "🐶" });
    expect(api.calls.map((c) => c.picks)).toEqual([{ a: "🐱" }]);
    api.calls[0]!.resolve(data({ "@animals": { a: "🐱" } }));
    await tick();
    expect(api.calls.map((c) => c.picks)).toEqual([{ a: "🐱" }, { b: "🐶" }]);
    api.calls[1]!.resolve(data({ "@animals": { a: "🐱", b: "🐶" } }));
    await tick();
    expect(sync.pendingCount()).toBe(0);
    expect(sync.data!.assigned).toEqual({ "@animals": { a: "🐱", b: "🐶" } });
  });

  it("a failed POST keeps the picks and resends them on the next flush", async () => {
    const api = fakeApi();
    const sync = new CharacterSync(api, () => {});
    sync.set(data());
    sync.remember("@animals", { a: "🐱" });
    api.calls[0]!.reject(new Error("offline"));
    await tick();
    expect(sync.remembered("@animals")).toEqual({ a: "🐱" });
    sync.flush();
    expect(api.calls.map((c) => c.picks)).toEqual([{ a: "🐱" }, { a: "🐱" }]);
  });

  it("picks the server dropped (stale) are forgotten", async () => {
    const api = fakeApi();
    const sync = new CharacterSync(api, () => {});
    sync.set(data());
    sync.remember("@animals", { a: "🐱", gone: "🦄" });
    api.calls[0]!.resolve(data({ "@animals": { a: "🐱" } }));
    await tick();
    expect(sync.remembered("@animals")).toEqual({ a: "🐱" });
    expect(sync.pendingCount()).toBe(0);
  });

  it("an older answer arriving late does not undo a newer one; its confirmed picks are merged", async () => {
    const api = fakeApi();
    const seen: CharactersData[] = [];
    const sync = new CharacterSync(api, (d) => seen.push(d));
    sync.set(data());
    sync.remember("@animals", { a: "🐱" });
    let release!: (d: CharactersData) => void;
    const later = sync.request(() => new Promise<CharactersData>((r) => (release = r)));
    release(data({}, "@sea")); // the newer request answers first (it did not see the pick)
    await later;
    expect(sync.data!.activePack).toBe("@sea");
    api.calls[0]!.resolve(data({ "@animals": { a: "🐱" } }, "@animals")); // the older one, late
    await tick();
    expect(sync.data!.activePack).toBe("@sea");
    expect(sync.data!.assigned["@animals"]).toEqual({ a: "🐱" });
  });

  it("a pick re-made before its POST answers is not lost", async () => {
    const api = fakeApi();
    const sync = new CharacterSync(api, () => {});
    sync.set(data());
    sync.remember("@animals", { a: "🐱" });
    sync.remember("@animals", { a: "🐶" });
    api.calls[0]!.resolve(data({ "@animals": { a: "🐱" } }));
    await tick();
    expect(sync.remembered("@animals")).toEqual({ a: "🐶" });
    expect(api.calls.at(-1)!.picks).toEqual({ a: "🐶" });
  });
});

describe("character element edits", () => {
  const CAT = "excaliagent-emoji-1f431";
  it("removeCharacter soft-deletes a session's characters; allowCharacter clears the flag of its cards without one", () => {
    const gen = testGen();
    const els = makeCard(session({ id: "a" }), { x: 0, y: 0 }, gen, 0, undefined, CAT);
    const removed = removeCharacter(els, "a", gen, 1);
    expect(removed.filter((e) => e.customData?.excaliagent?.kind === "card-character" && !e.isDeleted)).toHaveLength(0);
    expect(removed[0]!.customData!.excaliagent.charLayout).toBe(1);
    const allowed = allowCharacter(removed, "a", gen, 2);
    expect(allowed[0]!.customData!.excaliagent.charLayout).toBeUndefined();
    expect(allowed[0]!.version).toBe(els[0]!.version + 1);
    // A card that still shows its character keeps the flag; nothing to do.
    expect(allowCharacter(els, "a", gen, 3)).toBe(els);
    expect(removeCharacter(els, "zz", gen, 3)).toBe(els);
  });
});
