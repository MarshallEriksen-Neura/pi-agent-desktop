//! Minimal Chrome DevTools Protocol (CDP) client.
//!
//! A single WebSocket JSON-RPC connection to a Chrome/Edge debugging port.
//! Only the methods the browser pane needs are implemented; the protocol
//! surface stays tiny so it compiles on the project MSRV (1.77.2) without
//! pulling the heavy `chromiumoxide` stack (which requires Rust 1.85).

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Default per-call timeout: long enough for slow navigations, short enough
/// that a dead renderer surfaces an error instead of hanging the UI.
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

/// Events pushed from the browser to the UI (messages with no `id`).
#[derive(Debug)]
pub enum CdpEvent {
    /// A navigation committed (Page.frameNavigated / Page.navigatedWithinDocument).
    Navigated { url: String },
    /// The page started loading (Page.frameStartedLoading).
    Loading { url: String },
    /// The page finished loading (Page.loadEventFired).
    Loaded { url: String },
    /// A JavaScript console message (Runtime.consoleAPICalled).
    Console { text: String },
}

type Pending = oneshot::Sender<Result<Value, String>>;

/// Shared handle to a CDP session. Cheap to clone; all calls are serialized
/// through one background task per connection.
#[derive(Clone)]
pub struct CdpSession {
    inner: Arc<CdpInner>,
}

struct CdpInner {
    /// Outbound JSON-RPC requests, matched by incrementing id.
    tx: mpsc::Sender<(u64, String, Value, Pending)>,
    /// Inbound events (messages without an id); read via `next_event`.
    events: Mutex<Option<mpsc::Receiver<CdpEvent>>>,
    /// Set false when the reader task observes the socket close.
    connected: Arc<AtomicBool>,
}impl CdpSession {
    /// Connect to a page's WebSocket debugger URL.
    pub async fn connect(ws_url: &str) -> Result<Self, String> {
        let (tx, mut requests) = mpsc::channel::<(u64, String, Value, Pending)>(64);
        let (events, event_rx) = mpsc::channel::<CdpEvent>(128);

        let (mut ws_tx, mut ws_rx) = tokio_tungstenite::connect_async(ws_url)
            .await
            .map_err(|e| format!("cdp connect {ws_url}: {e}"))?
            .0
            .split();

        let pending_lock = Arc::new(Mutex::new(HashMap::<u64, Pending>::new()));
        let connected = Arc::new(AtomicBool::new(true));

        // Writer: drain queued requests onto the socket.
        let writer_pending = pending_lock.clone();
        let writer = tokio::spawn(async move {
            while let Some((id, method, params, reply)) = requests.recv().await {
                writer_pending.lock().await.insert(id, reply);
                let message = json!({ "id": id, "method": method, "params": params });
                let frame = tungstenite::Message::Text(message.to_string());
                if ws_tx.send(frame).await.is_err() {
                    break;
                }
            }
            let _ = ws_tx.close().await;
        });

        // Reader: resolve pending requests by id; forward events. When the
        // socket closes it flips the `connected` flag and flushes every still
        // pending request with an error so no caller waits forever.
        let reader_pending = pending_lock.clone();
        let reader_connected = connected.clone();
        tokio::spawn(async move {
            loop {
                match ws_rx.next().await {
                    Some(Ok(frame)) => {
                        let text = match frame {
                            tungstenite::Message::Text(text) => text.to_string(),
                            tungstenite::Message::Binary(bytes) => {
                                String::from_utf8_lossy(&bytes).to_string()
                            }
                            _ => continue,
                        };
                        let Ok(Value::Object(message)) = serde_json::from_str::<Value>(&text)
                        else {
                            continue;
                        };
                        if let Some(id) = message.get("id").and_then(Value::as_u64) {
                            let pending = reader_pending.lock().await.remove(&id);
                            if let Some(reply) = pending {
                                let result = if let Some(error) = message.get("error") {
                                    Err(error
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .unwrap_or("cdp error")
                                        .to_owned())
                                } else {
                                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                                };
                                let _ = reply.send(result);
                            }
                            continue;
                        }
                        if let Some(event) = parse_event(&message) {
                            let _ = events.send(event).await;
                        }
                    }
                    // Socket closed or protocol error → drop out.
                    _ => break,
                }
            }
            reader_connected.store(false, Ordering::SeqCst);
            // Fail every outstanding request so awaiting callers unblock.
            for (_, reply) in reader_pending.lock().await.drain() {
                let _ = reply.send(Err("cdp connection closed".to_owned()));
            }
            let _ = writer.await;
        });

        // Drop the writer handle held here so the reader loop terminates when
        // the remote closes (reader owns ws_rx; events channel outlives it).
        let _ = writer;

        Ok(Self {
            inner: Arc::new(CdpInner {
                tx,
                events: Mutex::new(Some(event_rx)),
                connected: connected,
            }),
        })
    }

    /// Send a CDP method and await its result, bounded by a timeout so a
    /// half-open WebSocket (network drop, hung renderer) cannot hang callers.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.call_timeout(method, params, CALL_TIMEOUT).await
    }

    /// `call` with a caller-chosen timeout (used by long-lived operations).
    pub async fn call_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let (reply_tx, reply_rx) = oneshot::channel();
        self.inner
            .tx
            .send((id, method.to_owned(), params, reply_tx))
            .await
            .map_err(|_| "cdp session closed".to_owned())?;
        tokio::time::timeout(timeout, reply_rx)
            .await
            .map_err(|_| format!("cdp method {method} timed out after {timeout:?}"))?
            .map_err(|_| "cdp request cancelled".to_owned())?
    }

    /// True when the background writer/reader is still alive (connection open).
    pub fn is_connected(&self) -> bool {
        self.inner.connected.load(Ordering::SeqCst)
    }

    /// Receive the next browser event (None when the connection closed).
    pub async fn next_event(&self) -> Option<CdpEvent> {
        let mut guard = self.inner.events.lock().await;
        match guard.as_mut() {
            Some(receiver) => receiver.recv().await,
            None => None,
        }
    }
}

fn parse_event(message: &serde_json::Map<String, Value>) -> Option<CdpEvent> {
    let method = message.get("method")?.as_str()?;
    let params = message.get("params")?;
    let url = || params.get("url").and_then(Value::as_str).unwrap_or("").to_owned();
    match method {
        "Page.frameNavigated" => Some(CdpEvent::Navigated { url: url() }),
        "Page.navigatedWithinDocument" => Some(CdpEvent::Navigated { url: url() }),
        "Page.frameStartedLoading" => Some(CdpEvent::Loading { url: url() }),
        "Page.loadEventFired" => Some(CdpEvent::Loaded { url: url() }),
        "Runtime.consoleAPICalled" => {
            let text = params
                .get("args")
                .and_then(Value::as_array)
                .map(|args| {
                    args.iter()
                        .filter_map(|arg| arg.get("value").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            Some(CdpEvent::Console { text })
        }
        _ => None,
    }
}
