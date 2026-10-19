import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSceneStore, defaultStateDir } from "./scene-store.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "excaliagent-scene-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("defaultStateDir", () => {
  it("respects XDG_STATE_HOME", () => {
    expect(defaultStateDir({ XDG_STATE_HOME: "/x/state" }, "/home/u")).toBe("/x/state/excaliagent");
  });
  it("falls back to ~/.local/state", () => {
    expect(defaultStateDir({}, "/home/u")).toBe("/home/u/.local/state/excaliagent");
  });
});

describe("scene store", () => {
  it("returns an empty scene when nothing is saved", async () => {
    const store = createSceneStore(join(dir, "nested", "state"));
    expect(await store.load()).toEqual({ elements: [], appState: {} });
  });

  it("round-trips a saved scene", async () => {
    const store = createSceneStore(dir);
    const scene = { elements: [{ id: "a", type: "rectangle" }], appState: { viewBackgroundColor: "#fff" } };
    await store.save(scene);
    expect(await store.load()).toEqual(scene);
    expect(JSON.parse(await readFile(join(dir, "scene.json"), "utf8"))).toEqual(scene);
  });

  it("leaves no temp files behind", async () => {
    const store = createSceneStore(dir);
    await store.save({ elements: [], appState: {} });
    await store.save({ elements: [{ id: "b" }], appState: {} });
    expect((await readdir(dir)).sort()).toEqual(["scene.json"]);
  });

  it("serializes concurrent saves so the last one wins", async () => {
    const store = createSceneStore(dir);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.save({ elements: [{ id: String(i) }], appState: {} })),
    );
    expect((await store.load()).elements).toEqual([{ id: "19" }]);
  });

  it("keeps a corrupt file aside and starts empty instead of crashing", async () => {
    await writeFile(join(dir, "scene.json"), "{not json");
    const store = createSceneStore(dir, { warn: () => {} });
    expect(await store.load()).toEqual({ elements: [], appState: {} });
    const files = await readdir(dir);
    expect(files.some((f) => f.startsWith("scene.json.corrupt-"))).toBe(true);
  });

  it("rejects scenes without an elements array", async () => {
    const store = createSceneStore(dir);
    await expect(store.save({ nope: true } as never)).rejects.toThrow(/elements/);
  });
});
