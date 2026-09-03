# Pi Desktop remote launcher

`pi-desktop-launcher` is the fixed remote entrypoint used by Remote Agent Mode. The desktop application starts system OpenSSH and invokes this file with an opaque Base64 payload. In run mode, the launcher's stdout is reserved exclusively for Pi's JSONL RPC stream.

## Requirements

The remote host must provide:

- POSIX `/bin/sh`
- `base64` with either the GNU `-d` or BSD/macOS `-D` decode option
- Node.js, reachable either on the noninteractive `PATH` or from a login shell (see below)
- Pi installed and authenticated on the remote host
- The configured workspace as an absolute POSIX path

Authentication, Pi settings, skills, MCP configuration, Git configuration, and SSH keys remain on the remote host. The profile stored by the desktop app contains no secrets. Provider sync is a separate, user-initiated capability: it can copy only selected provider definitions and explicitly approved API keys over SSH stdin. OAuth tokens, command credentials, resolved local environment secrets, and provider-scoped `env` values are never transferred.

## Install

The desktop app installs this file for you: **Settings › Remote agent**, fill in the host and workspace, press **Check**, then press **Install** on the launcher row. The app copies the launcher over the same SSH policy it uses at runtime, resolves `$HOME/.local/bin/pi-desktop-launcher` (no sudo), and stores the absolute path it wrote. The copy is embedded in the app binary, so it cannot drift from the build.

To place it manually instead, install it anywhere on an absolute path and set that path under **Advanced › Launcher path**:

```sh
install -m 0755 pi-desktop-launcher ~/.local/bin/pi-desktop-launcher
```

Configure the host in `~/.ssh/config` on the desktop machine and verify that noninteractive authentication and strict host-key validation already work:

```sh
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes build-host true
```

Remote Agent Mode does not handle password, MFA, keyboard-interactive, or first-use host-key prompts. Add or verify the host key outside the app before running preflight.

## Finding Node.js and Pi

`ssh host command` runs a **non-interactive, non-login** shell. It reads only `$BASH_ENV` — never `~/.bashrc` or `~/.profile` — and Debian's stock `~/.bashrc` returns early on `case $- in *i*) ;; *) return;; esac`, before any version-manager block. So nvm, fnm, volta and asdf put `node` on the *interactive* `PATH` and nowhere the launcher can see it. `node -v` works when you SSH in by hand and `ssh host node -v` fails on the same host.

When `node` is not already on the `PATH`, the launcher asks a login shell (`bash -lc`, then `zsh -lc`) for its `PATH` and **appends** it. Appending rather than prepending means anything already reachable keeps priority, so a host that works today cannot be changed by this. The same recovery is what makes an nvm-installed `pi` findable, since it lives in the same `bin` directory. Hosts with neither bash nor zsh fall back to the usual absolute locations (`~/.nvm/versions/node/*/bin`, `~/.local/share/fnm/…`, `~/.volta/bin`, `~/.asdf/shims`, `/usr/local/bin`, `/opt/homebrew/bin`); no version is chosen among them, so pin one with a symlink if it matters.

`--preflight` reports the interpreter it ended up on as `nodePath`, which the desktop app shows next to the version — a path under `.nvm` or `.volta` there is the visible sign that this recovery happened.

To check what a login shell resolves:

```sh
ssh build-host bash -lc 'command -v node; command -v pi'
```

## Protocol

The launcher accepts fixed internal modes. The desktop owns every SSH argument and the stored launcher path; renderer-provided values are never interpreted as shell, executable, environment, `HOME`, or arbitrary CLI argv.

- `--capabilities`: takes no payload and writes one JSON document to stdout. Launcher revision 5 advertises `run-v1`, `preflight-v1`, provider sync, detached task/attach, workspace read/write, and four independently gated PI-management capabilities: `pi-packages-read-v1`, `pi-packages-mutate-v1`, `pi-skills-read-v1`, and `pi-skills-mutate-v1`. `launcherRevision` identifies functional launcher builds; `statusVersion` changes only when the detached `status.json` schema changes.

  A launcher older than capability discovery answers `invalid launcher mode` with exit 64, which is byte-identical to what a corrupt launcher returns. The desktop therefore treats an unanswered query as a V1 baseline rather than a broken host. Reinstall the launcher (**Settings › Remote agent › Install**) to enable newer features. Read and mutation capabilities are checked separately, so a read-only launcher remains browsable while every mutation control fails closed.
- `--preflight`: validates the workspace and runs `pi --version`; writes one JSON document to stdout. Alongside `ok` it reports `piVersion`, `nodeVersion`, `nodePath`, and `piAuthConfigured` — the last is a nonempty-`auth.json` check, which the app surfaces as a warning rather than a blocker because pi exposes no way to query login state noninteractively.
- `--run`: starts `pi --mode rpc` in the remote workspace; stdout remains Pi JSONL and launcher diagnostics go to stderr.
- `--provider-sync`: reads one provider-sync protocol v1 request (maximum 2 MiB) from stdin. The fixed `inspect` and `apply` actions merge selected provider configuration while preserving existing remote credentials and unrelated entries. Provider JSON and credentials never appear in argv, environment variables, or diagnostics.
- `--manage`: reads exactly one management protocol v1 JSON envelope from stdin and writes exactly one JSON reply to stdout. It supports `inspect`, `readSkillSource`, `browseSkillSource`, `mutatePackage`, and `mutateSkill`. The global scope is always remote `$HOME/.pi/agent`; the project scope is always `<remoteCwd>/.pi`. Skill source reads use opaque SHA-256 references issued by `inspect`, never renderer-provided paths.
- Detached-task, attach, stop/send/status/reap, and workspace modes support the supervisor and target-scoped file bridge. Their arguments are fixed or opaque encoded protocol payloads; see the supervisor protocol document for lifecycle details.

Run/preflight payload protocol version `1` carries the remote workspace, Pi executable, and optional remote session path. Values are passed to Node's process APIs as arguments and are never evaluated as shell source.

### Management safety model

Management uses a separate short-lived SSH process; it never shares the `--run`, attached, detached, or attach data stream. Requests are limited to 64 KiB. Inspect/source reads time out after 30 seconds, source browsing after 120 seconds, and mutation after 300 seconds. Replies are limited to 2 MiB; CLI diagnostics to 64 KiB; one `SKILL.md` to 256 KiB; settings and package locks to 512 KiB each; package entries to 512 and skill entries to 2,048.

Every mutation carries the `stateToken` returned by `inspect`. The launcher acquires `$HOME/.pi/agent/.pi-desktop-management.lock`, performs a fresh inspect under that lock, and returns `stateConflict` rather than applying an operation to stale state. Live locks are never stolen. Locks older than ten minutes or owned by a missing PID are reclaimed through a separate reclaim lock and atomic quarantine rename. After the fixed PI/Skills CLI command ends—even with a nonzero status—the launcher performs another inspect and returns the authoritative snapshot. A skill move that installs the destination but fails to remove the source reports `halfDone: true`.

The launcher resolves only `pi`, `skills`, or the `npx -y skills@latest` fallback and constructs their allowlisted arguments itself. Long-running commands execute in a dedicated process group when `setsid` is available; timeout sends TERM and then KILL to the group. Snapshot settings expose only `packages`; package locks expose only package versions. Diagnostics are bounded and redact URL userinfo and common authorization, token, password, secret, and API-key forms.

## Lifecycle

Version 1 is attached to the SSH connection. Closing the app or stopping a conversation asks the launcher to terminate Pi, with a forced-kill fallback. Durable reattach, multi-client sharing, and guaranteed termination after network loss are not provided.

The SSH channel carries a liveness probe (`ServerAliveInterval=15`, `ServerAliveCountMax=3`), so a network partition ends the connection after roughly 45 seconds instead of leaving the desktop blocked on a socket that will never answer. What ends is the local `ssh` process: the remote Pi is terminated by SIGHUP forwarding, which requires the remote sshd to notice the dead peer first, and that can lag well behind. So after a partition the desktop reports the remote process status as **unknown** and does not reconnect on its own — a reconnect could start a second Pi against a session file the first one still owns. Recovery is an explicit restart.
