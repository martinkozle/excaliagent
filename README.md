# excaliagent

A spatial scratchboard for your Claude Code sessions, on an Excalidraw canvas.

![The board: session cards triaged into lanes](https://raw.githubusercontent.com/martinkozle/excaliagent/main/docs/images/board.png)

Every session is a card. You drag cards wherever they make sense to you (parked,
blocked on a colleague, come back to, done) and draw anything around them. The
app keeps each card's **color and label** in sync with the session (and its
height fitted to a one- or two-line title, until you resize the card yourself)
and never moves, resizes, or edits anything else on its own; cards move only
when you drop one on a lane title or ask for a tidy-up.

```
🐔 Fix flaky checkout       ✳   ← character, title (handwritten, larger), harness logo
   test
demo-app · fix/flaky             ← repo · branch
needs user: input needed · 2m    ← status · what it waits for · last activity
cache warm 41m                   ← prompt-cache warmth
herdr: demo-app › oauth          ← herdr workspace › tab
PR #12                           ← last PR link
```

| Color | Meaning |
|---|---|
| red | needs you (input, permission, trust, blocked) |
| yellow | busy |
| green | idle, prompt cache still warm: review it before it goes cold |
| grey | idle, cache cold |
| dashed, pale | dormant (not running) |

![Right-click on a card: the excaliagent section next to the Excalidraw menu](https://raw.githubusercontent.com/martinkozle/excaliagent/main/docs/images/card-menu.png)

## Run

```sh
npx excaliagent
```

It starts a server on `127.0.0.1:7357` (a random free port if that one is
busy; choose with `--port`), prints the URL with its access token, and opens it
in your browser. After that first visit, `http://127.0.0.1:7357/` works as a
bookmark. Running it again while a board is up just opens that board.

- **Live sessions** appear in the *inbox* by themselves. A new board comes with
  lanes next to it (To Do, In Progress, Review, Blocked, Parked, Done, and two
  blank ones to name yourself); they are plain shapes you can move, resize,
  rename (double-click) or delete. **+ Lane** (top right) adds one more at the
  right end. On an older
  board, add the whole set from the main menu: *Add starter lanes*.
- **Line cards up in a lane**: while you drag a card, every lane title shows a
  faint *drop to stack* hint; drop the card on one (it lights up) and the card
  goes into the lane's column, below the lowest card there.
  Dropped anywhere else, a card stays exactly where you put it. Right-click a
  lane → *Tidy cards* stacks its cards in one column, top to bottom (on the
  inbox it packs its columns). **Tidy all** (top right, or the main menu)
  does every lane and the inbox at once. Stacked cards are always 20 px
  apart; if a title later grows a second line, its card may overlap the one
  below a little until you tidy again. Cards
  that are locked, rotated, attached to an arrow or grouped with something
  else stay put; the column goes around them. Ctrl+Z undoes a tidy (or Tidy
  all) in one step and a drop in two (the snap, then the drag). Turn the
  title drop off in the main menu (*Drop on lane title stacks cards*).
- **Dormant sessions** are added from the **Sessions** panel (top right). On a
  narrow window the top-right buttons show only their icons; hover for the name.
- **Double-click a card** to jump to it: a live session focuses its
  [herdr](https://herdr.dev) pane and raises the terminal window (Hyprland,
  Sway, macOS). A dormant session is resumed with `claude --resume` in a new herdr
  tab, in the workspace for that repo. Without herdr, the resume command is
  copied instead.
- **Right-click a card** for an excaliagent section on top of the Excalidraw
  menu: focus or resume, copy the resume command (with or without `cd`), open
  the PR, or stop a running session (asks first; the conversation is kept and
  can be resumed).
- A **PR link** (GitHub, Bitbucket, GitLab) shows on the card; the card's link
  icon opens it.
- Every card has a **character**, so you remember which agent is which: an
  animal by default, different for every card on the board, and the same one
  each time that session comes back. Right-click → *Change character…* picks
  one by hand (or *Shuffle*, *Reset to automatic*, or *None*; deleting the
  character from a card also keeps it off). The **Characters** panel
  (top right) switches the pack (Animals, Cats & friends, Sea, Fantasy, Food)
  and makes your own packs from emoji and images: type or paste an emoji, or
  paste, drop or upload png, gif, webp, jpeg or svg files (up to 1 MB each). A
  custom pack is a folder, `packs/<name>/` in the state directory, so you can
  also drop image files there by hand, and list emoji in its `pack.json` as
  `{"emoji": ["🧟", "👻"]}`.

![The Characters panel: packs, and the characters of the active one](https://raw.githubusercontent.com/martinkozle/excaliagent/main/docs/images/characters.png)

- The board is saved to `$XDG_STATE_HOME/excaliagent/scene.json`
  (default `~/.local/state/excaliagent/`), pasted images under `files/` next
  to it, character choices in `characters.json` and your packs under `packs/`.
- **Start over**: main menu → *Reset the canvas* (undoable) lays out a fresh
  board with the live sessions. Or try a clean board without touching yours:
  `npx excaliagent --state-dir /tmp/excaliagent-fresh`.

Options: `--port`, `--no-open`, `--state-dir`, `--claude-dir`, `--no-herdr`, `--no-raise`.
See `npx excaliagent --help`.

## Privacy and security

- Reads `~/.claude/sessions/*.json` and the transcript files under
  `~/.claude/projects/` (only metadata lines: title, branch, timestamps, token
  usage, PR links; never message content). Installs no hooks, writes nothing
  outside its state directory.
- Listens on loopback only. A random token (created once, kept in the state
  directory, readable only by you) is put into the URL it opens and exchanged
  for an HttpOnly cookie; every request needs it, so other users on the same
  machine stay out. Requests with a
  foreign `Host` (DNS rebinding) or cross-origin writes are refused.
- Its only actions: focus a herdr pane, raise the terminal window, start
  `claude --resume <id>` in a new herdr pane, and stop a session when you ask
  (right-click → Stop session, confirmed; it exits as if its terminal closed).
  It never types into a running session.
- Images you paste onto the board, and the images of your character packs,
  are stored next to the scene, in the state directory.
- The only outside request: Chinese, Japanese or Korean text on the board loads
  Excalidraw's CJK font from esm.sh (it is not bundled, to keep the package
  small). Everything else, including all other fonts, is served locally.

## Platforms

Linux and macOS. Raising the terminal window after a jump works on Hyprland,
Sway and macOS. Windows is not supported yet
([#1](https://github.com/martinkozle/excaliagent/issues/1), contributions welcome).

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

MIT licensed. Built-in characters are Unicode emoji, drawn by your system's
emoji font. The harness logos on cards (from [simple-icons](https://simpleicons.org), CC0) are trademarks of their owners and only identify which agent a card belongs to.
