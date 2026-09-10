//! Pi's own session files on disk — `<sessions root>/<cwd-slug>/*.jsonl`.
//!
//! SQLite ([`crate::chat_store`]) indexes conversations; pi owns their content.
//! Deleting a conversation therefore has to reach both, and the two halves fail
//! differently. The desktop caller creates the database tombstone first, then uses
//! this module for the file move, persists the resulting trash paths, and compensates
//! a failed path update by restoring the moved files. Keeping the file operations
//! here makes that orchestration explicit and independently testable.
//!
//! Files are moved into a trash directory rather than unlinked. Any install that
//! predates this has a backlog of orphans — every delete before it left the
//! transcript behind — so the first real use of this is a bulk cleanup, which is
//! exactly when an undo path matters most.
//!
//! Both roots are parameters rather than resolved here: the caller knows where
//! `~/.pi/agent` is, and passing them in is what lets these rules be tested
//! against a temporary directory instead of the developer's own history.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

/// What a trash request actually did.
///
/// A `skipped` reason with nothing moved is still success: a conversation closed
/// before its first turn never had a transcript, and one deleted twice has
/// nothing left to move.
#[derive(Serialize, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTrashOutcome {
    /// Where the transcript went, when there was one to move.
    pub file: Option<String>,
    /// Where the sibling run directory went, when the session had one.
    pub directory: Option<String>,
    /// Why nothing moved, when that is the expected outcome.
    pub skipped: Option<String>,
}

impl SessionTrashOutcome {
    fn skipped(reason: &str) -> Self {
        Self {
            skipped: Some(reason.to_owned()),
            ..Default::default()
        }
    }
}

/// Files moved back to the live session tree by [`restore_transcript`].
///
/// The caller keeps this receipt until its database transaction commits. If that
/// transaction fails, [`rollback_restore_transcript`] uses the receipt to put only
/// the files moved by this attempt back into their exact recycle-bin locations.
#[derive(Default, Debug, PartialEq, Eq)]
pub struct SessionRestoreOutcome {
    pub file_restored: bool,
    pub directory_restored: bool,
}

impl SessionRestoreOutcome {
    pub fn is_empty(&self) -> bool {
        !self.file_restored && !self.directory_restored
    }
}

/// Resolve `raw` to a transcript inside `root`, or explain why it is refused.
///
/// The path comes from a database row, so it is not trusted: it may predate the
/// current install, or name a file on another host entirely — an SSH
/// conversation's `/root/.pi/agent/sessions/...` appears verbatim in a local row.
///
/// Canonicalizing the *parent* rather than the file is deliberate. A row can
/// point at a transcript pi never materialized, and that has to stay a skip
/// rather than an error. The parent still has to canonicalize, which is what
/// defeats `..` traversal and symlinked detours out of the root.
fn resolve_within(root: &Path, raw: &str) -> Result<PathBuf, SessionTrashOutcome> {
    let candidate = Path::new(raw);
    let Some(file_name) = candidate.file_name().and_then(|name| name.to_str()) else {
        return Err(SessionTrashOutcome::skipped("path has no file name"));
    };
    if !file_name.ends_with(".jsonl") {
        return Err(SessionTrashOutcome::skipped("not a .jsonl transcript"));
    }
    let Some(parent) = candidate.parent() else {
        return Err(SessionTrashOutcome::skipped("path has no parent"));
    };

    // The root itself may legitimately not exist yet on a fresh install.
    let Ok(root) = root.canonicalize() else {
        return Err(SessionTrashOutcome::skipped("no local session root"));
    };
    let Ok(parent) = parent.canonicalize() else {
        return Err(SessionTrashOutcome::skipped("transcript directory is gone"));
    };
    if !parent.starts_with(&root) {
        return Err(SessionTrashOutcome::skipped(
            "outside the local session root",
        ));
    }
    Ok(parent.join(file_name))
}

/// Whether pi can be pointed at `path` with `--session` without destroying it.
///
/// `--session` is not a read-only resume: pi *creates* a session at that path when
/// the file is missing or empty. So handing over a stale pin does not merely fail
/// to restore context — it can overwrite the very transcript it was meant to
/// restore. A caller that gets `false` should start a fresh session instead; pi
/// announces the new path, the index row is re-pinned, and the stale entry heals
/// rather than being built on.
///
/// Local paths only. A remote conversation's transcript lives on the far host,
/// where this check would test the wrong filesystem and refuse every resume.
pub fn is_resumable(path: &str) -> bool {
    let path = path.trim();
    if path.is_empty() {
        return false;
    }
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() > 0)
}

/// A trash name prefix that is free for both halves of a session's footprint.
///
/// The timestamp alone is not enough. It has millisecond resolution, so deleting
/// two conversations that share a file name within the same millisecond would aim
/// both moves at one path and let the second `rename` replace the first — losing
/// a transcript inside the very directory that exists to make deletes undoable.
///
/// The transcript and its run directory take the *same* prefix, so a restore can
/// still tell which pair belonged together.
fn free_prefix(destination: &Path, file_name: &str, stem: &str) -> String {
    let stamp = now_ms();
    for attempt in 0.. {
        let prefix = if attempt == 0 {
            stamp.to_string()
        } else {
            format!("{stamp}-{attempt}")
        };
        let taken = destination.join(format!("{prefix}__{file_name}")).exists()
            || destination.join(format!("{prefix}__{stem}")).exists();
        if !taken {
            return prefix;
        }
    }
    unreachable!("a free prefix always exists: the candidate name keeps growing")
}

/// Move one conversation's transcript from `root` into `trash`.
///
/// Best-effort by contract: the caller creates a database tombstone first, so a
/// skip or error leaves a recoverable record pointing at the original path.
pub fn trash_transcript(
    root: &Path,
    trash: &Path,
    path: &str,
) -> Result<SessionTrashOutcome, String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Ok(SessionTrashOutcome::skipped("no transcript path recorded"));
    }
    let transcript = match resolve_within(root, raw) {
        Ok(resolved) => resolved,
        Err(outcome) => return Ok(outcome),
    };

    // The slug directory is the per-cwd bucket pi files sessions under. Mirroring
    // it inside the trash is what makes a restore unambiguous: two projects can
    // hold transcripts with the same file name.
    let slug = transcript
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or("unknown");
    let file_name = transcript
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "transcript has no file name".to_owned())?;
    let destination = trash.join(slug);

    // A session's on-disk footprint is a transcript *and* optionally a sibling
    // directory of the same stem holding subagent run transcripts. Leaving those
    // behind was most of the orphan volume. `subagent-artifacts/` sits alongside
    // them but is shared by every session in the slug, and cannot be selected
    // here because it is not any transcript's stem.
    let stem = file_name.strip_suffix(".jsonl").unwrap_or(file_name);
    let runs = transcript.with_file_name(stem);
    let move_transcript = transcript.is_file();
    let move_runs = !stem.is_empty() && runs.is_dir();
    if !move_transcript && !move_runs {
        return Ok(SessionTrashOutcome::skipped("transcript was already gone"));
    }

    std::fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
    let prefix = free_prefix(&destination, file_name, stem);
    let mut outcome = SessionTrashOutcome::default();

    if move_transcript {
        let target = destination.join(format!("{prefix}__{file_name}"));
        std::fs::rename(&transcript, &target).map_err(|error| {
            format!("could not move transcript into the session trash: {error}")
        })?;
        outcome.file = Some(target.to_string_lossy().into_owned());
    }
    if move_runs {
        let target = destination.join(format!("{prefix}__{stem}"));
        if let Err(error) = std::fs::rename(&runs, &target) {
            if let Some(moved_file) = outcome.file.as_deref() {
                // Keep deletion atomic at the session-footprint level: if the
                // second move fails, put the transcript back so the caller does
                // not lose track of a partially recycled conversation.
                if let Err(rollback_error) = std::fs::rename(moved_file, &transcript) {
                    return Err(format!(
                        "could not move subagent runs into the session trash: {error}; transcript rollback also failed: {rollback_error}"
                    ));
                }
                outcome.file = None;
            }
            return Err(format!(
                "could not move subagent runs into the session trash: {error}"
            ));
        }
        outcome.directory = Some(target.to_string_lossy().into_owned());
    }
    Ok(outcome)
}

fn resolve_existing_in(root: &Path, raw: &str) -> Result<Option<PathBuf>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let root = root
        .canonicalize()
        .map_err(|error| format!("session trash root is unavailable: {error}"))?;
    let candidate = Path::new(raw);
    if !candidate.exists() {
        return Ok(None);
    }
    let resolved = candidate
        .canonicalize()
        .map_err(|error| format!("cannot resolve recycle-bin entry: {error}"))?;
    if !resolved.starts_with(&root) {
        return Err("recycle-bin entry is outside the trusted session trash".into());
    }
    Ok(Some(resolved))
}

/// Put a recycled transcript and its optional subagent run directory back at
/// their original Pi-owned paths. Existing destinations are never overwritten.
/// The returned receipt must be retained until the caller's database transaction
/// commits so the move can be compensated if that transaction fails.
pub fn restore_transcript(
    root: &Path,
    trash: &Path,
    original_path: &str,
    trash_file: Option<&str>,
    trash_directory: Option<&str>,
) -> Result<SessionRestoreOutcome, String> {
    let original = original_path.trim();
    if original.is_empty() {
        return Ok(SessionRestoreOutcome::default());
    }
    let destination = resolve_within(root, original).map_err(|outcome| {
        outcome
            .skipped
            .unwrap_or_else(|| "invalid original transcript path".into())
    })?;
    let file_source = match trash_file {
        Some(path) => resolve_existing_in(trash, path)?,
        None => None,
    };
    let dir_source = match trash_directory {
        Some(path) => resolve_existing_in(trash, path)?,
        None => None,
    };

    if file_source.is_some() && destination.exists() {
        return Err("cannot restore transcript because the original path already exists".into());
    }
    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "original transcript has no valid stem".to_owned())?;
    let run_destination = destination.with_file_name(stem);
    if dir_source.is_some() && run_destination.exists() {
        return Err(
            "cannot restore subagent runs because the original directory already exists".into(),
        );
    }

    // A missing recycled file is not allowed to trap the cached conversation in
    // the recycle bin forever. Restoring the SQLite row is still useful; the
    // existing resumability guard will start a fresh Pi session if the transcript
    // cannot be recovered.
    let mut outcome = SessionRestoreOutcome::default();
    if let Some(source) = file_source.as_ref() {
        std::fs::rename(source, &destination)
            .map_err(|error| format!("could not restore transcript: {error}"))?;
        outcome.file_restored = true;
    }
    if let Some(source) = dir_source.as_ref() {
        if let Err(error) = std::fs::rename(source, &run_destination) {
            if outcome.file_restored {
                let file_source = file_source.as_ref().expect("restored file source");
                if let Err(rollback_error) = std::fs::rename(&destination, file_source) {
                    return Err(format!(
                        "could not restore subagent runs: {error}; transcript rollback also failed: {rollback_error}"
                    ));
                }
            }
            return Err(format!("could not restore subagent runs: {error}"));
        }
        outcome.directory_restored = true;
    }
    Ok(outcome)
}

fn resolve_restore_target(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("session trash root is unavailable: {error}"))?;
    let candidate = Path::new(raw.trim());
    let file_name = candidate
        .file_name()
        .ok_or_else(|| "recycle-bin destination has no file name".to_owned())?;
    let parent = candidate
        .parent()
        .ok_or_else(|| "recycle-bin destination has no parent".to_owned())?
        .canonicalize()
        .map_err(|error| format!("cannot resolve recycle-bin destination: {error}"))?;
    if !parent.starts_with(&root) {
        return Err("recycle-bin destination is outside the trusted session trash".into());
    }
    Ok(parent.join(file_name))
}

/// Reverse only the moves reported by a failed restore attempt.
///
/// This is the filesystem compensation for a database transaction that could not
/// reinsert the session row. It targets the original recycle-bin names rather than
/// allocating new ones, so the still-live tombstone remains retryable.
pub fn rollback_restore_transcript(
    root: &Path,
    trash: &Path,
    original_path: &str,
    trash_file: Option<&str>,
    trash_directory: Option<&str>,
    restored: &SessionRestoreOutcome,
) -> Result<(), String> {
    if restored.is_empty() {
        return Ok(());
    }

    let destination = resolve_within(root, original_path.trim()).map_err(|outcome| {
        outcome
            .skipped
            .unwrap_or_else(|| "invalid original transcript path".into())
    })?;
    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "original transcript has no valid stem".to_owned())?;
    let run_destination = destination.with_file_name(stem);

    let file_target = if restored.file_restored {
        let raw = trash_file
            .ok_or_else(|| "restored transcript has no recycle-bin destination".to_owned())?;
        let target = resolve_restore_target(trash, raw)?;
        if target.exists() {
            return Err(
                "cannot roll back transcript restore because its recycle-bin path is occupied"
                    .into(),
            );
        }
        if !destination.is_file() {
            return Err(
                "cannot roll back transcript restore because the restored file is missing".into(),
            );
        }
        Some(target)
    } else {
        None
    };
    let directory_target = if restored.directory_restored {
        let raw = trash_directory
            .ok_or_else(|| "restored subagent runs have no recycle-bin destination".to_owned())?;
        let target = resolve_restore_target(trash, raw)?;
        if target.exists() {
            return Err(
                "cannot roll back subagent-run restore because its recycle-bin path is occupied"
                    .into(),
            );
        }
        if !run_destination.is_dir() {
            return Err(
                "cannot roll back subagent-run restore because the restored directory is missing"
                    .into(),
            );
        }
        Some(target)
    } else {
        None
    };

    if let Some(target) = directory_target.as_ref() {
        std::fs::rename(&run_destination, target)
            .map_err(|error| format!("could not roll back restored subagent runs: {error}"))?;
    }
    if let Some(target) = file_target.as_ref() {
        if let Err(error) = std::fs::rename(&destination, target) {
            if let Some(directory_target) = directory_target.as_ref() {
                let _ = std::fs::rename(directory_target, &run_destination);
            }
            return Err(format!("could not roll back restored transcript: {error}"));
        }
    }
    Ok(())
}

/// Permanently remove one recycled conversation. This covers both normal trash
/// entries and the fallback case where the index delete succeeded but moving the
/// original transcript into the recycle bin did not.
pub fn purge_transcript(
    root: &Path,
    trash: &Path,
    original_path: &str,
    trash_file: Option<&str>,
    trash_directory: Option<&str>,
) -> Result<(), String> {
    let recycled_file = match trash_file {
        Some(raw) => resolve_existing_in(trash, raw)?,
        None => None,
    };
    if let Some(path) = recycled_file {
        if path.is_file() {
            std::fs::remove_file(&path).map_err(|error| {
                format!("could not permanently delete recycled transcript: {error}")
            })?;
        }
    }
    let recycled_directory = match trash_directory {
        Some(raw) => resolve_existing_in(trash, raw)?,
        None => None,
    };
    if let Some(path) = recycled_directory {
        if path.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|error| {
                format!("could not permanently delete recycled subagent runs: {error}")
            })?;
        }
    }

    let original = original_path.trim();
    if original.is_empty() {
        return Ok(());
    }
    let transcript = match resolve_within(root, original) {
        Ok(path) => path,
        Err(outcome) => {
            return Err(outcome
                .skipped
                .unwrap_or_else(|| "invalid original transcript path".into()))
        }
    };
    if transcript.is_file() {
        std::fs::remove_file(&transcript).map_err(|error| {
            format!("could not permanently delete original transcript: {error}")
        })?;
    }
    let stem = transcript
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !stem.is_empty() {
        let runs = transcript.with_file_name(stem);
        if runs.is_dir() {
            std::fs::remove_dir_all(&runs).map_err(|error| {
                format!("could not permanently delete original subagent runs: {error}")
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temporary `sessions/` + `session-trash/` pair holding one slug bucket.
    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        trash: PathBuf,
        slug: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    fn fixture(name: &str) -> Fixture {
        let base = std::env::temp_dir().join(format!("pi-session-trash-{name}-{}", now_ms()));
        let root = base.join("sessions");
        let slug = root.join("--D--project--");
        let trash = base.join("session-trash");
        std::fs::create_dir_all(&slug).expect("slug dir");
        std::fs::create_dir_all(&trash).expect("trash dir");
        Fixture {
            base,
            root,
            trash,
            slug,
        }
    }

    fn transcript(fixture: &Fixture, name: &str) -> PathBuf {
        let path = fixture.slug.join(name);
        std::fs::write(&path, "{\"type\":\"session\",\"version\":3}\n").expect("write transcript");
        path
    }

    fn trash(fixture: &Fixture, path: &Path) -> SessionTrashOutcome {
        trash_transcript(
            &fixture.root,
            &fixture.trash,
            path.to_str().expect("utf-8 path"),
        )
        .expect("trash")
    }

    #[test]
    fn moves_the_transcript_out_of_the_session_root() {
        let f = fixture("moves");
        let path = transcript(&f, "a.jsonl");

        let outcome = trash(&f, &path);

        assert!(!path.exists(), "the transcript must leave the session root");
        let moved = outcome.file.expect("a moved transcript is reported back");
        assert!(Path::new(&moved).is_file(), "and must still be recoverable");
        assert!(
            moved.contains("--D--project--"),
            "the trash mirrors the slug so a restore is unambiguous: {moved}"
        );
        assert_eq!(outcome.skipped, None);
    }

    #[test]
    fn takes_the_sibling_subagent_run_directory_with_it() {
        let f = fixture("runs");
        let path = transcript(&f, "b.jsonl");
        let runs = f.slug.join("b");
        std::fs::create_dir_all(runs.join("7e0aef4a/run-0")).expect("runs dir");
        std::fs::write(runs.join("7e0aef4a/run-0/session.jsonl"), "{}\n").expect("run transcript");

        let outcome = trash(&f, &path);

        assert!(!runs.exists(), "the run directory is part of the footprint");
        let moved = outcome
            .directory
            .expect("a moved run directory is reported");
        assert!(Path::new(&moved)
            .join("7e0aef4a/run-0/session.jsonl")
            .is_file());
    }

    #[test]
    fn leaves_the_shared_subagent_artifacts_directory_alone() {
        let f = fixture("artifacts");
        let path = transcript(&f, "c.jsonl");
        let shared = f.slug.join("subagent-artifacts");
        std::fs::create_dir_all(&shared).expect("shared dir");
        let artifact = shared.join("3e8344bd_reviewer_transcript.jsonl");
        std::fs::write(&artifact, "{}\n").expect("artifact");

        trash(&f, &path);

        assert!(
            artifact.is_file(),
            "subagent-artifacts is shared by every session in the slug"
        );
    }

    #[test]
    fn a_transcript_pi_never_wrote_is_a_skip_not_a_failure() {
        let f = fixture("missing");

        let outcome = trash(&f, &f.slug.join("never-written.jsonl"));

        assert_eq!(outcome.file, None);
        assert_eq!(
            outcome.skipped.as_deref(),
            Some("transcript was already gone")
        );
    }

    #[test]
    fn refuses_a_path_outside_the_session_root() {
        let f = fixture("outside");
        let outside = f.base.join("elsewhere");
        std::fs::create_dir_all(&outside).expect("outside dir");
        let victim = outside.join("precious.jsonl");
        std::fs::write(&victim, "{}\n").expect("victim");

        let outcome = trash(&f, &victim);

        assert!(
            victim.is_file(),
            "a path outside the root must not be moved"
        );
        assert_eq!(
            outcome.skipped.as_deref(),
            Some("outside the local session root")
        );
    }

    #[test]
    fn refuses_traversal_back_out_of_the_session_root() {
        let f = fixture("traversal");
        let outside = f.base.join("elsewhere");
        std::fs::create_dir_all(&outside).expect("outside dir");
        let victim = outside.join("precious.jsonl");
        std::fs::write(&victim, "{}\n").expect("victim");

        let outcome = trash(&f, &f.slug.join("../../elsewhere/precious.jsonl"));

        assert!(victim.is_file(), "`..` must not reach outside the root");
        assert_eq!(
            outcome.skipped.as_deref(),
            Some("outside the local session root")
        );
    }

    #[test]
    fn refuses_anything_that_is_not_a_transcript() {
        let f = fixture("not-jsonl");
        let victim = f.slug.join("desktop-chat.sqlite");
        std::fs::write(&victim, "not a transcript").expect("victim");

        let outcome = trash(&f, &victim);

        assert!(victim.is_file(), "only .jsonl transcripts are trashable");
        assert_eq!(outcome.skipped.as_deref(), Some("not a .jsonl transcript"));
    }

    #[test]
    fn an_empty_path_is_a_skip() {
        let f = fixture("empty");

        let outcome = trash_transcript(&f.root, &f.trash, "   ").expect("trash");

        assert_eq!(
            outcome.skipped.as_deref(),
            Some("no transcript path recorded")
        );
    }

    #[test]
    fn two_conversations_sharing_a_file_name_do_not_overwrite_each_other() {
        let f = fixture("collision");

        // Back to back, so both land in the same millisecond — the case a stamp
        // alone cannot separate, and the one where `rename` would silently replace
        // the first transcript inside the directory that exists to undo deletes.
        let first = trash(&f, &transcript(&f, "same.jsonl"))
            .file
            .expect("first move");
        let second = trash(&f, &transcript(&f, "same.jsonl"))
            .file
            .expect("second move");

        assert_ne!(first, second, "each delete needs its own trash entry");
        assert!(Path::new(&first).is_file(), "the first must survive");
        assert!(Path::new(&second).is_file(), "and so must the second");
    }

    #[test]
    fn a_transcript_and_its_runs_land_under_one_prefix() {
        let f = fixture("pairing");
        let path = transcript(&f, "paired.jsonl");
        std::fs::create_dir_all(f.slug.join("paired")).expect("runs dir");

        let outcome = trash(&f, &path);

        let file = outcome.file.expect("moved transcript");
        let directory = outcome.directory.expect("moved runs");
        let prefix = |value: &str| {
            Path::new(value)
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.split("__").next())
                .expect("prefixed name")
                .to_owned()
        };
        assert_eq!(
            prefix(&file),
            prefix(&directory),
            "a restore has to be able to tell which runs belonged to which transcript",
        );
    }

    #[test]
    fn restores_a_recycled_transcript_and_its_runs() {
        let f = fixture("restore");
        let path = transcript(&f, "restore-me.jsonl");
        let runs = f.slug.join("restore-me");
        std::fs::create_dir_all(&runs).expect("runs dir");
        std::fs::write(runs.join("run.jsonl"), "{}\n").expect("run file");
        let outcome = trash(&f, &path);

        let restored = restore_transcript(
            &f.root,
            &f.trash,
            path.to_str().unwrap(),
            outcome.file.as_deref(),
            outcome.directory.as_deref(),
        )
        .expect("restore");
        assert_eq!(
            restored,
            SessionRestoreOutcome {
                file_restored: true,
                directory_restored: true,
            }
        );

        assert!(path.is_file());
        assert!(runs.join("run.jsonl").is_file());
        assert!(!Path::new(outcome.file.as_deref().unwrap()).exists());
    }

    #[test]
    fn rolls_restored_files_back_to_the_same_trash_paths() {
        let f = fixture("restore-rollback");
        let path = transcript(&f, "retry-me.jsonl");
        let runs = f.slug.join("retry-me");
        std::fs::create_dir_all(&runs).expect("runs dir");
        std::fs::write(runs.join("run.jsonl"), "{}\n").expect("run file");
        let trashed = trash(&f, &path);
        let trash_file = trashed.file.clone().expect("trash file");
        let trash_directory = trashed.directory.clone().expect("trash directory");

        let restored = restore_transcript(
            &f.root,
            &f.trash,
            path.to_str().unwrap(),
            Some(&trash_file),
            Some(&trash_directory),
        )
        .expect("restore");
        rollback_restore_transcript(
            &f.root,
            &f.trash,
            path.to_str().unwrap(),
            Some(&trash_file),
            Some(&trash_directory),
            &restored,
        )
        .expect("rollback restore");

        assert!(
            !path.exists(),
            "the failed database restore must not leave a live file"
        );
        assert!(
            !runs.exists(),
            "the restored run directory must be compensated too"
        );
        assert!(Path::new(&trash_file).is_file());
        assert!(Path::new(&trash_directory).join("run.jsonl").is_file());
    }

    #[test]
    fn missing_recycled_files_do_not_trap_cached_history() {
        let f = fixture("restore-missing");
        let path = f.slug.join("missing.jsonl");

        let restored = restore_transcript(
            &f.root,
            &f.trash,
            path.to_str().unwrap(),
            Some(f.trash.join("missing.jsonl").to_str().unwrap()),
            None,
        )
        .expect("restore the cached row without a file");

        assert!(restored.is_empty());
        assert!(!path.exists());
    }

    #[test]
    fn permanently_purges_a_recycled_transcript_and_its_runs() {
        let f = fixture("purge");
        let path = transcript(&f, "purge-me.jsonl");
        let runs = f.slug.join("purge-me");
        std::fs::create_dir_all(&runs).expect("runs dir");
        let outcome = trash(&f, &path);
        let recycled_file = outcome.file.clone().expect("recycled file");
        let recycled_runs = outcome.directory.clone().expect("recycled runs");

        purge_transcript(
            &f.root,
            &f.trash,
            path.to_str().unwrap(),
            outcome.file.as_deref(),
            outcome.directory.as_deref(),
        )
        .expect("purge");

        assert!(!path.exists());
        assert!(!Path::new(&recycled_file).exists());
        assert!(!Path::new(&recycled_runs).exists());
    }

    #[test]
    fn permanent_purge_cleans_an_original_left_behind_by_a_failed_trash_move() {
        let f = fixture("purge-original");
        let path = transcript(&f, "left-behind.jsonl");
        let runs = f.slug.join("left-behind");
        std::fs::create_dir_all(&runs).expect("runs dir");

        purge_transcript(&f.root, &f.trash, path.to_str().unwrap(), None, None)
            .expect("purge original");

        assert!(!path.exists());
        assert!(!runs.exists());
    }

    #[test]
    fn a_real_transcript_is_resumable() {
        let f = fixture("resume-ok");
        let path = transcript(&f, "live.jsonl");
        assert!(is_resumable(path.to_str().unwrap()));
    }

    #[test]
    fn a_missing_or_empty_transcript_is_not_resumable() {
        let f = fixture("resume-refuse");

        let missing = f.slug.join("gone.jsonl");
        assert!(
            !is_resumable(missing.to_str().unwrap()),
            "--session would create a session here, not resume one",
        );

        // The dangling rows observed in the wild are exactly this: pi announced a
        // path, the conversation ended before its first turn, and nothing was
        // written. Resuming it would hand pi an empty file to fill in.
        let empty = f.slug.join("empty.jsonl");
        std::fs::write(&empty, "").expect("empty transcript");
        assert!(!is_resumable(empty.to_str().unwrap()));

        assert!(!is_resumable(""), "no pin at all is not a resume");
        assert!(!is_resumable("   "));
        assert!(
            !is_resumable(f.slug.to_str().unwrap()),
            "a directory is not a transcript",
        );
    }
}
