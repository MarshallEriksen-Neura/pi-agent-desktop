# Pi Desktop 0.14.0 Release Audit

- Candidate: `0.14.0`
- Audit date: `2026-09-05`
- Baseline: `ca1e253824d5009d34d38205b0a6d563fdad41be` (`origin/main` at audit start)
- Release commit: `4f0c3e553858fae4badc6ca57d76e2f5226e7c59`
- Tag: `v0.14.0`
- Local validation status: **PASSED**
- Release status: **PUBLISHED** after workflow run `33974872670` completed successfully

## Scope

The candidate contains these user-facing changes:

- Native local and SSH PTY terminal tabs, with retained sessions, rename/close controls, resize, Unicode, clipboard, drag/drop, and an eight-tab cap.
- A local shell profile preference with Windows Auto fallback and creation-time cwd/profile snapshots.
- Long-text compose and message flows with compact references and a full editor/viewer.
- Atomic remote-project retargeting and stale task-binding removal.
- Model reasoning capability overrides and Pi-authoritative thinking-level choices.
- Structured loading states for Plugins and Skills.
- A default dark base of `#1c1c1e`, with `#2c2c2e` elevated surfaces and preserved custom-background precedence.
- Release publication gated on both desktop artifacts and Android APK completion.

## Code Audit

### Terminal boundaries and lifecycle

- Local PTY, SSH PTY, and Pi JSONL RPC remain separate transports and process lifecycles.
- Session IDs, generation values, dimensions, writes, buffers, and output chunks are bounded and validated.
- Late output/exit events cannot update a replacement generation.
- Hiding the drawer retains a terminal; closing a tab terminates only that tab; application exit tears down the complete process tree.
- SSH terminals retain strict host-key checking, non-interactive authentication, disabled forwarding, forced TTY allocation, and shell-quoted remote cwd.
- Custom shell paths must be absolute existing executables and cannot carry user-supplied arguments.
- Windows `cmd.exe` is canonicalized and started as `/K rem`, which remains interactive through ConPTY without a startup side effect.
- The Windows `portable-pty 0.9.0` child-kill return-value defect is contained in a platform-specific cleanup helper. Session cleanup still runs after the upstream false error.
- The Windows Common Controls v6 resource is linked only into the Rust test build; the production Tauri executable retains its normal resource path.

### Clipboard and retained UI state

- Modified `V` is intercepted at the xterm key boundary and routed through one asynchronous clipboard read. `Ctrl+V` no longer also reaches PSReadLine as `\x16`, eliminating first-permission duplicate paste.
- `Ctrl+Shift+C` copies the xterm selection. Unicode and double-width terminal cells were exercised in the real desktop runtime.
- Local and SSH tabs own immutable creation-time bindings, preventing later project/profile changes from moving a running shell.

### Thinking capabilities

- The model editor writes capability fields on local definitions and uses `modelOverrides` for built-in models without inventing a local model list or discarding unrelated provider fields.
- Model and thinking writes share a serial control queue. Snapshot sequence checks prevent stale `get_state` or capability responses from overwriting the latest selection.
- The picker exposes only levels returned by Pi for the effective current model and adopts Pi's actual fallback level after a write.
- `resetPiStoreForTests()` now clears stores without calling the active-store facade. The former facade call recreated a store bound to the client that teardown immediately disposed, causing the later thinking-capability request to time out and resolve to an empty list.

### Theme and release workflow

- Semantic dark-theme tokens carry the new background hierarchy; saved appearance variables still override defaults.
- `.github/workflows/release.yml` requires both `release` and `android` before `publish-release`, so a published release cannot omit a late Android artifact.

## Verification Evidence

### Automated gates

- `pnpm test:backend`: **359/359 passed** in the main process and **10/10 passed** in isolated processes. Run through `scripts/run-backend-tests.mjs`; log: `.tmp/release-audit-backend-tests-final-2.log`.
- `pnpm exec tsc --noEmit`: passed on the candidate after the thinking-store fix.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked remote_terminal::tests -- --no-capture`: **8/8 passed**, with assertions executing.
- `cargo check --manifest-path src-tauri/Cargo.toml --locked`: passed.
- Package builds: passed.
- `pnpm build`: passed, including the production Next.js build/static export.
- `pnpm tauri build --no-bundle`: passed after the Rust test-resource and Windows shell changes; release executable produced at `src-tauri/target/release/pi-desktop.exe`.
- Remote workspace tests: **15 passed**.
- Remote management tests: **5 passed**.

### Browser and desktop smoke

- Browser preview: dark tokens resolved correctly; 801-code-point paste, long-text editing, Escape close, focus restoration, and browser terminal fallback passed.
- Real release executable, PowerShell 7.6.1: command input/output and `RAGCODE_PTY_中文_✓` round-tripped through the PTY.
- Real keyboard path: CDP key events produced the expected Unicode marker file.
- Two local tabs produced independent `pwsh.exe` and `OpenConsole.exe` children; closing one removed only its process pair.
- Local resize changed xterm from 179 to 212 columns.
- Fresh-profile first clipboard permission: `Ctrl+V` inserted exactly one `PASTE_FIXED_中文_✓`; terminal selection copied Unicode text back to the system clipboard.
- Invalid custom shell: the UI showed the localized Auto fallback notice and started a working PowerShell PTY.
- Valid `C:/Windows/System32/cmd.exe`: canonicalized to a native path, remained interactive as `/K rem`, and round-tripped `CUSTOM_CMD_INTERACTIVE_OK` without fallback or exit.
- Drawer hide/reopen retained both the native process and terminal buffer.
- Real SSH profile `yuyun`: two independent `ssh.exe -tt` sessions opened in `/root/turb-gpt-free-register`; `SSH_PTY_中文_✓` round-tripped, resize changed 181 to 167 columns, and each tab cleanup removed only its own SSH/ConPTY children.
- Full application exit: all 12 recursively tracked application, WebView2, terminal, console-host, and Pi RPC processes disappeared (`Tracked: 12`, `Alive: 0`).

## Repository Hygiene

- `NUL` and `.tmpative-terminal-smoke.txt` were identified as accidental smoke artifacts and removed.
- `.tmp/`, `out/`, `target/`, installers, diagnostic scripts, credentials, private keys, and signing material are excluded from the release files.
- `release-audit.md` is an intentional release artifact.
- The release commit and tag were intentionally held until all local validation gates passed; final staging is restricted to the audited source, tests, version metadata, workflow, changelog, and this audit.

## Release Result

- GitHub Actions run `33974872670` completed successfully: draft creation, Android, Windows, macOS x64, macOS arm64, Ubuntu, and final publication all passed.
- The published release contains 18 uploaded assets: Android APK, Windows NSIS/MSI installers and signatures, Linux AppImage/DEB/RPM packages and signatures, macOS x64/arm64 app archives and DMGs, plus `latest.json`.
- The run exposed a publication-order defect: the Android `softprops/action-gh-release` upload changed the draft to public at `15:31:46Z`, before the last desktop job completed at `15:38:46Z`. Every remaining job subsequently passed and the final asset set is complete, so the released binaries are not missing artifacts.
- A post-tag `main` fix explicitly sets `releaseDraft: true` for both Tauri upload paths, `draft: true` for the Android upload, and `draft: false` only for `publish-release`. Future releases therefore preserve the draft until both desktop and Android dependencies succeed.

## Residual Risks

- `src/lib/orchestration/project-switch.ts` can surface a rollback error instead of the original operation error if rollback itself rejects. Existing state recovery remains intact; preserving both errors is a P2 follow-up, not a demonstrated release blocker.
- Reloading the same WebView while a native terminal is active can overlap old cleanup with a new start using the same session identity. Smoke tests for shell-profile changes must use a fresh application process/profile. Normal tab close and full application exit paths were verified directly.
- The Windows kill workaround is specific to `portable-pty 0.9.0` and should be revisited when that dependency is upgraded.
- The successful CI run emitted maintenance warnings for Node 20-based action runtimes, `actions/setup-java@v4`, and the unsupported `api-level` input to `android-actions/setup-android@v3`. They did not affect this release but should be cleaned up before those deprecations become enforced.
