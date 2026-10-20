# Contributing to excaliagent

## Setup

Development uses [Nix](https://nixos.org/) with flakes. The flake pins Node.js
24 and Chromium (for the Playwright tests); `package-lock.json` pins packages.

```sh
direnv allow     # or: nix develop
npm install
```

Without Nix: Node.js 24 and `npx playwright install chromium`.

herdr is optional. With it on `PATH`, the herdr browser test and the opt-in
herdr integration test start their own isolated `herdr server`; they never
connect to a herdr you are running.

## Layout

```
src/shared/types.ts      Session and Pane: the wire types
src/server/              Node server, no runtime dependencies
  cli.ts, args.ts        flags, port, open the browser
  token.ts               the access token, kept in the state dir
  http.ts                routes, auth, SSE
  hub.ts                 joins a Source with a PaneLink, fans out updates
  scene-store.ts         atomic scene.json
  sources/               Claude Code adapter (registry, transcripts, git)
  panes/                 herdr adapter (socket client, pid → pane, resume)
  desktop/               raise the terminal window (Hyprland, Sway)
src/web/                 React + Excalidraw frontend
  reconcile.ts           sessions + scene → patches (pure, the core)
  cards.ts, inbox.ts     card elements, labels, colours, placement
  App.tsx                wiring: scene load/save, SSE, double-click, picker
test/                    mock Claude home, Playwright e2e
docs/                    product, design, roadmap
```

## Running

```sh
npm run demo     # synthetic sessions, safe to show anyone
npm run dev      # your real sessions, with hot reload
npm run build && node bin/excaliagent.js
```

## Releasing

`npm publish` runs `npm run build` first (`prepack`), so the tarball contains
`dist/server` and `dist/web`. Check with `npm pack --dry-run`.
