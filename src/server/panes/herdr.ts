/**
 * herdr pane link: pid → pane map built from pane.list + pane.process_info.
 * Rebuilt on pane events, on (re)connect, on events_lost (herdr 0.9.2+), every
 * `resyncMs` (0.9.0 has no events_lost), and on refresh(). Never throws when
 * herdr is absent: available() is false and the socket is retried.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Desktop } from "../desktop/desktop.ts";
import { createHerdrClient, type Connect } from "./herdr-client.ts";
import { findHerdrClientPids } from "./herdr-clients.ts";
import type { Pane, PaneLink } from "./types.ts";

export { createNoPaneLink } from "./none.ts";

export const HERDR_SUBSCRIPTIONS = [
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.exited" },
  { type: "pane.agent_detected" },
  // Labels shown on cards: rebuild when they appear, change or go away.
  { type: "workspace.created" },
  { type: "workspace.renamed" },
  { type: "workspace.closed" },
  { type: "tab.created" },
  { type: "tab.renamed" },
  { type: "tab.closed" },
];

/** Every method this link sends (tests check them against the schema). */
export const HERDR_METHODS = [
  "events.subscribe",
  "pane.list",
  "pane.process_info",
  "pane.focus",
  "workspace.list",
  "tab.list",
] as const;

export function defaultHerdrSocketPath(): string {
  return process.env.HERDR_SOCKET_PATH || join(homedir(), ".config/herdr/herdr.sock");
}

export interface ProcessInfo {
  pane_id: string;
  shell_pid?: number | null;
  foreground_processes?: { pid: number }[];
}

const workspaceOf = (paneId: string) => paneId.split(":")[0] ?? paneId;

/** pid → pane for every foreground process of every pane; `panes` supplies ids and labels. */
export function parsePaneMap(infos: ProcessInfo[], panes = new Map<string, Pane>()): Map<number, Pane> {
  const map = new Map<number, Pane>();
  for (const info of infos) {
    const pane: Pane = panes.get(info.pane_id) ?? { paneId: info.pane_id, workspaceId: workspaceOf(info.pane_id) };
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
    if (
      !other ||
      other.paneId !== pane.paneId ||
      other.workspaceId !== pane.workspaceId ||
      other.workspaceLabel !== pane.workspaceLabel ||
      other.tabLabel !== pane.tabLabel
    ) {
      return false;
    }
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
  /** When set, focus() also raises the terminal window hosting the herdr client. */
  desktop?: Desktop;
  procRoot?: string;
}

export type HerdrLink = PaneLink & {
  refresh(): Promise<void>;
  /** pids of herdr client (TUI) processes attached to our server. */
  clientPids(): Promise<number[]>;
};

export function createHerdrLink(opts: HerdrLinkOptions = {}): HerdrLink {
  const { resyncMs = 30_000 } = opts;
  const socketPath = opts.socketPath ?? defaultHerdrSocketPath();
  const clientPids = () => findHerdrClientPids({ socketPath, procRoot: opts.procRoot });
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
    socketPath,
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

  /** id → label from workspace.list / tab.list; empty when the call fails (labels are optional). */
  async function labels(method: "workspace.list" | "tab.list", key: "workspaces" | "tabs", id: "workspace_id" | "tab_id") {
    try {
      const res = (await client.request(method, {})) as Record<string, { label?: unknown }[] | undefined>;
      const out = new Map<string, string>();
      for (const item of res[key] ?? []) {
        const k = (item as Record<string, unknown>)[id];
        if (typeof k === "string" && typeof item.label === "string") out.set(k, item.label);
      }
      return out;
    } catch {
      return new Map<string, string>();
    }
  }

  async function build(): Promise<void> {
    let list: { pane_id: string; workspace_id?: string; tab_id?: string }[];
    const wsLabels = labels("workspace.list", "workspaces", "workspace_id");
    const tabLabels = labels("tab.list", "tabs", "tab_id");
    try {
      const res = (await client.request("pane.list", {})) as { panes?: typeof list };
      list = res.panes ?? [];
    } catch {
      return; // keep the current map; the next event/timer/reconnect retries
    }
    const [ws, tabs] = await Promise.all([wsLabels, tabLabels]);
    const panes = new Map<string, Pane>();
    for (const p of list) {
      const pane: Pane = { paneId: p.pane_id, workspaceId: p.workspace_id ?? workspaceOf(p.pane_id) };
      const wl = ws.get(pane.workspaceId);
      const tl = p.tab_id !== undefined ? tabs.get(p.tab_id) : undefined;
      if (wl !== undefined) pane.workspaceLabel = wl;
      if (tl !== undefined) pane.tabLabel = tl;
      panes.set(p.pane_id, pane);
    }
    const panesList = list;
    const infos = await Promise.all(
      panesList.map(async (p) => {
        try {
          const res = (await client.request("pane.process_info", { pane_id: p.pane_id })) as { process_info?: ProcessInfo };
          return res.process_info;
        } catch {
          return undefined; // pane vanished or herdr hiccuped: skip it
        }
      }),
    );
    if (closed || !client.connected()) return;
    setMap(parsePaneMap(infos.filter((i): i is ProcessInfo => !!i), panes));
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
      if (opts.desktop) {
        try {
          await opts.desktop.raise(await clientPids());
        } catch {
          // raising the window is best effort
        }
      }
    },
    clientPids,
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
