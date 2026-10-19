import { mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Scene {
  elements: unknown[];
  appState: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SceneStore {
  readonly path: string;
  load(): Promise<Scene>;
  save(scene: Scene): Promise<void>;
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const base = env.XDG_STATE_HOME || join(home, ".local", "state");
  return join(base, "excaliagent");
}

const empty = (): Scene => ({ elements: [], appState: {} });

/** scene.json in stateDir, written atomically (temp file + fsync + rename), saves serialized. */
export function createSceneStore(stateDir: string, log: { warn(msg: string): void } = console): SceneStore {
  const path = join(stateDir, "scene.json");
  let queue: Promise<void> = Promise.resolve();
  let seq = 0;

  async function write(scene: Scene): Promise<void> {
    await mkdir(stateDir, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${seq++}`;
    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(JSON.stringify(scene));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
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
  };
}
