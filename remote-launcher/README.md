# Pi Desktop remote launcher

`pi-desktop-launcher` is the fixed remote entrypoint used by Remote Agent Mode. The desktop application starts system OpenSSH and invokes this file with an opaque Base64 payload. In run mode, the launcher's stdout is reserved exclusively for Pi's JSONL RPC stream.

## Requirements

The remote host must provide:

- POSIX `/bin/sh`
- `base64` with either the GNU `-d` or BSD/macOS `-D` decode option
- Node.js, reachable either on the noninteractive `PATH` or from a login shell (see below)
- Pi installed and authenticated on the remote host
- The configured workspace as an absolute POSIX path

Authentication, provider credentials, Pi settings, skills, MCP configuration, Git configuration, and SSH keys remain on the remote host. The profile stored by the desktop app contains no secrets.

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

The launcher accepts only two internal modes:

- `--preflight`: validates the workspace and runs `pi --version`; writes one JSON document to stdout. Alongside `ok` it reports `piVersion`, `nodeVersion`, `nodePath`, and `piAuthConfigured` — the last is a nonempty-`auth.json` check, which the app surfaces as a warning rather than a blocker because pi exposes no way to query login state noninteractively.
- `--run`: starts `pi --mode rpc` in the remote workspace; stdout remains Pi JSONL and launcher diagnostics go to stderr.

The payload protocol is versioned. Protocol version `1` carries the remote workspace, Pi executable, and optional remote session path. Values are passed to Node's process APIs as arguments and are never evaluated as shell source.

## Lifecycle

Version 1 is attached to the SSH connection. Closing the app or stopping a conversation asks the launcher to terminate Pi, with a forced-kill fallback. If the network connection disappears, the desktop reports the remote process status as unknown. Durable reattach, multi-client sharing, and guaranteed termination after network loss are not provided.
