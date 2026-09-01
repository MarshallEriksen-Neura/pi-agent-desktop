---
title: "Sessions: deleting a conversation deletes pi's transcript, and a stale pin can no longer overwrite one"
---

## Problem

Deleting a conversation only deleted the Desktop side of it. `chat_session_delete`
was one statement — `DELETE FROM chat_sessions WHERE id = ?1` — and nothing in the
delete path ever reached the filesystem, so pi's own `.jsonl` transcript stayed
where it was. Desktop reported the conversation gone while `pi` and the CLI still
listed it, and the orphans accumulated with nothing that could ever collect them.
On the machine this was diagnosed on, one project's session directory held 88
transcripts totalling 97 MB, of which 8 were still referenced by a database row.

Separately, `--session <path>` is not a read-only resume: pi *creates* a session at
that path when the file is missing or empty. A pin that no longer named a real file
was therefore not merely a lost resume — it was pi being pointed at a path to fill
in. Four rows in the same database had pins to files that no longer existed.

## What changed

**Deleting a conversation now moves its transcript to
`~/.pi/agent/session-trash/<slug>/`**, and takes the sibling `<stem>/` directory of
subagent run transcripts with it — that directory was most of the orphan volume.
`subagent-artifacts/` sits alongside those but is shared by every conversation in
the slug, and is deliberately not selectable: it is not any transcript's stem.

Trash rather than unlink, because the first real use of this on any existing
install is a bulk cleanup of the backlog above, which is when an undo path matters
most. Entries are prefixed with a timestamp, and the transcript and its run
directory share one prefix so a restore can tell which pair belonged together. The
prefix is probed for collisions rather than trusted: it has millisecond resolution,
and two same-named deletes inside one millisecond would otherwise have the second
`rename` silently replace the first — losing a transcript inside the directory that
exists to make deletes undoable. There is no in-app restore yet; the trash is a
plain directory, and restoring means moving a file back.

**The index row goes first, the file second.** The reverse order is what makes this
dangerous: a transcript moved out from under a surviving row would be recreated
empty by that row's next `--session` resume, so a delete the user was never told had
succeeded would quietly consume the conversation instead. This order can only leave
an orphan transcript, which is exactly where every delete before this already left
things. A failed move therefore does not fail the delete, and a failed row delete
does not touch the file.

**A pin that no longer names a real transcript is not passed to `--session`.**
`is_resumable` requires an existing, non-empty file; otherwise pi starts fresh and
its `session` announcement re-pins the row, so the stale entry heals instead of
being built on.

## Scope

Local conversations only. An SSH conversation's transcript lives on the remote
host, and the launcher has no file operations at all — reaching it needs a new
launcher mode and a protocol bump, so those transcripts are deliberately left in
place where the remote pi can still resume them. Mobile/gateway conversations
(`remote-control-sessions/`, indexed in `remote-control.sqlite3`) are a separate
store with its own sandbox and are untouched here.

This does not make pi's JSONL the source of truth for session *content*. Sessions
created outside Desktop are still invisible to the sidebar, which is the other half
of the same report and a much larger change.
