// Characters and packs on disk (docs/design.md "Characters"):
//
//   <stateDir>/characters.json        active pack, remembered assignments, overrides
//   <stateDir>/packs/<name>/          a custom pack: image files + optional pack.json
//   <stateDir>/packs/<name>/pack.json {"emoji": ["🧟", ...]}
//
// Hand-dropped folders and files work. Everything is validated: pack names come
// from a safe charset (never a path), image files are served only if the pack's
// own listing has them (so no name can escape the folder), image types are
// allowlisted and sniffed, sizes are capped, writes are atomic. A broken pack
// folder or file degrades only that pack.
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  BUILT_IN_PACKS,
  DEFAULT_PACK,
  MAX_PACK_CHARACTERS,
  PACK_NAME,
  emojiFileId,
  validEmoji,
  type CharacterRef,
  type CharactersData,
  type CharactersState,
  type Pack,
  type PackCharacter,
} from "../shared/packs.ts";
import { SESSION_ID } from "./hub.ts";

/** Largest image a pack may hold (uploaded or hand-dropped). */
export const MAX_IMAGE_BYTES = 1024 * 1024;

/** An error carrying the HTTP status the route should answer with. */
export class StatusError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};
const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/jpeg": ".jpg",
  "image/svg+xml": ".svg",
};

const SVG_START = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i;

/** Do the bytes look like `mimeType`? Keeps HTML or scripts out of a pack posing as images. */
export function sniffImage(bytes: Buffer, mimeType: string): boolean {
  const ascii = (from: number, to: number) => bytes.subarray(from, to).toString("latin1");
  switch (mimeType) {
    case "image/png":
      return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/gif":
      return ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a";
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/svg+xml":
      return SVG_START.test(bytes.subarray(0, 4096).toString("utf8").replace(/^﻿/, ""));
    default:
      return false;
  }
}

/** A hand-dropped file name we list: no path parts, not hidden, printable, an allowed extension. */
function listableName(name: string): boolean {
  return (
    name.length <= 200 &&
    !name.startsWith(".") &&
    !/[/\\\p{Cc}]/u.test(name) &&
    Object.hasOwn(MIME_BY_EXT, extname(name).toLowerCase())
  );
}

/** An uploaded file's name, made safe: `[A-Za-z0-9_-]` runs, at most 60, plus the extension of its type. */
function uploadName(raw: unknown, mimeType: string): string {
  let base = typeof raw === "string" ? raw : "";
  const ext = extname(base).toLowerCase();
  if (Object.hasOwn(MIME_BY_EXT, ext)) base = base.slice(0, -ext.length);
  base = base.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 60);
  return `${base || "image"}${EXT_BY_MIME[mimeType]}`;
}

export interface CharacterStore {
  load(): Promise<CharactersData>;
  /** Remember automatic picks for `pack`: session id → character id. */
  assign(pack: string, picks: Record<string, string>): Promise<CharactersData>;
  /** Pin a session's character (null: back to automatic). */
  override(sessionId: string, ref: CharacterRef | null): Promise<CharactersData>;
  setActive(pack: string): Promise<CharactersData>;
  /** A new custom pack, empty or a copy of `from` (a built-in or custom pack). */
  createPack(name: string, from?: string): Promise<CharactersData>;
  renamePack(pack: string, name: string): Promise<CharactersData>;
  deletePack(pack: string): Promise<CharactersData>;
  addEmoji(pack: string, emoji: string): Promise<CharactersData>;
  /** `dataURL`: `data:<allowed image type>;base64,…`. The stored name is derived from `name`. */
  addImage(pack: string, name: string, dataURL: string): Promise<CharactersData>;
  removeCharacter(pack: string, id: string): Promise<CharactersData>;
  /** One image of a custom pack, checked like a listing would (name, regular file, size, type). */
  readImage(pack: string, file: string): Promise<{ bytes: Buffer; mimeType: string; hash: string } | undefined>;
}

type Log = { warn(msg: string): void };

const emptyState = (): CharactersState => ({ activePack: DEFAULT_PACK, assigned: {}, overrides: {} });
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const validPackId = (id: unknown): id is string =>
  typeof id === "string" && (PACK_NAME.test(id) || BUILT_IN_PACKS.some((p) => p.id === id));

/** Keep only well-formed entries of a (possibly hand-edited) characters.json. */
function cleanState(raw: unknown): CharactersState {
  const out = emptyState();
  if (!isObject(raw)) return out;
  if (validPackId(raw.activePack)) out.activePack = raw.activePack;
  if (isObject(raw.assigned)) {
    for (const [pack, picks] of Object.entries(raw.assigned)) {
      if (!validPackId(pack) || !isObject(picks)) continue;
      const clean: Record<string, string> = {};
      for (const [sid, id] of Object.entries(picks)) if (SESSION_ID.test(sid) && typeof id === "string") clean[sid] = id;
      if (Object.keys(clean).length) out.assigned[pack] = clean;
    }
  }
  if (isObject(raw.overrides)) {
    for (const [sid, ref] of Object.entries(raw.overrides)) {
      if (SESSION_ID.test(sid) && isObject(ref) && validPackId(ref.pack) && typeof ref.id === "string")
        out.overrides[sid] = { pack: ref.pack, id: ref.id };
    }
  }
  return out;
}

export function createCharacterStore(stateDir: string, log: Log = console): CharacterStore {
  const statePath = join(stateDir, "characters.json");
  const packsDir = join(stateDir, "packs");
  let queue: Promise<unknown> = Promise.resolve();
  let seq = 0;
  /** path → content hash, valid while mtime and size match. */
  const hashes = new Map<string, { mtimeMs: number; size: number; hash: string }>();

  /** Mutations run one at a time. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  async function writeAtomic(target: string, data: string | Buffer): Promise<void> {
    const tmp = `${target}.tmp-${process.pid}-${seq++}`;
    try {
      const fh = await open(tmp, "w", 0o600);
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, target);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async function readState(): Promise<CharactersState> {
    let raw: string;
    try {
      raw = await readFile(statePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw err;
    }
    try {
      return cleanState(JSON.parse(raw));
    } catch (err) {
      const aside = `${statePath}.corrupt-${Date.now()}`;
      await rename(statePath, aside).catch(() => {});
      log.warn(`excaliagent: ${statePath} was unreadable (${(err as Error).message}); moved to ${aside}`);
      return emptyState();
    }
  }

  async function writeState(state: CharactersState): Promise<void> {
    await mkdir(stateDir, { recursive: true });
    await writeAtomic(statePath, JSON.stringify({ version: 1, ...state }, null, 1));
  }

  async function contentHash(path: string, mtimeMs: number, size: number, bytes?: Buffer): Promise<string> {
    const hit = hashes.get(path);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.hash;
    const hash = createHash("sha256").update(bytes ?? (await readFile(path))).digest("hex").slice(0, 24);
    hashes.set(path, { mtimeMs, size, hash });
    return hash;
  }

  /**
   * One image file of a pack folder, if it qualifies: a listable name, a
   * regular file (not a symlink), within the size cap, bytes matching its type.
   * `why` says why not (undefined: not an image file at all).
   */
  async function checkImage(
    dir: string,
    file: string,
    readAll: boolean,
  ): Promise<{ ok: true; mimeType: string; hash: string; bytes?: Buffer } | { ok: false; why?: string }> {
    if (!listableName(file)) return { ok: false };
    const path = join(dir, file);
    const mimeType = MIME_BY_EXT[extname(file).toLowerCase()]!;
    try {
      const st = await lstat(path);
      if (!st.isFile()) return { ok: false };
      if (st.size > MAX_IMAGE_BYTES) return { ok: false, why: `${file}: over ${MAX_IMAGE_BYTES / 1024 / 1024} MB` };
      let bytes: Buffer | undefined;
      let head: Buffer;
      if (readAll) head = bytes = await readFile(path);
      else {
        const fh = await open(path, "r");
        try {
          head = Buffer.alloc(Math.min(st.size, 4096));
          await fh.read(head, 0, head.length, 0);
        } finally {
          await fh.close();
        }
      }
      if (!sniffImage(head, mimeType)) return { ok: false, why: `${file}: not a ${mimeType} image` };
      return { ok: true, mimeType, hash: await contentHash(path, st.mtimeMs, st.size, bytes), bytes };
    } catch (err) {
      return { ok: false, why: `${file}: ${(err as Error).message}` };
    }
  }

  async function readEmojiList(dir: string): Promise<{ emoji: string[]; error?: string }> {
    let raw: string;
    try {
      raw = await readFile(join(dir, "pack.json"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { emoji: [] };
      return { emoji: [], error: `pack.json: ${(err as Error).message}` };
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      const list = isObject(parsed) && Array.isArray(parsed.emoji) ? parsed.emoji : undefined;
      if (!list) return { emoji: [], error: 'pack.json: expected {"emoji": [...]}' };
      return { emoji: [...new Set(list.filter(validEmoji))] };
    } catch (err) {
      return { emoji: [], error: `pack.json: ${(err as Error).message}` };
    }
  }

  /** A custom pack's listing; never throws (a broken pack lists what it can, plus an error). */
  async function readPack(name: string): Promise<Pack> {
    const dir = join(packsDir, name);
    const errors: string[] = [];
    const characters: PackCharacter[] = [];
    const list = await readEmojiList(dir);
    if (list.error) errors.push(list.error);
    for (const e of list.emoji) characters.push({ id: e, kind: "emoji", fileId: emojiFileId(e) });
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      errors.push((err as Error).message);
    }
    const files = entries
      .filter((e) => e.isFile() && listableName(e.name))
      .map((e) => e.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let capped = characters.length > MAX_PACK_CHARACTERS;
    characters.length = Math.min(characters.length, MAX_PACK_CHARACTERS);
    for (const file of files) {
      // Stop at the cap: no hashing of images that would be ignored anyway.
      if (characters.length >= MAX_PACK_CHARACTERS) {
        capped = true;
        break;
      }
      const img = await checkImage(dir, file, false);
      if (!img.ok) {
        if (img.why) errors.push(img.why);
        continue;
      }
      characters.push({
        id: file,
        kind: "image",
        fileId: `excaliagent-img-${img.hash}`,
        url: `/api/packs/${encodeURIComponent(name)}/${encodeURIComponent(file)}?v=${img.hash}`,
      });
    }
    if (capped) errors.push(`more than ${MAX_PACK_CHARACTERS} characters; the rest are ignored`);
    return { id: name, name, builtIn: false, characters, ...(errors.length ? { error: errors.join("; ") } : {}) };
  }

  /**
   * The pack folders (real directories with a valid name, as the directory
   * lists them: on a case-insensitive file system "FOO" must not alias "foo"),
   * plus the entries that are not packs, as problems.
   */
  async function scanPacks(): Promise<{ names: string[]; problems: string[] }> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(packsDir, { withFileTypes: true });
    } catch {
      return { names: [], problems: [] };
    }
    const names: string[] = [];
    const problems: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (!e.isDirectory()) {
        if (e.isSymbolicLink()) problems.push(`packs/${e.name}: a link, not a folder; ignored`);
        continue;
      }
      if (PACK_NAME.test(e.name)) names.push(e.name);
      else problems.push(`packs/${e.name}: not a valid pack name (letters, digits, - and _, up to 40); ignored`);
    }
    return { names: names.sort((a, b) => a.localeCompare(b)), problems };
  }

  async function data(state?: CharactersState): Promise<CharactersData> {
    const s = state ?? (await readState());
    const { names, problems } = await scanPacks();
    const packs = [...BUILT_IN_PACKS, ...(await Promise.all(names.map(readPack)))];
    const activePack = packs.some((p) => p.id === s.activePack) ? s.activePack : DEFAULT_PACK;
    return { ...s, activePack, packs, ...(problems.length ? { problems } : {}) };
  }

  /** Is `id` a custom pack folder, exactly as listed? */
  async function isPackFolder(id: string): Promise<boolean> {
    return PACK_NAME.test(id) && (await scanPacks()).names.includes(id);
  }

  /** A pack by id, or a 400 (bad name) / 404 (no such pack). */
  async function findPack(id: unknown): Promise<Pack> {
    const builtIn = BUILT_IN_PACKS.find((p) => p.id === id);
    if (builtIn) return builtIn;
    if (typeof id !== "string" || !PACK_NAME.test(id)) throw new StatusError(400, "invalid pack name");
    if (!(await isPackFolder(id))) throw new StatusError(404, "no such pack");
    return readPack(id);
  }

  async function customPack(id: unknown): Promise<Pack> {
    if (BUILT_IN_PACKS.some((p) => p.id === id)) throw new StatusError(403, "built-in packs are read-only");
    return findPack(id);
  }

  function newName(name: unknown): string {
    if (typeof name !== "string" || !PACK_NAME.test(name)) {
      throw new StatusError(400, `pack names must match ${PACK_NAME}`);
    }
    return name;
  }

  /** No folder (in any letter case: file systems may ignore it) or file takes `name`, except `self`. */
  async function mustNotExist(name: string, self?: string): Promise<void> {
    const lower = name.toLowerCase();
    const taken = (await readdir(packsDir).catch(() => [] as string[])).some(
      (n) => n.toLowerCase() === lower && n !== self,
    );
    if (taken) throw new StatusError(409, "a pack with that name exists");
  }

  async function writeEmojiList(pack: string, emoji: string[]): Promise<void> {
    await writeAtomic(join(packsDir, pack, "pack.json"), `${JSON.stringify({ emoji }, null, 1)}\n`);
  }

  /** Mutate characters.json under the lock and return the new data. */
  async function update(fn: (s: CharactersState) => void | Promise<void>): Promise<CharactersData> {
    const s = await readState();
    await fn(s);
    await writeState(s);
    return data(s);
  }

  function checkSession(sid: unknown): asserts sid is string {
    if (typeof sid !== "string" || !SESSION_ID.test(sid)) throw new StatusError(400, "sessionId must be a session UUID");
  }

  /** Forget assignments and overrides that point at characters `gone` of `pack`. */
  function forget(s: CharactersState, pack: string, gone: (id: string) => boolean) {
    const picks = s.assigned[pack];
    if (picks) for (const sid of Object.keys(picks)) if (gone(picks[sid]!)) delete picks[sid];
    if (picks && !Object.keys(picks).length) delete s.assigned[pack];
    for (const [sid, ref] of Object.entries(s.overrides)) if (ref.pack === pack && gone(ref.id)) delete s.overrides[sid];
  }

  return {
    load: () => serial(() => data()),

    // Picks are computed by the board from the packs it last saw; a pick for a
    // pack, character or session that is gone (or malformed) is dropped, not
    // the whole batch. The answer shows what was kept.
    assign: (pack, picks) =>
      serial(async () => {
        if (!isObject(picks)) throw new StatusError(400, "assign must be an object");
        const entries = Object.entries(picks);
        if (entries.length > 1000) throw new StatusError(400, "too many assignments");
        const p = await findPack(pack).catch((err: unknown) => {
          if (err instanceof StatusError && err.status === 404) return undefined;
          throw err;
        });
        const ids = new Set(p?.characters.map((c) => c.id));
        const keep = entries.filter(([sid, id]) => SESSION_ID.test(sid) && typeof id === "string" && ids.has(id));
        if (!p || !keep.length) return data();
        return update((s) => {
          s.assigned[p.id] = { ...s.assigned[p.id], ...Object.fromEntries(keep) };
        });
      }),

    override: (sessionId, ref) =>
      serial(async () => {
        checkSession(sessionId);
        if (ref !== null) {
          if (!isObject(ref)) throw new StatusError(400, "character must be {pack, id}");
          const p = await findPack(ref.pack).catch(() => undefined);
          if (!p || !p.characters.some((c) => c.id === ref.id)) throw new StatusError(400, "no such character");
          return update((s) => {
            s.overrides[sessionId] = { pack: p.id, id: ref.id };
          });
        }
        return update((s) => {
          delete s.overrides[sessionId];
        });
      }),

    setActive: (pack) =>
      serial(async () => {
        const p = await findPack(pack).catch(() => undefined);
        if (!p) throw new StatusError(400, "no such pack");
        return update((s) => {
          s.activePack = p.id;
        });
      }),

    createPack: (name, from) =>
      serial(async () => {
        const n = newName(name);
        const source = from === undefined ? undefined : await findPack(from);
        await mkdir(packsDir, { recursive: true });
        await mustNotExist(n);
        const dir = join(packsDir, n);
        if (source && !source.builtIn) {
          // Copy the folder (pack.json and images), not following symlinks.
          await cp(join(packsDir, source.id), dir, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
        } else {
          await mkdir(dir);
          if (source) await writeEmojiList(n, source.characters.map((c) => c.id));
        }
        return data();
      }),

    renamePack: (pack, name) =>
      serial(async () => {
        const p = await customPack(pack);
        const n = newName(name);
        if (n === p.id) return data();
        await mustNotExist(n, p.id);
        // State first, then the folder; if the folder cannot move, put the state back.
        const before = await readState();
        const after = structuredClone(before);
        if (after.activePack === p.id) after.activePack = n;
        if (after.assigned[p.id]) {
          after.assigned[n] = after.assigned[p.id]!;
          delete after.assigned[p.id];
        }
        for (const ref of Object.values(after.overrides)) if (ref.pack === p.id) ref.pack = n;
        await writeState(after);
        try {
          await rename(join(packsDir, p.id), join(packsDir, n));
        } catch (err) {
          await writeState(before);
          throw err;
        }
        return data(after);
      }),

    deletePack: (pack) =>
      serial(async () => {
        const p = await customPack(pack);
        // A validated name directly under packs/, checked to be a real directory by findPack.
        await rm(join(packsDir, p.id), { recursive: true, force: true });
        return update((s) => {
          if (s.activePack === p.id) s.activePack = DEFAULT_PACK;
          delete s.assigned[p.id];
          forget(s, p.id, () => true);
        });
      }),

    addEmoji: (pack, emoji) =>
      serial(async () => {
        const p = await customPack(pack);
        if (!validEmoji(emoji)) throw new StatusError(400, "not a single emoji");
        const list = await readEmojiList(join(packsDir, p.id));
        if (list.error) throw new StatusError(409, `cannot edit this pack: ${list.error}`);
        if (list.emoji.includes(emoji)) return data();
        if (p.characters.length >= MAX_PACK_CHARACTERS) throw new StatusError(400, `a pack holds at most ${MAX_PACK_CHARACTERS} characters`);
        await writeEmojiList(p.id, [...list.emoji, emoji]);
        return data();
      }),

    addImage: (pack, name, dataURL) =>
      serial(async () => {
        const p = await customPack(pack);
        const m = typeof dataURL === "string" ? /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]*)$/.exec(dataURL) : null;
        if (!m) throw new StatusError(400, "image must be a base64 data: URL");
        const mimeType = m[1]!;
        if (!Object.hasOwn(EXT_BY_MIME, mimeType)) throw new StatusError(400, "images must be png, gif, webp, jpeg or svg");
        if (m[2]!.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) throw new StatusError(400, "image too large (max 1 MB)");
        const bytes = Buffer.from(m[2]!, "base64");
        if (bytes.length > MAX_IMAGE_BYTES) throw new StatusError(400, "image too large (max 1 MB)");
        if (!sniffImage(bytes, mimeType)) throw new StatusError(400, `not a ${mimeType} image`);
        if (p.characters.length >= MAX_PACK_CHARACTERS) throw new StatusError(400, `a pack holds at most ${MAX_PACK_CHARACTERS} characters`);
        const base = uploadName(name, mimeType);
        const ext = extname(base);
        const stem = base.slice(0, -ext.length);
        const taken = new Set(await readdir(join(packsDir, p.id)));
        let file = base;
        for (let i = 2; taken.has(file); i++) file = `${stem}-${i}${ext}`;
        await writeAtomic(join(packsDir, p.id, file), bytes);
        return data();
      }),

    removeCharacter: (pack, id) =>
      serial(async () => {
        const p = await customPack(pack);
        const c = p.characters.find((c) => c.id === id);
        if (!c) throw new StatusError(404, "no such character");
        if (c.kind === "emoji") {
          const list = await readEmojiList(join(packsDir, p.id));
          await writeEmojiList(p.id, list.emoji.filter((e) => e !== id));
        } else {
          // `id` is a name from the pack's own listing, so it is a plain file in its folder.
          await unlink(join(packsDir, p.id, c.id));
        }
        return update((s) => forget(s, p.id, (x) => x === id));
      }),

    async readImage(pack, file) {
      if (typeof pack !== "string" || typeof file !== "string" || !(await isPackFolder(pack))) return undefined;
      // `file` passed listableName (no separators, not hidden), so it names an entry of this folder.
      const img = await checkImage(join(packsDir, pack), file, true);
      return img.ok ? { bytes: img.bytes!, mimeType: img.mimeType, hash: img.hash } : undefined;
    },
  };
}
