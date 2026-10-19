# excaliagent — product requirements

Version 1, 2026-10-19. Companion to `DESIGN.md` (architecture, data formats) and
`PLAN.md` (implementation slices). This file says *what* and *why*; it does not
repeat *how*.

## Problem

I run many coding-agent sessions, mostly Claude Code inside herdr. Few are active
at once (2–3), but many more are dormant: parked for later, blocked on a
colleague, or just grilled and waiting for me to decide. Today those live only in
my head, in herdr's one-column status-sorted sidebar, or in Claude Code's
FleetView list. None of these let me *place* a session somewhere meaningful and
come back to it. The result: sessions go stale, I forget which pane is which,
and I pay to re-warm context I could have continued cheaply.

## Who it is for

Me first. Published as an open-source npm package so anyone who runs several
Claude Code sessions can use it, with or without herdr. Other harnesses (Codex,
OpenCode) are a later adapter, not a v1 target.

## Goals

1. A 2D canvas where every session I care about is a card I can drag anywhere.
2. The card always tells the truth about the session: status, what it waits for,
   title, repo and branch, cache warmth, PR link, whether a herdr pane exists.
3. One click jumps to the session's herdr pane.
4. Dormant sessions are first-class: they stay on the board without a pane.
5. My layout and my notes are never modified by the app.
6. Zero setup: `npx excaliagent`, no hooks installed, no config file required.

## Non-goals (v1)

- Sending prompts or keystrokes to sessions from the board.
- Replacing herdr or FleetView as a session *browser*. The picker is deliberately minimal.
- Multi-machine or remote sessions.
- Collaboration, hosting, sharing, accounts.
- Auto-layout, auto-columns, or any status-driven movement of cards.
- Codex / OpenCode support (keep the adapter seam, do not build the adapters).

## User stories and acceptance criteria

### S1. See live sessions appear

As a user, when I start a Claude Code session, a card appears on the board without
me doing anything.

- A new live session gets a card inside the inbox region within 2 s.
- Cards are never spawned for sessions that are not currently running.
- If I delete a card whose session is still live, it respawns in the inbox.
- If I delete a card whose session is dormant, it stays gone.
- Restarting excaliagent or the browser never duplicates cards.

### S2. Read the state at a glance

As a user, I can tell from across the room which sessions need me.

- Needs-input states (`needs_user`, `waiting`, `needs_trust`, `blocked`) use the
  loudest color. Busy is calm. Idle with warm cache is highlighted. Idle with cold
  cache and dormant cards are muted.
- The label shows: title, repo · branch, status · waitingFor · age, cache warmth,
  herdr pane id or "no pane", PR link when present.
- Color and label update within 2 s of a status change.
- The app changes only the card's colors and its label text. It never changes
  position, size, rotation, grouping, frame membership, or any element it did
  not create.

### S3. Jump to the pane

As a user, I click a card and the matching herdr pane gets focus.

- Works when herdr is running and the session's pid matches a pane's foreground
  process. The card shows the pane id.
- When herdr is not running, the click does nothing and the card says "no pane".
- The link survives pane splits, tab moves, and herdr reconnects.

### S4. Keep dormant sessions

As a user, I can put a session on the board even though it is not running, so I
remember to come back to it.

- A picker lists sessions from the local transcript store that do not yet have a
  card, newest activity first, with title, repo, and last-activity time.
- Adding one spawns a card styled as dormant. The picker then hides it.
- A dormant card becomes live automatically when I resume that session anywhere.

### S5. Keep my layout

As a user, I arrange cards, draw regions, arrows and notes, and all of it is
there tomorrow.

- The scene is saved locally and restored on restart.
- Saves are atomic; a crash mid-save never corrupts the board.
- The inbox is just a rectangle I can move and resize; new cards land inside it.

## Success criteria

- I open the board every working day for two weeks after the MVP lands.
- I stop asking "which pane was that" and "did that one finish".
- At least one session per week gets resumed while its cache is still warm
  because the board told me so.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Claude Code changes the registry or transcript format (both undocumented) | Isolate parsing in one module with fixtures from real files; fail soft, never crash the board |
| Stale registry files after a crash make dead sessions look live | Liveness requires `kill -0 pid` to succeed |
| Excalidraw reconciles my edits and the app's patches badly (lost drags) | Frontend is the single writer; the server never edits elements |
| herdr protocol changes (pre-1.0) | Adapter talks to five methods only; version-check `protocol` from the schema |
| Any website could hit the local server | Loopback bind, startup token, Host header check |

## Later (not scheduled)

Resume a dormant card into a new herdr pane; quick reply to a needs-input
session; arrows between related sessions; remote machines via `herdr --remote`;
Codex and OpenCode adapters; a herdr plugin action that opens the board.
