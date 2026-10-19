/**
 * A fake herdr server for tests: a Unix socket that behaves like herdr 0.9.0
 * (one request per connection; a subscription connection stays open and
 * receives events) and replays the fixtures in herdr-0.9.0/ by default:
 *
 *   schema.json        method names, subscription types, event kinds and required
 *                      response fields from `herdr api schema --json` (protocol 22).
 *   synthetic.*.json   hand-written fixtures following that schema; all paths,
 *                      pids and pane ids are made up.
 *   isolated.*.json    raw wire lines from a throwaway herdr server started by
 *                      record-isolated.ts (temp HOME + temp socket, cwd /tmp);
 *                      they pin the exact event and error envelopes.
 *
 * Never record from a real herdr session: this repo is public.
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

export const FIXTURE_DIR = join(import.meta.dirname, "herdr-0.9.0");

interface Exchange {
  request: string;
  response: string;
}

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as T;
}

export const recorded = {
  paneList: load<Exchange>("synthetic.pane.list.json"),
  processInfo: load<Exchange[]>("synthetic.pane.process_info.json"),
  events: load<{ lines: string[] }>("synthetic.events.json"),
  isolatedEvents: load<{ lines: string[] }>("isolated.events.json"),
  isolatedExchanges: load<Exchange[]>("isolated.exchanges.json"),
  schema: load<{
    methods: string[];
    subscriptionTypes: string[];
    eventKinds: string[];
    required: Record<"PaneInfo" | "PaneProcessInfo" | "PaneProcessInfoProcess", string[]>;
  }>("schema.json"),
};

export interface FakeRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** Returns a result object, `{ error }`, or "hang" to never answer. */
export type Handler = (req: FakeRequest) => unknown;

/** Recorded result body for a method/params, or a pane_not_found error. */
export function recordedResult(req: FakeRequest): unknown {
  if (req.method === "pane.list") return JSON.parse(recorded.paneList.response).result;
  if (req.method === "pane.process_info") {
    for (const ex of recorded.processInfo) {
      const r = JSON.parse(ex.response);
      if (r.result.process_info.pane_id === req.params.pane_id) return r.result;
    }
    return { error: { code: "pane_not_found", message: "pane not found" } };
  }
  if (req.method === "pane.focus") {
    return { type: "pane_info", pane: { pane_id: req.params.pane_id } };
  }
  return { error: { code: "invalid_request", message: `unhandled ${req.method}` } };
}

export interface FakeHerdr {
  readonly socketPath: string;
  readonly requests: FakeRequest[];
  handler: Handler;
  /** Number of currently open subscription connections. */
  subscribers(): number;
  /** Send a raw line to all subscription connections. */
  emit(line: string): void;
  /** Destroy every open connection (simulates a herdr restart / drop). */
  dropAll(): void;
  close(): Promise<void>;
}

export async function startFakeHerdr(socketPath: string, handler: Handler = recordedResult): Promise<FakeHerdr> {
  const subs = new Set<net.Socket>();
  const all = new Set<net.Socket>();
  const requests: FakeRequest[] = [];
  const fake: FakeHerdr = {
    socketPath,
    requests,
    handler,
    subscribers: () => subs.size,
    emit(line) {
      for (const s of subs) s.write(line + "\n");
    },
    dropAll() {
      for (const s of all) s.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        fake.dropAll();
        server.close(() => resolve());
      }),
  };
  const server = net.createServer((sock) => {
    all.add(sock);
    sock.on("close", () => {
      all.delete(sock);
      subs.delete(sock);
    });
    sock.on("error", () => {});
    let buf = "";
    let handled = false;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      if (handled) {
        // herdr 0.9.0 resets the connection on a second request.
        sock.destroy();
        return;
      }
      handled = true;
      const req = JSON.parse(buf.slice(0, i)) as FakeRequest;
      buf = buf.slice(i + 1);
      requests.push(req);
      if (req.method === "events.subscribe") {
        subs.add(sock);
        sock.write(JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n");
        return;
      }
      const out = fake.handler(req);
      if (out === "hang") return;
      const body =
        out && typeof out === "object" && "error" in out ? { id: req.id, ...(out as object) } : { id: req.id, result: out };
      sock.end(JSON.stringify(body) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return fake;
}
