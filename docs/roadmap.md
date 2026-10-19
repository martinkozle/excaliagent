# excaliagent: roadmap

Bigger tasks live in the [GitHub issue tracker](https://github.com/martinkozle/excaliagent/issues),
so contributors can pick them up. This file is the map; the issues hold the
details. When something gets built, close its issue and describe it in
`product.md` (as a story) and `design.md` (how).

## Platforms

- Linux: supported and used daily (Hyprland + kitty + herdr).
- macOS: supported in code (including the terminal raise), tested by hand by
  the maintainer; CI runs on Linux only —
  [#2](https://github.com/martinkozle/excaliagent/issues/2).
- Windows: not supported; contributions welcome —
  [#1](https://github.com/martinkozle/excaliagent/issues/1).

## Open issues

| Issue | Area |
|---|---|
| [#3 Codex adapter](https://github.com/martinkozle/excaliagent/issues/3) | new `Source` |
| [#4 OpenCode adapter](https://github.com/martinkozle/excaliagent/issues/4) | new `Source` |
| [#5 Raise on X11, GNOME, KDE](https://github.com/martinkozle/excaliagent/issues/5) | desktop |
| [#6 Remote machines via herdr --machine](https://github.com/martinkozle/excaliagent/issues/6) | sources, herdr |
| [#7 Arrows between related sessions](https://github.com/martinkozle/excaliagent/issues/7) | board |
| [#8 Fit card height to the title](https://github.com/martinkozle/excaliagent/issues/8) | board, good first issue |
| [#9 Lighter package (CJK font from CDN)](https://github.com/martinkozle/excaliagent/issues/9) | packaging, good first issue |

## Releasing

Push a `v*` tag matching `package.json` "version"; `.github/workflows/publish.yml`
publishes to npm with trusted publishing (no token). One-time setup on
npmjs.com: package settings → Trusted publishers → this repository and
`publish.yml`.

## Deliberately out of scope

- **Typing into a session from the board** (quick reply). The board never sends
  input to a running session; changing that needs its own security design.

## Open questions

- **Inbox overflow** with more than a lane's worth of live cards: cards stack
  below the inbox today. Fine at 2–3 active sessions.
- **Picker scope**: all projects (today) or only projects with a live session.
- **`continued-in` merges**: if the continued session already has a card, both
  cards stay. Merge them?
- **Label churn**: ages and cache minutes change every minute, so active cards
  are patched (and the scene saved) about once a minute. Acceptable so far.
