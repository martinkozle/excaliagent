/**
 * Minimal herdr socket client (verified against herdr 0.9.0, protocol 22).
 *
 * Wire: newline-delimited JSON over a Unix stream socket.
 *   request  {"id","method","params"}
 *   response {"id","result":{"type",...}} | {"id","error":{"code","message"}}
 *   event    {"event":"pane_created","data":{"type":"pane_created",...}}  (no id)
 *
 * herdr serves ONE request per connection: a second line on the same
 * connection resets it, including on an events.subscribe connection. So this
 * client keeps one long-lived subscription connection (events, reconnect with
 * backoff, `connected()`), and opens a short connection per request.
 * Malformed requests get an error with id "" — on a one-shot connection any
 * reply is ours, so it is accepted.
 */
import { existsSync } from "node:fs";
import net from "node:net";

export class HerdrError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

export type ParsedLine =
  | { kind: "response"; id: string; result: unknown }
  | { kind: "error"; id: string; code: string; message: string }
  | { kind: "event"; event: HerdrEvent };

/** Parse one wire line; undefined for blank or unrecognised lines. */
export function parseLine(line: string): ParsedLine | undefined {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!msg || typeof msg !== "object") return undefined;
  const m = msg as Record<string, unknown>;
  if (m.error && typeof m.error === "object") {
    const e = m.error as Record<string, unknown>;
    return { kind: "error", id: String(m.id ?? ""), code: String(e.code ?? "unknown"), message: String(e.message ?? "") };
  }
  if ("result" in m) return { kind: "response", id: String(m.id ?? ""), result: m.result };
  if (typeof m.event === "string") {
    const data = m.data && typeof m.data === "object" ? (m.data as Record<string, unknown>) : {};
    return { kind: "event", event: { event: m.event, data } };
  }
  return undefined;
}

export type Connect = (socketPath: string) => net.Socket;
const defaultConnect: Connect = (p) => net.createConnection(p);

function onLines(sock: net.Socket, cb: (line: string) => void): void {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) cb(line);
    }
  });
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${process.pid}-${++seq}`;

export interface RequestOptions {
  timeoutMs?: number;
  connect?: Connect;
  /** Called with the socket so a caller can destroy it early (e.g. on close). */
  track?: (sock: net.Socket) => () => void;
}

/** One request on its own connection. Never throws synchronously. */
export function herdrRequest(
  socketPath: string,
  method: string,
  params: object = {},
  opts: RequestOptions = {},
): Promise<unknown> {
  const { timeoutMs = 5000, connect = defaultConnect } = opts;
  return new Promise((resolve, reject) => {
    if (!existsSync(socketPath)) {
      reject(new HerdrError("unavailable", `herdr socket not found: ${socketPath}`));
      return;
    }
    const id = nextId("ea");
    let sock: net.Socket;
    try {
      sock = connect(socketPath);
    } catch (e) {
      reject(new HerdrError("unavailable", String(e)));
      return;
    }
    const untrack = opts.track?.(sock);
    let done = false;
    const finish = (err: Error | undefined, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      untrack?.();
      sock.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new HerdrError("timeout", `${method} timed out after ${timeoutMs} ms`)), timeoutMs);
    sock.on("error", (e: NodeJS.ErrnoException) => finish(new HerdrError("unavailable", `${method}: ${e.code ?? e.message}`)));
    sock.on("close", () => finish(new HerdrError("closed", `${method}: connection closed without a reply`)));
    onLines(sock, (line) => {
      const msg = parseLine(line);
      if (!msg || msg.kind === "event") return;
      if (msg.id !== id && msg.id !== "") return;
      if (msg.kind === "error") finish(new HerdrError(msg.code, msg.message));
      else finish(undefined, msg.result);
    });
    sock.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

export interface HerdrClientOptions {
  socketPath: string;
  /** events.subscribe subscriptions sent on every (re)connect. */
  subscriptions: { type: string }[];
  onEvent?: (e: HerdrEvent) => void;
  /** Subscription acknowledged: a good moment to snapshot. */
  onConnect?: () => void;
  onDisconnect?: () => void;
  /** herdr 0.9.2+: events were dropped, resync now. */
  onEventsLost?: () => void;
  requestTimeoutMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  connect?: Connect;
}

export interface HerdrClient {
  request(method: string, params?: object): Promise<unknown>;
  /** True while the subscription connection is up and acknowledged. */
  connected(): boolean;
  close(): void;
}

export function createHerdrClient(opts: HerdrClientOptions): HerdrClient {
  const { socketPath, requestTimeoutMs = 5000, retryMinMs = 250, retryMaxMs = 5000 } = opts;
  const connect = opts.connect ?? defaultConnect;
  let closed = false;
  let isConnected = false;
  let sub: net.Socket | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let delay = retryMinMs;
  const inflight = new Set<net.Socket>();

  const scheduleRetry = () => {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      start();
    }, delay);
    retryTimer.unref?.();
    delay = Math.min(delay * 2, retryMaxMs);
  };

  const start = () => {
    if (closed) return;
    if (!existsSync(socketPath)) {
      scheduleRetry();
      return;
    }
    let sock: net.Socket;
    try {
      sock = connect(socketPath);
    } catch {
      scheduleRetry();
      return;
    }
    sub = sock;
    const subId = nextId("ea-sub");
    let acked = false;
    sock.on("error", () => {});
    sock.on("close", () => {
      if (sub === sock) sub = undefined;
      const was = isConnected && acked;
      if (acked) isConnected = false;
      if (was) opts.onDisconnect?.();
      scheduleRetry();
    });
    onLines(sock, (line) => {
      const msg = parseLine(line);
      if (!msg) return;
      if (msg.kind === "event") {
        if (msg.event.event === "events_lost") opts.onEventsLost?.();
        else opts.onEvent?.(msg.event);
        return;
      }
      if (msg.kind === "error") {
        if (msg.code === "events_lost") opts.onEventsLost?.();
        else if (!acked) sock.destroy(); // subscribe rejected: retry later
        return;
      }
      if (!acked && (msg.id === subId || msg.id === "")) {
        acked = true;
        isConnected = true;
        delay = retryMinMs;
        opts.onConnect?.();
      }
    });
    sock.write(
      JSON.stringify({ id: subId, method: "events.subscribe", params: { subscriptions: opts.subscriptions } }) + "\n",
    );
  };

  start();

  return {
    request(method, params = {}) {
      if (closed) return Promise.reject(new HerdrError("closed", "herdr client closed"));
      return herdrRequest(socketPath, method, params, {
        timeoutMs: requestTimeoutMs,
        connect,
        track: (s) => {
          inflight.add(s);
          return () => inflight.delete(s);
        },
      });
    },
    connected: () => isConnected && !closed,
    close() {
      if (closed) return;
      closed = true;
      isConnected = false;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      sub?.destroy();
      sub = undefined;
      for (const s of inflight) s.destroy();
      inflight.clear();
    },
  };
}
