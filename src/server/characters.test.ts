import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emojiFileId } from "../shared/packs.ts";
import { createCharacterStore, MAX_IMAGE_BYTES, type CharacterStore } from "./characters.ts";

const A = "11111111-0000-4000-8000-000000000001";
const B = "11111111-0000-4000-8000-000000000002";
/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const pngURL = `data:image/png;base64,${PNG.toString("base64")}`;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>`;

let dir: string;
let store: CharacterStore;
const warnings: string[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "excaliagent-chars-"));
  warnings.length = 0;
  store = createCharacterStore(dir, { warn: (m) => warnings.push(m) });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const pack = (data: Awaited<ReturnType<CharacterStore["load"]>>, id: string) => data.packs.find((p) => p.id === id);
const status = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);

describe("state", () => {
  it("starts with the built-in packs, Animals active, nothing remembered", async () => {
    const d = await store.load();
    expect(d.activePack).toBe("@animals");
    expect(d.assigned).toEqual({});
    expect(d.overrides).toEqual({});
    expect(d.packs.map((p) => p.id)).toEqual(["@animals", "@cats", "@sea", "@fantasy", "@food"]);
  });

  it("remembers assignments per pack and overrides per session, in characters.json", async () => {
    await store.assign("@animals", { [A]: "🐱" });
    await store.assign("@sea", { [A]: "🐙" });
    await store.override(A, { pack: "@food", id: "🍕" });
    await store.setActive("@sea");
    const onDisk = JSON.parse(await readFile(join(dir, "characters.json"), "utf8"));
    expect(onDisk).toEqual({
      version: 1,
      activePack: "@sea",
      assigned: { "@animals": { [A]: "🐱" }, "@sea": { [A]: "🐙" } },
      overrides: { [A]: { pack: "@food", id: "🍕" } },
    });
    const fresh = await createCharacterStore(dir).load();
    expect(fresh.overrides[A]).toEqual({ pack: "@food", id: "🍕" });
    await store.override(A, null);
    expect((await store.load()).overrides).toEqual({});
  });

  it("refuses bad pack names, characters and session ids (assign drops bad picks instead)", async () => {
    expect(await status(store.assign("@nope", { [A]: "🐱" }))).toBe(400);
    expect(await status(store.assign("@animals", { [A]: "🍕" }))).toBe(0);
    expect(await status(store.assign("@animals", { "../x": "🐱" }))).toBe(0);
    expect(await status(store.assign("@animals", { __proto__: "🐱" } as never))).toBe(0); // no own keys: no-op
    expect(await status(store.override("not-a-session", { pack: "@animals", id: "🐱" }))).toBe(400);
    expect(await status(store.override(A, { pack: "@animals", id: "🍕" }))).toBe(400);
    expect(await status(store.setActive("../../etc"))).toBe(400);
    expect(await status(store.setActive("missing"))).toBe(400);
  });

  it("a corrupt characters.json is moved aside and the board starts afresh", async () => {
    await writeFile(join(dir, "characters.json"), "{not json");
    const d = await store.load();
    expect(d.activePack).toBe("@animals");
    expect((await readdir(dir)).some((f) => f.startsWith("characters.json.corrupt-"))).toBe(true);
    expect(warnings.join()).toContain("unreadable");
  });

  it("drops malformed entries of a hand-edited file and falls back to Animals for a missing active pack", async () => {
    await writeFile(
      join(dir, "characters.json"),
      JSON.stringify({ activePack: "gone", assigned: { "@animals": { [A]: "🐱", [B]: 5 }, x: 3 }, overrides: { [A]: "🐱", [B]: { pack: "@sea", id: "🐙" } } }),
    );
    const d = await store.load();
    expect(d.activePack).toBe("@animals");
    expect(d.assigned).toEqual({ "@animals": { [A]: "🐱" } });
    expect(d.overrides).toEqual({ [B]: { pack: "@sea", id: "🐙" } });
  });
});

describe("custom packs", () => {
  it("are created, filled with emoji and images, listed in order, and removed from", async () => {
    await store.createPack("mobs");
    await store.addEmoji("mobs", "🧟");
    await store.addEmoji("mobs", "🧟"); // duplicate: ignored
    let d = await store.addImage("mobs", "Creeper Face!.png", pngURL);
    await store.addImage("mobs", "creeper.png", pngURL);
    await store.addImage("mobs", "ghost", `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`);
    d = await store.load();
    const p = pack(d, "mobs")!;
    expect(p).toMatchObject({ name: "mobs", builtIn: false });
    expect(p.characters.map((c) => c.id)).toEqual(["🧟", "Creeper-Face.png", "creeper.png", "ghost.svg"]);
    expect(p.characters[0]).toEqual({ id: "🧟", kind: "emoji", fileId: emojiFileId("🧟") });
    const img = p.characters[1]!;
    expect(img.kind).toBe("image");
    expect(img.fileId).toMatch(/^excaliagent-img-[0-9a-f]{24}$/);
    expect(img.url).toMatch(/^\/api\/packs\/mobs\/Creeper-Face.png\?v=[0-9a-f]{24}$/);
    expect(p.characters[2]!.fileId).toBe(img.fileId); // same bytes, same file id
    expect(await store.readImage("mobs", "creeper.png")).toMatchObject({ bytes: PNG, mimeType: "image/png" });

    await store.removeCharacter("mobs", "🧟");
    await store.removeCharacter("mobs", "creeper.png");
    d = await store.load();
    expect(pack(d, "mobs")!.characters.map((c) => c.id)).toEqual(["Creeper-Face.png", "ghost.svg"]);
    expect(await readdir(join(dir, "packs", "mobs"))).not.toContain("creeper.png");
  });

  it("uploads with a taken name get a numbered one", async () => {
    await store.createPack("p");
    await store.addImage("p", "a.png", pngURL);
    await store.addImage("p", "a.png", pngURL);
    expect(pack(await store.load(), "p")!.characters.map((c) => c.id)).toEqual(["a-2.png", "a.png"]);
  });

  it("can be duplicated from a built-in pack, renamed and deleted; state follows", async () => {
    await store.createPack("my-animals", "@animals");
    const p = pack(await store.load(), "my-animals")!;
    expect(p.characters.map((c) => c.id)).toEqual(pack(await store.load(), "@animals")!.characters.map((c) => c.id));
    await store.assign("my-animals", { [A]: "🐱" });
    await store.override(B, { pack: "my-animals", id: "🐶" });
    await store.setActive("my-animals");

    let d = await store.renamePack("my-animals", "zoo");
    expect(d.activePack).toBe("zoo");
    expect(d.assigned).toEqual({ zoo: { [A]: "🐱" } });
    expect(d.overrides).toEqual({ [B]: { pack: "zoo", id: "🐶" } });
    expect(pack(d, "my-animals")).toBeUndefined();

    d = await store.deletePack("zoo");
    expect(d.activePack).toBe("@animals");
    expect(d.assigned).toEqual({});
    expect(d.overrides).toEqual({});
    expect(await readdir(join(dir, "packs"))).toEqual([]);
  });

  it("duplicating a custom pack copies its images", async () => {
    await store.createPack("a");
    await store.addImage("a", "x.png", pngURL);
    await store.createPack("b", "a");
    expect(pack(await store.load(), "b")!.characters.map((c) => c.id)).toEqual(["x.png"]);
  });

  it("removing a character forgets assignments and overrides pointing at it", async () => {
    await store.createPack("p");
    await store.addEmoji("p", "🧟");
    await store.addEmoji("p", "👻");
    await store.assign("p", { [A]: "🧟", [B]: "👻" });
    await store.override(B, { pack: "p", id: "🧟" });
    const d = await store.removeCharacter("p", "🧟");
    expect(d.assigned).toEqual({ p: { [B]: "👻" } });
    expect(d.overrides).toEqual({});
  });

  it("built-in packs are read-only", async () => {
    for (const op of [
      store.addEmoji("@animals", "🧟"),
      store.addImage("@animals", "x.png", pngURL),
      store.removeCharacter("@animals", "🐱"),
      store.renamePack("@animals", "x"),
      store.deletePack("@animals"),
    ])
      expect(await status(op)).toBe(403);
  });
});

describe("validation", () => {
  it.each(["", "..", "../x", "a/b", "a\\b", ".hidden", "@animals", "a b", "x".repeat(41), "a\0b", "%2e%2e"])(
    "refuses the pack name %j",
    async (name) => {
      expect(await status(store.createPack(name))).toBe(400);
    },
  );

  it("refuses to create a pack that exists, or to rename onto one", async () => {
    await store.createPack("a");
    await store.createPack("b");
    expect(await status(store.createPack("a"))).toBe(409);
    expect(await status(store.renamePack("a", "b"))).toBe(409);
    expect(await status(store.renamePack("missing", "c"))).toBe(404);
    expect(await status(store.deletePack("missing"))).toBe(404);
  });

  it("refuses traversal through every pack and file argument", async () => {
    await mkdir(join(dir, "secret"), { recursive: true });
    await writeFile(join(dir, "secret", "x.png"), PNG);
    await store.createPack("p");
    for (const name of ["..", "../secret", "p/../../secret", "/etc"]) {
      expect(await status(store.addEmoji(name, "🧟"))).toBe(400);
      expect(await status(store.deletePack(name))).toBe(400);
      expect(await store.readImage(name, "x.png")).toBeUndefined();
    }
    for (const file of ["../secret/x.png", "../../secret/x.png", "..", "/etc/passwd", "x.png/.."]) {
      expect(await store.readImage("p", file)).toBeUndefined();
      expect(await status(store.removeCharacter("p", file))).toBe(404);
    }
    expect(await readdir(join(dir, "secret"))).toEqual(["x.png"]);
  });

  it("refuses bad emoji", async () => {
    await store.createPack("p");
    for (const e of ["", "abc", "🐱🐶", "<svg>", 5]) expect(await status(store.addEmoji("p", e as string))).toBe(400);
  });

  it("allows only png, gif, webp, jpeg and svg images whose bytes match their type, up to the size limit", async () => {
    await store.createPack("p");
    const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
    const bad = [
      `data:text/html;base64,${b64("<script>alert(1)</script>")}`,
      `data:image/x-icon;base64,${b64("xx")}`,
      `data:image/png;base64,${b64("not a png")}`,
      `data:image/svg+xml;base64,${b64("<html><script>1</script></html>")}`,
      `data:image/png,${PNG.toString("base64")}`, // not base64-marked
      "https://example.com/a.png",
      `data:image/png;base64,${Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]).toString("base64")}`,
    ];
    for (const url of bad) expect(await status(store.addImage("p", "x", url))).toBe(400);
    const ok = [
      ["g", `data:image/gif;base64,${b64("GIF89a....")}`, "g.gif"],
      ["w", `data:image/webp;base64,${b64("RIFF\0\0\0\0WEBPVP8 ")}`, "w.webp"],
      ["j", `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString("base64")}`, "j.jpg"],
      ["s", `data:image/svg+xml;base64,${b64(`<?xml version="1.0"?>\n${SVG}`)}`, "s.svg"],
    ];
    for (const [name, url] of ok) await store.addImage("p", name!, url!);
    expect(pack(await store.load(), "p")!.characters.map((c) => c.id)).toEqual(["g.gif", "j.jpg", "s.svg", "w.webp"]);
  });

  it("caps a pack's size", async () => {
    await store.createPack("p");
    const many = Array.from({ length: 200 }, (_, i) => String.fromCodePoint(0x1f400 + i));
    await writeFile(join(dir, "packs", "p", "pack.json"), JSON.stringify({ emoji: many }));
    expect(await status(store.addEmoji("p", "🍕"))).toBe(400);
  });
});

describe("hand-dropped folders", () => {
  it("are listed: pack.json emoji first, then images by name; other files and symlinks are ignored", async () => {
    const p = join(dir, "packs", "My_Pack");
    await mkdir(join(p, "sub"), { recursive: true });
    await writeFile(join(p, "pack.json"), JSON.stringify({ emoji: ["🧟", "nope", "🧟", "👻"] }));
    await writeFile(join(p, "b creeper.PNG"), PNG);
    await writeFile(join(p, "a.svg"), SVG);
    await writeFile(join(p, "notes.txt"), "hi");
    await writeFile(join(p, ".hidden.png"), PNG);
    await writeFile(join(p, "fake.png"), "not a png");
    await writeFile(join(dir, "outside.png"), PNG);
    await symlink(join(dir, "outside.png"), join(p, "link.png"));
    const d = await store.load();
    const mine = pack(d, "My_Pack")!;
    expect(mine.characters.map((c) => c.id)).toEqual(["🧟", "👻", "a.svg", "b creeper.PNG"]);
    expect(mine.characters[3]!.url).toMatch(/^\/api\/packs\/My_Pack\/b%20creeper.PNG\?v=/);
    expect(await store.readImage("My_Pack", "b creeper.PNG")).toMatchObject({ mimeType: "image/png" });
    expect(await store.readImage("My_Pack", "link.png")).toBeUndefined();
    expect(await store.readImage("My_Pack", "notes.txt")).toBeUndefined();
  });

  it("a broken pack degrades only itself", async () => {
    await mkdir(join(dir, "packs", "broken"), { recursive: true });
    await writeFile(join(dir, "packs", "broken", "pack.json"), "{oops");
    await writeFile(join(dir, "packs", "broken", "x.png"), PNG);
    await mkdir(join(dir, "packs", "bad name!"), { recursive: true });
    await writeFile(join(dir, "packs", "not-a-dir"), "x");
    await store.createPack("fine");
    await store.addEmoji("fine", "🧟");
    const d = await store.load();
    const broken = pack(d, "broken")!;
    expect(broken.error).toMatch(/pack\.json/);
    expect(broken.characters.map((c) => c.id)).toEqual(["x.png"]);
    expect(pack(d, "fine")!.characters).toHaveLength(1);
    expect(d.packs.map((p) => p.id)).not.toContain("bad name!");
    expect(d.packs.map((p) => p.id)).not.toContain("not-a-dir");
  });

  it("skips images over the size limit", async () => {
    const p = join(dir, "packs", "big");
    await mkdir(p, { recursive: true });
    await writeFile(join(p, "huge.png"), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
    const d = await store.load();
    expect(pack(d, "big")!.characters).toEqual([]);
    expect(pack(d, "big")!.error).toMatch(/huge\.png/);
  });
});

describe("review fixes", () => {
  it("assign keeps the good picks of a batch and drops unknown sessions, characters and packs", async () => {
    const d = await store.assign("@animals", { [A]: "🐱", [B]: "🍕", "not-a-session": "🐶" });
    expect(d.assigned).toEqual({ "@animals": { [A]: "🐱" } });
    expect((await store.assign("gone", { [A]: "🐱" })).assigned).toEqual({ "@animals": { [A]: "🐱" } });
    expect(await status(store.assign("../x", { [A]: "🐱" }))).toBe(400);
  });

  it("image urls carry the content hash; readImage checks just that file", async () => {
    await store.createPack("p");
    const d = await store.addImage("p", "a.png", pngURL);
    const c = pack(d, "p")!.characters[0]!;
    expect(c.url).toBe(`/api/packs/p/a.png?v=${c.fileId.slice("excaliagent-img-".length)}`);
    const img = await store.readImage("p", "a.png");
    expect(img).toMatchObject({ mimeType: "image/png", hash: c.fileId.slice("excaliagent-img-".length) });
    // Things a listing would skip are refused one by one too.
    await writeFile(join(dir, "packs", "p", "fake.png"), "not a png");
    await writeFile(join(dir, "packs", "p", ".hidden.png"), PNG);
    await writeFile(join(dir, "packs", "p", "big.png"), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
    await writeFile(join(dir, "outside.png"), PNG);
    await symlink(join(dir, "outside.png"), join(dir, "packs", "p", "link.png"));
    for (const f of ["fake.png", ".hidden.png", "big.png", "link.png", "pack.json"]) expect(await store.readImage("p", f), f).toBeUndefined();
  });

  it("a pack stops reading images at the cap", async () => {
    const p = join(dir, "packs", "many");
    await mkdir(p, { recursive: true });
    await writeFile(join(p, "pack.json"), JSON.stringify({ emoji: Array.from({ length: 199 }, (_, i) => String.fromCodePoint(0x1f400 + i)) }));
    for (const f of ["a.png", "b.png", "c.png"]) await writeFile(join(p, f), PNG);
    const many = pack(await store.load(), "many")!;
    expect(many.characters).toHaveLength(200);
    expect(many.characters.at(-1)!.id).toBe("a.png");
    expect(many.error).toMatch(/200/);
  });

  it("a symlinked pack folder is not a pack", async () => {
    await mkdir(join(dir, "elsewhere"), { recursive: true });
    await writeFile(join(dir, "elsewhere", "x.png"), PNG);
    await mkdir(join(dir, "packs"), { recursive: true });
    await symlink(join(dir, "elsewhere"), join(dir, "packs", "linked"));
    const d = await store.load();
    expect(pack(d, "linked")).toBeUndefined();
    expect(await store.readImage("linked", "x.png")).toBeUndefined();
    expect(await status(store.addEmoji("linked", "🧟"))).toBe(404);
    expect(await status(store.deletePack("linked"))).toBe(404);
    expect(await readdir(join(dir, "elsewhere"))).toEqual(["x.png"]);
  });

  it("pack names differing only in case are one pack: no alias, no twin; renaming the case works", async () => {
    await store.createPack("foo");
    expect(await status(store.addEmoji("FOO", "🧟"))).toBe(404);
    expect(await store.readImage("FOO", "x.png")).toBeUndefined();
    expect(await status(store.createPack("Foo"))).toBe(409);
    const d = await store.renamePack("foo", "Foo");
    expect(d.packs.map((p) => p.id)).toContain("Foo");
    expect(d.packs.map((p) => p.id)).not.toContain("foo");
  });

  it("lists folders with invalid names as problems", async () => {
    await mkdir(join(dir, "packs", "bad name!"), { recursive: true });
    await mkdir(join(dir, "packs", ".git"), { recursive: true });
    const d = await store.load();
    expect(d.problems).toEqual([expect.stringContaining("bad name!")]);
  });

  it("a failed write leaves no temp file behind", async () => {
    await store.createPack("p");
    // A directory where pack.json should go makes the final rename fail.
    await mkdir(join(dir, "packs", "p", "pack.json"));
    expect(await status(store.addEmoji("p", "🧟"))).not.toBe(0);
    expect((await readdir(join(dir, "packs", "p"))).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("renaming does not leave characters.json and the folders disagreeing", async () => {
    await store.createPack("a");
    await store.addEmoji("a", "🧟");
    await store.assign("a", { [A]: "🧟" });
    await store.setActive("a");
    // Simulate failure: make packs/ read-only so rename() fails after the state write.
    const { chmod } = await import("node:fs/promises");
    await chmod(join(dir, "packs"), 0o500);
    try {
      expect(await status(store.renamePack("a", "b"))).not.toBe(0);
    } finally {
      await chmod(join(dir, "packs"), 0o700);
    }
    const d = await store.load();
    expect(d.activePack).toBe("a");
    expect(d.assigned).toEqual({ a: { [A]: "🧟" } });
    expect(pack(d, "a")!.characters).toHaveLength(1);
  });
});
