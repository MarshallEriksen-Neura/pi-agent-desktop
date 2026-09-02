//! A flat, capped list of every path under a workspace root, for `@`-mention
//! completion in the composer.
//!
//! Separate from the per-directory listing the file tree uses: the tree asks
//! "what is in this one directory" and is driven by clicks, while completion has
//! to rank paths the user has never navigated to. One walk answering the whole
//! question is cheaper than the tree's lazy listing repeated a thousand times over
//! IPC, and it lets the matching itself happen with no round trip at all.
//!
//! **git first, walk second.** The file tree's `SKIP_DIRS` is enough for a tree —
//! it only ever pays for a directory somebody clicked open — and nowhere near
//! enough for a recursive walk. Measured on this repository: the plain walk returns
//! 192,669 paths, of which 185,564 are build output under one gitignored directory,
//! so a 20,000-path cap would be spent before `src/` was reached. `git ls-files`
//! answers the same question in 727 paths, because it applies the ignore rules the
//! project already wrote down, and it reads an index instead of a tree. The walk
//! stays as the fallback for a directory that is not a git repository.
//!
//! Paths are sorted shallowest-first, so hitting the cap drops the deepest paths
//! rather than everything after some letter of the alphabet.
//!
//! `root` is a parameter rather than resolved here so the rules can be tested
//! against a temporary directory.

use std::collections::{BTreeSet, HashSet, VecDeque};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Directories that never belong in a coding-agent file index.
///
/// The single source of truth for both this walk and the file tree's listing
/// (`fs_bridge::fs_list_dir`): a directory the tree hides but completion offers
/// would let the user mention a path they cannot see, and one the tree shows but
/// completion skips reads as the index being broken.
///
/// Dotfiles are not hidden wholesale — `.gitignore`, `.env` and `.claude` are all
/// things the agent is routinely asked to edit. Only these specific noise dirs go.
pub const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    ".next",
    "out",
    "dist",
    ".pnpm-store",
];

/// Paths past this depth are not indexed. A backstop for pathological trees
/// (a recursive junction that `visited` somehow fails to catch), not a real limit:
/// nothing a person mentions by name lives 32 directories down.
pub const DEFAULT_MAX_DEPTH: usize = 32;

/// How many paths one index holds. Roughly 1 MB of JSON at this size, paid once
/// per project rather than per keystroke.
pub const DEFAULT_LIMIT: usize = 20_000;

pub struct FileIndex {
    /// Paths relative to `root`, forward slashes on every platform.
    ///
    /// A directory is encoded with a trailing `/` — the `ls -F` convention, and
    /// exactly what a mention of a directory should insert. That keeps this a plain
    /// list of strings the matcher can score directly, instead of a struct that has
    /// to be unwrapped on both sides of the IPC boundary.
    pub paths: Vec<String>,
    /// True when the walk stopped at the cap. The UI says so rather than letting a
    /// missing file read as "no such path".
    pub truncated: bool,
}

/// Walk `root`, or read its git index, collecting up to `limit` relative paths.
pub fn index_files(root: &Path, limit: usize, max_depth: usize) -> io::Result<FileIndex> {
    if !root.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("not a directory: {}", root.display()),
        ));
    }
    match index_from_git(root, limit) {
        Some(index) => Ok(index),
        None => Ok(index_by_walk(root, limit, max_depth)),
    }
}

/// `git ls-files` for `root`, or None when it is not a git repository (or git is
/// not installed, which the walk then covers).
///
/// `--cached --others --exclude-standard` is "everything git would show you":
/// tracked files, plus files not yet added, minus everything `.gitignore`, the
/// global excludes and `.git/info/exclude` rule out. `-z` because a filename may
/// contain anything at all, including the newline this would otherwise split on —
/// and because it also turns off git's own path quoting.
///
/// Output is relative to `root` even when `root` is a subdirectory of the
/// repository, since `-C` makes it the working directory.
pub fn index_from_git(root: &Path, limit: usize) -> Option<FileIndex> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        // Without this every `@` would flash a console window over the app.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let files = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| String::from_utf8_lossy(entry).replace('\\', "/"))
        .collect::<Vec<String>>();
    // An empty repository is a real answer (no files), not a reason to fall back to
    // the walk — walking it would hand back the very build output git excluded.
    Some(compose(files, limit))
}

/// Directories implied by `files`, folded in, then sorted shallowest-first and cut
/// to `limit`.
///
/// git lists files only, and a mention of a directory is a useful thing to type, so
/// the parents are derived rather than asked for. Sorting by depth is what makes the
/// cut meaningful: git's own output is alphabetical, so truncating it would keep
/// everything under `apps/` and nothing under `src/`.
fn compose(files: Vec<String>, limit: usize) -> FileIndex {
    let mut dirs: BTreeSet<String> = BTreeSet::new();
    for file in &files {
        let mut cut = 0;
        while let Some(slash) = file[cut..].find('/') {
            cut += slash + 1;
            dirs.insert(file[..cut].to_string());
        }
    }
    let mut paths: Vec<String> = dirs.into_iter().chain(files).collect();
    paths.sort_by(|a, b| {
        depth_of(a).cmp(&depth_of(b)).then_with(|| a.cmp(b))
    });
    let truncated = paths.len() > limit;
    paths.truncate(limit);
    FileIndex { paths, truncated }
}

/// Segment count, with a directory's trailing slash not counting as one more.
fn depth_of(path: &str) -> usize {
    path.trim_end_matches('/').matches('/').count()
}

/// Breadth-first directory walk, for a root git cannot answer for.
///
/// Breadth-first because the walk is capped: depth-first spends that entire budget
/// inside whichever subtree it enters first, so the shallow paths — the ones a
/// person actually mentions by name — would be the ones missing.
///
/// Symlinked directories are followed, matching both the file tree (`entry_is_dir`)
/// and pi's own `@` completion (`fd --follow`) — skills that `npx skills add` linked
/// into place are real directories to everyone but `DirEntry::file_type`. Loops are
/// cut by canonicalizing *only* symlinked directories: a plain directory cannot
/// re-enter an ancestor, so the common case stays free of the extra syscall.
pub fn index_by_walk(root: &Path, limit: usize, max_depth: usize) -> FileIndex {
    let mut paths: Vec<String> = Vec::new();
    let mut truncated = false;
    let mut visited: HashSet<PathBuf> = HashSet::new();
    // (absolute dir, path relative to root, depth). The root's relative prefix is
    // empty, which is what makes every child's prefix a plain concatenation.
    // A deque, not a Vec: taking from the front is what makes this breadth-first,
    // and it is O(1) here where `Vec::remove(0)` would be O(n) per directory.
    let mut queue: VecDeque<(PathBuf, String, usize)> = VecDeque::new();
    queue.push_back((root.to_path_buf(), String::new(), 0));

    while let Some((dir, prefix, depth)) = queue.pop_front() {
        if paths.len() >= limit {
            truncated = true;
            break;
        }
        // A directory that cannot be read is skipped, not fatal: one unreadable
        // subtree (a permission-denied system folder inside the project) must not
        // cost the user the entire index.
        let Ok(children) = fs::read_dir(&dir) else {
            continue;
        };

        for entry in children.filter_map(|child| child.ok()) {
            if paths.len() >= limit {
                truncated = true;
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let is_symlink = file_type.is_symlink();
            let is_dir = if is_symlink {
                fs::metadata(entry.path())
                    .map(|meta| meta.is_dir())
                    .unwrap_or(false)
            } else {
                file_type.is_dir()
            };

            let relative = format!("{prefix}{name}");
            if !is_dir {
                paths.push(relative);
                continue;
            }

            paths.push(format!("{relative}/"));
            if depth + 1 >= max_depth {
                continue;
            }
            if is_symlink {
                // Canonicalizing is what makes the loop check meaningful: two
                // different link paths reaching one directory have to collide.
                let Ok(real) = fs::canonicalize(entry.path()) else {
                    continue;
                };
                if !visited.insert(real) {
                    continue;
                }
            }
            // Queued behind everything already known, so this directory's contents
            // are only opened once every shallower directory has been emitted.
            queue.push_back((entry.path(), format!("{relative}/"), depth + 1));
        }
    }

    FileIndex { paths, truncated }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write};

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pi-file-index-{name}"));
        let _ = fs::remove_dir_all(&dir);
        create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn lists_files_relative_to_root_with_forward_slashes() {
        let root = scratch("relative");
        create_dir_all(root.join("src/lib")).unwrap();
        write(root.join("src/lib/store.ts"), "x").unwrap();
        write(root.join("README.md"), "x").unwrap();

        let index = index_by_walk(&root, DEFAULT_LIMIT, DEFAULT_MAX_DEPTH);

        assert!(index.paths.contains(&"README.md".to_string()));
        assert!(index.paths.contains(&"src/lib/store.ts".to_string()));
        assert!(!index.truncated);
    }

    #[test]
    fn marks_directories_with_a_trailing_slash() {
        let root = scratch("dirs");
        create_dir_all(root.join("src")).unwrap();
        write(root.join("src/main.ts"), "x").unwrap();

        let index = index_by_walk(&root, DEFAULT_LIMIT, DEFAULT_MAX_DEPTH);

        assert!(index.paths.contains(&"src/".to_string()));
        assert!(index.paths.contains(&"src/main.ts".to_string()));
    }

    #[test]
    fn skips_the_noise_directories_the_file_tree_hides() {
        let root = scratch("skips");
        create_dir_all(root.join("node_modules/react")).unwrap();
        write(root.join("node_modules/react/index.js"), "x").unwrap();
        create_dir_all(root.join(".git")).unwrap();
        write(root.join(".git/HEAD"), "x").unwrap();
        // dotfiles themselves are indexed — only the listed dirs are noise
        write(root.join(".gitignore"), "x").unwrap();

        let index = index_by_walk(&root, DEFAULT_LIMIT, DEFAULT_MAX_DEPTH);

        assert!(index.paths.iter().all(|p| !p.starts_with("node_modules")));
        assert!(index.paths.iter().all(|p| !p.starts_with(".git/")));
        assert!(index.paths.contains(&".gitignore".to_string()));
    }

    #[test]
    fn shallow_paths_survive_the_cap() {
        // The whole point of walking breadth-first: a depth-first walk would spend
        // this budget inside deep/ and never reach the file at the top.
        let root = scratch("cap");
        let mut deep = root.join("deep");
        for level in 0..12 {
            create_dir_all(&deep).unwrap();
            write(deep.join(format!("f{level}.ts")), "x").unwrap();
            deep = deep.join(format!("level{level}"));
        }
        write(root.join("wanted.ts"), "x").unwrap();

        let index = index_by_walk(&root, 4, DEFAULT_MAX_DEPTH);

        assert!(index.truncated);
        assert!(index.paths.contains(&"wanted.ts".to_string()));
    }

    #[test]
    fn stops_at_the_depth_limit() {
        let root = scratch("depth");
        create_dir_all(root.join("a/b/c")).unwrap();
        write(root.join("a/b/c/deep.ts"), "x").unwrap();
        write(root.join("a/shallow.ts"), "x").unwrap();

        let index = index_by_walk(&root, DEFAULT_LIMIT, 2);

        assert!(index.paths.contains(&"a/shallow.ts".to_string()));
        assert!(index.paths.contains(&"a/b/".to_string()));
        assert!(!index.paths.contains(&"a/b/c/deep.ts".to_string()));
    }

    #[test]
    fn a_missing_root_is_an_error_not_an_empty_index() {
        // An empty list would read as "this project has no files", which is a very
        // different thing for the menu to say than "that root is gone".
        let root = scratch("missing").join("nope");
        assert!(index_files(&root, DEFAULT_LIMIT, DEFAULT_MAX_DEPTH).is_err());
    }

    #[test]
    fn derives_every_parent_directory_from_a_file_list() {
        // git lists files only, and "@src/lib/" is a useful thing to be able to type.
        let index = compose(vec!["src/lib/pi/chat.ts".to_string()], DEFAULT_LIMIT);

        assert_eq!(
            index.paths,
            vec![
                "src/".to_string(),
                "src/lib/".to_string(),
                "src/lib/pi/".to_string(),
                "src/lib/pi/chat.ts".to_string(),
            ]
        );
    }

    #[test]
    fn the_cap_drops_the_deepest_paths_not_the_alphabetical_tail() {
        // git's output is sorted by name, so a plain truncation would keep every path
        // under `apps/` and none under `src/` — sorting by depth first is what makes
        // a truncated index still useful.
        let index = compose(
            vec![
                "apps/a/b/c/d/deep.ts".to_string(),
                "src/top.ts".to_string(),
            ],
            4,
        );

        assert!(index.truncated);
        assert!(index.paths.contains(&"src/top.ts".to_string()));
        assert!(!index.paths.contains(&"apps/a/b/c/d/deep.ts".to_string()));
    }

    #[test]
    fn git_applies_the_projects_own_ignore_rules() {
        let root = scratch("git");
        write(root.join(".gitignore"), "ignored.ts\n").unwrap();
        write(root.join("ignored.ts"), "x").unwrap();
        write(root.join("tracked.ts"), "x").unwrap();
        let initialized = Command::new("git")
            .arg("-C")
            .arg(&root)
            .arg("init")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        // No git on this machine: the walk covers this root instead, and it has no
        // opinion about .gitignore, so there is nothing to assert.
        if !initialized {
            return;
        }
        let Some(index) = index_from_git(&root, DEFAULT_LIMIT) else {
            return;
        };

        assert!(index.paths.contains(&"tracked.ts".to_string()));
        assert!(!index.paths.contains(&"ignored.ts".to_string()));
    }

    #[test]
    fn a_root_outside_git_still_gets_an_index() {
        let root = scratch("nogit");
        write(root.join("plain.ts"), "x").unwrap();

        let index = index_files(&root, DEFAULT_LIMIT, DEFAULT_MAX_DEPTH).unwrap();

        assert!(index.paths.contains(&"plain.ts".to_string()));
    }
}
