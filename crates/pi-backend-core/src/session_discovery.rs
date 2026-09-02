use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_SESSION_HEADER_SCAN_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSessionMetadata {
    pub authority_session_id: String,
    pub session_path: String,
    pub cwd: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
struct SessionHeader {
    #[serde(rename = "type")]
    entry_type: String,
    id: String,
    #[serde(default)]
    cwd: String,
}

fn millis(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn comparable_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn cwd_matches(header_cwd: &str, project_root: &Path) -> bool {
    if header_cwd.is_empty() {
        return false;
    }
    let header = comparable_path(Path::new(header_cwd));
    let project = comparable_path(project_root);
    if cfg!(windows) {
        header
            .to_string_lossy()
            .eq_ignore_ascii_case(&project.to_string_lossy())
    } else {
        header == project
    }
}

fn read_header(path: &Path) -> Option<SessionHeader> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file).take(MAX_SESSION_HEADER_SCAN_BYTES + 1);
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader.read_line(&mut line).ok()?;
        if bytes == 0 || reader.limit() == 0 {
            return None;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let header: SessionHeader = serde_json::from_str(trimmed).ok()?;
        return (header.entry_type == "session" && !header.id.trim().is_empty()).then_some(header);
    }
}

/// Discover Pi transcripts without loading transcript bodies into memory.
///
/// Custom session roots are shared by projects, so callers set `filter_cwd` for
/// those roots. The default encoded project directory is already project-scoped.
pub fn discover_sessions(
    session_root: &Path,
    project_root: &Path,
    filter_cwd: bool,
) -> Vec<NativeSessionMetadata> {
    let Ok(entries) = fs::read_dir(session_root) else {
        return Vec::new();
    };
    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(header) = read_header(&path) else {
            continue;
        };
        if filter_cwd && !cwd_matches(&header.cwd, project_root) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        sessions.push(NativeSessionMetadata {
            authority_session_id: header.id,
            session_path: path.to_string_lossy().into_owned(),
            cwd: header.cwd,
            name: String::new(),
            created_at: metadata
                .created()
                .map(millis)
                .unwrap_or_else(|_| metadata.modified().map(millis).unwrap_or_default()),
            updated_at: metadata.modified().map(millis).unwrap_or_default(),
        });
    }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pi-session-discovery-{name}-{}",
            millis(SystemTime::now())
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn discovers_headers_and_filters_shared_custom_roots() {
        let base = temp_dir("filter");
        let project = base.join("project");
        let other = base.join("other");
        let sessions = base.join("sessions");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::create_dir_all(&sessions).unwrap();

        for (name, id, cwd) in [("a", "native-a", &project), ("b", "native-b", &other)] {
            let mut file = File::create(sessions.join(format!("{name}.jsonl"))).unwrap();
            writeln!(
                file,
                "{}",
                serde_json::json!({ "type": "session", "version": 3, "id": id, "cwd": cwd })
            )
            .unwrap();
            writeln!(file, "{{\"type\":\"message\",\"id\":\"large-body\"}}").unwrap();
        }

        let found = discover_sessions(&sessions, &project, true);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].authority_session_id, "native-a");
        assert_eq!(discover_sessions(&sessions, &project, false).len(), 2);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn ignores_missing_invalid_and_oversized_headers() {
        let base = temp_dir("invalid");
        let project = base.join("project");
        fs::create_dir_all(&project).unwrap();
        fs::write(base.join("invalid.jsonl"), "not-json\n").unwrap();
        fs::write(
            base.join("oversized.jsonl"),
            format!(
                "{}\n",
                " ".repeat(MAX_SESSION_HEADER_SCAN_BYTES as usize + 1)
            ),
        )
        .unwrap();
        assert!(discover_sessions(&base, &project, false).is_empty());
        let _ = fs::remove_dir_all(base);
    }
}
