import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, parseCliArgs, USAGE, type CliArgs } from "./args.ts";
import { createHub } from "./hub.ts";
import { createAppServer, type Middleware } from "./http.ts";
import { createDesktop } from "./desktop/desktop.ts";
import { createHerdrLink, createNoPaneLink } from "./panes/herdr.ts";
import { createSceneStore, defaultStateDir } from "./scene-store.ts";
import { createCharacterStore } from "./characters.ts";
import { createClaudeSource } from "./sources/claude.ts";
import { createCodexSource } from "./sources/codex.ts";
import { combineSources } from "./sources/multi.ts";
import { procRootFromEnv } from "./sources/proc.ts";
import { createOpenCodeSource } from "./sources/opencode.ts";
import { loadOrCreateToken } from "./token.ts";
import { clearRunning, findRunning, recordRunning } from "./instance.ts";

const here = dirname(fileURLToPath(import.meta.url));
// src/server or dist/server → package root
const root = join(here, "..", "..");

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // printing the URL is enough
  }
}

async function main(args: CliArgs) {
  const stateDir = args.stateDir ?? defaultStateDir();
  const token = await loadOrCreateToken(stateDir);
  // One board per state dir: a second server would overwrite the first one's saves.
  const running = await findRunning(stateDir, token);
  if (running !== undefined) {
    const url = `http://127.0.0.1:${running}/?token=${token}`;
    console.log(`excaliagent is already running for ${stateDir}`);
    console.log(`open: ${url}`);
    if (args.open) openBrowser(url);
    return;
  }

  // Tests and the demo point process scans at a synthetic tree (never documented as a flag).
  const procRoot = procRootFromEnv();
  const source = combineSources([
    createClaudeSource({ claudeDir: args.claudeDir }),
    ...(args.codex ? [createCodexSource({ codexDir: args.codexDir, ...(procRoot ? { procRoot } : {}) })] : []),
    ...(args.opencode ? [createOpenCodeSource({ ...(args.opencodeDir ? { dataDir: args.opencodeDir } : {}), ...(procRoot ? { procRoot } : {}) })] : []),
  ]);
  const desktop = args.herdr && args.raise ? createDesktop({ env: process.env }) : undefined;
  const panes = args.herdr ? createHerdrLink({ desktop }) : createNoPaneLink();
  const hub = createHub({ source, panes });
  await hub.start();
  const scenes = createSceneStore(stateDir);

  let middleware: Middleware | undefined;
  let closeVite = async () => {};
  const server = createAppServer({
    hub,
    scenes,
    characters: createCharacterStore(stateDir),
    token,
    webRoot: join(root, "dist", "web"),
    get middleware() {
      return middleware;
    },
  });
  if (args.dev) {
    const { createServer } = await import("vite");
    const vite = await createServer({
      configFile: join(root, "vite.config.ts"),
      server: { middlewareMode: true, hmr: { server: server.server } },
      appType: "spa",
    });
    middleware = vite.middlewares;
    closeVite = () => vite.close();
  }

  if (args.port !== undefined) await server.listen(args.port);
  else {
    try {
      await server.listen(DEFAULT_PORT);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      console.log(`port ${DEFAULT_PORT} is busy (another excaliagent?); using a random port`);
      await server.listen(0);
    }
  }
  const url = `http://127.0.0.1:${server.port}/?token=${token}`;
  console.log(`excaliagent ${args.dev ? "(dev) " : ""}listening on http://127.0.0.1:${server.port}`);
  console.log(`scene: ${scenes.path}`);
  console.log(`sources: ${["claude", ...(args.codex ? ["codex"] : []), ...(args.opencode ? ["opencode"] : [])].join(", ")}`);
  if (procRoot) console.log(`processes: ${procRoot} (EXCALIAGENT_PROC_ROOT)`);
  console.log(`herdr: ${panes.available() ? "connected" : args.herdr ? "not running (will retry)" : "disabled"}`);
  if (args.herdr) console.log(`raise window on focus: ${!desktop ? "off (--no-raise)" : desktop.kind === "none" ? "unsupported here" : desktop.kind}`);
  console.log(`open: ${url}`);
  await recordRunning(stateDir, server.port);
  if (args.open) openBrowser(url);

  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    hub.stop();
    panes.close();
    await closeVite();
    await server.close();
    await clearRunning(stateDir).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

let args: CliArgs;
try {
  args = parseCliArgs(process.argv.slice(2));
} catch (err) {
  console.error(`excaliagent: ${(err as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
} else if (args.version) {
  console.log(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
} else {
  main(args).catch((err: unknown) => {
    console.error("excaliagent:", err);
    process.exit(1);
  });
}
