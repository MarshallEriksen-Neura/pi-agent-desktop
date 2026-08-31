# Remote Agent V1 acceptance record

Remote Agent V2 (RAV2) replaces "attached to the SSH connection" with a remote task that has an identity and a confirmable state. Its status state machine can only be designed from **observed** V1 behaviour on a real Linux host, not from what the code is expected to do.

This document is the Phase 0.3 deliverable: a fill-in record. Every row's `Observed` column is an input to `remote-agent-v2-supervisor-protocol.md`, which should not be written before this table is complete.

## Naming

`remoteTasks.*`, `RemoteTaskState`, `task_manager`, and the "V2" in `src-tauri/src/remote_control/mod.rs` all belong to the **phone → desktop** LAN gateway. RAV2 is the **desktop → SSH host** feature and must not reuse those names. Use `remoteAgent.session.*` for i18n and `RemoteAgentTask` for types.

## Setup

Run it with the harness, which drives the real launcher over the real SSH policy:

```sh
node scripts/remote-agent-acceptance.mjs state          # leftovers from a previous run
node scripts/remote-agent-acceptance.mjs preflight      # 1 / 4 / 6
node scripts/remote-agent-acceptance.mjs normalExit     # 7
node scripts/remote-agent-acceptance.mjs partition      # 9  (server->client blocked)
node scripts/remote-agent-acceptance.mjs fullPartition  # 9b (both directions)
node scripts/remote-agent-acceptance.mjs desktopCrash   # 10
node scripts/remote-agent-acceptance.mjs reap           # kill anything left behind
```

Always run `state` first: a scenario that inherits another's orphan measures the wrong process. `partition`/`fullPartition` block **one peer port**, derived from the sshd session that owns the run, and install a self-removing rule — the harness's own control channel is never at risk, and a crashed harness cannot strand the rule.

## Setup

| Field | Value |
| --- | --- |
| Desktop build | `06bd8ca` + Phase 0.1/0.2 (uncommitted) |
| Host | `yuyun` (`154.40.59.88`, profile `remote-18d0a0eaf11dcf48`) |
| Remote OS / kernel | Ubuntu 24.04.4 LTS, 6.8.0-138-generic |
| Remote sshd | OpenSSH 9.6p1 Ubuntu-3ubuntu13.18 |
| Remote node / pi | v22.23.1 (resolved) / pi 0.84.4 |
| Launcher path | `/root/.local/bin/pi-desktop-launcher` |
| Workspace | `/root/turb-gpt-free-register` |
| Date | 2026-08-31 |

Host caveats that shape what is measurable: `pi` is **unauthenticated** (`auth.json` is 2 bytes, `piAuthConfigured: false`), so no scenario runs a model turn. That is not a blocker — pi's RPC loop boots and answers `get_state` without credentials, and every lifecycle question the V2 status machine needs is about process behaviour, not model output. Scenario 13's "long output" half is the one thing this host cannot answer.

Useful remote-side probes, run over a **second** SSH session so the measured one is untouched:

```sh
pgrep -af 'pi --mode rpc'                     # is the remote pi alive
ps -o pid,ppid,stat,etime,cmd -p "$(pgrep -d, -f 'pi --mode rpc')"
pgrep -af pi-desktop-launcher                 # did the launcher outlive its ssh channel
ss -tnp | grep -i ssh                         # channel still established
```

`ppid` and `stat` matter: a remote pi reparented to `1` with the launcher gone means SIGHUP forwarding never ran, which is exactly the state RAV2 must be able to report.

## Phase 0 changes under test

Two V1 defects were fixed before this run; both change what these scenarios produce.

- **D1 — SSH liveness probe.** `ssh_options()` now sends `ServerAliveInterval=15` and `ServerAliveCountMax=3`. `ConnectTimeout` only ever covered dialing, so a partition previously left the local `ssh` blocked forever: no exit, no error, no `pi://exit`, a UI stuck on "running", and a Stop that wrote into a dead pipe. Detection is now expected within roughly 45s (`interval × countMax`) plus scheduling overhead. **Scenario 9 measures the real number** — that measurement, not the arithmetic, is what RAV2's reconnect backoff is tuned against.
- **D2 — no blind remote reconnect.** `pi://exit` reports that the local `ssh` child ended, not that the remote pi died. The 3s auto-reconnect is now local-only. Previously a partition could reconnect while the first remote pi still held the session file, putting two `pi --session <same file>` processes on one transcript. Remote exits now surface `remoteAgent.target.statusUnknown` and wait for an explicit restart.

## Scenarios

Record what actually happened, including timings and exit codes. "As expected" is not an observation.

### Connection and prerequisites

| # | Scenario | Observed | Feeds |
| --- | --- | --- | --- |
| 1 | Plain SSH alias | ✅ `{"ok":true,"piVersion":"0.84.4","nodeVersion":"v22.23.1","nodePath":"/root/.nvm/versions/node/v22.23.1/bin/node","piAuthConfigured":false}` in **2.9s** | Baseline |
| 2 | ProxyJump | ⬜ not tested — `yuyun` is a direct host | RAV2 may not assume one TCP hop until tested |
| 3 | Agent / certificate auth | ⬜ not tested — plain `id_rsa` key | Auth boundary stays with OpenSSH |
| 4 | Pi not installed | ✅ `{"ok":false,"errorCode":"pi_not_found","error":"spawn pi-not-installed-xyz ENOENT"}`, launcher exit **0** | Preflight already distinguishes this; RAV2 needs no extra probe |
| 5 | Launcher not installed | ✅ `bash: /root/.local/bin/nope-launcher: No such file or directory`, exit **127** | V2.0 fallback keys off 127 |
| 5b | **Unknown launcher mode** | ✅ `invalid launcher mode` on stderr, exit **64** | **V2.0 handshake:** a V2 desktop against a V1 launcher gets 64 with no capability list — it cannot tell "old launcher" from "broken launcher" |
| 6 | Workspace missing | ✅ `{"ok":false,"errorCode":"workspace_missing","error":"remote cwd does not exist"}`, exit **0** | A task must not be creatable in this state |

### Lifecycle

| # | Scenario | Observed | Feeds |
| --- | --- | --- | --- |
| 7 | Normal completion | pi live as `1065642` (`ppid 1065621`, `Sl`). Local ssh ends → **remote pi and launcher both gone within 2s**. Local exit by SIGTERM | Terminal states are reliable on a clean close |
| 8 | Cancel while running | ✅ 14 chars streamed, then `abort`. **In-band acknowledgement in 204ms**; remote pi gone **3.4s** after channel close | **`stopConfirmedAt` has two sources** — see below |
| 9 | Half partition (server→client dropped) | Client detected in **24.4s**, exit **255**, `Connection reset by peer`. **Remote pi died** — server-side TCP gave up and RST, so sshd saw the close and SIGHUP reached pi | The benign shape |
| **9b** | **Full partition (both directions)** | Client detected in **24.2s**, exit **255**. **Remote pi alive at 12s, 32s, 62s, 92s, 122s — and still alive after the rules were removed.** `ppid` unchanged (`1074325`, launcher also alive), state `Sl`. Had to be killed manually | **The load-bearing result — see below** |
| 10 | Desktop crash (SIGKILL local ssh) | **Remote pi gone within 2s.** Even SIGKILL leaves the OS to send FIN, so sshd tears the session down normally | A crashed desktop does *not* orphan a task; only a partition does |

### Profile and configuration

| # | Scenario | Observed | Feeds |
| --- | --- | --- | --- |
| 11 | Profile edited mid-conversation | ⬜ not run on host — enforced desktop-side by `validate_binding` before any SSH, with unit coverage | `remoteTaskId` must not survive a revision bump |
| 12 | Profile deleted mid-conversation | ⬜ not run on host — same path | Orphan reaping must not require a profile |
| 13 | Long output | ✅ 53.0s, **2616 JSONL lines**, 2600 `text_delta` events, 4892 assistant chars but **677 KB stdout**, longest line **8513 chars**, **12.8 KB/s**, **0 bytes stderr** | Journal byte caps — see below |

## The 9b result

This is the measurement RAV2 is built on.

```text
t+0       both directions blocked
t+12.6s   remote pi 1074346 alive (ppid 1074325, Sl), launcher alive
t+24.2s   DESKTOP GIVES UP — ssh exits 255
t+32.5s   remote pi still alive
t+62.7s   remote pi still alive
t+92.6s   remote pi still alive
t+122.5s  remote pi still alive
t+122.5s  rules removed
t+127s    remote pi STILL ALIVE — reaped by hand
```

The remote side never learns. `sshd -T` on the host reports:

```text
clientaliveinterval 0
clientalivecountmax 3
tcpkeepalive yes
```

`ClientAliveInterval 0` means sshd runs **no** application-level liveness check, so it falls back to kernel TCP keepalive — which on Linux first probes after `tcp_keepalive_time`, **7200s**. So the ceiling on how long a remote pi can outlive the desktop's knowledge of it is on the order of **two hours**, not seconds.

Three consequences:

1. **D2 is confirmed by measurement, not argument.** For ~2 hours after the desktop reports failure, the remote pi is alive and holding its session file. The pre-Phase-0 code reconnected 3s after that exit with `--session <same file>` — two pi processes on one transcript, well inside the window.
2. **D1's window is 24s here, not the ~45s the arithmetic suggested.** `ServerAliveInterval × ServerAliveCountMax` is an upper bound; on this host TCP-level failure fires sooner. Reconnect backoff should be tuned against the measured 24s, and RAV2 must not assume the keepalive is what detects the loss.
3. **Orphan reaping is mandatory, and cheap.** Scenario 10 shows a crashed desktop does not orphan anything — only a partition does. So reaping is a rare path, not a hot one, which supports doing it on the next launcher invocation rather than from a resident daemon.

## Provider sync and a real model turn

`novol` was synced to this host through the launcher's `--provider-sync`, driving the same two-phase `inspect` → `apply` envelope Rust builds. Result on the remote:

```text
provider: novol api=openai-responses host=novol.ethereals.space models=13 apiKeyInDef=false
auth:     novol type=api_key keyPresent=true keyLen=67
models.json 0600   auth.json 0600
```

`apiKeyInDef=false` is the contract holding: the literal `models.json.apiKey` was stripped from the provider definition and installed as an auth credential instead. `inspect` first reported `configExists:false, authCredentialExists:false`, so nothing was overwritten, and `apply` returned `credentialAction: willInstallApiKey` with `remoteReloadRequired`. Preflight afterwards flipped to `piAuthConfigured: true`.

A real turn then ran end to end: `novol/gpt-5.6-sol` answered `SOL_OK` over the SSH channel in ~10s. That is what unblocked scenarios 8 and 13.

**The launcher on this host was several versions behind** (7418 bytes vs 34846 in source, zero occurrences of `provider-sync`), so the first `--provider-sync` attempt returned `invalid launcher mode` / exit 64 — byte-identical to what a corrupt launcher returns. Reinstalling through the app's own installer fixed it. This is the second independent confirmation that V2.0 is mandatory, and it argues for the desktop comparing installed against embedded launcher version, because this drift is currently silent.

## What 8 and 13 mean for the design

**`stopConfirmedAt` has two distinct sources, and they are 17× apart.** Pi acknowledges `abort` in-band in **204ms**, but the remote process only disappears **3.4s** after the channel closes. A supervisor must record both: the in-band ack proves the model stopped generating, while process death proves the task released its session file. Reporting only the fast one would call a task stopped while it still holds the file; reporting only the slow one would make cancellation feel broken.

**Journal caps must be byte-based, and the amplification is ~138×.** 4892 characters of assistant text produced **677 KB** of JSONL, because every delta is its own framed event with usage attached. At the measured 12.8 KB/s a chatty turn writes ~1 MB in 80 seconds, and the ~2 hour orphan ceiling from 9b implies a worst case near **90 MB for a single abandoned task**. Consequences:

- a per-line cap is wrong — the longest single line was **8513 chars** and that is legitimate;
- rotation must never split a JSONL line, or replay resumes mid-object;
- **16 MB is too small.** Size the cap against the 9b ceiling, not against a typical turn, and pair it with the idle TTL so an abandoned task is reaped long before it reaches the cap.

**stderr was 0 bytes across every scenario.** Every diagnostic pi produced arrived as stdout JSONL. The journal must therefore tag streams rather than assume stderr carries the errors, and a supervisor that watches only stderr for failure sees nothing.

## Findings

| Finding | Impact on RAV2 |
| --- | --- |
| **Pi rewrites its argv to a bare `pi`.** The `--mode rpc` the launcher passes never appears in `/proc/<pid>/cmdline`, so `pgrep -f 'pi --mode rpc'` matches nothing while pi is actively answering RPC. The tree is `sshd → node -e <launcher> → pi` | A reaper **cannot** identify a pi by command line. The supervisor must record the PID explicitly (`pi.pid`), and orphan sweeps need `pgrep -x pi` plus a parent check. This alone rules out the "just grep for it" reaper |
| **Pi inherits `PI_DESKTOP_LAUNCHER_MODE`.** Both launcher and pi carry it, so environment alone cannot tell them apart — they must be split by `comm` | Any `/proc`-based discovery must classify, not just filter |
| **Node version is chosen by glob order, not by nvm's `default` alias.** Three versions installed; `default → stable → v25.9.0`, but the launcher's fallback appended `v22.23.1` first and that is what ran. `pi` only exists in `v25.9.0/bin` yet still resolved, because every nvm bin lands on `PATH` | Pi runs under a **different node than it was installed with**. Harmless here (0.84.4 started fine) but it is silent version skew, and the launcher's own comment already admits no version is chosen. Worth a preflight warning when `nodePath` and the resolved `pi` come from different version directories |
| **Ubuntu's `.bashrc` early-return defeats `bash -lc` PATH recovery.** `ssh yuyun bash -lc 'command -v node'` finds nothing, so the documented login-shell recovery contributed nothing; only the absolute-path fallback worked | The fallback is not a last resort on this class of host — it is the primary path. Do not remove it |
| **`--attach` (any unknown mode) exits 64 with a bare `invalid launcher mode`** | Confirms V2.0 is a hard prerequisite: there is no way for a V2 desktop to distinguish an old launcher from a broken one, so it cannot degrade gracefully |
| Harness bug worth remembering: a literal NUL in argv (`tr "\0" "\n"`) makes Node's `spawnSync` throw, and a probe that swallows that error reports "no remote processes" — indistinguishable from a real clean state | Any RAV2 status check must fail loud, never fail empty |
| **Streaming is not guaranteed.** The same prompt to the same model sometimes arrives as `assistantMessageEvent: text_delta` events and sometimes only as finished text inside `message_end`, with `message_update` carrying nothing but `usage`. Both shapes were observed minutes apart. The first version of this harness read deltas only and reported an empty response for a turn that plainly succeeded | **V2.2 replay must journal raw JSONL and reconstruct text from both shapes.** A consumer that rebuilds a transcript from deltas alone will silently lose whole turns |
| **The installed launcher had drifted 5 versions behind with no signal.** `--provider-sync` returned exit 64, identical to a corrupt launcher | V2.0 confirmed mandatory; the desktop should also compare installed vs embedded launcher version and offer reinstall |

## Verdict

| Gate | Status |
| --- | --- |
| Scenarios 1, 4, 5, 5b, 6 recorded | ✅ |
| Scenarios 7, 9, 9b, 10 recorded with timings | ✅ |
| D1 detection window measured | ✅ **24.2–24.4s** on this host (not the ~45s the arithmetic implied) |
| D2 confirmed necessary | ✅ remote pi outlives desktop knowledge by up to ~2h (`ClientAliveInterval 0`) |
| Scenario 8 stop timing measured | ✅ **204ms** in-band ack, **3.4s** to process death |
| Scenario 13 output volume measured | ✅ **12.8 KB/s**, ~138× amplification, longest line **8513 chars** |
| Real model turn over SSH | ✅ `novol/gpt-5.6-sol` → `SOL_OK` |
| Scenarios 2, 3 (ProxyJump, cert auth) | ⬜ needs a second host shape |
| Scenarios 11, 12 (profile mutation) | ⬜ desktop-side, unit-covered, not host-verified |

**The status state machine can now be designed.** The four states RAV2 needs are all evidenced:

- `running` — pi alive, channel alive (7, 9, 9b all confirm the live shape)
- `lost` — channel gone, remote state **unknown and not inferable** (9b: the desktop is wrong for up to ~2h if it guesses)
- `exited` — confirmed dead with a code (7, 10: reliable on any clean close, including SIGKILL)
- `orphaned` — pi alive, no owning channel (9b, reachable only via partition)

`lost` and `orphaned` being distinct is the whole point: V1 collapses them into "unknown" and then guessed wrong.

Remaining gaps are narrow and none of them block the protocol document: ProxyJump/cert auth affect the transport assumption, and scenarios 8/13 affect timing constants that can be filled in from a host with credentials. Both should be closed before V2.1 ships, not before it starts.
