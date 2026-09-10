use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_SESSION_HEADER_SCAN_BYTES: u64 = 1024 * 1024;
pub const MAX_SESSION_DISPLAY_HEAD_SCAN_BYTES: u64 = 256 * 1024;
pub const MAX_SESSION_DISPLAY_TAIL_SCAN_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSessionMetadata {
    pub authority_session_id: String,
    pub session_path: String,
    pub cwd: String,
    pub name: String,
    pub preview: String,
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

fn truncate_chars(value: &str, limit: usize) -> String {
    value.trim().chars().take(limit).collect()
}

fn message_text(message: &serde_json::Value) -> String {
    let Some(content) = message.get("content") else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.trim().to_owned();
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    blocks
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(|value| value.as_str()) != Some("text") {
                return None;
            }
            block.get("text").and_then(|value| value.as_str())
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

#[derive(Default)]
struct DisplayMetadata {
    first_user_name: String,
    native_name: Option<String>,
    preview: String,
}

fn collect_display_line(line: &str, metadata: &mut DisplayMetadata) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return;
    };
    if value.get("type").and_then(|value| value.as_str()) == Some("session_info") {
        metadata.native_name = value
            .get("name")
            .and_then(|value| value.as_str())
            .map(|value| truncate_chars(value, 40));
        return;
    }
    if value.get("type").and_then(|value| value.as_str()) != Some("message") {
        return;
    }
    let Some(message) = value.get("message") else {
        return;
    };
    let Some(role) = message.get("role").and_then(|value| value.as_str()) else {
        return;
    };
    if role != "user" && role != "assistant" {
        return;
    }
    let text = message_text(message);
    if text.is_empty() {
        return;
    }
    if metadata.first_user_name.is_empty() && role == "user" {
        metadata.first_user_name = truncate_chars(&text, 40);
    }
    metadata.preview = truncate_chars(&text, 80);
}

fn scan_display_lines<R: BufRead>(
    mut reader: R,
    skip_partial_first_line: bool,
    metadata: &mut DisplayMetadata,
) {
    let mut line = String::new();
    if skip_partial_first_line {
        let _ = reader.read_line(&mut line);
    }
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => collect_display_line(&line, metadata),
        }
    }
}

/// Read a bounded head/tail sample for the history sidebar. The head preserves the
/// first user prompt used as a fallback title; the tail preserves the recent preview
/// and the newest native title when it is close to the active end of the transcript.
/// At most `MAX_SESSION_DISPLAY_HEAD_SCAN_BYTES +
/// MAX_SESSION_DISPLAY_TAIL_SCAN_BYTES` are read, regardless of transcript size.
fn read_display_metadata(path: &Path) -> (String, String) {
    let Ok(mut file) = File::open(path) else {
        return (String::new(), String::new());
    };
    let Ok(file_len) = file.metadata().map(|metadata| metadata.len()) else {
        return (String::new(), String::new());
    };
    let mut metadata = DisplayMetadata::default();
    let total_budget = MAX_SESSION_DISPLAY_HEAD_SCAN_BYTES + MAX_SESSION_DISPLAY_TAIL_SCAN_BYTES;

    if file_len <= total_budget {
        scan_display_lines(BufReader::new(file.take(file_len)), false, &mut metadata);
    } else {
        let Ok(head) = file.try_clone() else {
            return (String::new(), String::new());
        };
        scan_display_lines(
            BufReader::new(head.take(MAX_SESSION_DISPLAY_HEAD_SCAN_BYTES)),
            false,
            &mut metadata,
        );

        let tail_start = file_len - MAX_SESSION_DISPLAY_TAIL_SCAN_BYTES;
        let mut previous = [0_u8; 1];
        let skip_partial_first_line = file
            .seek(SeekFrom::Start(tail_start - 1))
            .and_then(|_| file.read_exact(&mut previous))
            .map(|_| previous[0] != b'\n')
            .unwrap_or(true);
        if file.seek(SeekFrom::Start(tail_start)).is_ok() {
            scan_display_lines(
                BufReader::new(file.take(MAX_SESSION_DISPLAY_TAIL_SCAN_BYTES)),
                skip_partial_first_line,
                &mut metadata,
            );
        }
    }

    let name = metadata
        .native_name
        .filter(|value| !value.is_empty())
        .unwrap_or(metadata.first_user_name);
    (name, metadata.preview)
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
        let (name, preview) = read_display_metadata(&path);
        sessions.push(NativeSessionMetadata {
            authority_session_id: header.id,
            session_path: path.to_string_lossy().into_owned(),
            cwd: header.cwd,
            name,
            preview,
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
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "type": "message",
                    "id": "user-message",
                    "parentId": null,
                    "message": {
                        "role": "user",
                        "content": [{ "type": "text", "text": "hello from native history" }]
                    }
                })
            )
            .unwrap();
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "type": "message",
                    "id": "assistant-message",
                    "parentId": "user-message",
                    "message": {
                        "role": "assistant",
                        "content": [{ "type": "text", "text": "native reply preview" }]
                    }
                })
            )
            .unwrap();
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "type": "session_info",
                    "id": "session-info",
                    "parentId": "assistant-message",
                    "name": "Native custom title"
                })
            )
            .unwrap();
        }

        let found = discover_sessions(&sessions, &project, true);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].authority_session_id, "native-a");
        assert_eq!(found[0].name, "Native custom title");
        assert_eq!(found[0].preview, "native reply preview");
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

    #[test]
    fn display_metadata_uses_a_bounded_head_and_tail_sample() {
        let base = temp_dir("bounded-display");
        let path = base.join("large.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({ "type": "session", "version": 3, "id": "large", "cwd": base })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "message",
                "message": { "role": "user", "content": "fallback title from head" }
            })
        )
        .unwrap();
        let padding = "x".repeat(MAX_SESSION_DISPLAY_HEAD_SCAN_BYTES as usize + 32 * 1024);
        writeln!(
            file,
            "{}",
            serde_json::json!({ "type": "padding", "data": padding })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({ "type": "session_info", "name": "title hidden in skipped middle" })
        )
        .unwrap();
        let padding = "y".repeat(MAX_SESSION_DISPLAY_TAIL_SCAN_BYTES as usize + 32 * 1024);
        writeln!(
            file,
            "{}",
            serde_json::json!({ "type": "padding", "data": padding })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "message",
                "message": { "role": "assistant", "content": "latest preview from tail" }
            })
        )
        .unwrap();
        drop(file);

        let (name, preview) = read_display_metadata(&path);

        assert_eq!(name, "fallback title from head");
        assert_eq!(preview, "latest preview from tail");
        let _ = fs::remove_dir_all(base);
    }
}
