# excaliagent: product

The goal state. `design.md` says how; this file says what and why. Status
markers: **done** (shipped and covered by tests), **later** (agreed, not built).

## Problem

I run many coding-agent sessions, mostly Claude Code inside herdr. Few are
active at once (2–3), but many more are dormant: parked for later, blocked on a
colleague, or grilled and waiting for a decision. Those lived only in my head,
in herdr's status-sorted sidebar, or in Claude Code's FleetView list. None of
them let me *place* a session somewhere meaningful and come back to it.
Sessions went stale, I forgot which pane was which, and I paid to re-warm
context I could have continued cheaply.

## Who it is for

The author first. Published as an open-source npm package for anyone running
several Claude Code sessions, with or without herdr. Other harnesses (Codex,
OpenCode) are a later adapter.

## Goals

1. A 2D canvas where every session I care about is a card I can drag anywhere.
2. The card tells the truth: status, what it waits for, title, repo and branch,
   prompt-cache warmth, PR link, and where it runs in herdr.
3. One gesture jumps to the session; one gesture resumes a dormant one.
4. Dormant sessions are first-class: they stay on the board without a pane.
5. My layout and my notes are never modified by the app.
6. Zero setup: `npx excaliagent`, no hooks installed, no config file.

## Non-goals

- Typing prompts or keystrokes into a session from the board.
- Replacing herdr or FleetView as a session browser. The picker stays minimal.
- Hosting, accounts, collaboration, sharing.
- Auto-layout or any status-driven movement of cards.

## User stories

### S1. Live sessions appear (done)

- A new live session gets a card inside the inbox region within 2 s.
- Cards are never spawned for sessions that are not running.
- Deleting the card of a live session respawns it; deleting a dormant one keeps
  it gone.
- Restarting the server or the browser never duplicates cards.

### S2. State at a glance (done)

- Needs-input states (`needs_user`, `waiting`, `needs_trust`, `blocked`) are
  the loudest colour; busy is calm; idle with warm cache is highlighted; idle
  with cold cache and dormant cards are muted.
- The card shows a handwritten title and smaller details: repo · branch,
  status · waiting-for · age, cache warmth, `herdr: workspace › tab` (or "not in
  herdr"), PR link.
- Colour and text update within 2 s of a change.
- The app never changes position, size, rotation, grouping, frame membership,
  or any element it did not create.

### S3. Jump to the session (done)

- Double-clicking a live card focuses its herdr pane and raises the terminal
  window (Hyprland, Sway).
- Without herdr the card says "not in herdr" and the gesture explains why.
- The link survives pane splits, tab moves, renames and herdr reconnects.

### S4. Keep and resume dormant sessions (done)

- A picker lists dormant sessions without a card, newest first; sessions
  superseded by a background session are hidden.
- Adding one spawns a dormant-styled card.
- A dormant card turns live automatically when the session is resumed anywhere.
- Double-click resumes it in herdr: a new tab in the workspace for that repo,
  else a new workspace. Without herdr the resume command is copied.
- Right-click on a card adds an excaliagent section to the menu: focus or
  resume, copy the resume command (with or without `cd`), open the PR.
- A card follows its session when Claude Code continues it in a background
  session (`continued-in`).

### S5. Keep my layout (done)

- The scene is saved locally and restored on restart; saves are atomic.
- The inbox is a rectangle I can move and resize; new cards land inside it.

### S6. Publish (in progress)

- Public GitHub repo, MIT, `npx excaliagent` from npm, README with privacy notes.

## Success criteria

- I open the board every working day for two weeks after the MVP.
- I stop asking "which pane was that" and "did that one finish".
- At least one session per week gets resumed while its cache is still warm
  because the board said so.

## Risks

| Risk | Mitigation |
|---|---|
| Claude Code changes its undocumented registry or transcript format | Parsing isolated in `src/server/sources`; facts in `design.md` carry the version they were verified on; fail soft |
| Stale registry files after a crash look live | Liveness requires `kill -0 pid` |
| Excalidraw fights the app's patches (lost drags) | Frontend is the single writer; app patches use `CaptureUpdateAction.NEVER` |
| herdr protocol changes (pre-1.0) | Adapter uses a handful of methods; tests check them against the recorded schema |
| Any website could hit the local server | Loopback bind, startup token, Host check, same-origin writes |
