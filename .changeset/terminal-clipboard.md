---
title: "Terminal: copy, paste, a right-click menu, and a `clear` that clears"
---

## Problem

The terminal drawer had no copy at all. xterm ships no clipboard bindings on
purpose — `Ctrl-C` is the shell's interrupt and the embedder decides what else
the modifier means — and nothing bound them, so the only route out of the
terminal was the per-block Copy button in block view. Right-click could not stand
in for the missing binding either: `AppShell` cancels `contextmenu` app-wide so
custom menus can exist, which takes WebView2's own Copy/Paste items with it, and
the terminal never got a replacement.

Paste half-worked in a way that was worse than not working. A paste is not a
keystroke: xterm delivers it to `onData` as one multi-character string with
newlines already folded to CR, and both views had only single-keystroke handling
for it.

- Classic mode's `switch` compared the whole payload against `"\r"`, so a
  two-line paste never matched Enter and fell through to the printable branch —
  embedded carriage returns and all — where it was echoed raw and left the
  display overwriting itself. Nothing ran until Enter, and then bash got one
  command with a CR inside it. A paste beginning with a newline failed
  `data >= " "` and vanished. A paste arriving while a command ran was dropped.
- Block mode let `<input type="text">` do what it does to newlines: strip them.
  `cd foo` + `echo bar` silently became `cd fooecho bar`.
- `TerminalInput` also called `preventDefault()` on every `Ctrl-C`, so the one
  field in the drawer that had a working native copy did not have one either.

## What this adds

**Copy.** `Ctrl/Cmd+Shift+C` always copies the selection; plain `Ctrl-C` copies
only when something is selected and otherwise still reaches the shell as SIGINT,
which is how Windows Terminal splits the same key. The selection is cleared after
a copy — leaving it would make the *next* `Ctrl-C` copy again instead of
interrupting, so a stale selection would render a running command unkillable. On
macOS `mod` is Cmd, so `Ctrl-C` keeps interrupting there regardless.

**Paste, native-first.** Plain `Ctrl/Cmd+V` deliberately does not
`preventDefault`. The webview's own paste event costs no permission, while
`navigator.clipboard.readText()` prompts — and a single "Block" is remembered, so
cancelling the native event in favour of a clipboard read would put a permanent
failure one misclick away. `armPasteFallback` waits 150 ms for the native event
and only reads the clipboard if none arrives; the event cancels the timer, so
exactly one paste happens either way. `Ctrl/Cmd+Shift+V` and the menu item are
the explicit routes, where a read is the only option and a prompt is expected.

**A right-click menu** — Copy / Paste / Select all / Clear — since the app-wide
`contextmenu` suppression removed the native one. Rendered through a portal: the
drawer animates its height with `overflow: hidden`, and Motion's transform makes
it a containing block, so a fixed-position menu rendered in place would be
clipped by the drawer it belongs to.

**`splitPastedLines`** ([src/lib/terminal-paste.ts](../src/lib/terminal-paste.ts))
now owns the multi-line rule for both views: newline-terminated lines are
commands, and the tail after the last newline is left editable, so a paste
without a trailing newline lands in the line editor instead of running blind.
Classic mode holds the rest as typeahead and replays it as each command finishes,
the way a real terminal queues pasted lines; `Ctrl-C` discards the queue, because
interrupting and then watching an abandoned paste continue is the opposite of
what the key is for.

## `clear`

`clear` could not have worked, for three independent reasons. Every command is a
separate `bash` RPC whose output is *captured* rather than written to a live PTY,
so the escape sequence arrives as text in a response body with no terminal on the
far end. No `TERM` is set for pi's shell, and `clear` reads terminfo to know what
to emit, so it fails before printing anything. And block mode renders through
`ansi_up`, which implements SGR and ignores every other CSI code — erase and
cursor commands included — so it could not act on the sequence even if it
received one.

So `clear` (and `cls`, which a Windows user will type and which would fare no
better) is answered client-side, along with `Ctrl-L`: block mode empties the block
list, classic mode gets `\x1b[3J\x1b[2J\x1b[H`. The `3J` matters — without it the
"cleared" scrollback is one scroll wheel away. `termBus.reset()` drops the backlog
at the same time, because the bus replays it to late subscribers and a terminal
mounting after a clear would otherwise restore what was cleared.

## Note

The permission prompt behind `readText()` is Chromium's, not a dev-server
artefact — packaging changes the origin from `localhost:3000` to
`tauri://localhost` but grants nothing, so it would appear in a release build
too. Native-first paste is what keeps it off the common path: on a normal
`Ctrl+V` the clipboard is never read and nothing is asked. Removing it from the
explicit routes as well means reading the clipboard in Rust via
`tauri-plugin-clipboard-manager`, which is a dependency change this repo's pinned
MSRV-1.77.2 graph should not take casually.
