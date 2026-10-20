# excaliagent: design

How the board works and why. `product.md` is the goal state; this file is the
reference for changing the code. Facts about Claude Code, Codex and herdr are
undocumented upstream: each says which version it was verified on. Re-verify
before relying on one after an upgrade, and update this file.

## Shape

```
Claude Code, Codex ► Source (src/server/sources) ──┐
                                                    ├─► Hub ──SSE──► browser: reconcile ──► Excalidraw scene
herdr socket ───────► PaneLink (src/server/panes) ──┘     ▲                                     │
                                                          └──── PUT /api/scene (scene.json) ◄───┘
```

- `npx excaliagent` starts one Node process on `127.0.0.1:7357` (a random port
  if that is busy) and opens the browser with the access token. One server per
  state dir: it records `{port, pid}` in `<stateDir>/server.json`; a second
  start finds it (pid alive, answers to the token), opens that board and exits,
  so two servers never overwrite each other's `scene.json`.
- The **server** reads sessions, links them to herdr panes, streams
  `Session[]` over SSE, stores the scene, and performs the only side effects
  (focus a pane, resume into a new pane, raise the terminal window, end a
  session the user chose to stop).
- The **frontend** owns the scene. On every sessions update (and every 30 s, for
  ages and cache minutes) it runs the pure `reconcile` and applies the patches.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Card unit | One card per **agent session** (never per pane or workspace) | Two agents in one worktree are two things to triage |
| Source of truth | **Each harness's own files**: `~/.claude/sessions/<pid>.json` + transcripts; Codex rollouts + held thread locks. herdr is optional | The board is mostly for dormant sessions, which have no pane |
| Identity | The harness's session id (Claude `sessionId`, Codex thread id), not qualified by harness; the card survives exit and resume | Claude ids are random UUIDs (v4), Codex ids time-ordered UUIDs (v7): they cannot collide, and existing boards keep their cards. The card rect records `source` |
| Several harnesses | One `Source` per harness behind `combineSources` (`src/server/sources/multi.ts`); each rejects ids not in its format; a failing one degrades to no sessions | Harness code stays in its adapter |
| Resume command | Built by the adapter from the validated id and sent as `Session.resumeCommand`; the web only prefixes `cd` | `src/web` knows harnesses by display name and logo only |
| Spawning | Live sessions auto-spawn into the inbox; dormant ones come from the picker | 40 transcripts in one project would flood the board |
| Single writer | Frontend writes the scene; the server never edits elements | Excalidraw and a second writer would fight over drags |
| Pane link | Registry `pid` == a pane's foreground process pid | Zero installs: no hooks, no herdr integration |
| Send input | **Never into a session.** Focus, and the resume command in a *new* pane | Small security surface |
| Notes | Free elements the user places; the app only writes its own card elements | Simple patching, user content never touched |
| Loudest signal | needs input (`needs_user`, `waiting`, `needs_trust`, `blocked`), then idle + warm cache | "Review me before the cache goes cold" |
| Stack | Node/TypeScript; server has zero runtime deps; Vite + React + `@excalidraw/excalidraw` | One toolchain; `npx` stays light |
| Fonts | Excalidraw fonts except Xiaolai (CJK) are served locally (`EXCALIDRAW_ASSET_PATH = "/"`); Xiaolai loads from Excalidraw's default CDN | Keeps offline Latin text, ~3 MB package |
| Runtime | Node (not Bun) | `npx` works wherever Claude Code does |
| Characters | Emoji packs built in; custom packs are folders in the state dir; assignment remembered server-side in `characters.json` | Emoji need no licence or bundled art; folders work by hand; remembering keeps a session's character stable when cards come and go (see "Characters") |

## Session model

`src/shared/types.ts`:

```ts
interface Session {
  id: string; source: "claude" | "codex"; cwd: string;
  repo: string; repoRoot?: string; branch?: string;
  title?: string; name?: string;
  status: "busy"|"idle"|"waiting"|"needs_user"|"needs_trust"|"blocked"|"exited"|"dormant";
  waitingFor?: string; lastActivityAt: number;
  cacheTtlMs: number; cacheExpiresAt: number;     // 0 = unknown
  live: boolean; pid?: number;
  pane?: { paneId; workspaceId; workspaceLabel?; tabLabel? };
  prLinks: string[]; continuedIn?: string;
  resumeCommand?: string;   // built server-side, e.g. "codex resume <id>"
  canEnd?: boolean;         // the process is known exactly: Stop may be offered
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

## Codex data (verified on 0.163.0)

How these were learned: the source at tag `rust-v0.163.0`
(github.com/openai/codex, `codex-rs/`), and throwaway runs of the installed
`codex-cli 0.163.0` (Linux, nix build) with a temporary `HOME`/`CODEX_HOME`/
`XDG_*`, a `config.toml` pointing a custom `model_provider` at a local mock of
the Responses API, `codex exec` and the TUI inside an isolated tmux server.
"(V)" = seen in those runs; "(S)" = read from source only. Never checked
against a real Codex home.

### Home

`$CODEX_HOME`, else `~/.codex` (V with `CODEX_HOME`). Besides the files below it holds SQLite databases
(`state_5.sqlite`, `logs_2.sqlite`, `thread_history_1.sqlite`, …), which the
board does not read: rollouts and lock files are enough, and that avoids
`node:sqlite`.

### Rollouts: `sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`

- Name: `rollout-2026-10-20T14-07-46-<uuid>.jsonl`; date dirs and the stamp are
  local time (V). A reverted thread appends `_<rollout id>` (S:
  `rollout/src/rollout_file_name.rs`). Rollouts older than 7 days may be
  compressed to `.jsonl.zst` by a background job (S: `rollout/src/compression.rs`);
  they are decompressed whole and asynchronously with Node's zstd (22.15+;
  output capped at 256 MB), else skipped with one warning.
  Archived threads move to `archived_sessions/` and are not listed.
- Thread ids are UUIDv7 (V: `01a15935-e3d1-71c2-…`), so their creation time is
  in the id; the board looks for a thread's file in that day's directory first.
- The file appears only with the first prompt: a fresh TUI's thread has no
  rollout yet, and no `sessions/` directory exists before the first one,
  while the daemon already holds its lock (V on 0.163.0: TUI opened in a
  throwaway home, lock present, no rollout until a prompt was sent; S:
  `deferred_creation` in `rollout/src/recorder.rs`). Such a live card has no
  line to date it: `lastActivityAt` falls back to the newest line's
  `timestamp`, else the rollout's mtime, else the thread's creation time from
  its v7 id. (Before this fallback such a card read "idle 20746d": age since
  the epoch.)
- Each line `{"timestamp", "ordinal", "type", "payload"}` (V), `timestamp` an
  ISO string in UTC with milliseconds, `2026-10-20T16:34:30.112Z` (V on
  0.163.0; S: `JsonlWriter::write_rollout_item`, `rollout/src/recorder.rs`). Used:

| `type` / `payload.type` | Fields used | Notes |
|---|---|---|
| `session_meta` | `id`, `cwd`, `git.branch`, `source`, `thread_source`, `parent_thread_id` | First line. `source` is `"vscode"` for the TUI (it talks to the app-server as a client; V), `"exec"` for `codex exec` (V), an object for sub-agents (S); `originator` `codex-tui` / `codex_exec` (V). `git` is `{}` outside a repo with commits (V) |
| `event_msg` `task_started` | | A turn began → busy (V). Alias `turn_started` (S) |
| `event_msg` `task_complete`, `turn_aborted` | | Turn over → idle (V: done, and Esc → `turn_aborted` `reason: "interrupted"`). Alias `turn_complete` (S) |
| `event_msg` `item_completed` with `item.type: "UserMessage"` | `item.content[].text` | First one = fallback title, collapsed and cut to 120 chars (V). Legacy rollouts: `event_msg` `user_message.message` (S) |
| any line | `timestamp` | Newest one = `lastActivityAt` (fallbacks above) |

  Not persisted (S: `rollout/src/policy.rs`): approval requests, questions,
  errors. So a Codex card cannot show "needs input": a turn waiting for
  approval stays busy. No prompt-cache TTL and no PR links are recorded:
  Codex cards show neither.
- The picker hides sub-agent, review and memory threads (`thread_source` not
  `user`, `parent_thread_id`, object `source`) and `exec`/`mcp` runs, like
  Codex's own resume picker (S: `INTERACTIVE_SESSION_SOURCES`).

### Names: `session_index.jsonl`

`{"id","thread_name","updated_at"}` appended on `/rename` (V); the last line
for an id wins. Title = name, else first prompt (this is what `codex resume`
shows too).

### Liveness: `thread-writer-locks/<thread id>.lock`

- Whoever has a thread loaded creates `<id>.lock` and holds an exclusive
  `flock` on it; unloading unlocks and deletes it (S:
  `rollout/src/writer_lock.rs`, `thread-store/src/local/live_writer.rs`; V).
  After a crash the file stays but the lock is gone, so only a **held** lock
  counts. Linux: the holder pid is found in `/proc/locks` by the file's inode
  (`FLOCK ADVISORY WRITE <pid> <maj:min:inode>`; the device numbers differ
  from `stat` on btrfs, so only the inode is matched) and confirmed by the
  path being open in `/proc/<pid>/fd` (V). `.coordination.lock` is ignored.
- **The TUI does not hold it.** `codex` (TUI) starts or reuses one shared
  app-server daemon per Codex home, `codex app-server --listen unix://
  --analytics-default-enabled --managed-daemon` (pid in
  `app-server-daemon/daemon.pid`), and that daemon loads the thread and holds
  the lock (V). A second TUI connects to the same daemon (V). The TUI process
  keeps nothing thread-specific open; its argv is `codex` or
  `codex resume <id>` (V).
- The daemon keeps a thread loaded for `thread_unload_delay_secs` (default
  1800 s) after its last client left and it went idle (S:
  `app-server/src/request_processors/thread_lifecycle.rs`,
  `core/src/config/mod.rs`; V: still held a minute after the TUI exited). A held
  lock alone therefore does not mean anyone is looking at the thread.
- `codex exec` runs without the daemon and holds the lock itself (S; V: its
  lock file was gone after it exited; the holder pid was not inspected).
- **Rule** (`src/server/sources/codex-live.ts`): a thread held by a non-daemon
  Codex process is live in that process. A thread held by the daemon is live
  only when a TUI process claims it: first by argv (`resume <id>`), then each
  remaining TUI (latest start time first, from `/proc/<pid>/stat` + `btime`)
  claims the most recently loaded (lock file
  birth time) unclaimed user thread whose `session_meta.cwd` (realpath) equals
  the TUI's `/proc/<pid>/cwd`, or one with no rollout yet (a fresh TUI's).
  Unclaimed daemon threads are lingering → dormant. Its pid is the TUI's, so
  herdr links the pane like Claude's. The npm shim (`node …/codex.js`, S) and
  its native child count once, as the shim. A TUI that names a thread
  (`resume <id>`) never falls back to the directory rule, even when that
  thread is not loaded or taken.
- **Exact or guessed**: an in-process holder and a `resume <id>` claim are
  exact; a directory claim is a guess. Only exact matches set
  `Session.canEnd` (the board offers Stop) and only they can be stopped
  (`end` answers "unsupported" otherwise), so a guess never sends a SIGTERM.
- **Known gap**: in one directory, a TUI that is still open on an older
  thread while a newer thread of a closed TUI lingers in the daemon (up to
  30 min) is matched to the newer one. Also `/new` or `/resume` inside a TUI
  switches threads without changing its argv; the cwd rule then picks the
  newest. Mismatches only affect which of two same-directory cards is live.
- Processes are only inspected when a lock file exists, and other processes'
  command lines and cwds only when the daemon holds one. Not Linux (no
  `/proc/locks`): no live Codex sessions; they are offered as dormant only.
  macOS (e.g. `lsof`) is not done.
- `fs.watch` on the lock dir (threads load and unload) plus a 2 s poll (turns
  start and end only in the rollouts). One look (process scan, rollouts, git)
  is reused for a poll interval by `list`, `listDormant` and `get`, so looking
  up many cards does not rescan; the watcher always looks afresh.
- The proc root is an option (`EXCALIAGENT_PROC_ROOT` for the CLI, not a
  documented flag): tests and the demo point it at a synthetic tree
  (`test/mock-proc.ts`), so they never read the machine's processes.

### Resume and stop

- Resume: `codex resume <id>` in the session's cwd (V: `codex resume --help`,
  and resuming reopened the thread through the daemon).
- Stop (exact matches only, see above): SIGTERM to the TUI pid, after a fresh
  check that it is still a Codex process that is not the daemon. The TUI exits (V); the daemon keeps the thread
  loaded, which the rule above treats as lingering, so the card turns dormant.
  A `codex exec` holder is SIGTERMed itself. The daemon is never signalled
  (it serves every TUI).

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
  Every foreground pid maps to its pane (exact match). Fallback: every
  descendant of a pane's `shell_pid` (from the process table) maps to that
  pane, so a session still matches while a command it runs holds the terminal
  or while it is suspended (Ctrl+Z). Foreground wins.
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
  `pane.send_text "<resumeCommand>\n"` (e.g. `claude --resume <id>`) and raise.
  The id must match `SESSION_ID` (`src/server/hub.ts`: the union of the
  harnesses' id formats; Claude and Codex: a UUID) and the owning source's own
  format; the command is built server-side by that source only. The
  characters store keys by the same check.
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

A card is five app-owned elements in one app group (group id first in
`groupIds`, i.e. innermost):

- **rect** — `customData.excaliagent = {kind:"card", source, sessionId, appHeight, charLayout?}`,
  300 wide, as tall as its title needs: room for 1 or 2 title lines + 5 detail
  lines (`cardHeight`; 156 or 181 px). `appHeight` is the height the app last
  gave it (see "What the app may change"). `fillStyle: "solid"` always,
  `link` = last PR URL (Excalidraw shows its link icon). `charLayout: 1` once
  the card got its character (see "What the app may change").
- **character** — an image element, 32 px (`AVATAR_SIZE`), at the rect's
  top-left inside the padding (14, 14): the session's character (see
  "Characters"). `{kind:"card-character", sessionId, cardId}`. It sits beside
  the title only: it ends at y = 46, and the details start at y = 47 under a
  one-line title (72 under two), so the card height is the same as without it.
- **title** — Excalifont (5) 20 px, `#1e1e1e`, at `TITLE_X` = 14 + 32 + 8 = 54
  px from the rect's left, word-wrapped to 2 lines of `TITLE_W` (204 px: from
  the character to short of the logo), the second cut with "…".
  `{kind:"card-title", sessionId, cardId}`.
- **details** — Nunito (6) 14 px, `#495057`: `repo · branch` / `status: waitingFor ·
  age` / `cache warm 41m` | `cache cold` / `herdr: ws › tab` | `not in herdr` /
  `PR #12`. Empty lines dropped. The age is left out (`idle`, not
  `idle · 20746d`) when `lastActivityAt` is missing (0) or implausible (before
  2020 or more than a day ahead), whatever the harness (`sessionAge`); the
  picker does the same. Full width (`TEXT_W` 272 px) at the rect's left
  padding, under the title. `{kind:"card-details", sessionId, cardId}`.
- **logo** — an image element, 20 px, in the rect's top-right corner, centred
  on the first title line: the harness mark (`src/web/logos.ts`; Claude's from
  simple-icons, CC0; simple-icons has no OpenAI mark, so Codex gets a neutral
  `>_` glyph drawn for this project, dark grey, evenodd holes). `{kind:"card-logo", sessionId, cardId}`. Its file
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
  `customData.excaliagent = {kind:"inbox"}` and the title "Inbox" bound inside
  it (`{kind:"inbox-label"}`, see titles below). New boards get a tall one at
  (40, 80): 660×1664, i.e. 2 columns of 8 two-line cards (20 px gaps) under a 56 px
  header (`AREA_HEADER`). The user moves and resizes it. New cards go in
  its columns (`columnsOf`: as many 300 px columns as fit the current width,
  20 px from the left edge and apart), each column stacked on its own
  (`nextSlot` → `firstFree` in `src/web/inbox.ts`): a spot is free when the
  new card, as tall as its title needs, stays at least `GAP` (20) clear of
  every non-deleted card (by its rotated bounds) above and below it. The
  candidates are the top under the header and `GAP` below each card in the
  column; the topmost free one wins, the leftmost column on a tie, so cards
  fill the columns side by side and a hole is reused only if the card fits
  it fully. When full, the columns continue below the inbox. Existing
  inboxes keep whatever size they have (older boards: 980×824, 3 columns).
  See "Column spacing" below for the trade-off of gaps by actual height.
- **Starter lanes** (Kanban): 8 rectangles one card wide (340 = 300 + 2×20),
  same height as the inbox, 40 px apart, starting 40 px right of the inbox and
  top-aligned with it. Same grey dashed transparent look. The first six are
  titled To Do, In Progress, Review, Blocked, Parked, Done; the last two are
  untitled. Markers only: `{kind:"lane"}` / `{kind:"lane-label"}`. The app
  never patches lanes; the user owns them (renaming = double-clicking the lane).
- **Titles** are Excalidraw bound text (`containerId` = the area,
  `verticalAlign: "top"`, `textAlign: "center"`), Excalifont 28 `#495057`, so
  they move with their box and cannot be dragged apart; placed and measured like
  Excalidraw would (5 px bound-text padding, the canvas measurer). An untitled
  lane has no text element (Excalidraw drops empty bound text). Boards from
  before 0.3.0 keep their free titles above the boxes; the app never rewrites
  lanes. Reconcile only ever places cards in the inbox; moving them between
  lanes is the user's job, helped by the lane drop zone, "Tidy cards" and
  "Tidy all" (below), which move cards only in direct response to the user's gesture.
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
- Existing card → rect: only colours, `link`, and its height fitted to the
  title's line count (`cardHeight`, growing or shrinking downwards from the
  same top edge) with `appHeight` updated to match. The height is fitted only
  while the rect is unrotated (`angle` 0; a height change would shift a rotated
  card's rotation centre) and its height still equals `appHeight` (±0.5 px). A
  card from before fitting has no `appHeight`; it counts as app-sized when it
  is exactly the old fixed height (`CARD_H`, 181), so existing boards get
  fitted too. A card the user resized (or scaled) differs and keeps its height
  from then on. Texts: only
  `text`/`originalText` and their box size; the details text is re-placed under
  the title when the title's line count changes. Never x, y, width,
  angle, groupIds or frameId of anything, nor the height of anything else.
- Card whose session is unknown → restyled dormant; texts and link left alone
  (never moved either).
- `continuedIn = X` → the card is retargeted to X (rect and texts' `sessionId`)
  before spawning, following chains, unless a hop already has a card.
- Missing title/details/logo (user deleted one, or a card from before logos)
  → recreated at the rect's current position (the logo at its current right
  edge). Parts whose rect is gone → soft-deleted, so a lone copy of a logo or
  character pasted without its card is cleaned up. Copy-pasted cards keep their
  own parts (matched by group first); a pasted card's character is re-derived
  from its session like any other card's. The logo is never patched or moved
  after that.
- **Character** (only once character data has loaded; never for a card the
  session of which has no character data at all):
  - A card without `charLayout` gets its character at the rect's current
    top-left (PAD, PAD) and `charLayout: 1`. In the same pass its title moves to
    `TITLE_X` **only if it is still exactly at the old app spot** (x = rect.x +
    14, y = rect.y + 14, where cards up to 0.3 had it); a title the user moved
    stays. Details never move for this (they keep their old spot, which is
    still right). This happens once per card.
  - If the card's session is unknown (no session data), nothing moves: the
    character is added only if it does not overlap the title, otherwise the
    card waits (no flag) until its session is known.
  - With `charLayout` set and no character element, the user removed it
    (deleted it, or picked *None*): it is never recreated and the title is not
    moved back. Picking a character (or *Reset to automatic*) in the picker
    clears the flag, so it is added again (the title is already right of it).
  - An existing character: only its `fileId`, when the session's character
    changes; never moved or resized (the user may). When the session has no
    character (empty pack) it is soft-deleted and `charLayout` cleared, so it
    comes back with the next character.
- **Migration** of old cards (rect + bound 5-line label): the bound text is
  soft-deleted, a fresh group id is prepended to the rect's `groupIds`, the
  rect grows to the new height if shorter, and title/details are created at the
  rect's current position. This is the only time `groupIds` change. A card
  grown to `CARD_H` this way counts as app-sized and is fitted in the same pass;
  a taller one keeps its height.
- App patches use `CaptureUpdateAction.NEVER`: undo only undoes the user's edits.

Reconcile never moves a card. The only code that does is the lane drop zone,
"Tidy cards" and "Tidy all" (Interactions), each the direct result of one
user gesture, as an undoable edit of its own; they change only x/y of card
rects and their own group's parts, never lanes or anything the user drew.
**Fixed cards** (`isFixedCard`) are never moved: locked, rotated (`angle` ≠
0), bound to an arrow (an arrow id in the rect's `boundElements`; moving the
card would leave the user's arrow behind, and the app never edits user
drawings), or in a user group (`groupIds.length > 1`). They stay where they
are as obstacles: the column flows around and below them (rotated ones by
their rotated bounds), and a fixed card being dragged is never placed.

### Interactions

- **Double-click a card** (capture phase, so Excalidraw does not enter text
  editing): live → `POST /api/focus`; dormant → `POST /api/resume`; no herdr →
  copy `cd '<cwd>' && <resumeCommand>` and toast. The Stop confirm names the
  harness (`HARNESS_NAMES` in `logos.ts`); picker rows show its logo.
- **Right-click a card** (or a lane, below): Excalidraw 0.18 hardcodes its context menu (no API),
  and injecting into its React-managed DOM breaks on re-render. So
  `src/web/CardMenu.tsx` renders its own panel, portalled into the `.excalidraw`
  root (dark mode variables) and placed beside Excalidraw's
  `.popover .context-menu`, top-aligned with it: on the right if it fits, else
  on the left, then clamped fully into the viewport (`menuPlacement` in
  `src/web/board.ts`; it uses the panel's measured height). Above/below does not
  work: on a 1080p screen Excalidraw's own menu is ~730 px tall. Tinted with
  `--color-primary-light`, header in `--color-primary`. Items: Focus pane | Resume in herdr, Copy resume
  command, Copy resume command with cd (both from the server's
  `resumeCommand`), Open PR, Change character…, Stop session… (only when the
  server set `canEnd`). A card whose session is unknown (its files are gone)
  gets only Change character…: the character belongs to the card, while
  resuming needs the server's command (it used to offer `claude --resume <id>`). They act on pointerdown and let
  the event bubble, so Excalidraw closes its menu and ours follows.
- **Main menu**: Excalidraw's `<MainMenu>` with all of its default items
  re-listed (`MainMenu.DefaultItems.*`, as Excalidraw's own default menu) plus
  "Add starter lanes" and "Tidy all" at the top. "Add starter lanes" appends
  the lanes beside the current inbox's bounds (`appendLanes`; toast if there
  is no inbox) as a normal undoable edit (`CaptureUpdateAction.IMMEDIATELY`),
  unlike reconcile's patches. "Tidy all" is below.
- **Reset the canvas** (Excalidraw's own main menu item): an empty scene
  triggers a sync at once, so reconcile lays out the starter board with the
  live sessions instead of waiting for the next 30 s tick.
- **+ Lane** (top right, beside "Sessions"): `addLane` appends one lane right
  of the rightmost lane or inbox, top-aligned with it and as tall, titled "New
  lane"; the same kind of undoable edit, then scrolled into view. Beside it,
  **Tidy all** (same button style; also in the main menu).
- **Picker**: an Excalidraw `Sidebar` toggled by "Sessions" (top right), listing
  `/api/picker` minus sessions already on the board.
- **Top-right buttons** (`TopBar.tsx`, `topbar.ts`, `topbar.css`): "+ Lane",
  "Tidy all", "Characters" and "Sessions" are styled like Excalidraw's Library button (its
  `sidebar-trigger` class): a 24 px tabler-style icon (stroke 1.25, like
  Excalidraw's) and a one-line label. `sidebar-trigger` sets `line-height: 0`,
  so a label that wraps draws its lines over each other; ours never wrap.
  `topBarLayout(appState.width, isMobile, n)` picks the layout from the canvas
  width that `renderTopRightUI` receives: **labels** when there is room beside
  the toolbar and the labelled Library button; **icons** (label hidden, kept
  as `title` tooltip and `aria-label`) when there is not; **column** (icons in
  a column flush with the right edge, below Excalidraw's own right-hand
  controls, styled like its mobile tool column) when even icons do not fit,
  and always in Excalidraw's phone layout (`isMobile`, under 730 px), whose
  top row is all toolbar. The thresholds are fixed estimates of Excalidraw
  0.18.1's widths (toolbar ~550 px); an e2e test checks at 400–1400 px that
  nothing overlaps. Excalidraw's Library button itself only drops its label
  in the phone layout; just above it (730–750 px) Excalidraw's own Library
  button runs up to 18 px past the right edge, with or without ours.
- **Lane drop zone** (`src/web/lanes.ts`: `dropZone`, `dropLaneAt`,
  `slotBelow`, `draggedCard`; wiring in `App.tsx`): a lane's drop zone is its
  title band, the full lane width × `AREA_HEADER` (56) from its top edge, i.e.
  where its title sits. Chosen over the whole lane so free placement inside a
  lane keeps working, and over a small button so it needs no extra element.
  The hit test uses the pointer, not the card. While Excalidraw reports
  `selectedElementsAreBeingDragged`, the selection is exactly one card (its
  rect plus its own parts; any other selected element opts out, as does a
  fixed card or Alt held), a temporary overlay (a `position: fixed`,
  `pointer-events: none` div placed with `sceneCoordsToViewportCoords`, never a
  scene element) makes the zones discoverable: every lane title band in the
  viewport (`zonesInView`, from the lane list taken once at drag start with
  `lanesOf`) gets a faint dashed outline and tint with a small "drop to stack"
  caption above it. The band under the pointer instead gets the strong
  highlight, and the target slot is outlined. The hints go on drop, when the
  button is released anywhere, or when the drag stops qualifying. On drop
  (Excalidraw's `onPointerUp` API, then a `setTimeout(0)` so Excalidraw has
  committed its drag first), the card group moves to `slotBelow`: x = lane x +
  `GAP`, y = `GAP` below the actual bottom of the lowest other card whose
  centre is inside the lane, or right under the header. Lanes are never grown. Its own edit with
  `CaptureUpdateAction.IMMEDIATELY`, after Excalidraw's drag edit, so undo
  takes two steps: the first puts the card back where it was dropped, the
  second undoes the drag. Alt held (Excalidraw's duplicate-drag) opts out.
  The overlay is portalled into the `.excalidraw` root (like the card menu)
  and coloured with `var(--color-primary)`, so it follows the light/dark
  theme. The App re-renders only when the visible bands, the hovered zone or
  the target slot change (to the whole px), not on every pointer move.
- **Column spacing** (`slotBelow`, `tidyMoves`, `nextSlot`): cards in a
  column are always exactly `GAP` (20) apart, measured from the actual
  bottom of the card above (its rotated bounds for a fixed card), whether it
  has one title line or two or was resized. No room is reserved for a title
  to grow. Trade-off, chosen for even spacing: when a title later wraps onto
  a second line, its card grows by one title line (25 px) and overlaps the
  card below by about 5 px. The app never moves cards on its own, so it
  stays that way until the user runs Tidy cards / Tidy all again, which
  restores the gaps.
- **No modifier key** for "stack anywhere over a lane": in Excalidraw 0.18.1
  every modifier already means something during a drag. Shift locks the axis,
  Alt duplicates, Ctrl/Cmd toggles object snapping (and at pointer-down starts a
  box selection instead of a drag); Meta/Super is the window manager's on
  Linux (Hyprland, Sway). Checked in `dist/dev/index.js` of 0.18.1.
- **Tidy cards** (right-click inside a lane, or the inbox, where nothing
  drawn above it but its own title is under the pointer, `laneTargetAt`,
  using each element's rotated or point bounds; elements below it do not
  count. Our menu section then holds this one item): `tidyMoves` takes the
  movable cards whose centre is in the area, sorted by y (then x). In a lane
  they stack in one column under the header, strictly top-down, with the
  column spacing above. In the inbox each card in turn takes the first free
  spot of the inbox's columns (`firstFree`, the same rule as new cards), so
  the grid is compacted in reading order. A spot that would come within
  `GAP` of a fixed card moves below it. One undoable edit.
- **Tidy all** (button beside "+ Lane", and the main menu): `tidyAllMoves`,
  i.e. `tidyMoves` for every lane and the inbox, merged into one move map
  (a card inside two overlapping areas goes with the first in scene order)
  and applied as one undoable edit, so a single Ctrl+Z puts every card back.
  The inbox is included because it follows the same column rule; a toast
  says so when everything is already tidy.
- **Setting**: main menu → "Drop on lane title stacks cards" (a checkbox item,
  on by default) turns the drop zone off. Stored per browser in `localStorage`
  (`excaliagent.laneDrop` = `on`/`off`); every access is wrapped in try/catch,
  and unreadable storage means on. "Tidy cards" and "Tidy all" are always available.

### Characters (`src/web/characters.ts`, `src/server/characters.ts`, `src/shared/packs.ts`)

- **Packs.** A pack is an ordered list of characters, each an emoji or an
  image. Built-ins (`src/shared/packs.ts`): `@animals` (default), `@cats`,
  `@sea`, `@fantasy`, `@food`, 28–40 emoji each, from Unicode ≤ 12 without
  ZWJ sequences or variation selectors so common emoji fonts have them. The
  `@` keeps their ids apart from custom pack names. Read-only; "Duplicate to
  edit" copies one into a custom pack.
- **Custom packs** are folders `<stateDir>/packs/<name>/`, `name` matching
  `^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$`. Other entries (invalid names, links)
  are ignored and reported as `problems`, shown in the panel. A pack id must
  match a folder exactly as the directory lists it, so on a case-insensitive
  file system "FOO" never aliases "foo"; names that differ only in case count
  as taken (renaming "foo" to "Foo" works). Characters: the emoji of an
  optional `pack.json` (`{"emoji": ["🧟", …]}`, invalid entries dropped) in
  order, then image files sorted by name. Listed images: regular files (no
  symlinks, not hidden) with extension png, gif, webp, jpg, jpeg or svg, at
  most 1 MB, whose first bytes match the type (PNG/GIF/WebP/JPEG magic, or an
  `<svg` root). At most 200 characters; listing stops there, without hashing
  the rest. A pack that cannot be read fully lists what it can plus an
  `error`; other packs are unaffected. Uploaded file names are reduced to
  `[A-Za-z0-9_-]` plus the type's extension, numbered if taken.
- **Drawing.** The card's character is an image element, so emoji and pack
  images take one path and render the same in exports. Emoji become an SVG
  with a `<text>` in the system emoji font, under the file id
  `excaliagent-emoji-<code points in hex>`; the board rebuilds it from the id,
  so it is never stored. Pack images get `excaliagent-img-<sha256[:24] of the
  bytes>` and are fetched from `/api/packs/<pack>/<file>?v=<that hash>`, then
  handed to Excalidraw. Like logos, files whose id starts with `excaliagent-`
  are never uploaded to `files/`, so a pack image is stored once, in its pack
  folder. An image that cannot be fetched is drawn as ❔ (`excaliagent-emoji-2754`),
  reported once in the console, and retried on the next 30 s tick; the
  remembered pick is not changed. The panel and picker show ❔ for it too.
- **Assignment** (pure, `assignCharacters`): over the sessions that have or
  are about to get a card, in board order. (1) An override (from any pack)
  wins. (2) Else the remembered pick for the active pack, if that character
  still exists, taken in the order the picks were made (the key order of
  `assigned[pack]`). (3) Everyone else: start at FNV-1a(session id; the
  same for every harness: Claude, Codex) mod pack
  size and probe linearly (wrapping) to the first character no other card
  uses; if all are used, take the start slot (duplicates). New picks are
  remembered at once, so a character never shifts when the cards it collided
  with leave, and survives the card being deleted and re-added. Each pack
  remembers its own picks, so switching packs and back restores them. A
  `continuedIn` continuation inherits the remembered pick and override of the
  session it continues.
  **Uniqueness wins over memory in one case only:** when a remembered pick is
  already shown by another card (an override, or an earlier pick: e.g. a card
  came back after another session probed onto its character) and the pack
  still has a free character, the later pick probes again (and the new pick is
  remembered). An exhausted pack keeps remembered duplicates. Overrides are
  never re-probed.
- **Keeping in step with the server** (`CharacterSync`): new picks count at
  once and are POSTed one batch per pack at a time; they stay pending until the
  server's answer confirms (or drops) them, so a failed POST is resent on the
  next 30 s tick. Every answer is the whole state; answers are numbered and one
  that arrives after a newer one was applied is not applied (only the picks it
  confirmed are merged). The server drops picks for unknown packs, characters
  or sessions instead of refusing the batch. The board re-reads
  `/api/characters` on every tick and when the Characters panel opens, so
  hand-edited pack folders show up.
- **Override**: right-click → "Change character…" opens a picker (our own
  dialog, portalled into `.excalidraw` for the theme; it takes focus, keeps
  Tab inside and closes on Escape) with every pack's characters, Shuffle (a
  random character of the active pack not on the board, else any other),
  Reset to automatic and None (removes the character from the card, as an
  undoable edit; see "What the app may change").
- **Characters panel**: an Excalidraw `Sidebar` ("Characters", top right) with
  our own UI in Excalidraw's library style: each pack row has a radio that
  makes it active and also shows it below, so right after a choice the
  checked radio and the preview always agree; clicking anywhere else on the
  row (its name is a "Show …" button for the keyboard) only shows the pack.
  The shown pack's row is highlighted (no extra status line: the maintainer
  found it noise); the radio stays checked on the pack chosen until the server
  answers. Create, rename, delete, duplicate; a pack's characters as
  library-like cells; add emoji by typing or pasting, images by pasting into
  that field (placeholder "Emoji or image", the full hint in its tooltip, so it
  fits the panel), dropping (the drop is stopped so Excalidraw does not also put the
  image on the canvas) or uploading.
- **`<stateDir>/characters.json`** (written atomically, a failed write leaves
  no temp file; a corrupt file is moved aside as
  `characters.json.corrupt-<ts>` and starts empty; malformed entries of a
  hand-edited one are dropped; an active pack that no longer exists falls back
  to `@animals`):

  ```json
  {"version": 1, "activePack": "@animals",
   "assigned": {"@animals": {"<session id>": "🐱"}, "mobs": {"<session id>": "creeper.png"}},
   "overrides": {"<session id>": {"pack": "@sea", "id": "🐙"}}}
  ```

  Renaming a pack moves its entries (characters.json is written first and put
  back if the folder cannot be renamed, so the two never disagree); deleting
  one, or removing a character, forgets the entries that point at it. The
  choice lives server-side, not in card `customData` (as #12 first suggested),
  because it must outlive the card.

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
| `POST /api/end {sessionId}` | 204 ended (SIGTERM) · 400 bad id · 409 not running · 501 source cannot end |
| `GET /api/characters` | `{activePack, assigned, overrides, packs: [{id, name, builtIn, characters: [{id, kind, fileId, url?}], error?}], problems?}` |
| `POST /api/characters/assign {pack, assign: {sessionId: id}}` | the same data, with picks for unknown packs, characters or sessions dropped · 400 malformed |
| `POST /api/characters/override {sessionId, character: {pack, id} \| null}` | the same data · 400 |
| `POST /api/characters/active {pack}` | the same data · 400 unknown pack |
| `POST /api/packs {name, from?}` | creates a custom pack (empty, or a copy of `from`) · 400 bad name · 409 exists (in any letter case) |
| `POST /api/packs/rename {pack, name}`, `/delete {pack}` | · 403 built-in · 404 unknown · 409 name taken |
| `POST /api/packs/emoji {pack, emoji}` | adds one emoji (a single grapheme) · 400 · 403 built-in |
| `POST /api/packs/image {pack, name, dataURL}` | adds a base64 png/gif/webp/jpeg/svg ≤ 1 MB whose bytes match its type · 400 · 403 |
| `POST /api/packs/remove {pack, id}` | removes an emoji or image · 404 not in the pack |
| `GET /api/packs/<pack>/<file>?v=<hash>` | one image, checked on its own like a listing would (valid pack folder, listable name, regular file, size, type) · `nosniff`, a sandboxing CSP; `private, max-age=31536000, immutable` when `v` is its content hash, else `no-store` |

Body limits: `/api/packs/image` 1.5 MB, the other character and pack routes
64 KB, refused from `content-length` before reading (413); other routes 50 MB.

## Security

- Bound to `127.0.0.1`. A random token, created once per state dir
  (`<stateDir>/token`, mode 0600) and reused, goes in the opened URL and is
  exchanged for an HttpOnly cookie named `excaliagent_token_<port>` (cookies
  ignore ports; two boards must not clobber each other) with a one-year
  `Max-Age`, so `http://127.0.0.1:7357/` works as a bookmark. On a single-user
  machine the Host/Origin checks already stop websites; the token keeps other
  local users out of your session list and herdr.
- Host header check (DNS rebinding), same-origin and JSON-only writes (CSRF).
- Side effects: focus a pane, raise a window, start `claude --resume <id>` or
  `codex resume <id>` in a new pane, end a session (`POST /api/end`, after a
  confirm in the UI: SIGTERM to the registry pid, only if that pid is still a
  `claude` process, which guards against pid reuse; for Codex to the TUI
  (or `codex exec`) pid of an exact match, only if it is still a `codex`
  process and not the shared daemon). Ids are validated; commands and pids are derived
  server-side only.
- Reads only `~/.claude/sessions`, transcript metadata lines, Codex rollouts
  (metadata, turn markers, the first prompt as title), `session_index.jsonl`
  and `thread-writer-locks/`, `.git/HEAD`, and `/proc` (window raise;
  `/proc/locks` and Codex processes' argv, cwd and fds). Writes only its state
  dir (scene, images, `characters.json`, `packs/`). Pack names are validated
  against a strict charset and matched against the folder listing before they
  touch a path; image file names must be plain listable names (no separators,
  not hidden) and regular files.

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
