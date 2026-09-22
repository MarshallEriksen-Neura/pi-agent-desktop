//! TypeSafe "System One" proxy for the desktop UI.
//!
//! The frontend asks Jev for typed judgments (a Noul probability per candidate
//! when reranking plugin-search results) and Rust only authenticates and
//! forwards — the API key never reaches the webview. One endpoint, one command.
//!
//! The key is read from the `TYPESAFE_API_KEY` environment variable. A
//! GUI-launched process does not inherit a shell `export`, so for a packaged
//! build the key must live in the user environment (setx on Windows) and the
//! app restarted; the frontend treats a missing key as "rerank disabled" and
//! falls back to substring order. If GUI env proves unreliable, move the key
//! into the app settings (a settings field, never the shipped bundle).

use serde_json::Value;
use std::time::Duration;

const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";

/// Evaluate one System One request: `state` + `questions` in, the raw API JSON
/// out. The frontend assembles `questions` (Noul/Choice); Rust authenticates.
/// A missing key surfaces as the sentinel `typesafe:not-configured` so the
/// frontend can disable rerank for the session instead of retrying every keystroke.
#[tauri::command]
pub async fn typesafe_eval(state: Value, questions: Value) -> Result<Value, String> {
    let key =
        std::env::var("TYPESAFE_API_KEY").map_err(|_| "typesafe:not-configured".to_string())?;

    let body = serde_json::json!({
        "state": state,
        "model": "jev-latest",
        "questions": questions,
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))?;

    let resp = client
        .post(ENDPOINT)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("typesafe request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(400).collect();
        return Err(format!("typesafe returned HTTP {status}: {snippet}"));
    }

    resp.json::<Value>()
        .await
        .map_err(|e| format!("typesafe invalid JSON: {e}"))
}
