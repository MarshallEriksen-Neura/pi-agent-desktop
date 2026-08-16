use crate::protocol::{
    validate_relative_path, RemoteFileBody, RemoteProjectSummary, RemoteTreeEntry,
    RemoteTreeEntryKind, RemoteTreePage, ValidationError, MAX_RELATIVE_PATH_BYTES,
};
use crate::task_manager::TaskManager;
use pi_backend_core::projects::{
    canonical_project_root, resolve_existing_relative_path, ProjectPathError,
};
use ring::rand::{SecureRandom, SystemRandom};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const MAX_TREE_ENTRIES_PER_PAGE: usize = 200;
pub const MAX_PROJECTS: usize = 64;
pub const MAX_CURSOR_BYTES: usize = 128;
pub const MAX_CURSORS: usize = 2_048;
/// Upper bound for a single file-body preview. Oversized files are truncated
/// to this size instead of rejected; the response carries `truncated: true`.
pub const MAX_FILE_BODY_BYTES: usize = 256 * 1024;
const CURSOR_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_PROJECT_NAME_BYTES: usize = 256;

const BUILTIN_DENY_NAMES: &[&str] = &[
    ".git",
    ".next",
    ".ragcode",
    "node_modules",
    "target",
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    "credentials",
    "credential",
    "secrets",
    "secret",
    "id_rsa",
    "id_ed25519",
    "desktop.json",
];

#[derive(Debug, Clone)]
pub struct ProjectCatalogConfig {
    pub max_tree_entries_per_page: usize,
    pub max_projects: usize,
    pub max_cursors: usize,
    pub deny_names: Vec<String>,
}

impl Default for ProjectCatalogConfig {
    fn default() -> Self {
        Self {
            max_tree_entries_per_page: MAX_TREE_ENTRIES_PER_PAGE,
            max_projects: MAX_PROJECTS,
            max_cursors: MAX_CURSORS,
            deny_names: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectCatalogError {
    InvalidProjectId,
    ProjectNotFound,
    InvalidRelativePath,
    PathPolicy,
    NotDirectory,
    NotRegularFile,
    FileNotText,
    DeniedEntry,
    ReparsePoint,
    InvalidCursor,
    CursorStoreFull,
    ProjectLimit,
    ProjectIdCollision,
    IdentityUnavailable,
    NameInvalid,
    Io,
}

impl fmt::Display for ProjectCatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Deliberately do not include a filesystem path or OS diagnostic in
        // this error. The gateway maps these categories to stable redacted
        // HTTP errors later.
        let message = match self {
            Self::InvalidProjectId | Self::ProjectNotFound | Self::InvalidCursor => {
                "project is not available"
            }
            Self::InvalidRelativePath | Self::PathPolicy => "project path is not allowed",
            Self::NotDirectory => "project directory is not available",
            Self::NotRegularFile => "project file is not available",
            Self::FileNotText => "project file is not previewable as text",
            Self::DeniedEntry => "project entry is not allowed",
            Self::ReparsePoint => "project entry is not allowed",
            Self::CursorStoreFull | Self::ProjectLimit => "project catalog is at capacity",
            Self::ProjectIdCollision | Self::IdentityUnavailable => {
                "project identity is unavailable"
            }
            Self::NameInvalid => "project name is invalid",
            Self::Io => "project catalog I/O failed",
        };
        f.write_str(message)
    }
}

impl std::error::Error for ProjectCatalogError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevokedProject {
    pub summary: RemoteProjectSummary,
    pub revoked_tasks: Vec<crate::protocol::RemoteTaskSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedProject {
    pub project_id: String,
    pub root: PathBuf,
    pub name: String,
    pub last_opened_at: Option<String>,
}

#[derive(Debug, Clone)]
struct ProjectRecord {
    summary: RemoteProjectSummary,
    canonical_root: PathBuf,
}

#[derive(Debug, Clone)]
struct CursorState {
    project_id: String,
    directory: String,
    offset: usize,
    directory_signature: u64,
    created_at: Instant,
}

pub struct ProjectCatalog {
    config: ProjectCatalogConfig,
    rng: SystemRandom,
    projects: Mutex<HashMap<String, ProjectRecord>>,
    cursors: Mutex<HashMap<String, CursorState>>,
}

impl ProjectCatalog {
    pub fn new(config: ProjectCatalogConfig) -> Self {
        let config = sanitize_config(config);
        Self {
            config,
            rng: SystemRandom::new(),
            projects: Mutex::new(HashMap::new()),
            cursors: Mutex::new(HashMap::new()),
        }
    }

    pub fn allow_project(
        &self,
        root: impl AsRef<Path>,
        name: impl Into<String>,
        last_opened_at: Option<String>,
    ) -> Result<RemoteProjectSummary, ProjectCatalogError> {
        let canonical_root = canonical_project_root(root.as_ref()).map_err(map_path_error)?;
        let name = name.into();
        validate_project_name(&name)?;
        let mut projects = self.lock_projects();
        let existing_project_id = projects
            .iter()
            .find(|(_, existing)| existing.canonical_root == canonical_root)
            .map(|(project_id, _)| project_id.clone());
        if let Some(project_id) = existing_project_id {
            let summary = RemoteProjectSummary {
                project_id: project_id.clone(),
                name,
                last_opened_at,
            };
            let record = projects
                .get_mut(&project_id)
                .expect("project found while holding the map lock");
            record.summary = summary.clone();
            return Ok(summary);
        }
        if projects.len() >= self.config.max_projects {
            return Err(ProjectCatalogError::ProjectLimit);
        }
        let project_id = (0..8)
            .find_map(|_| {
                let candidate = random_project_id(&self.rng).ok()?;
                (!projects.contains_key(&candidate)).then_some(candidate)
            })
            .ok_or(ProjectCatalogError::ProjectIdCollision)?;
        let summary = RemoteProjectSummary {
            project_id: project_id.clone(),
            name,
            last_opened_at,
        };
        projects.insert(
            project_id,
            ProjectRecord {
                summary: summary.clone(),
                canonical_root,
            },
        );
        Ok(summary)
    }

    pub fn allow_project_with_derived_name(
        &self,
        root: impl AsRef<Path>,
    ) -> Result<RemoteProjectSummary, ProjectCatalogError> {
        let name = root
            .as_ref()
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("project")
            .to_owned();
        self.allow_project(root, name, None)
    }

    pub fn list_projects(&self) -> Vec<RemoteProjectSummary> {
        let mut projects = self
            .lock_projects()
            .values()
            .map(|record| record.summary.clone())
            .collect::<Vec<_>>();
        projects.sort_by(|left, right| {
            left.name
                .cmp(&right.name)
                .then_with(|| left.project_id.cmp(&right.project_id))
        });
        projects
    }

    pub fn persisted_projects(&self) -> Vec<PersistedProject> {
        self.lock_projects()
            .values()
            .map(|record| PersistedProject {
                project_id: record.summary.project_id.clone(),
                root: record.canonical_root.clone(),
                name: record.summary.name.clone(),
                last_opened_at: record.summary.last_opened_at.clone(),
            })
            .collect()
    }

    /// Atomically replaces the remotely visible catalog with one desktop-selected
    /// project. The previous records are returned so a composition-layer
    /// persistence failure can restore the exact opaque ids without exposing two
    /// projects at the same time.
    pub fn replace_with_single_project(
        &self,
        root: impl AsRef<Path>,
        name: impl Into<String>,
        last_opened_at: Option<String>,
    ) -> Result<(RemoteProjectSummary, Vec<PersistedProject>), ProjectCatalogError> {
        let canonical_root = canonical_project_root(root.as_ref()).map_err(map_path_error)?;
        let name = name.into();
        validate_project_name(&name)?;
        let mut projects = self.lock_projects();
        let previous = persisted_projects_from_records(&projects);
        let project_id = projects
            .iter()
            .find(|(_, existing)| existing.canonical_root == canonical_root)
            .map(|(project_id, _)| project_id.clone())
            .or_else(|| {
                (0..8).find_map(|_| {
                    let candidate = random_project_id(&self.rng).ok()?;
                    (!projects.contains_key(&candidate)).then_some(candidate)
                })
            })
            .ok_or(ProjectCatalogError::ProjectIdCollision)?;
        let summary = RemoteProjectSummary {
            project_id: project_id.clone(),
            name,
            last_opened_at,
        };
        projects.clear();
        projects.insert(
            project_id.clone(),
            ProjectRecord {
                summary: summary.clone(),
                canonical_root,
            },
        );
        drop(projects);
        self.lock_cursors()
            .retain(|_, cursor| cursor.project_id == project_id);
        Ok((summary, previous))
    }

    /// Restores a complete trusted snapshot in one map replacement. This is
    /// used only to roll back a failed desktop-current-project persistence step.
    pub fn replace_with_persisted_projects(
        &self,
        persisted: Vec<PersistedProject>,
    ) -> Result<(), ProjectCatalogError> {
        if persisted.len() > self.config.max_projects {
            return Err(ProjectCatalogError::ProjectLimit);
        }
        let mut replacement = HashMap::with_capacity(persisted.len());
        for project in persisted {
            if project.project_id.is_empty()
                || project.project_id.len() > 128
                || !project.project_id.starts_with("project-")
                || project.project_id.chars().any(char::is_control)
            {
                return Err(ProjectCatalogError::InvalidProjectId);
            }
            validate_project_name(&project.name)?;
            let canonical_root = canonical_project_root(&project.root).map_err(map_path_error)?;
            if replacement.contains_key(&project.project_id)
                || replacement
                    .values()
                    .any(|existing: &ProjectRecord| existing.canonical_root == canonical_root)
            {
                return Err(ProjectCatalogError::ProjectIdCollision);
            }
            let summary = RemoteProjectSummary {
                project_id: project.project_id.clone(),
                name: project.name,
                last_opened_at: project.last_opened_at,
            };
            replacement.insert(
                project.project_id,
                ProjectRecord {
                    summary,
                    canonical_root,
                },
            );
        }
        *self.lock_projects() = replacement;
        self.lock_cursors().clear();
        Ok(())
    }

    pub fn restore_project(
        &self,
        persisted: PersistedProject,
    ) -> Result<RemoteProjectSummary, ProjectCatalogError> {
        if persisted.project_id.is_empty()
            || persisted.project_id.len() > 128
            || !persisted.project_id.starts_with("project-")
            || persisted.project_id.chars().any(char::is_control)
        {
            return Err(ProjectCatalogError::InvalidProjectId);
        }
        validate_project_name(&persisted.name)?;
        let canonical_root = canonical_project_root(&persisted.root).map_err(map_path_error)?;
        let mut projects = self.lock_projects();
        if let Some(existing) = projects.get(&persisted.project_id) {
            if existing.canonical_root != canonical_root {
                return Err(ProjectCatalogError::ProjectIdCollision);
            }
        }
        if let Some((existing_id, _)) = projects
            .iter()
            .find(|(_, existing)| existing.canonical_root == canonical_root)
        {
            if existing_id != &persisted.project_id {
                return Err(ProjectCatalogError::ProjectIdCollision);
            }
        }
        if projects.len() >= self.config.max_projects
            && !projects.contains_key(&persisted.project_id)
        {
            return Err(ProjectCatalogError::ProjectLimit);
        }
        let summary = RemoteProjectSummary {
            project_id: persisted.project_id.clone(),
            name: persisted.name,
            last_opened_at: persisted.last_opened_at,
        };
        projects.insert(
            persisted.project_id,
            ProjectRecord {
                summary: summary.clone(),
                canonical_root,
            },
        );
        Ok(summary)
    }

    pub fn project_summary(
        &self,
        project_id: &str,
    ) -> Result<RemoteProjectSummary, ProjectCatalogError> {
        self.lock_projects()
            .get(project_id)
            .map(|record| record.summary.clone())
            .ok_or(ProjectCatalogError::ProjectNotFound)
    }

    /// Resolves the canonical root for the trusted local runtime.  This is
    /// deliberately crate-visible and returns no HTTP DTO; mobile clients
    /// only ever receive the opaque project id and display metadata.
    pub(crate) fn runtime_project_root(
        &self,
        project_id: &str,
    ) -> Result<PathBuf, ProjectCatalogError> {
        Ok(self.project_record(project_id)?.canonical_root)
    }

    /// Revalidates the project and returns its canonical root immediately
    /// before process launch.  Allowlist removal therefore fails closed even
    /// when a task was queued before the removal.
    pub(crate) fn revalidate_runtime_context(
        &self,
        project_id: &str,
        context_files: &[crate::protocol::RemoteTaskContextFile],
    ) -> Result<PathBuf, ProjectCatalogError> {
        let root = self.runtime_project_root(project_id)?;
        for file in context_files {
            self.resolve_context_file(project_id, &file.relative_path)?;
        }
        Ok(root)
    }

    pub fn remove_project(
        &self,
        project_id: &str,
    ) -> Result<RemoteProjectSummary, ProjectCatalogError> {
        let record = self
            .lock_projects()
            .remove(project_id)
            .ok_or(ProjectCatalogError::ProjectNotFound)?;
        self.lock_cursors()
            .retain(|_, cursor| cursor.project_id != project_id);
        Ok(record.summary)
    }

    pub fn remove_project_and_revoke(
        &self,
        project_id: &str,
        task_manager: &TaskManager,
    ) -> Result<RevokedProject, ProjectCatalogError> {
        let summary = self.remove_project(project_id)?;
        let revoked_tasks = task_manager.revoke_project(project_id);
        Ok(RevokedProject {
            summary,
            revoked_tasks,
        })
    }

    pub fn tree(
        &self,
        project_id: &str,
        directory: &str,
        cursor: Option<&str>,
    ) -> Result<RemoteTreePage, ProjectCatalogError> {
        let record = self.project_record(project_id)?;
        let (directory, offset, cursor_signature) =
            self.resolve_cursor(project_id, directory, cursor)?;
        let target = self.resolve_directory(&record.canonical_root, &directory)?;
        let signature = directory_signature(&target)?;
        if cursor_signature.map_or(false, |expected| expected != signature) {
            return Err(ProjectCatalogError::InvalidCursor);
        }
        let mut entries = Vec::with_capacity(self.config.max_tree_entries_per_page);
        let mut visible_index = 0usize;
        let mut has_more = false;
        let read_dir = fs::read_dir(&target).map_err(|_| ProjectCatalogError::Io)?;
        for item in read_dir {
            let item = item.map_err(|_| ProjectCatalogError::Io)?;
            let name = match item.file_name().to_str() {
                Some(name) => name.to_owned(),
                None => continue,
            };
            if self.is_denied_name(&name) {
                continue;
            }
            let path = item.path();
            let metadata = fs::symlink_metadata(&path).map_err(|_| ProjectCatalogError::Io)?;
            if is_symlink_or_reparse(&metadata) {
                // Tree browsing is metadata-only; silently omit links and
                // reparse points so no link target can become a browse surface.
                continue;
            }
            let kind = if metadata.is_dir() {
                RemoteTreeEntryKind::Directory
            } else if metadata.is_file() {
                RemoteTreeEntryKind::File
            } else {
                continue;
            };
            let relative_path = if directory.is_empty() {
                name.clone()
            } else {
                format!("{directory}/{name}")
            };
            if validate_relative_path(&relative_path).is_err() {
                continue;
            }
            if visible_index < offset {
                visible_index += 1;
                continue;
            }
            if entries.len() >= self.config.max_tree_entries_per_page {
                has_more = true;
                break;
            }
            visible_index += 1;
            entries.push(RemoteTreeEntry {
                name,
                relative_path,
                kind,
                size_bytes: if metadata.is_file() {
                    Some(metadata.len())
                } else {
                    None
                },
                modified_at: None,
            });
        }
        let next_cursor = if has_more {
            Some(self.store_cursor(CursorState {
                project_id: project_id.to_owned(),
                directory: directory.clone(),
                offset: offset + entries.len(),
                directory_signature: signature,
                created_at: Instant::now(),
            })?)
        } else {
            None
        };
        Ok(RemoteTreePage {
            project_id: project_id.to_owned(),
            directory,
            entries,
            next_cursor,
        })
    }

    pub fn resolve_context_file(
        &self,
        project_id: &str,
        relative_path: &str,
    ) -> Result<RemoteTreeEntry, ProjectCatalogError> {
        self.resolve_regular_file(project_id, relative_path)
            .map(|(entry, _)| entry)
    }

    /// Read-only text preview of one file, reusing the full context-file
    /// policy (path validation, deny list, symlink rejection, project-root
    /// containment) before any byte is read.
    pub fn read_file_body(
        &self,
        project_id: &str,
        relative_path: &str,
    ) -> Result<RemoteFileBody, ProjectCatalogError> {
        let (entry, target) = self.resolve_regular_file(project_id, relative_path)?;
        let file = fs::File::open(&target).map_err(|_| ProjectCatalogError::Io)?;
        let mut bytes = Vec::new();
        file.take(MAX_FILE_BODY_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ProjectCatalogError::Io)?;
        let truncated = bytes.len() > MAX_FILE_BODY_BYTES;
        if truncated {
            bytes.truncate(MAX_FILE_BODY_BYTES);
        }
        let content = match std::str::from_utf8(&bytes) {
            Ok(text) => text.to_owned(),
            Err(error) => {
                // error_len() == None means the byte string ends inside a
                // multi-byte sequence. That is expected when the cap cut
                // mid-character; fall back to the longest valid prefix. In a
                // non-truncated read it means genuinely broken UTF-8.
                if truncated && error.error_len().is_none() {
                    let valid_up_to = error.valid_up_to();
                    String::from_utf8(bytes[..valid_up_to].to_vec())
                        .map_err(|_| ProjectCatalogError::FileNotText)?
                } else {
                    return Err(ProjectCatalogError::FileNotText);
                }
            }
        };
        // NUL is valid UTF-8 yet a strong binary signal — same heuristic git
        // uses to keep binaries out of text diffs.
        if content.contains('\0') {
            return Err(ProjectCatalogError::FileNotText);
        }
        Ok(RemoteFileBody {
            relative_path: entry.relative_path,
            content,
            size_bytes: entry.size_bytes.unwrap_or(0),
            truncated,
        })
    }

    /// Shared resolution for every file-level operation: returns both the
    /// metadata entry (for API responses) and the sanitized on-disk target.
    fn resolve_regular_file(
        &self,
        project_id: &str,
        relative_path: &str,
    ) -> Result<(RemoteTreeEntry, PathBuf), ProjectCatalogError> {
        validate_relative_path(relative_path).map_err(map_validation_error)?;
        let record = self.project_record(project_id)?;
        if self.is_denied_path(relative_path) {
            return Err(ProjectCatalogError::DeniedEntry);
        }
        let target = resolve_existing_relative_path(
            &record.canonical_root,
            Path::new(relative_path),
            MAX_RELATIVE_PATH_BYTES,
        )
        .map_err(map_path_error)?;
        let metadata = fs::symlink_metadata(&target).map_err(|_| ProjectCatalogError::Io)?;
        if is_symlink_or_reparse(&metadata) {
            return Err(ProjectCatalogError::ReparsePoint);
        }
        if !metadata.is_file() {
            return Err(ProjectCatalogError::NotRegularFile);
        }
        let entry = RemoteTreeEntry {
            name: Path::new(relative_path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("file")
                .to_owned(),
            relative_path: relative_path.to_owned(),
            kind: RemoteTreeEntryKind::File,
            size_bytes: Some(metadata.len()),
            modified_at: None,
        };
        Ok((entry, target))
    }

    fn project_record(&self, project_id: &str) -> Result<ProjectRecord, ProjectCatalogError> {
        if project_id.is_empty() || project_id.len() > 128 || !project_id.starts_with("project-") {
            return Err(ProjectCatalogError::InvalidProjectId);
        }
        self.lock_projects()
            .get(project_id)
            .cloned()
            .ok_or(ProjectCatalogError::ProjectNotFound)
    }

    fn resolve_directory(
        &self,
        canonical_root: &Path,
        directory: &str,
    ) -> Result<PathBuf, ProjectCatalogError> {
        if directory.is_empty() {
            return Ok(canonical_root.to_owned());
        }
        validate_relative_path(directory).map_err(map_validation_error)?;
        let target = resolve_existing_relative_path(
            canonical_root,
            Path::new(directory),
            MAX_RELATIVE_PATH_BYTES,
        )
        .map_err(map_path_error)?;
        let metadata = fs::symlink_metadata(&target).map_err(|_| ProjectCatalogError::Io)?;
        if is_symlink_or_reparse(&metadata) {
            return Err(ProjectCatalogError::ReparsePoint);
        }
        if !metadata.is_dir() {
            return Err(ProjectCatalogError::NotDirectory);
        }
        if self.is_denied_path(directory) {
            return Err(ProjectCatalogError::DeniedEntry);
        }
        Ok(target)
    }

    fn resolve_cursor(
        &self,
        project_id: &str,
        directory: &str,
        cursor: Option<&str>,
    ) -> Result<(String, usize, Option<u64>), ProjectCatalogError> {
        match cursor {
            None => Ok((directory.to_owned(), 0, None)),
            Some(cursor) => {
                if cursor.is_empty() || cursor.len() > MAX_CURSOR_BYTES {
                    return Err(ProjectCatalogError::InvalidCursor);
                }
                let state = self
                    .lock_cursors()
                    .get(cursor)
                    .cloned()
                    .ok_or(ProjectCatalogError::InvalidCursor)?;
                if state.created_at.elapsed() > CURSOR_TTL {
                    return Err(ProjectCatalogError::InvalidCursor);
                }
                if state.project_id != project_id || state.directory != directory {
                    return Err(ProjectCatalogError::InvalidCursor);
                }
                Ok((
                    state.directory,
                    state.offset,
                    Some(state.directory_signature),
                ))
            }
        }
    }

    fn store_cursor(&self, state: CursorState) -> Result<String, ProjectCatalogError> {
        let token = opaque_cursor(&state);
        let mut cursors = self.lock_cursors();
        if !cursors.contains_key(&token) && cursors.len() >= self.config.max_cursors {
            return Err(ProjectCatalogError::CursorStoreFull);
        }
        cursors.insert(token.clone(), state);
        Ok(token)
    }

    fn is_denied_name(&self, name: &str) -> bool {
        let lower = name.to_ascii_lowercase();
        BUILTIN_DENY_NAMES.iter().any(|denied| lower == *denied)
            || self
                .config
                .deny_names
                .iter()
                .any(|denied| lower == denied.to_ascii_lowercase())
            || lower.ends_with(".pem")
            || lower.ends_with(".key")
            || lower.ends_with(".p12")
            || lower.ends_with(".pfx")
            || lower.starts_with(".env")
    }

    fn is_denied_path(&self, relative_path: &str) -> bool {
        Path::new(relative_path)
            .components()
            .filter_map(|component| component.as_os_str().to_str())
            .any(|name| self.is_denied_name(name))
    }

    fn lock_projects(&self) -> std::sync::MutexGuard<'_, HashMap<String, ProjectRecord>> {
        self.projects
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_cursors(&self) -> std::sync::MutexGuard<'_, HashMap<String, CursorState>> {
        self.cursors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn persisted_projects_from_records(
    projects: &HashMap<String, ProjectRecord>,
) -> Vec<PersistedProject> {
    projects
        .values()
        .map(|record| PersistedProject {
            project_id: record.summary.project_id.clone(),
            root: record.canonical_root.clone(),
            name: record.summary.name.clone(),
            last_opened_at: record.summary.last_opened_at.clone(),
        })
        .collect()
}

fn sanitize_config(mut config: ProjectCatalogConfig) -> ProjectCatalogConfig {
    if config.max_tree_entries_per_page == 0
        || config.max_tree_entries_per_page > MAX_TREE_ENTRIES_PER_PAGE
    {
        config.max_tree_entries_per_page = MAX_TREE_ENTRIES_PER_PAGE;
    }
    if config.max_projects == 0 || config.max_projects > MAX_PROJECTS {
        config.max_projects = MAX_PROJECTS;
    }
    if config.max_cursors == 0 || config.max_cursors > MAX_CURSORS {
        config.max_cursors = MAX_CURSORS;
    }
    config.deny_names.truncate(64);
    config
}

fn validate_project_name(name: &str) -> Result<(), ProjectCatalogError> {
    if name.is_empty()
        || name.len() > MAX_PROJECT_NAME_BYTES
        || name.chars().any(char::is_control)
        || name.contains('/')
        || name.contains('\\')
        || name.contains(':')
    {
        return Err(ProjectCatalogError::NameInvalid);
    }
    Ok(())
}

fn random_project_id(rng: &SystemRandom) -> Result<String, ProjectCatalogError> {
    let mut bytes = [0_u8; 16];
    rng.fill(&mut bytes)
        .map_err(|_| ProjectCatalogError::IdentityUnavailable)?;
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("project-{hex}"))
}

fn opaque_cursor(state: &CursorState) -> String {
    let material = format!(
        "{}\0{}\0{}",
        state.project_id, state.directory, state.offset
    );
    let digest = ring::digest::digest(&ring::digest::SHA256, material.as_bytes());
    let hex = digest
        .as_ref()
        .iter()
        .take(24)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("cursor-{hex}")
}

fn directory_signature(path: &Path) -> Result<u64, ProjectCatalogError> {
    let metadata = fs::metadata(path).map_err(|_| ProjectCatalogError::Io)?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .unwrap_or_default();
    let mut hasher = DefaultHasher::new();
    metadata.len().hash(&mut hasher);
    modified.as_secs().hash(&mut hasher);
    modified.subsec_nanos().hash(&mut hasher);
    Ok(hasher.finish())
}

fn map_validation_error(error: ValidationError) -> ProjectCatalogError {
    match error {
        ValidationError::TooLong { .. } => ProjectCatalogError::PathPolicy,
        ValidationError::Empty { .. }
        | ValidationError::TooMany { .. }
        | ValidationError::InvalidValue { .. } => ProjectCatalogError::InvalidRelativePath,
    }
}

fn map_path_error(error: ProjectPathError) -> ProjectCatalogError {
    match error {
        ProjectPathError::InvalidRelativePath => ProjectCatalogError::InvalidRelativePath,
        ProjectPathError::PathTooLong { .. } => ProjectCatalogError::PathPolicy,
        ProjectPathError::EscapedRoot => ProjectCatalogError::PathPolicy,
        ProjectPathError::RootUnavailable(_) | ProjectPathError::TargetUnavailable(_) => {
            ProjectCatalogError::ProjectNotFound
        }
    }
}

#[cfg(windows)]
fn is_symlink_or_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_symlink_or_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}
