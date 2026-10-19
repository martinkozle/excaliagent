import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs, USAGE, type CliArgs } from "./args.ts";
import { createHub } from "./hub.ts";
import { createAppServer, type Middleware } from "./http.ts";
import { createHerdrLink, createNoPaneLink } from "./panes/herdr.ts";
import { createSceneStore, defaultStateDir } from "./scene-store.ts";
import { createClaudeSource } from "./sources/claude.ts";

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
  const token = randomBytes(24).toString("base64url");
  const source = createClaudeSource({ claudeDir: args.claudeDir });
  const panes = args.herdr ? createHerdrLink() : createNoPaneLink();
  const hub = createHub({ source, panes });
  await hub.start();
  const scenes = createSceneStore(args.stateDir ?? defaultStateDir());

  let middleware: Middleware | undefined;
  let closeVite = async () => {};
  const server = createAppServer({
    hub,
    scenes,
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

  await server.listen(args.port);
  const url = `http://127.0.0.1:${server.port}/?token=${token}`;
  console.log(`excaliagent ${args.dev ? "(dev) " : ""}listening on http://127.0.0.1:${server.port}`);
  console.log(`scene: ${scenes.path}`);
  console.log(`herdr: ${panes.available() ? "connected" : args.herdr ? "not running (will retry)" : "disabled"}`);
  console.log(`open: ${url}`);
  if (args.open) openBrowser(url);

  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    hub.stop();
    panes.close();
    await closeVite();
    await server.close();
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
