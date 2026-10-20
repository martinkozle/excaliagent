// `npm run demo [-- --dev]`: start excaliagent against synthetic Claude, Codex and OpenCode homes
// with a seeded cast, simulate some activity, tear everything down on exit.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockClaude, seedDemo, type MockStatus } from "../test/mock-claude.ts";
import { createMockCodex, seedCodexDemo } from "../test/mock-codex.ts";
import { createMockProc } from "../test/mock-proc.ts";
import { createMockOpenCode, seedOpenCodeDemo } from "../test/mock-opencode.ts";

const mock = createMockClaude();
seedDemo(mock);
// Process scans read a synthetic /proc, never this machine's processes.
const procs = createMockProc(mkdtempSync(join(tmpdir(), "excaliagent-demo-proc-")));
const codex = createMockCodex(procs);
seedCodexDemo(codex);
const opencode = createMockOpenCode(procs);
seedOpenCodeDemo(opencode);
const stateDir = mkdtempSync(join(tmpdir(), "excaliagent-demo-state-"));
const root = join(import.meta.dirname, "..");

const server = spawn(
  process.execPath,
  [join(root, "src/server/cli.ts"), "--claude-dir", mock.dir, "--codex-dir", codex.dir, "--opencode-dir", opencode.dir, "--state-dir", stateDir, "--no-herdr", ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, EXCALIAGENT_PROC_ROOT: procs.root } },
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
  codex.teardown();
  opencode.teardown();
  rmSync(procs.root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
};
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
server.on("exit", (code) => { cleanup(); process.exit(code ?? 0); });
