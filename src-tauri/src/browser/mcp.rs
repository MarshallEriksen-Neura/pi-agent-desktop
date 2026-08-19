//! Local MCP server exposing the in-app browser as tools to the pi agent.
//!
//! Implements the MCP streamable-HTTP JSON-RPC surface (initialize,
//! tools/list, tools/call) on a loopback port. The pi agent connects with an
//! `http` transport entry in `mcp.json`; every tool call is dispatched to the
//! same browser commands the UI uses, so origin approvals flow through the
//! pane's dialog exactly as they do for interactive navigation.

use axum::{
    Json,
    extract::State as AxumState,
    routing::post,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

const PROTOCOL_VERSION: &str = "2025-06-18";

/// Upper bound on any single browser tool call seen by pi. Screenshots and
/// navigations are usually fast; this only fires on a wedged browser.
const TOOL_CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

struct McpRuntime {
    app: AppHandle,
}

pub struct RunningMcp {
    pub port: u16,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

impl RunningMcp {
    pub fn endpoint(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port)
    }
}

/// Start the local MCP server on a random loopback port.
pub fn start_mcp_server(app: AppHandle) -> Result<RunningMcp, String> {
    let runtime = Arc::new(Mutex::new(McpRuntime { app }));
    let router = axum::Router::new()
        .route("/mcp", post(handle_mcp))
        .with_state(runtime);

    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("mcp bind: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("mcp local addr: {e}"))?
        .port();
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("mcp nonblocking: {e}"))?;

    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let server = axum::serve(
            tokio::net::TcpListener::from_std(listener)
                .map_err(|e| eprintln!("[browser-mcp] listener: {e}"))
                .ok()
                .unwrap_or_else(|| panic!("browser mcp listener init")),
            router,
        )
        .with_graceful_shutdown(async move {
            let _ = stop_rx.await;
        });
        if let Err(error) = server.await {
            eprintln!("[browser-mcp] server error: {error}");
        }
    });
    std::mem::forget(server); // owned by the runtime; graceful shutdown via stop_tx

    Ok(RunningMcp {
        port,
        stop: Some(stop_tx),
    })
}

impl Drop for RunningMcp {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

async fn handle_mcp(
    AxumState(runtime): AxumState<Arc<Mutex<McpRuntime>>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    let Some(id) = body.get("id") else {
        // Notifications (e.g. notifications/initialized) get an empty 202.
        return Json(json!({}));
    };
    let method = body.get("method").and_then(Value::as_str).unwrap_or("");
    let params = body.get("params").cloned().unwrap_or(Value::Null);
    let response = match method {
        "initialize" => json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "pi-browser", "version": "1.0" }
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools() }),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            // Outer timeout so a stuck browser can never leave pi waiting on a
            // tool call forever, even if an inner CDP call wedges.
            match tokio::time::timeout(TOOL_CALL_TIMEOUT, call_tool(&runtime, name, &args)).await {
                Ok(result) => result,
                Err(_) => error_content(format!("browser tool {name} timed out after {TOOL_CALL_TIMEOUT:?}")),
            }
        }
        other => json!({
            "error": { "code": -32601, "message": format!("method not found: {other}") }
        }),
    };
    Json(json!({ "jsonrpc": "2.0", "id": id, "result": response }))
}

fn tool_schema(
    name: &str,
    description: &str,
    required: Vec<&str>,
    properties: serde_json::Map<String, Value>,
) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required
        }
    })
}

fn tools() -> Vec<Value> {
    let text = |description: &str| {
        json!({
            "type": "string",
            "description": description
        })
    };
    vec![
        tool_schema(
            "browser_status",
            "Report whether the in-app browser is running, plus its current URL and title.",
            vec![],
            serde_json::Map::new(),
        ),
        tool_schema(
            "browser_navigate",
            "Navigate the in-app browser to a URL. The first visit to a new origin requires user approval in the desktop pane.",
            vec!["url"],
            {
                let mut p = serde_json::Map::new();
                p.insert("url".into(), text("Absolute http(s) URL to open"));
                p
            },
        ),
        tool_schema(
            "browser_click",
            "Click at CSS-pixel coordinates in the current page view.",
            vec!["x", "y"],
            {
                let mut p = serde_json::Map::new();
                p.insert("x".into(), json!({ "type": "number", "description": "X coordinate in CSS pixels" }));
                p.insert("y".into(), json!({ "type": "number", "description": "Y coordinate in CSS pixels" }));
                p
            },
        ),
        tool_schema(
            "browser_type",
            "Type text into the focused element (like pasting into the current input).",
            vec!["text"],
            {
                let mut p = serde_json::Map::new();
                p.insert("text".into(), text("Text to type"));
                p
            },
        ),
        tool_schema(
            "browser_press_key",
            "Press a keyboard key (Enter, Escape, Tab, Backspace, ArrowDown, ...).",
            vec!["key"],
            {
                let mut p = serde_json::Map::new();
                p.insert("key".into(), text("Key name to press"));
                p
            },
        ),
        tool_schema(
            "browser_screenshot",
            "Capture the current page as a PNG screenshot (base64 data URL).",
            vec![],
            serde_json::Map::new(),
        ),
        tool_schema(
            "browser_back",
            "Go back one page in the history.",
            vec![],
            serde_json::Map::new(),
        ),
        tool_schema(
            "browser_forward",
            "Go forward one page in the history.",
            vec![],
            serde_json::Map::new(),
        ),
        tool_schema(
            "browser_reload",
            "Reload the current page.",
            vec![],
            serde_json::Map::new(),
        ),
        tool_schema(
            "browser_eval",
            "Run JavaScript in the page and return the JSON-serialized result.",
            vec!["expression"],
            {
                let mut p = serde_json::Map::new();
                p.insert("expression".into(), text("JavaScript expression to evaluate"));
                p
            },
        ),
    ]
}

fn text_content(text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

fn error_content(message: String) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

async fn call_tool(
    runtime: &Arc<Mutex<McpRuntime>>,
    name: &str,
    args: &Value,
) -> Value {
    let runtime_guard = runtime.lock().await;
    let app = runtime_guard.app.clone();

    let str_arg = |key: &str| args.get(key).and_then(Value::as_str).map(ToOwned::to_owned);
    let num_arg = |key: &str| args.get(key).and_then(Value::as_f64);

    match name {
        "browser_status" => match super::browser_status(app.state()).await {
            Ok(status) => text_content(serde_json::to_string_pretty(&status).unwrap_or_default()),
            Err(error) => error_content(format!("browser_status failed: {error}")),
        },
        "browser_navigate" => {
            let Some(url) = str_arg("url") else {
                return error_content("missing argument: url".into());
            };
            match super::browser_navigate(app.clone(), app.state(), url.clone()).await {
                Ok(result) if result.ok => text_content(format!("navigated to {url}")),
                Ok(result) => {
                    if result.needs_approval {
                        text_content(
                            "Navigation needs user approval in the browser pane. The user has been asked; retry once approved.".into(),
                        )
                    } else {
                        error_content(result.error.unwrap_or_else(|| "navigation failed".into()))
                    }
                }
                Err(error) => error_content(format!("browser_navigate failed: {error}")),
            }
        }
        "browser_click" => {
            let (Some(x), Some(y)) = (num_arg("x"), num_arg("y")) else {
                return error_content("missing argument: x/y".into());
            };
            match super::browser_click(app.state(), x, y).await {
                Ok(()) => text_content(format!("clicked at ({x}, {y})")),
                Err(error) => error_content(format!("browser_click failed: {error}")),
            }
        }
        "browser_type" => {
            let Some(text) = str_arg("text") else {
                return error_content("missing argument: text".into());
            };
            match super::browser_type(app.state(), text.clone()).await {
                Ok(()) => text_content(format!("typed {text:?}")),
                Err(error) => error_content(format!("browser_type failed: {error}")),
            }
        }
        "browser_press_key" => {
            let Some(key) = str_arg("key") else {
                return error_content("missing argument: key".into());
            };
            match super::browser_press_key(app.state(), key.clone()).await {
                Ok(()) => text_content(format!("pressed {key}")),
                Err(error) => error_content(format!("browser_press_key failed: {error}")),
            }
        }
        "browser_screenshot" => match super::browser_screenshot(app.state()).await {
            Ok(data) => text_content(format!("data:image/png;base64,{data}")),
            Err(error) => error_content(format!("browser_screenshot failed: {error}")),
        },
        "browser_back" => match super::browser_back(app.state()).await {
            Ok(()) => text_content("went back".into()),
            Err(error) => error_content(format!("browser_back failed: {error}")),
        },
        "browser_forward" => match super::browser_forward(app.state()).await {
            Ok(()) => text_content("went forward".into()),
            Err(error) => error_content(format!("browser_forward failed: {error}")),
        },
        "browser_reload" => match super::browser_reload(app.state()).await {
            Ok(()) => text_content("reloaded".into()),
            Err(error) => error_content(format!("browser_reload failed: {error}")),
        },
        "browser_eval" => {
            let Some(expression) = str_arg("expression") else {
                return error_content("missing argument: expression".into());
            };
            match super::browser_eval(app.state(), expression.clone()).await {
                Ok(value) => text_content(serde_json::to_string_pretty(&value).unwrap_or_default()),
                Err(error) => error_content(format!("browser_eval failed: {error}")),
            }
        }
        other => error_content(format!("unknown tool: {other}")),
    }
}
