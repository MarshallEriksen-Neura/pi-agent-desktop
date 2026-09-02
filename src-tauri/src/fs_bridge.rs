//! Workspace filesystem commands for the editor & file tree.
//! Deliberately minimal: list a directory, read/write/create/delete files and
//! directories, report the root.

use pi_backend_core::file_index::{
    index_files, DEFAULT_LIMIT, DEFAULT_MAX_DEPTH, SKIP_DIRS,
};
use serde::Serialize;
use std::fs;
use std::path::Path;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024; // 2 MB guard for the editor
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024; // 20 MB guard for image preview

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// The workspace root: the last-opened project when one is on record (and its
/// directory still exists), otherwise the process cwd — which keeps the
/// "launch from a project directory" dev workflow working.
#[tauri::command]
pub fn workspace_root() -> Result<String, String> {
    if let Some(project) = crate::projects::last_project()? {
        return Ok(project);
    }
    std::env::current_dir()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .map_err(|e| e.to_string())
}

/// Whether a directory entry should be treated as a directory, following
/// symlinks. `DirEntry::file_type` reports the link itself, so a Windows
/// junction or a Unix symlink to a directory comes back as neither file nor
/// dir — which would hide, for instance, skills that `npx skills add` linked
/// into `~/.pi/agent/skills` in its default (symlink) mode.
fn entry_is_dir(entry: &fs::DirEntry) -> bool {
    match entry.file_type() {
        Ok(ft) if ft.is_symlink() => fs::metadata(entry.path())
            .map(|meta| meta.is_dir())
            .unwrap_or(false),
        Ok(ft) => ft.is_dir(),
        Err(_) => false,
    }
}

#[tauri::command]
pub fn fs_list_dir(path: String) -> Result<Vec<FsEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let mut entries: Vec<FsEntry> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            // only skip the noisy vendored/build dirs — dotfiles (.gitignore,
            // .env, .claude, etc.) are shown so the agent can read/edit them
            if SKIP_DIRS.contains(&name.as_str()) {
                return None;
            }
            let is_dir = entry_is_dir(&e);
            Some(FsEntry {
                path: e.path().to_string_lossy().replace('\\', "/"),
                name,
                is_dir,
            })
        })
        .collect();

    // dirs first, then case-insensitive alphabetical — Finder order
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// A flat, capped list of every path under `path`, for `@`-mention completion.
///
/// Separate from `fs_list_dir` rather than a recursive flag on it: the tree wants
/// entries for one directory (name, absolute path, kind) while completion wants
/// relative strings it can score, and the two differ in shape as well as depth.
/// Directories come back with a trailing `/` — see `FileIndex::paths`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsIndex {
    pub paths: Vec<String>,
    pub truncated: bool,
}

#[tauri::command]
pub fn fs_index_files(path: String) -> Result<FsIndex, String> {
    let index = index_files(Path::new(&path), DEFAULT_LIMIT, DEFAULT_MAX_DEPTH)
        .map_err(|e| format!("cannot index {path}: {e}"))?;
    Ok(FsIndex {
        paths: index.paths,
        truncated: index.truncated,
    })
}

#[tauri::command]
pub fn fs_read_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "file too large for the editor ({} KB)",
            meta.len() / 1024
        ));
    }
    fs::read_to_string(p).map_err(|e| format!("cannot read {path}: {e}"))
}

/// Read a binary file (image preview) as base64 — text-decoding it would fail.
#[tauri::command]
pub fn fs_read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "file too large for preview ({} KB)",
            meta.len() / 1024
        ));
    }
    let bytes = fs::read(p).map_err(|e| format!("cannot read {path}: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn fs_write_file(path: String, content: String) -> Result<(), String> {
    fs::write(Path::new(&path), content).map_err(|e| format!("cannot write {path}: {e}"))
}

/// Create a new empty file.  Parent directories must already exist.
/// Fails if the path already exists to avoid silent overwrites.
#[tauri::command]
pub fn fs_create_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("already exists: {path}"));
    }
    fs::File::create(p)
        .map(|_| ())
        .map_err(|e| format!("cannot create {path}: {e}"))
}

/// Create a directory (and any missing parents).
#[tauri::command]
pub fn fs_create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(Path::new(&path)).map_err(|e| format!("cannot create directory {path}: {e}"))
}

/// Delete a file or an entire directory tree.
/// This is irreversible — the caller (UI) is responsible for confirmation.
#[tauri::command]
pub fn fs_delete(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("not found: {path}"));
    }
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| format!("cannot delete directory {path}: {e}"))
    } else {
        fs::remove_file(p).map_err(|e| format!("cannot delete file {path}: {e}"))
    }
}

/// Rename or move a file/directory within the workspace.
#[tauri::command]
pub fn fs_rename(from: String, to: String) -> Result<(), String> {
    fs::rename(Path::new(&from), Path::new(&to))
        .map_err(|e| format!("cannot rename {from} → {to}: {e}"))
}
