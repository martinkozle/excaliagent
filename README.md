# excaliagent

A spatial scratchboard for your Claude Code sessions, on an Excalidraw canvas.

Every session is a card. You drag cards wherever they make sense to you (parked,
blocked on a colleague, come back to, done) and draw anything around them. The
app keeps each card's **color and label** in sync with the session and never
moves, resizes, or edits anything else.

```
Fix flaky checkout test           ← title (handwritten, larger)
demo-app · fix/flaky              ← repo · branch
needs user: input needed · 2m     ← status · what it waits for · last activity
cache warm 41m                    ← prompt-cache warmth
herdr: demo-app › oauth           ← herdr workspace › tab
PR #12                            ← last PR link
```

| Color | Meaning |
|---|---|
| red | needs you (input, permission, trust, blocked) |
| blue | busy |
| green | idle, prompt cache still warm: review it before it goes cold |
| grey | idle, cache cold |
| dashed, pale | dormant (not running) |

## Run

```sh
npx excaliagent
```

It starts a server on `127.0.0.1` and opens the board in your browser.

- **Live sessions** appear in the *inbox* rectangle by themselves.
- **Dormant sessions** are added from the **Sessions** panel (top right).
- **Double-click a card** to jump to it: a live session focuses its
  [herdr](https://herdr.dev) pane and raises the terminal window (Hyprland,
  Sway). A dormant session is resumed with `claude --resume` in a new herdr
  tab, in the workspace for that repo. Without herdr, the resume command is
  copied instead.
- **Right-click a card** for an excaliagent section on top of the Excalidraw
  menu: focus or resume, copy the resume command (with or without `cd`), open
  the PR.
- A **PR link** (GitHub, Bitbucket, GitLab) shows on the card; the card's link
  icon opens it.
- The board is saved to `$XDG_STATE_HOME/excaliagent/scene.json`
  (default `~/.local/state/excaliagent/`).

Options: `--port`, `--no-open`, `--state-dir`, `--claude-dir`, `--no-herdr`, `--no-raise`.
See `npx excaliagent --help`.

## Privacy and security

- Reads `~/.claude/sessions/*.json` and the transcript files under
  `~/.claude/projects/` (only metadata lines: title, branch, timestamps, token
  usage, PR links; never message content). Installs no hooks, writes nothing
  outside its state directory.
- Listens on loopback only. A random token is put into the URL it opens and
  exchanged for an HttpOnly cookie; every request needs it. Requests with a
  foreign `Host` (DNS rebinding) or cross-origin writes are refused.
- Its only actions: focus a herdr pane, raise the terminal window, and start
  `claude --resume <id>` in a new herdr pane. It never types into a running
  session.

## herdr (optional)

If [herdr](https://herdr.dev) is running, cards are linked to panes by matching
the session's process id to the pane's foreground process. No herdr
integration or plugin is needed. Tested with herdr 0.9.0 and its protocol 22.

## Development

The repo ships a Nix flake with Node 24 and Chromium for the browser tests:

```sh
direnv allow        # or: nix develop
npm install
npm test            # unit tests (vitest)
npm run test:e2e    # browser tests (playwright) against a mock Claude home
npm run demo        # the board with a seeded, synthetic set of sessions
npm run dev         # server + Vite hot reload against your real ~/.claude
```

Tests never read your real `~/.claude` or talk to your running herdr:
`test/mock-claude.ts` seeds a throwaway Claude home with dummy processes, and the
herdr tests start an isolated `herdr server` with its own temp home and socket.
A privacy test fails if any fixture contains this machine's home path or user
name.

Docs: [product](docs/product.md), [design](docs/design.md), [roadmap](docs/roadmap.md). Agents start at [AGENTS.md](AGENTS.md).
