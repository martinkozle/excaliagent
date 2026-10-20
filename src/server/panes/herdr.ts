/**
 * herdr pane link: pid → pane map built from pane.list + pane.process_info.
 * Rebuilt on pane events, on (re)connect, on events_lost (herdr 0.9.2+), every
 * `resyncMs` (0.9.0 has no events_lost), and on refresh(). Never throws when
 * herdr is absent: available() is false and the socket is retried.
 */
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Desktop } from "../desktop/desktop.ts";
import { createHerdrClient, HerdrError, type Connect } from "./herdr-client.ts";
import { createProcessTable, type ProcEntry, type ProcessTable } from "../desktop/process-table.ts";
import { findHerdrClientPids, herdrSocketPath } from "./herdr-clients.ts";
import type { Pane, PaneLink, ResumeRequest } from "./types.ts";

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
  "tab.create",
  "workspace.create",
  "pane.send_text",
] as const;

/** True when path is dir or inside it (separator boundary: /a/b is not inside /a/bc). */
export function isInside(path: string, dir: string): boolean {
  const d = dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
  return path === d || path.startsWith(d === "/" ? "/" : d + "/");
}

interface ListedPane {
  pane_id: string;
  workspace_id?: string;
  tab_id?: string;
  cwd?: string | null;
  foreground_cwd?: string | null;
  focused?: boolean;
}

/** Workspace showing root: the focused pane's workspace if it matches, else the first match. */
export function pickWorkspace(panes: ListedPane[], root: string): string | undefined {
  const matches = panes.filter((p) => [p.cwd, p.foreground_cwd].some((c) => typeof c === "string" && isInside(c, root)));
  const pick = matches.find((p) => p.focused) ?? matches[0];
  return pick ? (pick.workspace_id ?? workspaceOf(pick.pane_id)) : undefined;
}

export function defaultHerdrSocketPath(): string {
  return herdrSocketPath(process.env, homedir()) ?? join(homedir(), ".config", "herdr", "herdr.sock");
}

export interface ProcessInfo {
  pane_id: string;
  shell_pid?: number | null;
  foreground_processes?: { pid: number }[];
}

const workspaceOf = (paneId: string) => paneId.split(":")[0] ?? paneId;

/**
 * pid → pane for every foreground process of every pane; `panes` supplies ids
 * and labels. With `procs` (the process table), every descendant of a pane's
 * shell maps to that pane too: a session is not always in the foreground (a
 * command it runs can take the terminal, or it is suspended). Foreground wins.
 */
export function parsePaneMap(
  infos: ProcessInfo[],
  panes = new Map<string, Pane>(),
  procs: readonly ProcEntry[] = [],
): Map<number, Pane> {
  const map = new Map<number, Pane>();
  const byShell = new Map<number, Pane>();
  for (const info of infos) {
    const pane: Pane = panes.get(info.pane_id) ?? { paneId: info.pane_id, workspaceId: workspaceOf(info.pane_id) };
    for (const p of info.foreground_processes ?? []) {
      if (typeof p.pid === "number") map.set(p.pid, pane);
    }
    if (typeof info.shell_pid === "number") byShell.set(info.shell_pid, pane);
  }
  if (!byShell.size) return map;
  const children = new Map<number, number[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  const seen = new Set<number>(); // a pid is walked once, even if the table has a cycle
  for (const [shell, pane] of byShell) {
    const todo = [...(children.get(shell) ?? [])];
    for (let pid = todo.pop(); pid !== undefined; pid = todo.pop()) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (!map.has(pid)) map.set(pid, pane);
      todo.push(...(children.get(pid) ?? []));
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
  /** Where herdr client processes are looked up (default: this platform's). */
  processTable?: ProcessTable;
  /** Rebuild the pid map this long after resume() (the new process needs a moment). */
  resumeRefreshMs?: number;
}

export type HerdrLink = PaneLink & {
  refresh(): Promise<void>;
  resume(req: ResumeRequest): Promise<{ paneId: string }>;
  /** pids of herdr client (TUI) processes attached to our server. */
  clientPids(): Promise<number[]>;
};

export function createHerdrLink(opts: HerdrLinkOptions = {}): HerdrLink {
  const { resyncMs = 30_000 } = opts;
  const socketPath = opts.socketPath ?? defaultHerdrSocketPath();
  const table = opts.processTable ?? createProcessTable();
  const clientPids = () => findHerdrClientPids({ socketPath, table });
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
    const procs = table.list().catch(() => [] as ProcEntry[]);
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
    setMap(parsePaneMap(infos.filter((i): i is ProcessInfo => !!i), panes, await procs));
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
  const pending = new Set<NodeJS.Timeout>();

  async function raise(): Promise<void> {
    if (!opts.desktop) return;
    try {
      await opts.desktop.raise(await clientPids());
    } catch {
      // raising the window is best effort
    }
  }

  return {
    available: () => !closed && client.connected(),
    match: (pid) => map.get(pid),
    async focus(paneId) {
      if (closed || !client.connected()) return;
      await client.request("pane.focus", { pane_id: paneId });
      await raise();
    },
    async resume(req) {
      if (closed || !client.connected()) throw new HerdrError("unavailable", "herdr is not connected");
      const root = req.repoRoot ?? req.cwd;
      const { panes = [] } = (await client.request("pane.list", {})) as { panes?: ListedPane[] };
      const workspaceId = pickWorkspace(panes, root);
      const created = (
        workspaceId !== undefined
          ? await client.request("tab.create", { workspace_id: workspaceId, cwd: req.cwd, label: req.label, focus: true })
          : await client.request("workspace.create", { cwd: req.cwd, label: basename(root) || root, focus: true })
      ) as { root_pane?: { pane_id?: unknown } };
      const paneId = created.root_pane?.pane_id;
      if (typeof paneId !== "string") throw new HerdrError("bad_response", "herdr did not return the new pane");
      // A fresh shell buffers typed input until it is ready (checked on herdr 0.9.0 with sh and a slow zsh).
      await client.request("pane.send_text", { pane_id: paneId, text: req.command + "\n" });
      await raise();
      const t = setTimeout(() => {
        pending.delete(t);
        void rebuild();
      }, opts.resumeRefreshMs ?? 1500);
      t.unref?.();
      pending.add(t);
      return { paneId };
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
      for (const t of pending) clearTimeout(t);
      pending.clear();
      client.close();
      listeners.clear();
      map = new Map();
    },
  };
}
