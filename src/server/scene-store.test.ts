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

describe("image files", () => {
  const png = (id: string) => ({ id, mimeType: "image/png", dataURL: `data:image/png;base64,${btoa(id)}`, created: 5 });

  it("stores each file once under files/ and loads them by id, skipping unknown ids", async () => {
    const store = createSceneStore(dir);
    await store.saveFiles([png("a1"), png("b2")]);
    await store.saveFiles([png("a1")]); // already there: no rewrite
    expect((await readdir(join(dir, "files"))).sort()).toEqual(["a1.json", "b2.json"]);
    expect(await store.loadFiles(["b2", "zz", "a1"])).toEqual([png("b2"), png("a1")]);
    expect(await store.loadFiles([])).toEqual([]);
  });

  it("rejects ids that could escape the folder and data that is not an image", async () => {
    const store = createSceneStore(dir);
    await expect(store.saveFiles([png("../x")])).rejects.toThrow(/id/);
    await expect(store.saveFiles([{ ...png("c3"), mimeType: "text/html" }])).rejects.toThrow(/mimeType/);
    await expect(store.saveFiles([{ ...png("c3"), dataURL: "javascript:alert(1)" }])).rejects.toThrow(/dataURL/);
    await expect(store.saveFiles([{ ...png("c3"), dataURL: "data:text/html;base64,PGh0bWw+" }])).rejects.toThrow(/dataURL/);
    expect(await store.loadFiles(["../scene", "c3"])).toEqual([]);
  });
});
