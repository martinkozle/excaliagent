/**
 * Records herdr event and error envelopes from a THROWAWAY herdr server (see
 * isolated-herdr.ts), so mutating calls never reach a real session.
 * Run: node src/server/panes/__fixtures__/record-isolated.ts
 * Writes herdr-<version>/isolated.{events,exchanges}.json and schema.json.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { startIsolatedHerdr } from "./isolated-herdr.ts";

const versionOut = execFileSync("herdr", ["--version"], { encoding: "utf8" }).trim();
const version = /(\d+\.\d+\.\d+)/.exec(versionOut)?.[1] ?? "unknown";
const outDir = join(import.meta.dirname, `herdr-${version}`);
mkdirSync(outDir, { recursive: true });

// Published protocol only (no session data): method names, subscription
// types, event kinds, required response fields.
const schema = JSON.parse(execFileSync("herdr", ["api", "schema", "--json"], { encoding: "utf8", maxBuffer: 1 << 24 }));
const defs = schema.schemas.success_response.$defs;
writeFileSync(
  join(outDir, "schema.json"),
  JSON.stringify(
    {
      herdr: versionOut,
      protocol: schema.protocol,
      methods: schema.schemas.request.oneOf.map((o: any) => o.properties.method.const),
      subscriptionTypes: schema.schemas.request.$defs.Subscription.oneOf.map((o: any) => o.properties.type.const),
      eventKinds: schema.schemas.event.$defs.EventKind.enum,
      required: {
        PaneInfo: defs.PaneInfo.required,
        PaneProcessInfo: defs.PaneProcessInfo.required,
        PaneProcessInfoProcess: defs.PaneProcessInfoProcess.required,
      },
    },
    null,
    2,
  ) + "\n",
);

const herdr = await startIsolatedHerdr();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function conn(onLine: (l: string) => void): net.Socket {
  const s = net.createConnection(herdr.socketPath);
  let b = "";
  s.setEncoding("utf8");
  s.on("error", () => {});
  s.on("data", (c: string) => {
    b += c;
    let i: number;
    while ((i = b.indexOf("\n")) >= 0) {
      onLine(b.slice(0, i));
      b = b.slice(i + 1);
    }
  });
  return s;
}
let n = 0;
const exchanges: { request: string; response: string }[] = [];
function call(method: string, params: object): Promise<any> {
  const request = JSON.stringify({ id: `iso-${++n}`, method, params });
  return new Promise((resolve) => {
    const s = conn((line) => {
      s.destroy();
      exchanges.push({ request, response: line });
      resolve(JSON.parse(line));
    });
    s.write(request + "\n");
  });
}

const subLines: string[] = [];
const sub = conn((l) => subLines.push(l));
const subscriptions = ["pane.created", "pane.closed", "pane.exited", "pane.agent_detected"].map((type) => ({ type }));
sub.write(JSON.stringify({ id: "iso-sub", method: "events.subscribe", params: { subscriptions } }) + "\n");
await sleep(300);

try {
  await call("workspace.create", { cwd: "/tmp", focus: false });
  await sleep(300);
  const split = await call("pane.split", { target_pane_id: "w1:p1", direction: "right", focus: false });
  const p2: string = split.result.pane.pane_id;
  await sleep(300);
  await call("pane.focus", { pane_id: p2 });
  await call("pane.send_text", { pane_id: p2, text: "exit\n" });
  await sleep(1500);
  await call("pane.close", { pane_id: "w1:p1" });
  await sleep(500);
  await call("pane.process_info", { pane_id: "w99:p99" }); // error: pane_not_found
  await call("pane.process_info", { nope: 1, pane_id: 5 }); // malformed: error with id ""
} finally {
  sub.destroy();
  await herdr.stop();
}

writeFileSync(join(outDir, "isolated.events.json"), JSON.stringify({ lines: subLines }, null, 2) + "\n");
writeFileSync(join(outDir, "isolated.exchanges.json"), JSON.stringify(exchanges, null, 2) + "\n");
console.log(`isolated herdr ${version}: ${subLines.length} subscription lines, ${exchanges.length} exchanges -> ${outDir}`);
