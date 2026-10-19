# excaliagent: roadmap

What is agreed but not built, and what is still undecided. Move an item to
`product.md` (as a story) when it gets built.

## Next

- **npm publish.** Needs the maintainer's npm account (`npm login`), then
  `npm publish`. A GitHub Actions workflow that publishes on a `v*` tag would
  avoid local uploads.

## Later

- **Quick reply** to a needs-input session from the board. Deliberately out of
  scope while "never send input to a session" holds; would need its own
  security review.
- **Arrows between related sessions** (spawned-from, continued-in), drawn by the
  app but owned by the user once drawn.
- **Remote machines** via `herdr --machine` / `herdr --remote`.
- **Codex and OpenCode adapters** behind `Source`. herdr already detects both
  (`agent: "codex" | "opencode"` in `pane.list`).
- **Window raise on more desktops**: X11 (`wmctrl`/`xdotool`), macOS
  (`osascript`), KDE/GNOME Wayland (no generic API; per-compositor).
- **herdr plugin action** that opens the board.

## Open questions

- **Card height.** Cards are sized for a two-line title; single-line titles
  leave space at the bottom. Fit height to content, or keep the grid uniform?
- **Inbox overflow** with more than ~12 live cards: cards stack below the inbox
  today. Fine at 2–3 active sessions.
- **Picker scope**: all projects (today) or only projects with a live session.
- **`continued-in` chains**: a card follows one hop per reconcile. If the new
  session already has a card, both stay. Merge them?
- **Label churn**: the age and cache minutes change every minute, so cards are
  patched (and the scene saved) about once a minute while sessions are active.
  Acceptable so far.
