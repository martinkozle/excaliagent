# excaliagent — design

Status: decided 2026-10-19 after a grilling session. MVP slices 0–5 implemented 2026-10-19 (see PLAN.md "Implementation notes").

## What it is

A local, personal, spatial scratchboard for coding-agent sessions. An Excalidraw
canvas where each session is a card. I place cards freely and bucket them by hand
(parked, blocked on someone, come back to, done). The app keeps each card's
**status color** and **label** in sync and **spawns cards**. **Position, size, and
anything I draw are mine**; the app never touches them.

The point is **dormant** sessions, not live ones. On a bad day 2–3 sessions are
active, but many more are parked, blocked on a colleague, or grilled-and-waiting.
Claude Code's own FleetView is a list of sessions; this board exists only for the
spatial, manual triage on top of it.

Run: `npx excaliagent` → server on `127.0.0.1:<random>` → opens the browser.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Card unit | One card per **agent session** (never per shell pane, never per workspace) | Two agents in one worktree are two things to triage |
| Data source | **Claude Code first.** `~/.claude/sessions/<pid>.json` + transcripts. herdr is **optional**, only for "jump to pane" | Registry gives id, cwd, name, status, waitingFor. Dormant sessions have no pane, so herdr cannot be the source of truth |
| Identity | `sessionId` from Claude. Same card survives exit + `/resume` | "Same card if cheap"; with the registry it is free |
| Spawn rule | **Live sessions auto-spawn** into the inbox. **Dormant** sessions are added from a **picker** | 40 transcripts in one project; no flooding |
| Dormant click | herdr if available (new pane in cwd, `claude --resume <id>`), else copy the command | Post-MVP |
| Pane link | **pid match**: registry `pid` == herdr `pane.process_info.foreground_processes[].pid` | Zero installs. No hook, no herdr integration needed |
| Send input | **Never in v1.** Focus and resume only | Keeps security surface small |
| Notes | Card is a plain rectangle; notes are free elements I place myself | Simplest spawn/patch logic |
| Loudest signal | **needs input / permission** (`needs_user`, `waiting`, `needs_trust`, `blocked`) | Then: idle + warm cache ("review me before it goes cold") |
| Stack | **Node/TypeScript end to end.** Vite + React + `@excalidraw/excalidraw` frontend, Node server | One toolchain; Excalidraw is React anyway |
| Audience | Design for publishing now: adapter interface, README, generic name | User's call |
| Name | **excaliagent** | Free on npm and PyPI. No Claude trademark. Honest if Codex lands |

## MVP (the version I would open every day)

1. Live Claude sessions appear as cards in the inbox with status color and label.
2. Clicking a card focuses its herdr pane (no-op when herdr is absent).
3. Picker side panel lists dormant transcripts without a card; "Add" spawns a card.
4. Scene persists across restarts.

Explicitly later: resume-from-card, quick reply, arrows between cards, remote
machines (`herdr --remote`), Codex / OpenCode adapters.

## Card label (app-owned bound text)

```
ExcaliClaude handoff              ← ai-title (falls back to registry name, then cwd basename)
excaliagent · main                ← repo basename · gitBranch
waiting: input needed · 2m        ← status · waitingFor · time since last activity
cache warm 41m · herdr w7:p1      ← cache warmth · pane id if matched, "no pane" if live but unmatched, nothing if dormant
PR #12                            ← last pr-link, if any
```

Label text is regenerated wholesale on every change. That is why notes must live
outside the card.

### Status → color (Excalidraw palette)

| State | Fill | Stroke |
|---|---|---|
| `needs_user`, `waiting`, `needs_trust`, `blocked` | `#ffc9c9` | `#e03131` |
| `busy` | `#a5d8ff` | `#1971c2` |
| `idle`, cache warm | `#b2f2bb` | `#2f9e44` |
| `idle`, cache cold | `#e9ecef` | `#868e96` |
| dormant (no registry entry) / `exited` | `#f8f9fa` | `#adb5bd`, dashed |

Always `fillStyle: "solid"`, otherwise the color reads as faint hatching.

### Cache warmth

From the last `assistant` line of the transcript: `timestamp` plus TTL. TTL is
1 h if `usage.cache_creation.ephemeral_1h_input_tokens > 0`, else 5 min. Warm if
`now < timestamp + ttl`. Rendered as `cache warm 41m` or `cache cold`.

## Data: what Claude Code exposes (verified on 2.1.303)

**Live registry** `~/.claude/sessions/<pid>.json`, one file per running session:

```json
{"pid":4242,"sessionId":"0a1b2c3d-…","cwd":"/home/alice/src/demo-app",
 "name":"demo-app-64","nameSource":"derived","kind":"interactive",
 "entrypoint":"cli","status":"busy","statusUpdatedAt":1792439563125,
 "messagingSocketPath":"/run/user/1000/cc-socks/4242.sock", "version":"2.1.303"}
```

Statuses seen in the binary: `busy`, `idle`, `waiting`, `needs_user`,
`needs_trust`, `blocked`, `exited`. Optional `waitingFor`: "input needed",
"dialog open", "sandbox request", "goal proposal". Liveness = file present AND
`kill -0 pid` succeeds (files can go stale after a crash).

**Transcripts** `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`. Useful line
types (grep by `"type":`): `ai-title`, `agent-name`, `pr-link`, `continued-in`,
`cost-state`, `last-prompt`, and `user`/`assistant` lines carrying `cwd`,
`gitBranch`, `version`, `timestamp`, `usage`. Read with a tail-and-scan, never
parse message content.

**Hooks** exist (SessionStart, Stop, Notification, SessionEnd, 30+ more) and
carry `session_id`, but the MVP does not install any. The registry plus
`fs.watch` on the sessions dir is enough.

## Data: herdr (verified on 0.9.0, protocol 22)

- Socket: `$HERDR_SOCKET_PATH` (`~/.config/herdr/herdr.sock`), JSON request
  `{id, method, params}` → `{id, result}`; `herdr api schema --json` has every type.
- `pane.list` → `PaneInfo` with `pane_id`, `workspace_id`, `cwd`, `agent`,
  `agent_status` (`idle|working|blocked|done|unknown`), `agent_session` (only when
  an integration reports it; **null for Claude here**, the Claude integration is
  not installed and status comes from a title heuristic).
- `pane.process_info {pane_id}` → `foreground_processes[].pid`. **This is the link.**
- `pane.focus` / `plugin.pane.focus {pane_id}` to jump.
- `pane.split {cwd, direction, focus}` + `pane.send_text {pane_id, text}` or
  `tab.create {cwd, label, focus}` for resume (later).
- `events.subscribe {subscriptions:[{type:"pane.created"},{type:"pane.closed"},…]}`.
  Subscribe first, then snapshot: no replay since 0.9.0. `events_lost` does **not**
  exist until 0.9.2; on 0.9.0 re-run `pane.list` on a timer or on reconnect.
- herdr 0.9.5 notes in the original handoff do not apply to this machine yet.

Re-match pids on `pane.created`, `pane.closed`, `pane.exited`,
`pane_agent_detected`, and whenever the registry changes.

## Architecture

```
excaliagent/
  package.json            single package, bin → dist/server/cli.js
  src/server/
    cli.ts                parse flags, pick port, make token, open browser
    http.ts               static files, GET /api/sessions, GET /api/events (SSE),
                          GET/POST /api/scene, POST /api/focus, GET /api/picker
    sources/
      types.ts            Session, Source interface
      claude.ts           registry watcher + transcript scanner + cache warmth
    panes/
      types.ts            PaneLink interface: match(pid), focus(paneId), open(cwd, cmd)
      herdr.ts            unix-socket client, pid → pane cache, event resubscribe
    scene-store.ts        ~/.local/state/excaliagent/scene.json, atomic write
  src/web/
    main.tsx, App.tsx     Excalidraw, reconcile loop, picker Sidebar tab
    reconcile.ts          sessions + elements → element patches (pure, unit-tested)
    cards.ts              spawn, label text, colors, inbox placement
```

### Model

```ts
interface Session {
  id: string; source: "claude"; cwd: string; repo: string; branch?: string;
  title?: string; name?: string;
  status: "busy"|"idle"|"waiting"|"needs_user"|"needs_trust"|"blocked"|"exited"|"dormant";
  waitingFor?: string; lastActivityAt: number;
  cacheTtlMs: number; cacheExpiresAt: number;
  live: boolean; pid?: number;
  pane?: { paneId: string; workspaceId: string };
  prLinks: string[];
}
interface Source { list(): Promise<Session[]>; watch(cb: (s: Session[]) => void): () => void; listDormant(): Promise<Session[]>; }
interface PaneLink { available(): boolean; match(pid: number): Pane|undefined; focus(paneId: string): Promise<void>; }
```

### Single writer

The frontend owns the scene. The server never edits elements; it streams
`Session[]` over SSE and stores whatever scene the frontend POSTs. On each
sessions update the frontend runs `reconcile`:

- Card = rectangle with `customData.excaliagent = { kind: "card", source, sessionId }`
  plus its bound text element (`containerId`). Soft-deleted elements
  (`isDeleted: true`) count as "no card".
- Live session, no card → spawn in the inbox. Dormant session, no card → nothing
  (the picker adds it). Card with no matching session at all (transcript gone) →
  style as dormant, never delete.
- Existing card → patch only `backgroundColor`, `strokeColor`, `strokeStyle`, and
  the bound text's `text`/`originalText`. Never `x`, `y`, `width`, `height`,
  `angle`, `groupIds`, `frameId`.
- Inbox = a rectangle with `customData.excaliagent = { kind: "inbox" }`, spawned
  once, movable and resizable by me. New cards stack inside it, wrapping.
- Save: debounced POST on every Excalidraw `onChange` where element versions
  differ, plus immediately after reconcile applies patches.

### Security

- Bind `127.0.0.1` only.
- Random token at startup, put in the opened URL, exchanged for a cookie; every
  `/api/*` call requires it.
- Reject requests whose `Host` is not the bound address (DNS rebinding).
- `/api/focus` is the only side-effecting endpoint in v1.

## Prior art checked

- herdr-dash, ekanban, herdr-kanban, herdr-workboard, herdr-code-board: columns
  by status or task queues, none spatial, all herdr-only.
- ExcaliDash: hosted, whole-scene writes, Agent API only in 0.6.x-dev. Rejected.
- Orca: cards are worktrees, not agents. Rejected.
- Claude Code FleetView (built in): a session list with peers and PR batching.
  Not spatial. The board should not duplicate its browsing features.
- Name collisions on GitHub: four "excaliclaude" repos exist (12, 3, 2, 0 stars),
  all tools that let Claude *draw diagrams* in Excalidraw. The name now means
  "diagram generation", not session triage. One empty "excaliagent" repo (0 stars).
  Both npm and PyPI are free for every candidate except `agentboard`.

## Open questions

- How to tell a card's session is "the same work" after `continued-in` (session
  forked/continued). Probably follow the `continued-in` pointer and move the card.
- Inbox overflow behaviour when more than ~10 live cards exist. Not a real
  problem at 2–3 active.
- Picker scope: all projects, or only projects with a live session.
