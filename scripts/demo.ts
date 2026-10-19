// `npm run demo [-- --dev]`: start excaliagent against a synthetic Claude home
// with a seeded cast, simulate some activity, tear everything down on exit.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockClaude, seedDemo, type MockStatus } from "../test/mock-claude.ts";

const mock = createMockClaude();
seedDemo(mock);
const stateDir = mkdtempSync(join(tmpdir(), "excaliagent-demo-state-"));
const root = join(import.meta.dirname, "..");

const server = spawn(
  process.execPath,
  [join(root, "src/server/cli.ts"), "--claude-dir", mock.dir, "--state-dir", stateDir, "--no-herdr", ...process.argv.slice(2)],
  { stdio: "inherit" },
);

// Cycle the first session through states so colors visibly change.
const cycle: [MockStatus, string?][] = [["busy"], ["needs_user", "input needed"], ["idle"], ["blocked", "sandbox request"]];
let i = 0;
const timer = setInterval(() => {
  const [status, waitingFor] = cycle[i++ % cycle.length]!;
  mock.setStatus("11111111-0000-4000-8000-000000000001", status, waitingFor);
  if (status === "idle") mock.turn("11111111-0000-4000-8000-000000000001");
}, 8000);

let done = false;
const cleanup = () => {
  if (done) return;
  done = true;
  clearInterval(timer);
  server.kill("SIGTERM");
  mock.teardown();
  rmSync(stateDir, { recursive: true, force: true });
};
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
server.on("exit", (code) => { cleanup(); process.exit(code ?? 0); });
