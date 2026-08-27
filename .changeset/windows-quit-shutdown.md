---
title: "Stop the window hanging on quit, without cutting backend teardown short"
---

## Problem

Quitting ran `PiProc::shutdown` on the event-loop thread — the same thread that
has to paint the window closing. Teardown includes remote-control waits and
child-process joins, so the window could sit on screen, unresponsive, until they
finished.

The frontend path made it worse. `closeBehavior: "quit"` still registered a
WebView `onCloseRequested` listener, which puts the renderer on the close path:
a hung WebView stalled the close before Rust ever saw `ExitRequested`.

## Changes

**Teardown moves off the event loop.** `ExitRequested` holds the exit with
`prevent_exit()`, runs teardown on a `pi-shutdown` thread, and exits from there.
An 8s `pi-exit-watchdog` bounds it, so a wedged child process cannot keep the
process alive indefinitely.

**No JS close listener in quit mode.** Only ask/minimize needs one — those have a
decision to make. In quit mode the request goes straight to the event loop, which
tears down on its own, so a sick renderer cannot block it. The listener is now
keyed on `closeBehavior` rather than registered once for every mode.

**Quit goes through Rust.** `quit()` invokes a new `app_quit` command instead of
`@tauri-apps/plugin-process`'s `exit()`, which would terminate without running any
of the above.

## The race that took a second pass

Holding only the *first* exit request is not enough. `AppHandle::exit` ignores
`prevent_exit`, so any later request that reached it — a tray quit or a second
Alt+F4 while teardown was still running — killed the process with the pi child
still alive. The original fix forwarded exactly those to `exit`.

`BackendLifecycle` now carries a second flag, `cleanup_settled`. Every exit
request is held until teardown finishes or the watchdog gives up; repeated quit
actions are dropped rather than forwarded, because the in-flight teardown already
owns the exit. `settle_and_exit` sets the flag with `Release` before calling
`exit`, so the handler cannot hold the very exit teardown is asking for.

Reported by CodeRabbit on
[#2](https://github.com/MarshallEriksen-Neura/pi-agent-desktop/pull/2).

## Testing

- `cargo check` → exit 0
- `rustfmt --check src/lib.rs` → no diff in `lib.rs`; the drift it reports in
  `mcp_config.rs`, `pi_bridge.rs`, `pi_command.rs`, and `provider_auth.rs` is
  byte-identical on `main` and predates this change
- `npx tsc --noEmit` → exit 0

Not verified: the Windows close paths themselves. `cargo check` type-checks the
lifecycle but does not exercise it, and `tauri build` needs a linker this machine
does not have. Worth a manual pass over caption-button close, Alt+F4, tray quit,
and a tray quit issued while teardown is already running, in each of the three
close behaviors.
