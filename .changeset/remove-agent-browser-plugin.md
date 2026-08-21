---
title: "Remove the agent-browser plugin dependency"
---

## Changes

**Comments only** — no behavior change in the repo itself:
- [pi_command.rs](../src-tauri/src/pi_command.rs): `npm_bin_dir` and `prepend_npm_bin_to_path` no longer cite `agent-browser.cmd` / `pi-agent-browser-native` as their motivating example. Both stay: prepending npm's global bin to the pi child process's PATH is generic infrastructure that any pi extension shelling out to a globally installed binary depends on, and on Windows those shims are `.cmd` files a bare `Command::new` lookup misses.
- [pi_bridge.rs](../src-tauri/src/pi_bridge.rs): same, at the `pi --mode rpc` spawn site.

**Environment side** (outside the repo, done once on this machine):
- `pi remove npm:pi-agent-browser-native` — pi extension packages 22 → 21
- `npm uninstall -g agent-browser` — the upstream CLI (87.2 MB) the extension shelled out to
- Removed the retired `browser` entry from `~/.pi/agent/mcp.json`, left over from the in-app browser pane deleted in the previous change
- Removed `~/.agent-browser/` (17 daemon/session bookkeeping files; no auth vault, cookie state, or user config)
- Kept `~/AppData/Local/ms-playwright/` (683.2 MB of Chromium builds) — potentially shared with other tooling, and likely reusable by the replacement

## Why

With the in-app browser pane gone, `agent_browser` was the only browser surface left — but it does not do what is actually wanted. Both stacks spawn a *new* isolated Chrome (fresh temp `user-data-dir`), so neither drives the browser the user already has open, and neither carries their login state.

The plan is to instead follow Codex's approach: a Chrome extension installed into the user's own browser, operating inside sessions they are already signed into. `agent-browser` cannot be adapted to that — it ships no extension and no native-messaging host (`--extension <path>` loads an extension *into the browser it launches*, the opposite direction). Its only path to an existing browser is CDP, which requires relaunching Chrome with `--remote-debugging-port` and, per upstream's own docs, "exposes full browser control on localhost. Any local process can connect and read cookies, execute JS."

Keeping a plugin that cannot reach the target design while a replacement is built would leave two competing browser tool surfaces and keep leaking Chrome trees — the daemon enforces its own idle timeout, so a dead daemon reaps nothing (this machine had accumulated 3.2 GB of orphaned profiles).

## Testing

- `npx tsc --noEmit -p tsconfig.json` → exit 0
- `node scripts/check-backend-boundaries.mjs --inventory` → 57 unique commands / 59 calls, unchanged; the sole remaining error (`src/lib/store.ts contains platform guess typeof window`) is pre-existing and unrelated
- `agent-browser close --all` before uninstalling: 1 session closed, agent-browser Chrome processes 0 → verified still 0 after removal
- Verified gone: global package dir, PATH shim (`which agent-browser`), `~/.agent-browser/`, the extension in `pi list` and in `settings.json`
- `~/.pi/agent/mcp.json` now lists only `tavily-remote`

`cargo check` was not run — this machine has no MSVC linker (`link.exe`), a pre-existing environmental limit. The Rust edits are comment-only, so they cannot affect compilation.
