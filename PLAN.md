# excaliagent — implementation plan

Ordered slices. Each one ends in something runnable and verified. Read
`DESIGN.md` for formats and `PRD.md` for acceptance criteria. Facts below were
verified on this machine on 2026-10-19 (Claude Code 2.1.303, herdr 0.9.0,
node 24, no python on PATH).

## Slice 0 — repo skeleton

- `npm init`, TypeScript, strict. Single package, two build targets:
  `src/server` (tsc or tsup → `dist/server`), `src/web` (Vite → `dist/web`).
- `bin/excaliagent` → `dist/server/cli.js`. `files` in package.json includes `dist/`.
- Test runner: `vitest`. Lint: whatever is cheapest; do not spend time here.
- `npm run dev` runs the server with Vite in middleware mode or a proxy, so the
  frontend hot-reloads against the real server.
- Verify: `npm run build && node bin/excaliagent --no-open` serves a hello page on
  `127.0.0.1:<port>` and prints the URL with the token.

## Slice 1 — Claude source adapter (pure data, fully unit-tested)

`src/server/sources/claude.ts`

1. **Registry watcher.** Read every `~/.claude/sessions/*.json` (skip `*.key`).
   Fields used: `pid`, `sessionId`, `cwd`, `name`, `status`, `waitingFor`,
   `statusUpdatedAt`, `updatedAt`. Live = file parses AND `process.kill(pid, 0)`
   succeeds AND `status !== "exited"`. Watch the directory with `fs.watch`
   (debounce 200 ms) and also poll every 5 s as a fallback.
2. **Transcript scanner.** For a session id, find
   `~/.claude/projects/*/<sessionId>.jsonl`. Scan lines; keep only:
   - last `{"type":"ai-title","aiTitle"}`
   - last `{"type":"agent-name","agentName"}`
   - all `{"type":"pr-link", …}` (inspect a real line for the URL field name)
   - `{"type":"continued-in", …}` (record, do not act on it yet)
   - from `user`/`assistant` lines: `cwd`, `gitBranch`, `timestamp`
   - from the last `assistant` line: `timestamp` and
     `message.usage.cache_creation.{ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}`
   Files reach several MB. Read incrementally: remember the byte offset per file
   and only parse appended bytes on change. Never parse message content.
3. **Cache warmth.** `ttl = ephemeral_1h > 0 ? 3600e3 : 300e3`;
   `cacheExpiresAt = lastAssistantTs + ttl`.
4. **Dormant listing.** All transcripts sorted by mtime desc, mapped to
   `Session` with `status: "dormant"`, `live: false`. Cap at 200.
5. Emit `Session[]` on every change. Merge order: registry fields win over
   transcript fields.

Tests: fixtures copied from real files (strip content), covering a busy session,
a waiting one with `waitingFor`, a stale registry file with a dead pid, a
transcript with two `ai-title` lines, and the 1 h vs 5 m TTL choice.

## Slice 2 — HTTP server, SSE, scene store, token

`src/server/http.ts`, `scene-store.ts`, `cli.ts`

- Plain `node:http` is enough. No framework needed.
- `GET /` serves `dist/web` only when the `token` query matches; sets a cookie.
  Every `/api/*` request requires the cookie. Reject if `Host` is not
  `127.0.0.1:<port>` or `localhost:<port>`.
- `GET /api/sessions` → current `Session[]`.
- `GET /api/events` → SSE; sends the full `Session[]` on connect and on change
  (small payload, no diffs needed).
- `GET /api/scene` / `PUT /api/scene` → `~/.local/state/excaliagent/scene.json`
  (respect `XDG_STATE_HOME`). Write to a temp file then `rename`.
- `GET /api/picker` → dormant sessions.
- `POST /api/focus {sessionId}` → wired in slice 4; returns 501 until then.
- CLI flags: `--port`, `--no-open`, `--state-dir`. Open the browser with the
  token in the URL (`open`/`xdg-open`, or print it).

Verify: `curl` with and without the cookie; SSE stream shows a change when a
Claude session starts.

## Slice 3 — Frontend: canvas, cards, reconcile

`src/web`

- `@excalidraw/excalidraw` (check the installed version's README for the CSS
  import and the Vite `define` of `process.env.IS_PREACT`).
- Load scene from `/api/scene` → `initialData`. Capture `excalidrawAPI`.
- `reconcile.ts` is pure: `(sessions, elements) → { newElements, patchedIds }`.
  Rules in `DESIGN.md` "Single writer". Cards are rectangles with
  `customData.excaliagent = { kind:"card", source:"claude", sessionId }`; the
  label is the bound text (`containerId` = rect id). Spawn both with
  `convertToExcalidrawElements([{ type:"rectangle", label:{ text }, customData, … }])`.
  Inbox: rectangle with `customData.excaliagent = { kind:"inbox" }`, created once
  if missing, `locked: false`. Place new cards in a grid inside its bounds.
- Patching: copy the element, set `backgroundColor`, `strokeColor`,
  `strokeStyle`, bump `version` and `versionNonce`; for the text element set
  `text` and `originalText`. Call `updateScene({ elements })`. Keep card width
  fixed (~280) and font size ~14 so five lines fit; let Excalidraw wrap.
- Save: on `onChange`, compare a cheap version hash of non-deleted elements;
  if changed, debounce 500 ms, `PUT /api/scene` (elements only, plus
  `appState.viewBackgroundColor`). Also save right after reconcile applies patches.
- Soft-deleted elements (`isDeleted`) are "no card". Do not purge them; Excalidraw
  handles that.
- Click → if the card has `pane`, `POST /api/focus`. Use `onPointerDown` or a
  double-click handler on the API; single click must not fight selection, so
  default to **double-click** and revisit.

Verify manually: start a second Claude session, see the card spawn; drag it;
change status (ask it something); reload the page; restart the server; nothing
moves and nothing duplicates. Unit tests for `reconcile.ts` with element fixtures.

## Slice 4 — herdr pane link

`src/server/panes/herdr.ts`

- Socket: `$HERDR_SOCKET_PATH` or `~/.config/herdr/herdr.sock`. Protocol:
  newline-delimited JSON over a Unix stream socket. Request
  `{"id":"<unique>","method":"…","params":{…}}`, response `{"id","result"}` or
  `{"id","error":{"code","message"}}`. Use one long-lived connection for
  `events.subscribe` and short ones for requests, or multiplex by id.
- Methods (all verified in `herdr api schema --json`, protocol 22):
  - `pane.list {}` → `{ panes: PaneInfo[] }`
  - `pane.process_info { pane_id }` → `{ process_info: { foreground_processes: [{ pid, cwd, argv }], shell_pid } }`
  - `pane.focus { pane_id }`; `agent.focus { target }` also exists
  - `events.subscribe { subscriptions: [{type:"pane.created"},{type:"pane.closed"},{type:"pane.exited"},{type:"pane.agent_detected"}] }`
  - `session.snapshot {}` as a resync fallback
- Build `pid → pane_id` by calling `process_info` for every pane (cheap: ~10
  panes). Rebuild on any subscribed event, on reconnect, and whenever the
  registry changes. **Subscribe before snapshot**; 0.9.0 has no `events_lost`,
  so also rebuild every 30 s.
- If the socket is absent, `available()` is false and nothing else runs.
- Attach `pane` to each `Session` by `session.pid`.

Verify: card shows `herdr w7:p1`; double-click focuses the pane; split the pane,
link still correct; stop herdr, card shows "no pane", nothing crashes.

## Slice 5 — picker

- Excalidraw `Sidebar` with a custom tab, toggled from a `renderTopRightUI`
  button. Lists `/api/picker` rows: title, repo, last-activity relative time.
  "Add" spawns a dormant card in the inbox via the same spawn code.
- Rows already on the board (non-deleted card with that `sessionId`) are hidden
  client-side.

## Slice 6 — publish

- README: what it is, the two screenshots that matter (busy vs needs-input, a
  parked region), `npx excaliagent`, privacy note (reads `~/.claude`, binds
  loopback only), herdr optional.
- `npm publish --dry-run`, check the tarball contains `dist/web`.

## Conventions

- No hooks installed in `~/.claude`. No files written outside the state dir.
- Everything that reads Claude or herdr lives behind `Source` / `PaneLink`
  interfaces; nothing in `src/web` knows which harness it is.
- Fail soft: a malformed file or a dead socket logs once and degrades; the board
  keeps working.
