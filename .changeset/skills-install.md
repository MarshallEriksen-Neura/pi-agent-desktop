---
title: "Skills: install, uninstall, update and re-scope skills without leaving the app"
---

## Problem

The skills page could only read. `useSkills.scan()` walked pi's three skill
locations and parsed each `SKILL.md` frontmatter, so the page listed, searched
and previewed skills — and that was the end of it. Getting a skill onto disk
meant leaving the app for a terminal, and remembering which directory maps to
"available everywhere" versus "just this project".

## What this adds

`npx skills` ([vercel-labs/skills](https://github.com/vercel-labs/skills)) now
drives the page. That CLI already treats pi as a first-class agent
(`--agent pi`), writing to `~/.pi/agent/skills` globally and `<root>/.pi/skills`
per project — the same two directories the scanner already reads, so an install
lands in the existing Global/Project groups after a rescan.

**One field, two ways in.** Type a name and the skills.sh catalogue answers as
you type; paste a place — `owner/repo`, a git or download URL, a local path — and
a List button appears to enumerate it. Which mode applies is decided by whether
the text carries a separator (`/ \ : . ~`), because a bare word cannot be a
source and a name should never trigger a twenty-second clone.

Naming a skill is the common case and it is genuinely ambiguous: `ui-ux-pro-max`
exists in nine different repositories, so the answer has to be a list to choose
from, not a guess. Results are ranked exact-name-first and then by installs —
without that, one repo's higher-installed siblings (`ckm:design-system` at 32K)
outrank the eight other repos actually publishing the name you typed.

Search hits go to `https://skills.sh/api/search`, the anonymous endpoint the
CLI's own `find` command uses. The documented `/api/v1/*` API is not reachable
from here: it wants a Vercel OIDC bearer token and returns 401.

The request is issued from Rust, not the renderer. `/api/search` answers with no
`Access-Control-Allow-Origin` at all, so a `fetch` from the webview is blocked
before the response can be read and surfaces only `TypeError: Failed to fetch` —
which looks exactly like a dead network and is why the store page's
`registry.npmjs.org` fetch works while this one could not (npm sends `ACAO: *`).
A native client has no same-origin rule, gets a real error message and a
timeout, and picks up the user's proxy from `HTTP(S)_PROXY` or, on Windows, the
Internet Settings registry key.

- **Uninstall / update / move between scopes** from the expanded skill row.
  Moving re-installs from the source recorded in the CLI's lock file and then
  removes the old copy — the same two steps `skills update` performs internally.
  Copying the directory instead would leave the target scope's lock empty and
  silently opt the skill out of future updates, so the action is offered only
  when a lock entry exists.

## Notes

Installs pass `--copy`. The CLI's default is a symlink into a canonical
`~/.agents/skills`, and a Windows junction cannot be committed alongside a
project's `.pi/skills/`, which upstream intends to be checked in.

`skills_cli` ([src-tauri/src/skills_cli.rs](../src-tauri/src/skills_cli.rs))
mirrors `pi_cli`: an allowlist of subcommands (`add`, `remove`, `update`,
`list`), null stdin, no console window on Windows. It prefers a globally
installed `skills` binary and otherwise falls back to `npx -y skills@latest`,
resolving both through `pi_command::resolve_executable` so npm's `.cmd` shims are
found. Because a first npx download plus a source clone runs into tens of
seconds, it is `async` over `spawn_blocking` rather than a sync command.

## Reading the CLI's failures

The Skills CLI logs through clack, which writes to **stdout** — including the
reason an operation failed. stderr, meanwhile, usually carries nothing but npm's
warning about a config key in the user's `.npmrc`. Reporting `stderr || stdout`
therefore showed the noise and hid the reason: typing a skill name into the
source field produced

> npm warn Unknown project config "verify-deps-before-run" …

instead of

> Failed to clone ui-ux-pro-max: fatal: repository 'ui-ux-pro-max' does not exist

`cliError` now reads both streams, drops npm chatter, clack gutters, spinner
frames and the generic "Installation failed / Canceled" outro, and keeps the last
few meaningful lines. `npm_config_loglevel=error` on the child process stops the
warning at the source as well.

## Which row is installed

A skill name is not unique: `ui-ux-pro-max` is published by nine unrelated
repos. Matching the installed set by name alone therefore badged all nine rows
as installed the moment one of them was.

What is on disk carries no record of where it came from — `SKILL.md` has a name
and a description, nothing else. The CLI's lock files do, keyed by name
(`~/.agents/.skill-lock.json`, and `<root>/skills-lock.json` for a project), so
`parseLock` now reports each entry's `source` — the same `owner/repo` identity
the catalogue returns — with `sourceUrl` normalized down to it for older
entries. A row is badged installed only when that source is the one it offers.

The other eight are not simply "not installed": only one directory can hold a
given name, so installing any of them replaces what is there. Those rows keep
the install button and gain a `Replaces` badge naming the consequence.

## Incidental fix

`fs_list_dir` decided `isDir` from `DirEntry::file_type()`, which describes the
link rather than its target — so a Windows junction or a Unix symlink to a
directory was reported as neither file nor directory. Since a symlink is the
CLI's *default* install mode, every skill a user had installed from a terminal
was invisible on this page. It now follows the link. The file tree gets the same
fix for free.
