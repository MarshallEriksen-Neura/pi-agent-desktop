//! In-app browser pane: spawns a headless Chrome/Edge, controls it over CDP,
//! and exposes browser tools to the pi agent through a local MCP server.
//!
//! Architecture (mirrors Codex's browser-use integration):
//!   - A Chromium browser is spawned on a random debug port with a fresh
//!     user-data dir. All control flows over CDP WebSocket JSON-RPC.
//!   - `BrowserState` owns the running browser, the origin allowlist, and any
//!     pending origin-approval request.
//!   - The MCP bridge is armed once at app startup (`arm_mcp_bridge`) on a fixed
//!     port, not on pane open, and outlives the Chrome engine. Chrome itself
//!     starts lazily on the first tool call or pane open (`ensure_engine`).
//!   - Navigating to a host outside the allowlist parks the navigation and
//!     emits `browser://approval`; the UI confirms, then `browser_approve_origin`
//!     completes the navigation (Codex's `access_browser_origin` pattern).

mod cdp;
mod chrome;
mod mcp;

use cdp::{CdpEvent, CdpSession};
use mcp::RunningMcp;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::process::Child;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

const ALLOWLIST_FILE: &str = "browser-allowlist.json";
/// An unanswered origin-approval prompt auto-expires after this long so a
/// forgotten dialog can't block the next navigation forever.
const APPROVAL_TTL: Duration = Duration::from_secs(120);
/// How long `browser_start` waits for the browser to expose its CDP endpoint.
const START_TIMEOUT: Duration = Duration::from_secs(20);

/// Browser engine state registered as a Tauri managed state.
pub struct BrowserState {
    inner: Mutex<Option<RunningBrowser>>,
    allowlist: Mutex<HashSet<String>>,
    pending: Mutex<Option<PendingApproval>>,
    mcp: Mutex<Option<RunningMcp>>,
}

impl Default for BrowserState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
            allowlist: Mutex::new(load_allowlist()),
            pending: Mutex::new(None),
            mcp: Mutex::new(None),
        }
    }
}

struct RunningBrowser {
    child: Child,
    port: u16,
    session: CdpSession,
    url: String,
    title: String,
    loading: bool,
    /// When the current navigation's `loading` flag may be force-cleared.
    loading_deadline: Option<std::time::Instant>,
    user_data_dir: PathBuf,
}

struct PendingApproval {
    id: u64,
    origin: String,
    url: String,
    created_at: SystemTime,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub running: bool,
    pub url: Option<String>,
    pub title: Option<String>,
    pub loading: bool,
    pub port: Option<u16>,
    pub browser: Option<String>,
    pub pending_approval: Option<ApprovalInfo>,
    pub mcp_endpoint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalInfo {
    pub id: u64,
    pub origin: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigateResult {
    pub needs_approval: bool,
    pub approval: Option<ApprovalInfo>,
    pub ok: bool,
    pub error: Option<String>,
}

fn browser_home() -> Result<PathBuf, String> {
    crate::pi_settings::home_dir().map(|home| home.join(".pi").join("browser"))
}

fn allowlist_path() -> Result<PathBuf, String> {
    Ok(browser_home()?.join(ALLOWLIST_FILE))
}

fn load_allowlist() -> HashSet<String> {
    let Ok(path) = allowlist_path() else { return HashSet::new() };
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
        .unwrap_or_default()
        .into_iter()
        .collect()
}

fn save_allowlist(list: &HashSet<String>) {
    let Ok(path) = allowlist_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let mut sorted: Vec<&String> = list.iter().collect();
    sorted.sort();
    let _ = fs::write(path, serde_json::to_string_pretty(&sorted).unwrap_or_default());
}

fn origin_of(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    let host = rest.split(['/', '?', '#']).next()?;
    let host = host.split('@').last().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    Some(host.to_lowercase())
}

/// Delete leftover `profile-*` dirs older than a day. These are only ever
/// written by a browser session; anything still there was abandoned by a
/// crash/kill, so removing it reclaims disk without losing user data (cookies
/// and login state are intentionally not persisted across sessions).
fn gc_stale_profiles() {
    let Ok(home) = browser_home() else { return };
    let Ok(entries) = fs::read_dir(&home) else { return };
    let cutoff = SystemTime::now() - Duration::from_secs(24 * 60 * 60);
    for entry in entries.flatten() {
        let path = entry.path();
        let is_profile = path
            .file_name()
            .map(|name| name.to_string_lossy().starts_with("profile-"))
            .unwrap_or(false);
        if !is_profile {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .map(|modified| modified < cutoff)
            .unwrap_or(false);
        if stale {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

/// Connect CDP to the page Chrome opened. The browser is spawned with
/// `--remote-debugging-port=<port>`; we discover the page via /json/list.
async fn discover_page(port: u16) -> Result<CdpSession, String> {
    let list_url = format!("http://127.0.0.1:{port}/json/list");
    for _ in 0..50 {
        if let Ok(response) = reqwest::get(&list_url).await {
            if let Ok(pages) = response.json::<Vec<serde_json::Value>>().await {
                if let Some(page) = pages
                    .iter()
                    .find(|page| page.get("type").and_then(|v| v.as_str()) == Some("page"))
                {
                    if let Some(ws) = page.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
                        let session = CdpSession::connect(ws).await?;
                        let _ = session.call("Page.enable", serde_json::json!({})).await;
                        let _ = session
                            .call("Runtime.enable", serde_json::json!({}))
                            .await;
                        return Ok(session);
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err("browser page did not become available over CDP".to_owned())
}

/// Spawn the browser and return the running handle. On any failure the child
/// process and its fresh profile dir are cleaned up so nothing leaks.
async fn start_browser_engine() -> Result<RunningBrowser, String> {
    let executable = chrome::find_browser().ok_or_else(|| {
        "no Chrome or Edge installation found — install Chrome/Edge to use the browser pane".to_owned()
    })?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let user_data_dir = browser_home()?.join(format!("profile-{stamp}"));

    // Garbage-collect stale profiles from previous crashes before creating a
    // fresh one, so the profile dir doesn't grow unbounded on disk.
    gc_stale_profiles();

    fs::create_dir_all(&user_data_dir).map_err(|e| e.to_string())?;

    let (child, port) = match chrome::spawn_browser(&executable, &user_data_dir) {
        Ok(ok) => ok,
        Err(error) => {
            let _ = fs::remove_dir_all(&user_data_dir);
            return Err(error);
        }
    };

    let session = match tokio::time::timeout(START_TIMEOUT, discover_page(port)).await {
        Ok(Ok(session)) => session,
        Ok(Err(error)) => {
            let mut child = child;
            chrome::kill_tree(&mut child);
            let _ = fs::remove_dir_all(&user_data_dir);
            return Err(error);
        }
        Err(_) => {
            let mut child = child;
            chrome::kill_tree(&mut child);
            let _ = fs::remove_dir_all(&user_data_dir);
            return Err("timed out waiting for the browser's CDP endpoint".to_owned());
        }
    };

    Ok(RunningBrowser {
        child,
        port,
        session,
        url: String::new(),
        title: String::new(),
        loading: false,
        loading_deadline: None,
        user_data_dir,
    })
}

/// Take a screenshot of the current page (JPEG, base64) — the pane renders it
/// as its live view, which works even when sites block framing. JPEG + a
/// modest quality keeps the 450ms frame stream light on bandwidth.
async fn screenshot(session: &CdpSession) -> Result<String, String> {
    let result = session
        .call(
            "Page.captureScreenshot",
            serde_json::json!({ "format": "jpeg", "quality": 70 }),
        )
        .await?;
    result
        .get("data")
        .and_then(|v| v.as_str())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "browser returned no screenshot data".to_owned())
}

/// Navigate the current page.
async fn navigate_locked(session: &CdpSession, url: &str) -> Result<String, String> {
    session
        .call("Page.navigate", serde_json::json!({ "url": url }))
        .await?;
    Ok(url.to_owned())
}

/// How long a page may stay in the `loading` state before we give up waiting
/// for `loadEventFired` (slow/hung network) and let the user retry.
const NAV_LOAD_TIMEOUT: Duration = Duration::from_secs(45);

/// Set `loading` and stamp the deadline; the event-forwarder loop clears it
/// after the timeout so a hung page can't pin the spinner forever.
fn mark_loading(state: &BrowserState, url: String) {
    if let Ok(mut guard) = state.inner.try_lock() {
        if let Some(browser) = guard.as_mut() {
            browser.url = url;
            browser.loading = true;
            browser.loading_deadline = Some(std::time::Instant::now() + NAV_LOAD_TIMEOUT);
        }
    }
}

async fn browser_status_snapshot(state: &BrowserState) -> BrowserStatus {
    let guard = state.inner.lock().await;
    let pending = state
        .pending
        .lock()
        .await
        .as_ref()
        .map(|p| ApprovalInfo {
            id: p.id,
            origin: p.origin.clone(),
            url: p.url.clone(),
        });
    let mcp_endpoint = state.mcp.lock().await.as_ref().map(|m| m.endpoint());
    match guard.as_ref() {
        Some(browser) => BrowserStatus {
            running: true,
            url: Some(browser.url.clone()),
            title: Some(browser.title.clone()),
            loading: browser.loading,
            port: Some(browser.port),
            browser: Some("chromium".to_owned()),
            pending_approval: pending,
            mcp_endpoint,
        },
        None => BrowserStatus {
            running: false,
            url: None,
            title: None,
            loading: false,
            port: None,
            browser: None,
            pending_approval: pending,
            mcp_endpoint,
        },
    }
}

#[tauri::command]
pub async fn browser_start(
    app: AppHandle,
    state: State<'_, BrowserState>,
) -> Result<BrowserStatus, String> {
    ensure_engine(&app).await?;
    Ok(browser_status_snapshot(&state).await)
}

/// Start the Chrome engine if it isn't already running (idempotent).
///
/// Shared by the `browser_start` command and the MCP tool dispatcher, so an
/// agent tool call works even when the user never opened the browser pane.
pub(crate) async fn ensure_engine(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    {
        let guard = state.inner.lock().await;
        if guard.is_some() {
            return Ok(());
        }
    }
    let browser = start_browser_engine().await?;
    let mut guard = state.inner.lock().await;
    // Lost a concurrent race — keep the engine that landed first and discard ours
    // so we never leak a Chrome tree or its profile dir.
    if guard.is_some() {
        drop(guard);
        let mut browser = browser;
        chrome::kill_tree(&mut browser.child);
        let _ = fs::remove_dir_all(&browser.user_data_dir);
        return Ok(());
    }
    *guard = Some(browser);
    Ok(())
}

/// Arm the browser MCP bridge: start the local server and register its endpoint
/// in pi's global `mcp.json`.
///
/// Called once from the app `setup` hook — deliberately *before* any pi process
/// is spawned, because pi reads `mcp.json` only at startup and cannot reload it.
/// Registering on pane open (as this used to) meant pi booted with a stale port
/// from the previous run and every `browser_*` call failed for the whole session.
pub fn arm_mcp_bridge(app: &AppHandle) {
    let state = app.state::<BrowserState>();
    let running = match mcp::start_mcp_server(app.clone()) {
        Ok(running) => running,
        Err(error) => {
            eprintln!("[browser-mcp] failed to start MCP server: {error}");
            return;
        }
    };
    let endpoint = running.endpoint();

    // Write the config synchronously: the frontend calls `pi_start` as soon as
    // the webview loads, so this must land before pi reads the file.
    if let Err(error) = register_mcp_in_pi_config(&endpoint) {
        eprintln!("[browser-mcp] failed to register endpoint in mcp.json: {error}");
    }

    tauri::async_runtime::block_on(async {
        *state.mcp.lock().await = Some(running);
    });
    let _ = app.emit("browser://mcp", endpoint);
}

/// Write the `browser` server entry into the global pi MCP config (~/.pi/agent/mcp.json).
fn register_mcp_in_pi_config(endpoint: &str) -> Result<(), String> {
    let scope = "global";
    let read = crate::mcp_config::mcp_config_read(scope.to_owned(), None)?;
    let mut config: serde_json::Value = if read.exists && !read.content.trim().is_empty() {
        serde_json::from_str(&read.content).map_err(|e| format!("invalid mcp.json: {e}"))?
    } else {
        serde_json::json!({ "mcpServers": {} })
    };
    let servers = config
        .get_mut("mcpServers")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| "mcp.json has no mcpServers object".to_owned())?;
    servers.insert(
        "browser".to_owned(),
        serde_json::json!({
            "type": "http",
            "url": endpoint,
            "enabled": true
        }),
    );
    crate::mcp_config::mcp_config_write(
        scope.to_owned(),
        serde_json::to_string_pretty(&config).unwrap_or_default(),
        None,
    )
}

#[tauri::command]
pub async fn browser_stop(state: State<'_, BrowserState>) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if let Some(mut browser) = guard.take() {
        chrome::kill_tree(&mut browser.child);
        let _ = fs::remove_dir_all(&browser.user_data_dir);
    }
    *state.pending.lock().await = None;
    // The MCP server deliberately outlives the engine: its endpoint is what pi
    // holds for the whole session, and tearing it down here would make every
    // later `browser_*` tool call fail with a dead port. A tool call restarts
    // the engine on demand via `ensure_engine`.
    Ok(())
}

#[tauri::command]
pub async fn browser_status(state: State<'_, BrowserState>) -> Result<BrowserStatus, String> {
    Ok(browser_status_snapshot(&state).await)
}

#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    state: State<'_, BrowserState>,
    url: String,
) -> Result<NavigateResult, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("only http(s) URLs are allowed in the browser pane".to_owned());
    }
    let Some(origin) = origin_of(&url) else {
        return Err(format!("cannot parse origin from {url}"));
    };

    // Origin allowlist gate (Codex `access_browser_origin` pattern).
    {
        // A new navigation always supersedes a stale (possibly expired) prompt.
        let now = SystemTime::now();
        let mut pending_guard = state.pending.lock().await;
        if let Some(pending) = pending_guard.as_ref() {
            let expired = now
                .duration_since(pending.created_at)
                .map(|age| age > APPROVAL_TTL)
                .unwrap_or(true);
            if expired {
                *pending_guard = None;
            }
        }
        drop(pending_guard);

        let allowlist = state.allowlist.lock().await;
        if !allowlist.contains(&origin) {
            let id = now
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let approval = PendingApproval {
                id,
                origin: origin.clone(),
                url: url.clone(),
                created_at: now,
            };
            *state.pending.lock().await = Some(approval);
            let info = ApprovalInfo {
                id,
                origin: origin.clone(),
                url: url.clone(),
            };
            let _ = app.emit("browser://approval", info.clone());
            return Ok(NavigateResult {
                needs_approval: true,
                approval: Some(info),
                ok: false,
                error: None,
            });
        }
    }

    let mut guard = state.inner.lock().await;
    let Some(browser) = guard.as_mut() else {
        return Err("browser pane is not running — start it first".to_owned());
    };
    let committed = navigate_locked(&browser.session, &url).await?;
    drop(guard);
    mark_loading(&state, committed.clone());
    let _ = app.emit("browser://state", browser_status_snapshot(&state).await);
    Ok(NavigateResult {
        needs_approval: false,
        approval: None,
        ok: true,
        error: None,
    })
}

#[tauri::command]
pub async fn browser_approve_origin(
    app: AppHandle,
    state: State<'_, BrowserState>,
    id: u64,
    allow: bool,
) -> Result<NavigateResult, String> {
    let pending = {
        let mut pending_guard = state.pending.lock().await;
        let Some(pending) = pending_guard.take() else {
            return Err("no pending origin approval".to_owned());
        };
        if pending.id != id {
            return Err("stale origin approval id".to_owned());
        }
        // Expired prompt — refuse instead of silently navigating.
        let expired = SystemTime::now()
            .duration_since(pending.created_at)
            .map(|age| age > APPROVAL_TTL)
            .unwrap_or(true);
        if expired {
            return Ok(NavigateResult {
                needs_approval: false,
                approval: None,
                ok: false,
                error: Some("origin approval expired — navigate again".to_owned()),
            });
        }
        pending
    };
    if !allow {
        return Ok(NavigateResult {
            needs_approval: false,
            approval: None,
            ok: false,
            error: Some("origin approval denied by user".to_owned()),
        });
    }
    let allowlist_snapshot = {
        let mut allowlist = state.allowlist.lock().await;
        allowlist.insert(pending.origin.clone());
        allowlist.clone()
    };
    save_allowlist(&allowlist_snapshot);

    let mut guard = state.inner.lock().await;
    let Some(browser) = guard.as_mut() else {
        return Err("browser pane is not running — start it first".to_owned());
    };
    let committed = navigate_locked(&browser.session, &pending.url).await?;
    drop(guard);
    mark_loading(&state, committed.clone());
    let _ = app.emit("browser://state", browser_status_snapshot(&state).await);
    Ok(NavigateResult {
        needs_approval: false,
        approval: None,
        ok: true,
        error: None,
    })
}

#[tauri::command]
pub async fn browser_screenshot(state: State<'_, BrowserState>) -> Result<String, String> {
    let guard = state.inner.lock().await;
    let Some(browser) = guard.as_ref() else {
        return Err("browser pane is not running".to_owned());
    };
    screenshot(&browser.session).await
}

#[tauri::command]
pub async fn browser_click(state: State<'_, BrowserState>, x: f64, y: f64) -> Result<(), String> {
    let guard = state.inner.lock().await;
    let Some(browser) = guard.as_ref() else {
        return Err("browser pane is not running".to_owned());
    };
    browser
        .session
        .call(
            "Input.dispatchMouseEvent",
            serde_json::json!({
                "type": "mousePressed",
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": 1
            }),
        )
        .await?;
    browser
        .session
        .call(
            "Input.dispatchMouseEvent",
            serde_json::json!({
                "type": "mouseReleased",
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": 1
            }),
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn browser_type(state: State<'_, BrowserState>, text: String) -> Result<(), String> {
    let guard = state.inner.lock().await;
    let Some(browser) = guard.as_ref() else {
        return Err("browser pane is not running".to_owned());
    };
    browser
        .session
        .call("Input.insertText", serde_json::json!({ "text": text }))
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn browser_press_key(state: State<'_, BrowserState>, key: String) -> Result<(), String> {
    let guard = state.inner.lock().await;
    let Some(browser) = guard.as_ref() else {
        return Err("browser pane is not running".to_owned());
    };
    for (event_type, key_name) in [("keyDown", key.as_str()), ("keyUp", key.as_str())] {
        browser
            .session
            .call(
                "Input.dispatchKeyEvent",
                serde_json::json!({
                    "type": event_type,
                    "key": key_name,
                    "code": key_name,
                }),
            )
            .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_back(state: State<'_, BrowserState>) -> Result<(), String> {
    let guard = state.inner.lock().await;
    let Some(browser) = guard.as_ref() else {
        return Err("browser pane is not running".to_owned());
    };
    browser
        .session
        .call("Page.goBack", serde_json::json!({}))
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn browser_forward(state: State<'_, BrowserState>) -> Result<(), String> {
    let guard = state.inner.lock().await;
    let Some(browser) = guard.as_ref() else {
        return Err("browser pane is not running".to_owned());
    };
    browser
        .session
        .call("Page.goForward", serde_json::json!({}))
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn browser_reload(state: State<'_, BrowserState>) -> Result<(), String> {
    let guard = state.inner.lock().await;
    let Some(browser) = guard.as_ref() else {
        return Err("browser pane is not running".to_owned());
    };
    browser.session.call("Page.reload", serde_json::json!({})).await?;
    Ok(())
}

#[tauri::command]
pub async fn browser_eval(
    state: State<'_, BrowserState>,
    expression: String,
) -> Result<serde_json::Value, String> {
    let guard = state.inner.lock().await;
    let Some(browser) = guard.as_ref() else {
        return Err("browser pane is not running".to_owned());
    };
    let result = browser
        .session
        .call(
            "Runtime.evaluate",
            serde_json::json!({
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true
            }),
        )
        .await?;
    if let Some(exception) = result.get("exceptionDetails") {
        return Err(format!("browser eval failed: {exception}"));
    }
    Ok(result
        .get("result")
        .and_then(|v| v.get("value"))
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
pub async fn browser_allowlist(state: State<'_, BrowserState>) -> Result<Vec<String>, String> {
    let allowlist = state.allowlist.lock().await;
    let mut list: Vec<String> = allowlist.iter().cloned().collect();
    list.sort();
    Ok(list)
}

#[tauri::command]
pub async fn browser_remove_origin(
    state: State<'_, BrowserState>,
    origin: String,
) -> Result<(), String> {
    let mut allowlist = state.allowlist.lock().await;
    allowlist.remove(&origin);
    save_allowlist(&allowlist);
    Ok(())
}

/// Background task: pump CDP events into the frontend, keep status fresh,
/// detect browser-process death, and self-heal (respawn) after unexpected
/// crashes. This is the robustness spine for network wobble / renderer hangs.
pub fn start_event_forwarder(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<BrowserState>();
        loop {
            let snapshot = {
                let mut guard = state.inner.lock().await;
                match guard.as_mut() {
                    Some(browser) => {
                        let exited = browser.child.try_wait().ok().flatten();
                        let connected = browser.session.is_connected();
                        Some((browser.session.clone(), browser.port, connected, exited))
                    }
                    None => None,
                }
            };
            let Some((session, port, connected, exited)) = snapshot else {
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            };

            // The browser process exited (crash / killed externally).
            if exited.is_some() {
                eprintln!("[browser] Chrome/Edge process exited — clearing state");
                let mut guard = state.inner.lock().await;
                if let Some(mut browser) = guard.take() {
                    let _ = browser.child.wait();
                    let _ = fs::remove_dir_all(&browser.user_data_dir);
                }
                *state.pending.lock().await = None;
                // Keep the MCP server up — see `browser_stop`. A crashed Chrome is
                // recovered on the next tool call, not by dropping the endpoint.
                drop(guard);
                let _ = app.emit("browser://state", browser_status_snapshot(&state).await);
                continue;
            }

            // Connection dropped but process alive (network blip). Attempt to
            // re-establish the CDP session before surfacing an error.
            if !connected {
                eprintln!("[browser] CDP connection lost — reconnecting on port {port}");
                match discover_page(port).await {
                    Ok(new_session) => {
                        let mut guard = state.inner.lock().await;
                        if let Some(browser) = guard.as_mut() {
                            browser.session = new_session;
                        }
                        drop(guard);
                        let _ = app.emit("browser://state", browser_status_snapshot(&state).await);
                    }
                    Err(error) => {
                        eprintln!("[browser] CDP reconnect failed: {error}");
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
                continue;
            }

            // Deadline watchdog: force-clear a stuck `loading` flag so the UI
            // spinner can't hang forever on a stalled network.
            {
                let mut guard = state.inner.lock().await;
                if let Some(browser) = guard.as_mut() {
                    if browser.loading {
                        if let Some(deadline) = browser.loading_deadline {
                            if std::time::Instant::now() >= deadline {
                                browser.loading = false;
                                browser.loading_deadline = None;
                            }
                        }
                    }
                }
            }

            // Wait for the next event, but re-enter the loop regularly so the
            // process/liveness checks above still run on quiet periods.
            let event = tokio::time::timeout(Duration::from_millis(500), session.next_event())
                .await
                .ok()
                .flatten();

            match event {
                Some(CdpEvent::Navigated { url }) | Some(CdpEvent::Loading { url }) => {
                    let mut guard = state.inner.lock().await;
                    if let Some(browser) = guard.as_mut() {
                        browser.url = url.clone();
                        browser.loading = true;
                    }
                    drop(guard);
                    let _ = app.emit("browser://state", browser_status_snapshot(&state).await);
                }
                Some(CdpEvent::Loaded { url }) => {
                    let title = {
                        let guard = state.inner.lock().await;
                        match guard.as_ref() {
                            Some(browser) => browser
                                .session
                                .call(
                                    "Runtime.evaluate",
                                    serde_json::json!({
                                        "expression": "document.title",
                                        "returnByValue": true
                                    }),
                                )
                                .await
                                .ok()
                                .and_then(|result| {
                                    result
                                        .get("result")
                                        .and_then(|v| v.get("value"))
                                        .and_then(serde_json::Value::as_str)
                                        .map(ToOwned::to_owned)
                                })
                                .unwrap_or_default(),
                            None => String::new(),
                        }
                    };
                    let mut guard = state.inner.lock().await;
                    if let Some(browser) = guard.as_mut() {
                        browser.url = url;
                        browser.loading = false;
                        if !title.is_empty() {
                            browser.title = title;
                        }
                    }
                    drop(guard);
                    let _ = app.emit("browser://state", browser_status_snapshot(&state).await);
                }
                Some(CdpEvent::Console { text }) => {
                    let _ = app.emit("browser://console", text);
                }
                None => {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
        }
    });
}

/// Live-engine smoke test: spawn Chrome, navigate, screenshot, eval.
/// Run with `cargo run --bin browser-smoke --features browser-smoke`.
#[cfg(feature = "browser-smoke")]
pub fn run_smoke() {
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    runtime.block_on(async {
        let executable = match chrome::find_browser() {
            Some(path) => path,
            None => {
                eprintln!("no Chrome/Edge found — skipping live browser smoke");
                return;
            }
        };
        eprintln!("using browser: {}", executable.display());
        let user_data_dir = std::env::temp_dir().join(format!(
            "pi-browser-smoke-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&user_data_dir);
        fs::create_dir_all(&user_data_dir).expect("create profile dir");
        let (mut child, port) =
            chrome::spawn_browser(&executable, &user_data_dir).expect("spawn browser");
        eprintln!("CDP port: {port}");
        let session = discover_page(port).await.expect("discover page");
        let _ = session
            .call("Page.enable", serde_json::json!({}))
            .await
            .expect("enable page");
        let _ = session
            .call(
                "Page.navigate",
                serde_json::json!({
                    "url": "data:text/html,<title>ok</title><h1>pi browser smoke</h1>"
                }),
            )
            .await
            .expect("navigate");
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let shot = screenshot(&session).await.expect("screenshot");
        eprintln!("screenshot bytes (b64): {}", shot.len());
        assert!(shot.len() > 100, "screenshot too small");
        let title = session
            .call(
                "Runtime.evaluate",
                serde_json::json!({ "expression": "document.title", "returnByValue": true }),
            )
            .await
            .expect("eval title");
        let title = title
            .get("result")
            .and_then(|v| v.get("value"))
            .and_then(serde_json::Value::as_str);
        eprintln!("document.title = {title:?}");
        assert_eq!(title, Some("ok"));
        chrome::kill_tree(&mut child);
        let _ = fs::remove_dir_all(&user_data_dir);
        eprintln!("browser smoke OK");
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::sleep;

    #[tokio::test]
    async fn engine_spawns_navigates_and_screenshots() {
        let executable = match chrome::find_browser() {
            Some(path) => path,
            None => {
                eprintln!("no Chrome/Edge found — skipping live browser test");
                return;
            }
        };
        let user_data_dir = std::env::temp_dir().join(format!("pi-browser-test-{}", std::process::id()));
        fs::create_dir_all(&user_data_dir).unwrap();
        let (mut child, port) = chrome::spawn_browser(&executable, &user_data_dir).unwrap();
        let session = discover_page(port).await.expect("page discovered");
        session.call("Page.enable", serde_json::json!({})).await.unwrap();
        let result = session
            .call("Page.navigate", serde_json::json!({ "url": "data:text/html,<title>ok</title><h1>hello</h1>" }))
            .await
            .expect("navigate");
        assert!(result.is_object());
        // Let the page settle, then capture.
        sleep(Duration::from_millis(1200)).await;
        let shot = screenshot(&session).await.expect("screenshot");
        assert!(shot.len() > 100, "screenshot payload too small");
        // Title via eval.
        let title = session
            .call(
                "Runtime.evaluate",
                serde_json::json!({ "expression": "document.title", "returnByValue": true }),
            )
            .await
            .unwrap();
        let value = title.get("result").and_then(|v| v.get("value")).and_then(serde_json::Value::as_str);
        assert_eq!(value, Some("ok"));
        chrome::kill_tree(&mut child);
        let _ = fs::remove_dir_all(&user_data_dir);
    }
}
