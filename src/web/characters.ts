// A character per session (docs/design.md "Characters"). Pure: no DOM, no fetch.
//
// Assignment is open addressing over the active pack: hash(session id) picks a
// start index, then linear probing skips characters already used by another
// card on the board. Once picked, a character is remembered server-side per
// (pack, session), so it survives the card being deleted and coming back, and
// does not shift when the cards it collided with go away. An exhausted pack
// hands out duplicates. A hand-picked override (from any pack) beats all of it.
// One exception to memory: when two cards on the board would show the same
// remembered character while the pack still has a free one (a card came back
// after another session took its character), the later-assigned one probes
// again. Uniqueness wins over memory only then.
import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { Session } from "../shared/types.ts";
import { cardMeta } from "./cards.ts";
import {
  emojiFileId,
  emojiFromFileId,
  type CharacterRef,
  type CharactersData,
  type Pack,
  type PackCharacter,
} from "../shared/packs.ts";

/** FNV-1a, 32 bit, over UTF-16 code units: stable across browsers and releases. */
export function characterHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface AssignInput {
  /** The active pack; undefined or empty → no automatic characters. */
  pack: Pack | undefined;
  /** Every pack by id, to resolve overrides. */
  packs: ReadonlyMap<string, Pack>;
  /** Sessions with a card on the board (or about to get one), in board order. */
  sessionIds: readonly string[];
  /** Remembered picks in the active pack: session id → character id. */
  remembered: Readonly<Record<string, string>>;
  overrides: Readonly<Record<string, CharacterRef>>;
  /** Continuation → the session it continues (`continuedIn`), to inherit from. */
  inherit?: ReadonlyMap<string, string>;
}

export interface Assignment {
  /** The character to draw on each session's card. */
  chars: Map<string, PackCharacter>;
  /** New picks to remember for the active pack. */
  remember: Record<string, string>;
  /** Overrides a continuation inherited, to store under its own id. */
  overrides: Record<string, CharacterRef>;
}

const find = (pack: Pack | undefined, id: string) => pack?.characters.find((c) => c.id === id);

/** The first entry for `sid` or, failing that, for a session it continues. */
function resolve<T>(
  sid: string,
  table: Readonly<Record<string, T>>,
  inherit: ReadonlyMap<string, string> | undefined,
  valid: (v: T) => boolean,
): { value: T; inherited: boolean } | undefined {
  const seen = new Set<string>();
  for (let cur: string | undefined = sid; cur !== undefined && !seen.has(cur); cur = inherit?.get(cur)) {
    seen.add(cur);
    const v = Object.hasOwn(table, cur) ? table[cur] : undefined;
    if (v !== undefined && valid(v)) return { value: v, inherited: cur !== sid };
  }
  return undefined;
}

/** The session whose remembered entry `sid` resolves to (itself or one it continues). */
function firstKey(sid: string, table: Readonly<Record<string, unknown>>, inherit: ReadonlyMap<string, string> | undefined): string {
  const seen = new Set<string>();
  for (let cur: string | undefined = sid; cur !== undefined && !seen.has(cur); cur = inherit?.get(cur)) {
    seen.add(cur);
    if (Object.hasOwn(table, cur)) return cur;
  }
  return sid;
}

export function assignCharacters(input: AssignInput): Assignment {
  const { pack, packs, remembered, overrides, inherit } = input;
  const chars = new Map<string, PackCharacter>();
  const remember: Record<string, string> = {};
  const inheritedOverrides: Record<string, CharacterRef> = {};
  const used = new Set<string>();
  const order = [...new Set(input.sessionIds)];

  const n = pack?.characters.length ?? 0;
  // 1) Overrides claim their characters first.
  const auto: string[] = [];
  for (const sid of order) {
    const o = resolve(sid, overrides, inherit, (r) => !!find(packs.get(r.pack), r.id));
    if (!o) {
      auto.push(sid);
      continue;
    }
    chars.set(sid, find(packs.get(o.value.pack), o.value.id)!);
    if (o.inherited) inheritedOverrides[sid] = o.value;
    if (pack && o.value.pack === pack.id) used.add(o.value.id);
  }
  // 2) Remembered picks, in the order they were assigned (the key order of
  //    `remembered`); one already shown by another card gives way while the
  //    pack has a free character.
  const rank = new Map(Object.keys(remembered).map((k, i) => [k, i]));
  const held = auto
    .map((sid) => ({ sid, r: resolve(sid, remembered, inherit, (id) => !!find(pack, id)) }))
    .filter((x): x is { sid: string; r: NonNullable<typeof x.r> } => !!x.r)
    .map((x) => ({ ...x, at: rank.get(x.r.inherited ? firstKey(x.sid, remembered, inherit) : x.sid) ?? 0 }))
    .sort((a, b) => a.at - b.at);
  for (const { sid, r } of held) {
    if (used.has(r.value) && used.size < n) continue; // probes below
    chars.set(sid, find(pack, r.value)!);
    if (r.inherited) remember[sid] = r.value;
    used.add(r.value);
  }

  // 3) Everyone else probes from their hash slot, in board order.
  if (!pack || n === 0) return { chars, remember, overrides: inheritedOverrides };
  for (const sid of order) {
    if (chars.has(sid)) continue;
    const start = characterHash(sid) % n;
    let pick = pack.characters[start]!;
    for (let k = 0; k < n; k++) {
      const c = pack.characters[(start + k) % n]!;
      if (!used.has(c.id)) {
        pick = c;
        break;
      }
    }
    chars.set(sid, pick);
    used.add(pick.id);
    remember[sid] = pick.id;
  }
  return { chars, remember, overrides: inheritedOverrides };
}

/** Continuation → the session it continues. */
export function inheritMap(sessions: readonly Session[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of sessions) if (s.continuedIn && s.continuedIn !== s.id) m.set(s.continuedIn, s.id);
  return m;
}

/** "Shuffle": a random character of the active pack not on the board and not `current`; else any other. */
export function shuffleCharacter(
  pack: Pack | undefined,
  used: ReadonlySet<string>,
  current: CharacterRef | undefined,
  random: () => number,
): CharacterRef | undefined {
  if (!pack || pack.characters.length === 0) return undefined;
  const isCurrent = (c: PackCharacter) => current?.pack === pack.id && current.id === c.id;
  const others = pack.characters.filter((c) => !isCurrent(c));
  const free = others.filter((c) => !used.has(c.id));
  const from = free.length ? free : others.length ? others : pack.characters;
  const pick = from[Math.min(from.length - 1, Math.floor(random() * from.length))]!;
  return { pack: pack.id, id: pick.id };
}

function utf8Base64(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

const EMOJI_FONTS = "Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,Twemoji Mozilla,EmojiOne Color,sans-serif";

/**
 * An emoji as an SVG image, drawn by the viewer's emoji font. Built from the
 * file id alone, so it is never stored: the scene only keeps the image element.
 */
export function emojiFile(emoji: string, created: number): BinaryFileData {
  const esc = emoji.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="256" height="256">` +
    `<text x="64" y="68" font-size="104" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="${EMOJI_FONTS}">${esc}</text></svg>`;
  return {
    id: emojiFileId(emoji) as FileId,
    mimeType: "image/svg+xml",
    dataURL: `data:image/svg+xml;base64,${utf8Base64(svg)}` as DataURL,
    created,
  };
}

/** The emoji file for an `excaliagent-emoji-*` id (e.g. from a saved scene), or undefined. */
export function emojiFileFor(fileId: string, created: number): BinaryFileData | undefined {
  const emoji = emojiFromFileId(fileId);
  return emoji === undefined ? undefined : emojiFile(emoji, created);
}

/** Files the app makes itself (logos, characters): handed to Excalidraw, never uploaded to files/. */
export const isAppFile = (fileId: string) => fileId.startsWith("excaliagent-");

/** Sessions that have a card or are about to get one (live, or added from the picker), in board order. */
export function boardSessionIds(
  elements: readonly ExcalidrawElement[],
  sessions: readonly Session[],
  add: readonly Session[] = [],
): string[] {
  const ids: string[] = [];
  for (const e of elements) {
    const m = e.isDeleted ? undefined : cardMeta(e);
    if (m) ids.push(m.sessionId);
  }
  for (const s of sessions) if (s.live) ids.push(s.id);
  for (const s of add) ids.push(s.id);
  return [...new Set(ids)];
}

/** Picker → None: soft-delete the characters on `sessionId`'s cards (an ordinary, undoable edit). */
export function removeCharacter(
  elements: readonly ExcalidrawElement[],
  sessionId: string,
  gen: { seed(): number },
  now: number,
): ExcalidrawElement[] {
  let changed = false;
  const out = elements.map((e) => {
    const m = e.customData?.excaliagent;
    if (e.isDeleted || e.type !== "image" || m?.kind !== "card-character" || m.sessionId !== sessionId) return e;
    changed = true;
    return { ...e, isDeleted: true, version: e.version + 1, versionNonce: gen.seed(), updated: now };
  });
  return changed ? out : (elements as ExcalidrawElement[]);
}

/**
 * Picker → a character, on a card whose character was removed: clear the
 * card's `charLayout` flag so reconcile adds one again (its title is already
 * right of where it goes, so nothing moves).
 */
export function allowCharacter(
  elements: readonly ExcalidrawElement[],
  sessionId: string,
  gen: { seed(): number },
  now: number,
): ExcalidrawElement[] {
  const shown = new Set<string>();
  for (const e of elements) {
    const m = e.customData?.excaliagent;
    if (!e.isDeleted && m?.kind === "card-character" && m.sessionId === sessionId) shown.add(e.groupIds[0] ?? "");
  }
  let changed = false;
  const out = elements.map((e) => {
    const m = e.isDeleted ? undefined : cardMeta(e);
    if (!m || m.sessionId !== sessionId || m.charLayout !== 1 || shown.has(e.groupIds[0] ?? "")) return e;
    changed = true;
    const { charLayout: _, ...rest } = m;
    return { ...e, customData: { ...e.customData, excaliagent: rest }, version: e.version + 1, versionNonce: gen.seed(), updated: now };
  });
  return changed ? out : (elements as ExcalidrawElement[]);
}

/**
 * The board's copy of the character state, kept consistent with the server
 * while requests overlap:
 * - every answer is numbered; one that arrives after a newer one was applied
 *   is not applied (only the picks it confirmed are merged in);
 * - new picks count at once (`remembered`), are sent one batch per pack at a
 *   time, and stay pending until the server confirms them, so a failed POST
 *   is resent on the next `flush`; a pick the server dropped (stale pack,
 *   character or session) is forgotten.
 */
export class CharacterSync {
  data: CharactersData | null = null;
  private readonly pending = new Map<string, Record<string, string>>();
  private readonly inflight = new Set<string>();
  private seq = 0;
  private applied = 0;
  private readonly api: { assign(pack: string, picks: Record<string, string>): Promise<CharactersData> };
  private readonly onChange: (d: CharactersData) => void;

  constructor(
    api: { assign(pack: string, picks: Record<string, string>): Promise<CharactersData> },
    onChange: (d: CharactersData) => void,
  ) {
    this.api = api;
    this.onChange = onChange;
  }

  set(d: CharactersData): void {
    this.data = d;
    this.onChange(d);
  }

  /** Run a request whose answer is the whole state; applied unless a newer answer already was. */
  async request(fn: () => Promise<CharactersData>): Promise<CharactersData | null> {
    const n = ++this.seq;
    const d = await fn();
    if (n > this.applied) {
      this.applied = n;
      this.set(d);
    }
    return this.data;
  }

  /** Server-confirmed picks plus the ones not confirmed yet. */
  remembered(pack: string): Record<string, string> {
    return { ...this.data?.assigned[pack], ...this.pending.get(pack) };
  }

  pendingCount(): number {
    let n = 0;
    for (const p of this.pending.values()) n += Object.keys(p).length;
    return n;
  }

  remember(pack: string, picks: Record<string, string>): void {
    this.pending.set(pack, { ...this.pending.get(pack), ...picks });
    this.flush();
  }

  /** Send what is pending (one request per pack at a time). */
  flush(): void {
    for (const [pack, picks] of this.pending) {
      if (this.inflight.has(pack) || !Object.keys(picks).length) continue;
      const batch = { ...picks };
      this.inflight.add(pack);
      const n = ++this.seq;
      this.api
        .assign(pack, batch)
        .then(
          (d) => {
            const kept = d.assigned[pack] ?? {};
            const left = this.pending.get(pack) ?? {};
            // Confirmed or dropped by the server: no longer pending, unless re-picked meanwhile.
            for (const [sid, id] of Object.entries(batch)) if (left[sid] === id) delete left[sid];
            if (!Object.keys(left).length) this.pending.delete(pack);
            if (n > this.applied) {
              this.applied = n;
              this.set(d);
            } else if (this.data) {
              // Older than what we show: keep that, plus the picks this answer confirmed.
              const confirmed = Object.fromEntries(Object.entries(batch).filter(([sid, id]) => kept[sid] === id));
              this.set({ ...this.data, assigned: { ...this.data.assigned, [pack]: { ...this.data.assigned[pack], ...confirmed } } });
            }
            this.settled(pack);
          },
          () => {
            // Kept pending; the next flush (the 30 s tick) resends them.
            this.inflight.delete(pack);
          },
        );
    }
  }

  /** An answer came: the pack is free again; send what was picked meanwhile. */
  private settled(pack: string): void {
    this.inflight.delete(pack);
    if (Object.keys(this.pending.get(pack) ?? {}).length) this.flush();
  }
}
