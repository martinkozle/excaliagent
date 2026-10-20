# excaliagent agent guidance

A local Excalidraw board where each coding-agent session (Claude Code, Codex) is
a card. Read these before changing anything:

- `docs/product.md`: the goal state. What the board must do and must never do.
- `docs/design.md`: architecture, decisions with their reasons, and the
  verified (undocumented) data formats of Claude Code, Codex and herdr, with quirks.
- `docs/roadmap.md`: platforms, open questions, and a map of the bigger tasks,
  which live as GitHub issues (`gh issue list`).

Keep these docs true. A change that alters behaviour, a data format, or a
decision updates the matching doc in the same commit. When you verify a fact
about Claude Code or herdr, write down the version you verified it on.

## Architecture invariants

- **The frontend is the single writer of the scene.** The server streams
  `Session[]` and stores whatever scene the frontend saves; it never edits
  elements.
- **The app only touches what it created**, and on cards only the fields listed
  in `docs/design.md` ("What the app may change"). Never position, size,
  rotation, grouping or frames of anything the user arranged; never the user's
  own drawings. (A card's height fits its title only while it still has the
  height the app gave it, `appHeight`, and is unrotated; once the user
  resizes it, it is theirs.)
  The app moves cards in exactly one situation: as the direct result of a user
  gesture to line cards up (dropping a card on a lane's title band, "Tidy
  cards" on a lane or the inbox, or "Tidy all"), as
  an undoable edit of its own, and only free card elements (never locked,
  rotated, arrow-bound or user-grouped cards). Nothing moves on its own:
  reconcile and status changes never move anything.
- **Never send input to an agent session.** The only side effects: focusing a
  pane, starting the session's resume command (`claude --resume <id>`,
  `codex resume <id>`, built by its `Source`) in a *new* pane, and, after the user
  confirms, ending a running session with SIGTERM (as if its terminal closed;
  only to a pid from Claude's registry that is still a `claude` process, or
  to a Codex process matched exactly, never by a guess, that is still a
  `codex` process, never Codex's daemon).
  Commands and pids are derived server-side from validated session ids, never
  from request bodies.
- **Loopback only**, with the access token cookie, Host check and same-origin
  writes on every `/api/*` route. New side-effecting routes get the same checks.
- **Harness-specific code stays behind interfaces**: `Source`
  (`src/server/sources/types.ts`) and `PaneLink` (`src/server/panes/types.ts`).
  Nothing in `src/web` knows about Claude Code, Codex or herdr beyond a
  display name and a logo per `Session.source`.
- **Fail soft.** A malformed file, an unknown status, or a dead socket degrades
  one card or one feature; the board keeps working.
- **Zero runtime dependencies** for the server (`node:` modules only). The web
  bundle is built at publish time.

## Tests and data (hard rules)

- **Never use the user's real data.** No fixtures, recordings or test runs
  against the real `~/.claude`, `~/.codex` or the user's running herdr. Learn
  harness formats from upstream source and throwaway runs with a temp home. Fixtures are
  synthetic (`/home/alice/...`, `example/demo-app`). `src/privacy.test.ts` fails
  if any fixture contains this machine's home path or user name.
- **Never scan the real processes under test.** Sources that look at running
  processes take a proc root; every server a test, the demo or the
  screenshots start gets `EXCALIAGENT_PROC_ROOT` pointing at a synthetic tree
  (`test/mock-proc.ts`), and `test/e2e/board.ts` refuses a server that did not
  take it. `src/server/sources/no-real-proc.test.ts` fails if a source reads
  `/proc` when given another root. Dummy pids stay real processes, so Stop
  is a real SIGTERM. Mock session ids are random, so parallel workers never
  share one.
- Mock Claude: `test/mock-claude.ts` seeds a throwaway Claude home with dummy
  processes (`createMockClaude`, `seedDemo`) and tears it down. Mock Codex:
  `test/mock-codex.ts` (rollouts, and lock files held, per the synthetic
  /proc, by dummy processes). Every server a test or script starts gets
  `--claude-dir` and `--codex-dir` (or `--no-codex`) pointing at mocks.
- Real herdr only as an **isolated server**:
  `src/server/panes/__fixtures__/isolated-herdr.ts` (temp HOME, own socket,
  `HERDR_*` scrubbed; refuses the live socket). Browser e2e servers always run
  with `--no-herdr` or an isolated socket, and always `--no-raise`.
- Work test-first. Pure logic (`src/web/reconcile.ts`, `cards.ts`, transcript
  parsing) gets unit tests; whole flows get a Playwright test in `test/e2e/`.

## Commands

Run everything inside the Nix shell (`direnv allow`, or prefix with
`nix develop -c`). See `CONTRIBUTING.md` for setup.

```sh
npm test                 # unit tests (vitest)
npm run typecheck
npm run test:e2e         # builds the web bundle, then Playwright
EXCALIAGENT_E2E_HERDR=1 npx vitest run src/server/panes   # isolated herdr e2e
npm run demo             # the board on a synthetic, seeded Claude home
npm run dev              # server + Vite HMR against the real ~/.claude (manual use only)
```

Before handing off: unit tests, typecheck, `npm run build`, and the Playwright
suite all pass. CI (`.github/workflows/ci.yml`) runs the same on Linux. macOS
is supported but tested by hand by the maintainer; mark macOS-only facts in
`docs/design.md` as verified or not.

README screenshots are generated from synthetic data: `npm run screenshots`
(writes `docs/images/`). Regenerate them when the board's look changes.

## Git handoff

Commits are the unit of completed work. After the checks pass, commit the files
changed for the task and report the commit id. Keep unrelated changes out.
