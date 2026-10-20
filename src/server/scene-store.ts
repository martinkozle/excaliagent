import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Scene {
  elements: unknown[];
  appState: Record<string, unknown>;
  [key: string]: unknown;
}

/** An image's data (Excalidraw BinaryFileData), kept apart from the scene's elements. */
export interface StoredFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
}

export interface SceneStore {
  readonly path: string;
  load(): Promise<Scene>;
  save(scene: Scene): Promise<void>;
  /** Writes files not stored yet (Excalidraw file ids are content hashes). Throws on an invalid file. */
  saveFiles(files: StoredFile[]): Promise<void>;
  /** The stored files among `ids`, in that order; unknown or invalid ids are skipped. */
  loadFiles(ids: string[]): Promise<StoredFile[]>;
}

/** Excalidraw file ids: hex hashes or nanoids. Also keeps paths inside files/. */
export const FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/;

/** A clean StoredFile, or an Error naming the bad field. */
export function validFile(f: unknown): StoredFile | Error {
  const x = f as Partial<StoredFile> | null;
  if (typeof x?.id !== "string" || !FILE_ID.test(x.id)) return new Error("file id must match " + FILE_ID);
  if (typeof x.mimeType !== "string" || !IMAGE_MIME.test(x.mimeType)) return new Error("file mimeType must be image/*");
  if (typeof x.dataURL !== "string" || !x.dataURL.startsWith(`data:${x.mimeType}`)) {
    return new Error("file dataURL must be a data: URL of its mimeType");
  }
  return { id: x.id, mimeType: x.mimeType, dataURL: x.dataURL, created: typeof x.created === "number" ? x.created : 0 };
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const base = env.XDG_STATE_HOME || join(home, ".local", "state");
  return join(base, "excaliagent");
}

const empty = (): Scene => ({ elements: [], appState: {} });

/**
 * scene.json in stateDir, written atomically (temp file + fsync + rename), saves
 * serialized. Image files live apart, one files/<id>.json each, written once.
 */
export function createSceneStore(stateDir: string, log: { warn(msg: string): void } = console): SceneStore {
  const path = join(stateDir, "scene.json");
  let queue: Promise<void> = Promise.resolve();
  let seq = 0;
  const filesDir = join(stateDir, "files");

  async function writeAtomic(target: string, data: unknown): Promise<void> {
    const tmp = `${target}.tmp-${process.pid}-${seq++}`;
    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(JSON.stringify(data));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, target);
  }

  async function write(scene: Scene): Promise<void> {
    await mkdir(stateDir, { recursive: true });
    await writeAtomic(path, scene);
  }

  return {
    path,
    async load() {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty();
        throw err;
      }
      try {
        const scene = JSON.parse(raw) as Scene;
        if (!Array.isArray(scene.elements)) throw new Error("no elements array");
        return { ...scene, appState: scene.appState ?? {} };
      } catch (err) {
        const aside = `${path}.corrupt-${Date.now()}`;
        await rename(path, aside).catch(() => {});
        log.warn(`excaliagent: ${path} was unreadable (${(err as Error).message}); moved to ${aside}`);
        return empty();
      }
    },
    save(scene) {
      if (!scene || !Array.isArray(scene.elements)) {
        return Promise.reject(new Error("scene must have an elements array"));
      }
      const run = queue.then(() => write(scene));
      queue = run.catch(() => {});
      return run;
    },
    async saveFiles(files) {
      const valid = files.map(validFile);
      const bad = valid.find((f) => f instanceof Error);
      if (bad) throw bad;
      await mkdir(filesDir, { recursive: true });
      for (const f of valid as StoredFile[]) {
        const target = join(filesDir, `${f.id}.json`);
        if (await stat(target).catch(() => undefined)) continue;
        await writeAtomic(target, f);
      }
    },
    async loadFiles(ids) {
      const out: StoredFile[] = [];
      for (const id of ids) {
        if (!FILE_ID.test(id)) continue;
        try {
          const f = validFile(JSON.parse(await readFile(join(filesDir, `${id}.json`), "utf8")));
          if (!(f instanceof Error) && f.id === id) out.push(f);
        } catch {
          // missing or unreadable: the image shows as a placeholder
        }
      }
      return out;
    },
  };
}
