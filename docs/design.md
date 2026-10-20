# excaliagent: design

How the board works and why. `product.md` is the goal state; this file is the
reference for changing the code. Facts about Claude Code and herdr are
undocumented upstream: each says which version it was verified on. Re-verify
before relying on one after an upgrade, and update this file.

## Shape

```
Claude Code files ──► Source (src/server/sources) ──┐
                                                    ├─► Hub ──SSE──► browser: reconcile ──► Excalidraw scene
herdr socket ───────► PaneLink (src/server/panes) ──┘     ▲                                     │
                                                          └──── PUT /api/scene (scene.json) ◄───┘
```

- `npx excaliagent` starts one Node process on `127.0.0.1:<random>` and opens
  the browser with a one-time token.
- The **server** reads sessions, links them to herdr panes, streams
  `Session[]` over SSE, stores the scene, and performs the only side effects
  (focus a pane, resume into a new pane, raise the terminal window).
- The **frontend** owns the scene. On every sessions update (and every 30 s, for
  ages and cache minutes) it runs the pure `reconcile` and applies the patches.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Card unit | One card per **agent session** (never per pane or workspace) | Two agents in one worktree are two things to triage |
| Source of truth | **Claude Code's own files**: `~/.claude/sessions/<pid>.json` + transcripts. herdr is optional | The board is mostly for dormant sessions, which have no pane |
| Identity | Claude `sessionId`; the card survives exit and `--resume` | Free with the registry |
| Spawning | Live sessions auto-spawn into the inbox; dormant ones come from the picker | 40 transcripts in one project would flood the board |
| Single writer | Frontend writes the scene; the server never edits elements | Excalidraw and a second writer would fight over drags |
| Pane link | Registry `pid` == a pane's foreground process pid | Zero installs: no hooks, no herdr integration |
| Send input | **Never into a session.** Focus, and `claude --resume <id>` in a *new* pane | Small security surface |
| Notes | Free elements the user places; the app only writes its own card elements | Simple patching, user content never touched |
| Loudest signal | needs input (`needs_user`, `waiting`, `needs_trust`, `blocked`), then idle + warm cache | "Review me before the cache goes cold" |
| Stack | Node/TypeScript; server has zero runtime deps; Vite + React + `@excalidraw/excalidraw` | One toolchain; `npx` stays light |
| Fonts | Excalidraw fonts except Xiaolai (CJK) are served locally (`EXCALIDRAW_ASSET_PATH = "/"`); Xiaolai loads from Excalidraw's default CDN | Keeps offline Latin text, ~3 MB package |
| Runtime | Node (not Bun) | `npx` works wherever Claude Code does |

## Session model

`src/shared/types.ts`:

```ts
interface Session {
  id: string; source: "claude"; cwd: string;
  repo: string; repoRoot?: string; branch?: string;
  title?: string; name?: string;
  status: "busy"|"idle"|"waiting"|"needs_user"|"needs_trust"|"blocked"|"exited"|"dormant";
  waitingFor?: string; lastActivityAt: number;
  cacheTtlMs: number; cacheExpiresAt: number;     // 0 = unknown
  live: boolean; pid?: number;
  pane?: { paneId; workspaceId; workspaceLabel?; tabLabel? };
  prLinks: string[]; continuedIn?: string;
}
```

## Claude Code data (verified on 2.1.303)

### Live registry: `~/.claude/sessions/<pid>.json`

One file per running session (ignore `<pid>.<hash>.key` files):

```json
{"pid":4242,"sessionId":"0a1b2c3d-…","cwd":"/home/alice/src/demo-app",
 "name":"demo-app-64","nameSource":"derived","kind":"interactive","entrypoint":"cli",
 "status":"busy","waitingFor":"input needed","statusUpdatedAt":1792439563125,
 "updatedAt":1792439563125,"version":"2.1.303"}
```

- Statuses seen: `busy`, `idle`, `waiting`, `needs_user`, `needs_trust`,
  `blocked`, `exited`. Unknown values are treated as `idle`.
- `waitingFor`: "input needed", "dialog open", "sandbox request", "goal proposal".
- **Live** = file parses AND `kill -0 pid` succeeds (EPERM counts as alive) AND
  status is not `exited`. Files go stale after a crash.
- A fresh idle session has a registry file but often no transcript yet.
- If two pid files name the same session, the most recently updated wins.
- Watched with `fs.watch` (debounced 200 ms) plus a 5 s poll.

### Transcripts: `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`

Read incrementally (byte offset per file, partial trailing line kept, rescan on
truncation). Message content is never parsed or kept. Lines used:

| `type` | Fields used | Notes |
|---|---|---|
| `ai-title` | `aiTitle` | Repeats very often; last wins |
| `agent-name` | `agentName` | Title fallback |
| `pr-link` | `prUrl` (`prNumber`, `prRepository`) | Repeats; deduped; last is shown |
| `continued-in` | `continuedInSessionId` | See below; last wins |
| `api-request` | `cacheControl[].value.ttl`, `querySource` | The real cache TTL (see below) |
| `user` / `assistant` | `cwd`, `gitBranch`, `timestamp`; assistant `message.usage.cache_creation` | |

Other types (`api-request-blob`, `attachment`, `last-prompt`, `cost-state`, …)
are ignored. Subagent transcripts live in `<sessionId>/subagents/` and are not
listed.

**Cache TTL.** Claude Code 2.1.303 logs every cache write in `usage` as
`ephemeral_5m_input_tokens` even when the request asked for a 1 h cache. The
truth is in `api-request` lines:

```json
{"type":"api-request","querySource":"repl_main_thread","cacheControl":[
  {"path":["system",1],"value":{"type":"ephemeral","ttl":"1h","scope":"global"}}, …]}
```

Rule: TTL = max `ttl` of the latest `repl_main_thread` request (any request if
none from the main thread); `"1h"` → 1 h, else 5 min. Transcripts without
`api-request` lines (older Claude Code) fall back to the usage counters of the
most recent assistant line that wrote cache. Expiry = last assistant timestamp
+ TTL. No assistant line → unknown (0).

**Branch and repo.** `gitBranch` is stamped once and goes stale (a whole session
said `HEAD`). The branch is read live: walk up from `cwd` to `.git` (a dir, or a
`gitdir:` file for worktrees and submodules), read `HEAD`; detached → short sha.
No `git` subprocess; cached 2 s per cwd. `repo` = basename of the folder holding
`.git`, `repoRoot` = that folder. Dormant sessions keep their recorded branch
unless it is `HEAD`.

**`continued-in`.** Written into an old transcript when its conversation moved
into a background session. Claude Code then hides the old one from `/resume` as
superseded. The picker hides superseded transcripts too; a card on the old id
follows `continuedIn` to the new session (see reconcile).

**PR links.** Claude Code records links matching
`https?://host/<repo>/(pull|pull-requests|-/merge_requests)/N`: GitHub,
Bitbucket (including self-hosted) and GitLab. Shown as `PR #N` / `MR !N`.

**Resume.** `claude --resume <sessionId>` in the session's cwd.

Hooks exist (SessionStart, Stop, Notification, …) but none are installed: the
registry plus file watching is enough, and "no setup" is a goal.

## herdr data (verified on 0.9.0, protocol 22)

- Socket: `$HERDR_SOCKET_PATH`, else `~/.config/herdr/herdr.sock`.
  Newline-delimited JSON: `{"id","method","params"}` → `{"id","result"}` or
  `{"id","error":{"code","message"}}`. `herdr api schema --json` lists everything.
- **One request per connection.** A second request on the same connection
  resets it (also after a subscription ack). The client keeps one long-lived
  subscription connection and opens a short one per request, 5 s timeout.
- Methods used (tests check them against the recorded schema):
  `events.subscribe`, `pane.list`, `pane.process_info`, `pane.focus`,
  `workspace.list`, `tab.list`, `tab.create`, `workspace.create`, `pane.send_text`.
- `pane.process_info {pane_id}` → `{process_info:{pane_id, shell_pid,
  foreground_process_group_id, foreground_processes:[{pid,name,argv,cmdline,cwd}]}}`.
  Every foreground pid maps to its pane (exact match).
- `workspace.list` → `{workspaces:[{workspace_id,label,…}]}`, `tab.list {}` →
  `{tabs:[{tab_id,workspace_id,label,…}]}` (all tabs). New workspaces default to
  their cwd's folder name, new tabs to their number.
- `tab.create {workspace_id,cwd,label,focus}` → `{tab, root_pane}`;
  `workspace.create {cwd,label,focus}` → `{workspace, tab, root_pane}`. Text sent
  to a new pane right away is buffered as typeahead; no wait needed.
- Subscriptions use dots (`pane.created`), wire events use underscores:
  `{"event":"pane_created","data":{"type":"pane_created","pane":{…}}}`. Close
  and exit events carry `pane_id` and `workspace_id`. Subscribed: `pane.created`,
  `pane.closed`, `pane.exited`, `pane.agent_detected`, `workspace.created`,
  `workspace.renamed`, `workspace.closed`, `tab.created`, `tab.renamed`, `tab.closed`.
- No replay: subscribe first, then snapshot. `events_lost` exists only from
  0.9.2 (as an error or an event) and triggers a resync; 0.9.0 lacks it, so the
  map is also rebuilt every 30 s, on reconnect, and when the Claude registry
  changes membership.
- 0.9.1–0.9.5 (checked from release notes) changed none of the methods above;
  0.9.2 removed the pane graphics API (unused).
- Running an isolated server for tests: `herdr server` with a temp HOME/XDG
  dirs, `HERDR_SOCKET_PATH` short (under `/tmp/hdr-*`: the socket path limit is
  ~107 bytes), all inherited `HERDR_*` variables removed.

## Pane link and desktop

- **Match**: `match(pid)` → `{paneId, workspaceId, workspaceLabel, tabLabel}`.
  The card shows `herdr: <workspace> › <tab>`; live without a pane shows
  `not in herdr`.
- **Focus**: `pane.focus`, then raise the terminal window.
- **Resume** (dormant card): pick the workspace that has a pane whose `cwd` or
  `foreground_cwd` is inside `repoRoot ?? cwd` (path-boundary aware, focused one
  preferred) → `tab.create` there, labelled with the session title (40 chars);
  else `workspace.create` labelled with the repo name. Then
  `pane.send_text "claude --resume <id>\n"` and raise. The id is validated
  (`/^[0-9a-f-]{36}$/i`) and the command built server-side only.
- **Socket**: `HERDR_SOCKET_PATH`, else `$XDG_CONFIG_HOME/herdr/herdr.sock`, else
  `~/.config/herdr/herdr.sock` (checked on herdr 0.9.0 / Linux with isolated
  servers). The herdr binary has no `~/Library` path, so macOS is assumed to be
  the same: *unverified on real hardware (maintainer to test)*.
- **Raise** (`src/server/desktop`): find herdr *client* processes (executable
  name `herdr`, no `server` arg) attached to our socket (computed as above from
  their environment). Clients on another server are never raised; clients whose
  environment can't be read are a fallback. Walk their ancestors to something
  that can be raised:
  - Linux + Hyprland: `hyprctl clients -j` → `hyprctl dispatch focuswindow
    address:<addr>` (switches workspace).
  - Linux + Sway: `swaymsg -t get_tree` → `swaymsg [pid=N] focus`.
  - macOS: the first ancestor whose executable is inside an `.app` bundle
    (outermost, e.g. `/Applications/kitty.app/Contents/MacOS/kitty` →
    `/Applications/kitty.app`) → `open -a <bundle>`. This activates the app (all
    its windows come forward); no Accessibility permission is needed.
    *Unverified on real hardware (maintainer to test).* When nothing is raised,
    the server logs once per cause: no herdr client found, no `.app` among the
    ancestors (with the pid/executable chain), or the failing command with its
    stderr (`open -a …`, `ps …`).
  - Anything else: no-op. Startup prints `raise window on focus: <hyprland |
    sway | macos | unsupported here | off (--no-raise)>`.

  `--no-raise` disables it. A browser cannot raise another app's window, which
  is why the server does it.
- **Process table** (`src/server/desktop/process-table.ts`): Linux reads `/proc`
  (`stat`, `cmdline`, `environ`, `exe`; no subprocesses). macOS has no `/proc`:
  `ps -axww -o pid=,ppid=,comm=` (comm is the full executable path and may
  contain spaces), cached for 1 s; `ps -ww -o command= -p N` for argv and
  `ps -E -ww -o command= -p N` for the environment (own-user processes only).
  Arguments and environment values containing spaces are approximate there. All
  `ps` flags and output shapes are *unverified on real hardware (maintainer to
  test)*; unit tests run the parsers against hand-written fixtures. Other
  platforms get an empty table (no raise).
- **Portability**: the rest of the server is platform-neutral Node (Unix
  sockets, `fs.watch` on `~/.claude/sessions` with a poll fallback,
  `process.kill(pid, 0)` with EPERM = alive, `open` vs `xdg-open` for the
  browser). Windows is out of scope.

## The board

### Cards

A card is four app-owned elements in one app group (group id first in
`groupIds`, i.e. innermost):

- **rect** — `customData.excaliagent = {kind:"card", source, sessionId}`, 300 wide,
  sized for 2 title lines + 5 detail lines, `fillStyle: "solid"` always,
  `link` = last PR URL (Excalidraw shows its link icon).
- **title** — Excalifont (5) 20 px, `#1e1e1e`, word-wrapped to 2 lines of
  `TITLE_W` (short of the logo), the second cut with "…".
  `{kind:"card-title", sessionId, cardId}`.
- **details** — Nunito (6) 14 px, `#495057`: `repo · branch` / `status: waitingFor ·
  age` / `cache warm 41m` | `cache cold` / `herdr: ws › tab` | `not in herdr` /
  `PR #12`. Empty lines dropped. `{kind:"card-details", sessionId, cardId}`.
- **logo** — an image element, 20 px, in the rect's top-right corner, centred
  on the first title line: the harness mark (`src/web/logos.ts`; Claude's from
  simple-icons, CC0). `{kind:"card-logo", sessionId, cardId}`. Its file
  (`excaliagent-logo-<source>`, an SVG data URL) is a constant handed to
  Excalidraw on load and never stored, so the mark can change between releases.
  A source without a logo gets none.

Texts are not bound to the rect: Excalidraw allows one bound text and one font
size per text element. Widths are measured with a canvas in the browser (an
injectable `measure`; node tests use a character estimate). The first
reconcile waits for the fonts with real sample text, because faces are split by
unicode range and a bare `fonts.load("20px Excalifont")` only loads one subset.
A text box whose stored size drifts from its measured size by more than 1 px is
re-fitted, so a late font load cannot leave clipped text.

| State | Fill | Stroke |
|---|---|---|
| `needs_user`, `waiting`, `needs_trust`, `blocked` | `#ffc9c9` | `#e03131` |
| `busy` | `#ffec99` | `#f08c00` |
| `idle`, cache warm | `#b2f2bb` | `#2f9e44` |
| `idle`, cache cold or unknown | `#e9ecef` | `#868e96` |
| dormant, `exited`, or session unknown | `#f8f9fa` | `#adb5bd`, dashed |

### Inbox and lanes (`src/web/cards.ts`, `src/web/inbox.ts`, `src/web/lanes.ts`)

- **Inbox**: a grey dashed, transparent rectangle with
  `customData.excaliagent = {kind:"inbox"}` plus a free Excalifont "inbox" text
  above it (`{kind:"inbox-label"}`). New boards get a tall one at (40, 80):
  660×1628, i.e. 2 cards wide × 8 rows (20 px gaps). The user moves and resizes
  it. New cards take the first free grid slot inside its current bounds
  (`nextSlot`: columns = what fits the width, row-major, skipping any slot that
  overlaps a non-deleted card); when full, rows continue below it. Existing
  inboxes keep whatever size they have (older boards: 980×824, 3 columns).
- **Starter lanes** (Kanban): 8 rectangles one card wide (340 = 300 + 2×20),
  same height as the inbox, 40 px apart, starting 40 px right of the inbox and
  top-aligned with it. Same grey dashed transparent look. The first six have a
  free Excalifont title above them: To Do, In Progress, Review, Blocked, Parked,
  Done; the last two are untitled. Markers only: `{kind:"lane"}` /
  `{kind:"lane-label"}`. The app never patches lanes; the user owns them
  (renaming = editing the text). Cards are only ever placed in the inbox; moving
  them between lanes is the user's job.
- **When they are created**: when reconcile needs an inbox and the board has
  neither an inbox nor any lane, it creates the whole template (inbox + lanes) in
  one go. If lanes exist but the inbox was deleted, only the inbox is recreated.
  Existing boards get lanes from the main menu ("Add starter lanes", below).

### What the app may change (`src/web/reconcile.ts`)

Reconcile is pure: `(sessions, elements, now, gen, {add, measure}) →
{elements, changed, spawned, patched, retargeted, touchedIds}`; a no-op returns
the same array.

- Live session without a card → spawn in the inbox (creating the inbox, and on
  a board with no lanes the starter lanes, if missing). Picker adds (`opts.add`) spawn even when dormant. Dormant session
  without a card → nothing. Soft-deleted cards count as no card.
- Existing card → rect: only colours and `link`. Texts: only
  `text`/`originalText` and their box size; the details text is re-placed under
  the title when the title's line count changes. Never x, y, width, height,
  angle, groupIds or frameId of anything else.
- Card whose session is unknown → restyled dormant; texts and link left alone.
- `continuedIn = X` → the card is retargeted to X (rect and texts' `sessionId`)
  before spawning, following chains, unless a hop already has a card.
- Missing title/details/logo (user deleted one, or a card from before logos)
  → recreated at the rect's current position (the logo at its current right
  edge). Parts whose rect is gone → soft-deleted. Copy-pasted cards keep their
  own parts (matched by group first). The logo is never patched or moved after
  that.
- **Migration** of old cards (rect + bound 5-line label): the bound text is
  soft-deleted, a fresh group id is prepended to the rect's `groupIds`, the
  rect grows to the new height if shorter, and title/details are created at the
  rect's current position. This is the only time `groupIds` or height change.
- App patches use `CaptureUpdateAction.NEVER`: undo only undoes the user's edits.

### Interactions

- **Double-click a card** (capture phase, so Excalidraw does not enter text
  editing): live → `POST /api/focus`; dormant → `POST /api/resume`; no herdr →
  copy `cd '<cwd>' && claude --resume <id>` and toast.
- **Right-click a card**: Excalidraw 0.18 hardcodes its context menu (no API),
  and injecting into its React-managed DOM breaks on re-render. So
  `src/web/CardMenu.tsx` renders its own panel, portalled into the `.excalidraw`
  root (dark mode variables) and placed beside Excalidraw's
  `.popover .context-menu`, top-aligned with it: on the right if it fits, else
  on the left, then clamped fully into the viewport (`menuPlacement` in
  `src/web/board.ts`; it uses the panel's measured height). Above/below does not
  work: on a 1080p screen Excalidraw's own menu is ~730 px tall. Tinted with
  `--color-primary-light`, header in `--color-primary`. Items: Focus pane | Resume in herdr, Copy resume
  command, Copy resume command with cd, Open PR. They act on pointerdown and let
  the event bubble, so Excalidraw closes its menu and ours follows.
- **Main menu**: Excalidraw's `<MainMenu>` with all of its default items
  re-listed (`MainMenu.DefaultItems.*`, as Excalidraw's own default menu) plus
  "Add starter lanes" at the top. It appends the lanes beside the current
  inbox's bounds (`appendLanes`; toast if there is no inbox) as a normal
  undoable edit (`CaptureUpdateAction.IMMEDIATELY`), unlike reconcile's patches.
- **Picker**: an Excalidraw `Sidebar` toggled by "Sessions" (top right), listing
  `/api/picker` minus sessions already on the board.

### Saving

Debounced `PUT /api/scene` 500 ms after a change in element versions (non-deleted
elements plus `viewBackgroundColor`), and immediately after reconcile patches.
`scene.json` lives in `$XDG_STATE_HOME/excaliagent/` (default
`~/.local/state/excaliagent/`), written to a temp file, fsynced, renamed. An
unreadable file is moved aside as `scene.json.corrupt-<ts>` and the board starts
empty.

Pasted images: Excalidraw keeps image data (`BinaryFiles`) apart from the
elements, so the scene only holds the image element. Each image file the board
shows and the server lacks goes up once with `PUT /api/files` and is stored
as `files/<id>.json` next to `scene.json` (Excalidraw file ids are content
hashes, so a stored id is never rewritten). On load the frontend fetches the
files its image elements reference. Logo files are excluded. Files are never
deleted yet (see roadmap open questions).

## HTTP API

All routes need the token cookie and a loopback `Host`; non-GET requests with a
foreign `Origin` are refused and must be `application/json`.

| Route | Result |
|---|---|
| `GET /?token=…` | sets the HttpOnly SameSite=Strict cookie, redirects to `/` |
| `GET /api/sessions` | live `Session[]` |
| `GET /api/events` | SSE `event: sessions` with the full list on connect and on change |
| `GET /api/picker` | dormant, non-superseded sessions |
| `POST /api/lookup {ids}` | sessions by id, live or dormant |
| `GET`/`PUT /api/scene` | `{elements, appState}` |
| `PUT /api/files {files}` | 204 · 400 unless every file has an id matching `^[A-Za-z0-9_-]{1,128}$`, an `image/*` mimeType and a `data:` URL of that type |
| `POST /api/files/get {ids}` | the stored files among `ids` |
| `POST /api/focus {sessionId}` | 204 · 409 `no pane` |
| `POST /api/resume {sessionId}` | 204 · 400 bad id · 404 unknown · 409 `live` / `no herdr` |

## Security

- Bound to `127.0.0.1`. Random token in the opened URL, exchanged for a cookie.
- Host header check (DNS rebinding), same-origin and JSON-only writes (CSRF).
- Side effects: focus a pane, raise a window, start `claude --resume <id>` in a
  new pane. Ids are validated; commands are built server-side only.
- Reads only `~/.claude/sessions`, transcript metadata lines, `.git/HEAD`, and
  `/proc` (for the window raise). Writes only its state dir.

## Prior art

- herdr-dash, ekanban, herdr-kanban, herdr-workboard, herdr-code-board: columns
  or task queues, none spatial, all herdr-only.
- ExcaliDash: hosted, whole-scene writes. Orca: cards are worktrees, not agents.
- Claude Code FleetView: a session list, not spatial. Don't duplicate its
  browsing features.
- "excaliclaude" on GitHub means "Claude draws diagrams in Excalidraw"; hence the
  name excaliagent (free on npm).

## Dependency audit (2026-10-20)

All advisories come through `@excalidraw/excalidraw` 0.18.1, a dev dependency
compiled into the web bundle; the published package has no runtime
dependencies. `package.json` `overrides` pin patched versions within the same
major: `lodash-es` ^4.18.1, Excalidraw's `nanoid` ^3.3.20, and
`mermaid-to-excalidraw`'s `nanoid` ^5.1.16 (no patched 4.x; same API). Left
open: `braces` (no fixed version; build-time only, via Excalidraw's `sass` →
`chokidar`) and `katex` (low; a fix needs a 0.x minor jump inside mermaid's
math rendering). Re-check when upgrading Excalidraw and drop overrides it no
longer needs.
