// Test harness: seeded mock Claude and Codex homes + a real excaliagent server process.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockClaude, type MockClaude } from "../mock-claude.ts";
import { createMockCodex, type MockCodex } from "../mock-codex.ts";
import { createMockProc, type MockProc } from "../mock-proc.ts";

const root = join(import.meta.dirname, "..", "..");

export interface Board {
  url: string;
  origin: string;
  mock: MockClaude;
  /** Always a throwaway Codex home (empty unless `codexSeed`): never ~/.codex. */
  codex: MockCodex;
  /** The synthetic /proc the server reads instead of the real one. */
  procs: MockProc;
  stateDir: string;
  restart(): Promise<void>;
  /** Cards from the saved scene.json: what the frontend persisted. */
  savedCards(): SavedCard[];
  /** Non-deleted elements of the saved scene.json ([] if none yet). */
  savedElements(): Record<string, any>[];
  stop(): void;
}

export interface SavedCard {
  sessionId: string;
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** customData.excaliagent.appHeight: the height the app last set. */
  appHeight?: number;
  backgroundColor: string;
  strokeColor: string;
  strokeStyle: string;
  label: string;
  /** The card rect's link (last PR url) or null. */
  link: string | null;
}

export interface BoardOptions {
  /** Link panes through this (isolated!) herdr socket. Default: herdr disabled. */
  herdrSocket?: string;
  /** Pre-existing scene.json contents (an existing board). */
  scene?: { elements: unknown[]; appState?: Record<string, unknown> };
  /** Seed the mock Codex home. */
  codexSeed?: (codex: MockCodex) => void;
}

async function startServer(
  claudeDir: string,
  codexDir: string,
  procRoot: string,
  stateDir: string,
  opts: BoardOptions,
): Promise<{ proc: ChildProcess; url: string }> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(HERDR|OPENCODE|CODEX)_/.test(k)) env[k] = v;
  // Process scans read a synthetic tree, never the developer's real processes.
  env.EXCALIAGENT_PROC_ROOT = procRoot;
  if (opts.herdrSocket) env.HERDR_SOCKET_PATH = opts.herdrSocket;
  const proc = spawn(
    process.execPath,
    [
      join(root, "src/server/cli.ts"),
      "--no-open",
      "--no-raise", // never raise windows on the developer's desktop
      "--port",
      "0", // never the default port: parallel workers, or the developer's own board
      ...(opts.herdrSocket ? [] : ["--no-herdr"]),
      "--claude-dir",
      claudeDir,
      "--codex-dir",
      codexDir,
      "--state-dir",
      stateDir,
    ],
    { stdio: ["ignore", "pipe", "inherit"], env },
  );
  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    proc.stdout!.on("data", (chunk) => {
      out += chunk;
      const m = out.match(/open: (\S+)/);
      if (!m) return;
      // Guard: the server must have taken the synthetic proc root.
      if (!out.includes(`processes: ${procRoot} (EXCALIAGENT_PROC_ROOT)`)) {
        proc.kill("SIGTERM");
        reject(new Error(`server did not take the synthetic proc root:\n${out}`));
      }
      resolve(m[1]!);
    });
    proc.on("exit", (code) => reject(new Error(`server exited early (${code}):\n${out}`)));
  });
  return { proc, url };
}

export async function startBoard(seed: (mock: MockClaude) => void, opts: BoardOptions = {}): Promise<Board> {
  const mock = createMockClaude();
  seed(mock);
  const procs = createMockProc(mkdtempSync(join(tmpdir(), "excaliagent-e2e-proc-")));
  const codex = createMockCodex(procs);
  opts.codexSeed?.(codex);
  const stateDir = mkdtempSync(join(tmpdir(), "excaliagent-e2e-state-"));
  if (opts.scene) writeFileSync(join(stateDir, "scene.json"), JSON.stringify({ appState: {}, ...opts.scene }));
  let { proc, url } = await startServer(mock.dir, codex.dir, procs.root, stateDir, opts);

  const board: Board = {
    url,
    origin: new URL(url).origin,
    mock,
    codex,
    procs,
    stateDir,
    async restart() {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
      ({ proc, url } = await startServer(mock.dir, codex.dir, procs.root, stateDir, opts));
      board.url = url;
      board.origin = new URL(url).origin;
    },
    savedElements() {
      try {
        const scene = JSON.parse(readFileSync(join(stateDir, "scene.json"), "utf8")) as { elements: Record<string, any>[] };
        return scene.elements.filter((e) => !e.isDeleted);
      } catch {
        return [];
      }
    },
    savedCards() {
      let scene: { elements: Record<string, any>[] };
      try {
        scene = JSON.parse(readFileSync(join(stateDir, "scene.json"), "utf8"));
      } catch {
        return [];
      }
      const els = scene.elements.filter((e) => !e.isDeleted);
      return els
        .filter((e) => e.type === "rectangle" && e.customData?.excaliagent?.kind === "card")
        .map((r) => ({
          sessionId: r.customData.excaliagent.sessionId,
          id: r.id,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          appHeight: r.customData.excaliagent.appHeight,
          backgroundColor: r.backgroundColor,
          strokeColor: r.strokeColor,
          strokeStyle: r.strokeStyle,
          link: r.link ?? null,
          // Title + details texts (free texts in the card's group, customData.cardId = rect id).
          label: ["card-title", "card-details"]
            .map(
              (kind) =>
                els.find((t) => t.customData?.excaliagent?.kind === kind && t.customData.excaliagent.cardId === r.id)
                  ?.originalText ?? "",
            )
            .filter(Boolean)
            .join("\n"),
        }));
    },
    stop() {
      proc.kill("SIGTERM");
      mock.teardown();
      codex.teardown();
      rmSync(procs.root, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
  return board;
}
