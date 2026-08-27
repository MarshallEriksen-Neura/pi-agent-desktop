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

## One stored value, two controls

Three layouts exist:

- **Editor** (`default`) — sidebar, editor, docked chat rail; ⌘/ still switches
- **Chat** (`work`) — opens in the centered chat column; ⌘/ returns to the editor
- `work-only` — permanent chat column; the editor never mounts and every entry
  point to it (top-bar toggle, ⌘/, palette command) is hidden

They are stored as one `layoutMode` enum, not as a startup preference plus an
independent "enable IDE" boolean. Those two would not be orthogonal — turning the
IDE off *is* permanent chat mode — so as separate persisted values they admit a
state that means nothing: IDE off, startup "Editor".

But a single three-way control cannot present them either. The difference between
`work` and `work-only` is not how much chat you get, it is whether you can leave —
and no segment label that short can say so. "Chat" next to "Chat only" reads as a
distinction about the chat column, which it is not.

So the settings surface is two rows over the one stored value:

- **Startup interface** — `Editor | Chat`, the layout Pi opens in
- **Remove the editor** — a switch; when on, the startup segment greys out

Each row answers one question — *where do I start*, and *do I want the editor at
all* — and the dead combination is visibly disabled rather than selectable.
Turning the switch back off lands on `work`, not `default`: you were in the chat
column, and regaining the editor should not also throw you out of it.

Picking a layout applies it immediately rather than only on next launch — a
settings control that visibly does nothing reads as broken.

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
