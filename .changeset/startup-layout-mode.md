---
title: "Pick the layout Pi opens in, including a chat-only mode with no editor"
---

## Problem

The chat column (work mode) was reachable only by pressing ⌘/ after every
launch — the choice was never persisted. For people using Pi as an agent client
rather than an editor, that meant re-entering their preferred layout each time,
and the editor still owned the middle of the window by default.

Requested in [#1](https://github.com/MarshallEriksen-Neura/pi-agent-desktop/issues/1),
first implemented in [#2](https://github.com/MarshallEriksen-Neura/pi-agent-desktop/pull/2).

## One setting, not two

The original proposal was a startup-layout picker *plus* an "enable IDE editor"
switch. Those are not orthogonal: turning the IDE off **is** permanent work mode,
so the pair admits a combination the user can select that means nothing (IDE off
+ startup "Editor"). It also grows the wrong way — a future layout would add a
dimension rather than a choice.

`layoutMode` is therefore a single three-way enum:

- **Editor** (`default`) — sidebar, editor, docked chat rail; ⌘/ still switches
- **Chat** (`work`) — opens in the centered chat column; ⌘/ returns to the editor
- **Chat only** (`work-only`) — permanent chat column; the editor never mounts and
  every entry point to it (top-bar toggle, ⌘/, palette command) is hidden

Picking a layout applies it immediately rather than only on next launch — a
settings control that visibly does nothing reads as broken. The segmented labels
are too short to carry the difference, so the row's detail line describes the
selected mode.

## Not mounting the editor was already true

The issue asked for the editor to be *unmounted* rather than CSS-hidden. It
already was: `EditorCanvas` lazy-loads CodeMirror behind `ssr: false`, and work
mode has always left `showEditor` false, so nothing editor-shaped is built. The
value `work-only` adds is a simpler window and no way to land back in the IDE by
accident — not bundle savings.

What is new is that panels now wait for `layoutReady` before mounting at all, so
a chat-launch never builds the editor just to tear it down a frame later. The
boot screen already covers that gap: it lifts two frames after mount, and the
layout is read back synchronously inside the first one.

## Dead controls this removes

Two buttons pointed at a panel that could not appear in the current layout, so
they flipped a flag nothing read:

- **The chat rail's History button** toggled `sidebarOpen` — but work and zen mode
  cannot render the sidebar. It is now a `SessionHistoryMenu` that lists sessions
  in place, and offers "Show all in sidebar" only where the sidebar is reachable.
- **The top bar's sidebar toggle** is gated on the same condition as the sidebar
  itself, instead of being shown unconditionally.

`work-only` keeps the sidebar available, since it is the only route to the session
list once the IDE is gone.

Also fixed: the command palette's search field no longer draws a focus ring — the
palette is its own popup, so the inner outline was a second frame inside a frame.

## Testing

- `npx tsc --noEmit -p tsconfig.json` → exit 0
- All three modes exercised for panel mounting, ⌘/ behavior, top-bar and palette
  gating, and reload persistence; storage-unavailable falls back to `default`
- en/zh key parity is enforced by `zh`'s `Record<keyof typeof en, string>` type

`next build` was not run locally: this machine OOMs on the export step
(15 workers, ~41 GB commit). `tsc` is the gate used here.
