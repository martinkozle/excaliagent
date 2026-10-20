# excaliagent: roadmap

Bigger tasks live in the [GitHub issue tracker](https://github.com/martinkozle/excaliagent/issues),
so contributors can pick them up. This file is the map; the issues hold the
details. When something gets built, close its issue and describe it in
`product.md` (as a story) and `design.md` (how).

## Platforms

- Linux: supported and used daily (Hyprland + kitty + herdr).
- macOS: supported, verified by the maintainer on a MacBook with kitty
  (2026-10-20, main before 0.3.0): the board, herdr focus and the terminal
  raise work. Switching kitty tabs is not done yet (#14). Tested by hand only; CI runs on Linux only —
  [#2](https://github.com/martinkozle/excaliagent/issues/2).
- Windows: not supported; contributions welcome —
  [#1](https://github.com/martinkozle/excaliagent/issues/1).

## Open issues

| Issue | Area |
|---|---|
| [#5 Raise on X11, GNOME, KDE](https://github.com/martinkozle/excaliagent/issues/5) | desktop |
| [#14 Switch to the terminal tab that holds herdr](https://github.com/martinkozle/excaliagent/issues/14) | desktop |
| [#6 Remote machines via herdr --machine](https://github.com/martinkozle/excaliagent/issues/6) | sources, herdr |
| [#7 Arrows between related sessions](https://github.com/martinkozle/excaliagent/issues/7) | board |
| [#13 Hand-gesture control via the webcam](https://github.com/martinkozle/excaliagent/issues/13) | board, experimental |

## Releasing

Push a `v*` tag matching `package.json` "version"; `.github/workflows/publish.yml`
publishes to npm with trusted publishing (no token). Then create a GitHub
release for the tag with the notes.

One-time setup:

- npmjs.com, package settings → Trusted publishers → GitHub Actions: this
  repository, workflow `publish.yml`, environment `npm`. Publishing access:
  require 2FA and disallow tokens.
- GitHub: environment `npm` admits deployments from `v*` tags only; Actions are
  limited to GitHub-owned actions (`actions/*`).

## Deliberately out of scope

- **Typing into a session from the board** (quick reply). The board never sends
  input to a running session; changing that needs its own security design.

## Open questions

- **Codex liveness**: Codex 0.163 has no session registry; running threads
  come from held lock files plus matching TUI processes (design.md, "Codex
  data"). Same-directory TUIs can be mismatched while a closed one's thread
  lingers in the daemon, and macOS has no live Codex sessions yet (needs an
  `lsof`-based lock check). Codex could also be asked over its app-server
  socket (`thread/loaded/list`), at the cost of speaking its protocol.
- **OpenCode liveness** is inferred from TUI argv and cwd (design.md,
  "OpenCode data"): wrong after switching sessions inside a TUI. Exact would
  need OpenCode to record its open session (an upstream feature request), or
  a `--port` the board could query. macOS has no live OpenCode sessions yet.

- **Inbox overflow** with more than a lane's worth of live cards: cards stack
  below the inbox today. Fine at 2–3 active sessions.
- **Picker scope**: all projects (today) or only projects with a live session.
- **`continued-in` merges**: if the continued session already has a card, both
  cards stay. Merge them?
- **Stored images are never deleted**: `files/` keeps the data of images
  removed from the board. Prune unreferenced files on startup?
- **Characters never forgotten**: `characters.json` remembers every
  session's pick per pack, including sessions long gone (a few dozen bytes
  each). Prune entries of sessions without a card or transcript?
- **Character packs for others**: built-in packs are emoji only. A freely
  licensed image pack (OpenMoji CC BY-SA 4.0, Twemoji CC BY 4.0, with
  attribution) would render the same on every system.
- **Label churn**: ages and cache minutes change every minute, so active cards
  are patched (and the scene saved) about once a minute. Acceptable so far.
