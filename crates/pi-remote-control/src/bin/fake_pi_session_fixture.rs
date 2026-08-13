use serde_json::Value;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.iter().any(|arg| arg == "--version") {
        println!("{}", pi_version());
        return Ok(());
    }
    require_arg_pair(&args, "--mode", "rpc")?;
    let cwd = env::current_dir().map_err(|error| error.to_string())?;
    let session_dir = arg_value(&args, "--session-dir")
        .map(PathBuf::from)
        .ok_or_else(|| "missing --session-dir".to_owned())?;
    fs::create_dir_all(&session_dir).map_err(|error| error.to_string())?;

    let explicit_session = arg_value(&args, "--session").map(PathBuf::from);
    let session_id_arg = arg_value(&args, "--session-id").map(str::to_owned);
    let (session_file, session_id, create_on_prompt) = if let Some(path) = explicit_session {
        if !path.is_file() {
            return Err("session file missing".into());
        }
        let id = read_session_id(&path)?;
        (path, id, false)
    } else {
        let id = session_id_arg.unwrap_or_else(|| "fake-session-id".to_owned());
        (session_dir.join(format!("{id}.jsonl")), id, true)
    };

    for line in io::stdin().lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
        match value.get("type").and_then(Value::as_str) {
            Some("get_state") => {
                let id = value.get("id").and_then(Value::as_str);
                let mut response = serde_json::json!({
                    "type": "response",
                    "success": true,
                    "command": "get_state",
                    "data": {
                        "sessionFile": session_file,
                        "sessionId": session_id,
                    }
                });
                if let Some(id) = id {
                    response["id"] = Value::String(id.to_owned());
                }
                println!("{response}");
                io::stdout().flush().map_err(|error| error.to_string())?;
            }
            Some("prompt") => {
                let message = value
                    .get("message")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "missing prompt message".to_owned())?;
                if create_on_prompt && !session_file.exists() {
                    write_header(&session_file, &session_id, &cwd)?;
                }
                append_prompt(&session_file, message)?;
                let count = prompt_count(&session_file)?;
                // Optional delay between delivery and settling so runtime
                // cancellation can be exercised mid-turn.
                if let Ok(delay) = env::var("FAKE_PI_SETTLE_DELAY_MS") {
                    if let Ok(ms) = delay.parse::<u64>() {
                        std::thread::sleep(std::time::Duration::from_millis(ms));
                    }
                }
                println!("{}", serde_json::json!({"type":"agent_start"}));
                println!(
                    "{}",
                    serde_json::json!({
                        "type": "message_update",
                        "assistantMessageEvent": {
                            "type": "text_delta",
                            "delta": format!("settled prompt {count}")
                        }
                    })
                );
                println!(
                    "{}",
                    serde_json::json!({"type":"agent_end", "willRetry": true})
                );
                println!("{}", serde_json::json!({"type":"agent_settled"}));
                io::stdout().flush().map_err(|error| error.to_string())?;
            }
            _ => {
                println!(
                    "{}",
                    serde_json::json!({"type":"response","success":false,"error":"unsupported"})
                );
                io::stdout().flush().map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

fn require_arg_pair(args: &[String], key: &str, expected: &str) -> Result<(), String> {
    match arg_value(args, key) {
        Some(value) if value == expected => Ok(()),
        _ => Err(format!("missing {key} {expected}")),
    }
}

fn arg_value<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|pair| pair[0] == key)
        .map(|pair| pair[1].as_str())
}

fn write_header(path: &Path, session_id: &str, cwd: &Path) -> Result<(), String> {
    let header = serde_json::json!({
        "type": "session",
        "version": 3,
        "id": session_id,
        "timestamp": "2026-08-12T00:00:00Z",
        "cwd": cwd,
    });
    fs::write(path, format!("{header}\n")).map_err(|error| error.to_string())
}

fn read_session_id(path: &Path) -> Result<String, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let first = content
        .lines()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| "empty session".to_owned())?;
    let value: Value = serde_json::from_str(first).map_err(|error| error.to_string())?;
    value
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "missing session id".to_owned())
}

fn append_prompt(path: &Path, message: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    writeln!(
        file,
        "{}",
        serde_json::json!({"type":"prompt_delivery","message":message})
    )
    .map_err(|error| error.to_string())
}

fn prompt_count(path: &Path) -> Result<usize, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    Ok(content
        .lines()
        .filter(|line| line.contains(r#""type":"prompt_delivery""#))
        .count())
}

fn pi_version() -> String {
    env::var("FAKE_PI_VERSION").unwrap_or_else(|_| "0.84.1".to_owned())
}
