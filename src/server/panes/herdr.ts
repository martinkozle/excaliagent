/**
 * herdr pane link: pid → pane map built from pane.list + pane.process_info.
 * Rebuilt on pane events, on (re)connect, on events_lost (herdr 0.9.2+), every
 * `resyncMs` (0.9.0 has no events_lost), and on refresh(). Never throws when
 * herdr is absent: available() is false and the socket is retried.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createHerdrClient, type Connect } from "./herdr-client.ts";
import type { Pane, PaneLink } from "./types.ts";

export { createNoPaneLink } from "./none.ts";

export const HERDR_SUBSCRIPTIONS = [
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.exited" },
  { type: "pane.agent_detected" },
];

/** Every method this link sends (tests check them against the schema). */
export const HERDR_METHODS = ["events.subscribe", "pane.list", "pane.process_info", "pane.focus"] as const;

export function defaultHerdrSocketPath(): string {
  return process.env.HERDR_SOCKET_PATH || join(homedir(), ".config/herdr/herdr.sock");
}

export interface ProcessInfo {
  pane_id: string;
  shell_pid?: number | null;
  foreground_processes?: { pid: number }[];
}

const workspaceOf = (paneId: string) => paneId.split(":")[0] ?? paneId;

/** pid → pane for every foreground process of every pane. */
export function parsePaneMap(infos: ProcessInfo[], workspaces = new Map<string, string>()): Map<number, Pane> {
  const map = new Map<number, Pane>();
  for (const info of infos) {
    const pane: Pane = { paneId: info.pane_id, workspaceId: workspaces.get(info.pane_id) ?? workspaceOf(info.pane_id) };
    for (const p of info.foreground_processes ?? []) {
      if (typeof p.pid === "number") map.set(p.pid, pane);
    }
  }
  return map;
}

function sameMap(a: Map<number, Pane>, b: Map<number, Pane>): boolean {
  if (a.size !== b.size) return false;
  for (const [pid, pane] of a) {
    const other = b.get(pid);
    if (!other || other.paneId !== pane.paneId || other.workspaceId !== pane.workspaceId) return false;
  }
  return true;
}

export interface HerdrLinkOptions {
  socketPath?: string;
  resyncMs?: number;
  requestTimeoutMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  connect?: Connect;
}

export function createHerdrLink(opts: HerdrLinkOptions = {}): PaneLink & { refresh(): Promise<void> } {
  const { resyncMs = 30_000 } = opts;
  let map = new Map<number, Pane>();
  const listeners = new Set<() => void>();
  let closed = false;

  const setMap = (next: Map<number, Pane>) => {
    if (sameMap(map, next)) return;
    map = next;
    for (const cb of [...listeners]) {
      try {
        cb();
      } catch {
        // a listener's failure must not break the link
      }
    }
  };

  const client = createHerdrClient({
    socketPath: opts.socketPath ?? defaultHerdrSocketPath(),
    subscriptions: HERDR_SUBSCRIPTIONS,
    requestTimeoutMs: opts.requestTimeoutMs,
    retryMinMs: opts.retryMinMs,
    retryMaxMs: opts.retryMaxMs,
    connect: opts.connect,
    onConnect: () => void rebuild(),
    onEvent: () => void rebuild(),
    onEventsLost: () => void rebuild(),
    onDisconnect: () => setMap(new Map()),
  });

  async function build(): Promise<void> {
    let panes: { pane_id: string; workspace_id?: string }[];
    try {
      const res = (await client.request("pane.list", {})) as { panes?: typeof panes };
      panes = res.panes ?? [];
    } catch {
      return; // keep the current map; the next event/timer/reconnect retries
    }
    const workspaces = new Map(panes.map((p) => [p.pane_id, p.workspace_id ?? workspaceOf(p.pane_id)]));
    const infos = await Promise.all(
      panes.map(async (p) => {
        try {
          const res = (await client.request("pane.process_info", { pane_id: p.pane_id })) as { process_info?: ProcessInfo };
          return res.process_info;
        } catch {
          return undefined; // pane vanished or herdr hiccuped: skip it
        }
      }),
    );
    if (closed || !client.connected()) return;
    setMap(parsePaneMap(infos.filter((i): i is ProcessInfo => !!i), workspaces));
  }

  // Coalesce: at most one build running, plus one queued behind it.
  let running: Promise<void> | undefined;
  let queued: Promise<void> | undefined;
  function rebuild(): Promise<void> {
    if (closed || !client.connected()) return Promise.resolve();
    if (!running) {
      running = build().finally(() => {
        running = undefined;
      });
      return running;
    }
    queued ??= running.then(() => {
      queued = undefined;
      return rebuild();
    });
    return queued;
  }

  const timer = setInterval(() => void rebuild(), resyncMs);
  timer.unref?.();

  return {
    available: () => !closed && client.connected(),
    match: (pid) => map.get(pid),
    async focus(paneId) {
      if (closed || !client.connected()) return;
      await client.request("pane.focus", { pane_id: paneId });
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    refresh: rebuild,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      client.close();
      listeners.clear();
      map = new Map();
    },
  };
}
