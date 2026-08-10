use crate::pi_process::ProcessSnapshot;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComponentStatus {
    Healthy,
    Degraded,
    Failed,
    Stopped,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendHealthSnapshot {
    pub captured_at_ms: u64,
    pub status: ComponentStatus,
    pub process: Option<ProcessSnapshot>,
    pub storage_status: ComponentStatus,
    pub shutdown_in_progress: bool,
    pub restart_count: u64,
    pub cleanup_failures: u64,
    pub last_error_code: Option<String>,
}

impl BackendHealthSnapshot {
    pub fn new(
        status: ComponentStatus,
        process: Option<ProcessSnapshot>,
        storage_status: ComponentStatus,
    ) -> Self {
        Self {
            captured_at_ms: now_ms(),
            status,
            process,
            storage_status,
            shutdown_in_progress: false,
            restart_count: 0,
            cleanup_failures: 0,
            last_error_code: None,
        }
    }

    pub fn with_error_code(mut self, code: impl Into<String>) -> Self {
        self.last_error_code = Some(sanitize_code(&code.into()));
        self
    }
}

fn sanitize_code(value: &str) -> String {
    let valid = !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_');
    if valid {
        value.to_owned()
    } else {
        "invalid_error_code".to_owned()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_snapshot_redacts_sensitive_values() {
        let snapshot =
            BackendHealthSnapshot::new(ComponentStatus::Degraded, None, ComponentStatus::Healthy)
                .with_error_code("token=secret C:\\Users\\alice\\private prompt text");
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(!json.contains("secret"));
        assert!(!json.contains("Users"));
        assert!(!json.contains("prompt"));
        assert_eq!(
            snapshot.last_error_code.as_deref(),
            Some("invalid_error_code")
        );
    }
}
