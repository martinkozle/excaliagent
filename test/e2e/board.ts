// Test harness: a seeded mock Claude home + a real excaliagent server process.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockClaude, type MockClaude } from "../mock-claude.ts";

const root = join(import.meta.dirname, "..", "..");

export interface Board {
  url: string;
  origin: string;
  mock: MockClaude;
  stateDir: string;
  restart(): Promise<void>;
  /** Cards from the saved scene.json: what the frontend persisted. */
  savedCards(): SavedCard[];
  stop(): void;
}

export interface SavedCard {
  sessionId: string;
  id: string;
  x: number;
  y: number;
  width: number;
  backgroundColor: string;
  strokeColor: string;
  strokeStyle: string;
  label: string;
}

async function startServer(claudeDir: string, stateDir: string): Promise<{ proc: ChildProcess; url: string }> {
  const proc = spawn(
    process.execPath,
    [join(root, "src/server/cli.ts"), "--no-open", "--no-herdr", "--claude-dir", claudeDir, "--state-dir", stateDir],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    proc.stdout!.on("data", (chunk) => {
      out += chunk;
      const m = out.match(/open: (\S+)/);
      if (m) resolve(m[1]!);
    });
    proc.on("exit", (code) => reject(new Error(`server exited early (${code}):\n${out}`)));
  });
  return { proc, url };
}

export async function startBoard(seed: (mock: MockClaude) => void): Promise<Board> {
  const mock = createMockClaude();
  seed(mock);
  const stateDir = mkdtempSync(join(tmpdir(), "excaliagent-e2e-state-"));
  let { proc, url } = await startServer(mock.dir, stateDir);

  const board: Board = {
    url,
    origin: new URL(url).origin,
    mock,
    stateDir,
    async restart() {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
      ({ proc, url } = await startServer(mock.dir, stateDir));
      board.url = url;
      board.origin = new URL(url).origin;
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
          backgroundColor: r.backgroundColor,
          strokeColor: r.strokeColor,
          strokeStyle: r.strokeStyle,
          label: els.find((t) => t.containerId === r.id)?.originalText ?? "",
        }));
    },
    stop() {
      proc.kill("SIGTERM");
      mock.teardown();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
  return board;
}
