//! Fetch the list of available models from a custom provider's HTTP API so the
//! desktop UI can offer a "fetch model list" button instead of making the user
//! type every model id by hand.
//!
//! Two auth schemes are handled (matching pi's models.json `api` values):
//!   - OpenAI-compatible (`openai-completions` / `openai-responses` / `compat`):
//!     `GET {baseUrl}/models` with `Authorization: Bearer <apiKey>`.
//!   - Google Generative AI (`google-generative-ai`):
//!     `GET {baseUrl}/models?key=<apiKey>` — ids come back as `models/<name>`,
//!     the `models/` prefix is stripped.
//!
//! Anthropic has no public key-authenticated list endpoint, so it intentionally
//! falls through to the OpenAI-compatible path and will surface a clear error.

#[tauri::command]
pub async fn pi_fetch_models(
    base_url: String,
    api: String,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    let base = base_url.trim();
    if base.is_empty() {
        return Err("baseUrl is required".into());
    }

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))?;

    let (url, bearer): (String, Option<String>) = match api.as_str() {
        "google-generative-ai" => {
            let trimmed = base.trim_end_matches('/');
            let key = api_key.unwrap_or_default();
            (format!("{trimmed}/models?key={key}"), None)
        }
        // openai-completions / openai-responses / compat / anything else
        _ => {
            let trimmed = base.trim_end_matches('/');
            (format!("{trimmed}/models"), api_key)
        }
    };

    let mut req = client.get(&url);
    if let Some(k) = bearer {
        if !k.is_empty() {
            req = req.bearer_auth(k);
        }
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(400).collect();
        return Err(format!("provider returned HTTP {status}: {snippet}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("invalid JSON response: {e}"))?;

    // Skip entries with empty ids/names — pi's models.json schema requires a
    // non-empty `id`/`name`, and a single blank entry makes pi reject the whole
    // file (leaving the desktop with no model list at all).
    let ids: Vec<String> = if let Some(arr) = json.get("data").and_then(|v| v.as_array()) {
        arr.iter()
            .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect()
    } else if let Some(arr) = json.get("models").and_then(|v| v.as_array()) {
        arr.iter()
            .filter_map(|m| m.get("name").and_then(|i| i.as_str()))
            .map(|s| s.trim().trim_start_matches("models/"))
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect()
    } else {
        return Err("no model list in response (expected a `data` or `models` array)".into());
    };

    if ids.is_empty() {
        return Err("provider returned an empty model list".into());
    }

    Ok(ids)
}
