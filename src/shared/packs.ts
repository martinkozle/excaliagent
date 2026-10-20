// Character packs (docs/design.md "Characters"): shared by the server (which
// lists, validates and stores them) and the board (which assigns and draws them).
//
// A pack is an ordered list of characters. Built-in packs are Unicode emoji,
// drawn by the system's emoji font; their ids start with "@", a character that
// custom pack names (folder names under <stateDir>/packs/) cannot contain, so
// the two never collide. Custom packs hold emoji and/or image files.

export interface PackCharacter {
  /** Unique within its pack: the emoji itself, or the image's file name. */
  id: string;
  kind: "emoji" | "image";
  /** The Excalidraw file id the card's image element points at. */
  fileId: string;
  /** Image characters: where the board fetches the bytes (same-origin, token cookie). */
  url?: string;
}

export interface Pack {
  /** "@animals" for built-ins, the folder name for custom packs. */
  id: string;
  /** Display name. */
  name: string;
  builtIn: boolean;
  characters: PackCharacter[];
  /** Why (part of) a custom pack could not be read; its other characters still work. */
  error?: string;
}

export interface CharacterRef {
  pack: string;
  id: string;
}

/** `<stateDir>/characters.json`. */
export interface CharactersState {
  activePack: string;
  /** pack id → session id → character id: the remembered automatic assignments. */
  assigned: Record<string, Record<string, string>>;
  /** session id → character chosen by hand; beats every pack's assignment. */
  overrides: Record<string, CharacterRef>;
}

/** What `GET /api/characters` (and every character/pack mutation) returns. */
export interface CharactersData extends CharactersState {
  packs: Pack[];
  /** Folders under packs/ that are not packs (e.g. an invalid name), for the panel to show. */
  problems?: string[];
}

export const DEFAULT_PACK = "@animals";

/** Custom pack names: a folder name that can never escape `<stateDir>/packs/`. */
export const PACK_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** Characters per pack beyond this are ignored (and refused on add). */
export const MAX_PACK_CHARACTERS = 200;

/** `excaliagent-emoji-1f431`: the file id encodes the emoji, so the board can redraw it from the id alone. */
export function emojiFileId(emoji: string): string {
  return `excaliagent-emoji-${[...emoji].map((c) => c.codePointAt(0)!.toString(16)).join("-")}`;
}

/** The emoji an `emojiFileId` encodes, or undefined. */
export function emojiFromFileId(fileId: string): string | undefined {
  const m = /^excaliagent-emoji-([0-9a-f]{1,6}(?:-[0-9a-f]{1,6}){0,15})$/.exec(fileId);
  if (!m) return undefined;
  try {
    const emoji = String.fromCodePoint(...m[1]!.split("-").map((h) => parseInt(h, 16)));
    return validEmoji(emoji) ? emoji : undefined;
  } catch {
    return undefined;
  }
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * One emoji: a single grapheme (ZWJ sequences, skin tones and flags included),
 * at most 32 UTF-16 units, with a pictographic or regional-indicator character
 * and no control characters or whitespace.
 */
export function validEmoji(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0 || s.length > 32) return false;
  if (/[\p{Cc}\s]/u.test(s)) return false;
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s)) return false;
  return [...segmenter.segment(s)].length === 1;
}

const emojiPack = (id: string, name: string, emoji: string): Pack => ({
  id,
  name,
  builtIn: true,
  characters: emoji
    .split(" ")
    .filter(Boolean)
    .map((e) => ({ id: e, kind: "emoji" as const, fileId: emojiFileId(e) })),
});

// Emoji from Unicode ≤ 12 without ZWJ sequences or variation selectors, so
// every common emoji font (Noto Color Emoji, Apple, Segoe UI) has them.
export const BUILT_IN_PACKS: readonly Pack[] = [
  emojiPack(
    "@animals",
    "Animals",
    "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🦆 🦅 🦉 🐺 🐗 🐴 🦄 🐝 🐞 🦋 🐌 🐢 🐍 🦎 🦒 🦓 🐘 🦔 🦘",
  ),
  emojiPack(
    "@cats",
    "Cats & friends",
    "😺 😸 😹 😻 😼 😽 🙀 😿 😾 🐱 🐈 🐯 🐅 🐆 🦁 🐶 🐕 🐩 🐹 🐰 🐇 🐭 🐁 🦔 🐤 🐥 🐣 🐦",
  ),
  emojiPack(
    "@sea",
    "Sea",
    "🐙 🦑 🦐 🦞 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐢 🐚 🦦 🐧 🦢 🦆 🦪 ⛵ 🚤 🛶 🚢 ⚓ 🏄 🌊 🧜 🌴",
  ),
  emojiPack(
    "@fantasy",
    "Fantasy",
    "🐉 🐲 🦄 🧙 🧚 🧛 🧜 🧝 🧞 🧟 🦸 🦹 👻 👽 👾 🤖 👹 👺 💀 🎃 🦖 🦕 🔮 🗿 🏰 🛸 🌋 🌈 🍄",
  ),
  emojiPack(
    "@food",
    "Food",
    "🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🌽 🥕 🥐 🥖 🥨 🧀 🥚 🥞 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🍣 🍜 🍩 🍪 🍰 🍫 🍿",
  ),
];
