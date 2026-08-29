//! `npx skills` bridge — the desktop app's skill install/remove/update path.
//!
//! pi has no skills subcommand of its own, so skill management goes through the
//! upstream Skills CLI (vercel-labs/skills), which already knows pi's skill
//! directories: `~/.pi/agent/skills` globally, `<root>/.pi/skills` per project —
//! the same ones `useSkills.scan()` reads. A globally installed `skills` binary
//! is preferred when present; otherwise we fall back to `npx -y skills@latest`.

use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::pi_settings::CliResult;

/// Anonymous catalogue search — the endpoint the Skills CLI's own `find` command
/// uses. The documented `/api/v1/*` API needs a Vercel OIDC bearer token.
const SEARCH_URL: &str = "https://skills.sh/api/search";

/// Subcommands the UI may run. `add`/`remove`/`update` mutate skill
/// directories, `list` is read-only. Everything else is rejected so a renderer
/// bug can't turn this into an arbitrary-argv escape hatch.
const ALLOWED: &[&str] = &["add", "remove", "update", "list"];

/// `skills` on PATH if the user installed it globally, else npx running the
/// published package. Both resolve through `pi_command`, which handles Windows
/// `PATHEXT` and npm's `.cmd` shims.
fn skills_command(args: &[String]) -> Result<Command, String> {
    if let Some(program) = crate::pi_command::resolve_executable("skills") {
        let mut cmd = Command::new(program);
        cmd.args(args);
        return Ok(cmd);
    }

    let npx = crate::pi_command::resolve_executable("npx").ok_or_else(|| {
        "Neither `skills` nor `npx` was found on PATH. Install Node.js (it ships npx), \
         or run `npm install -g skills`, then restart Pi."
            .to_string()
    })?;
    let mut cmd = Command::new(npx);
    cmd.arg("-y").arg("skills@latest").args(args);
    Ok(cmd)
}

#[tauri::command]
pub async fn skills_cli(args: Vec<String>, cwd: Option<String>) -> Result<CliResult, String> {
    match args.first().map(String::as_str) {
        Some(sub) if ALLOWED.contains(&sub) => {}
        _ => return Err("only skills add/remove/update/list are allowed".into()),
    }

    // A first npx download plus a source clone runs into tens of seconds; keep
    // it off the synchronous command threads.
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = skills_command(&args)?;
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // The CLI draws clack spinners and box-drawing prefixes; without
            // these the `--list` output is unparseable ANSI soup.
            .env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0")
            // npx echoes npm's own warnings about the user's .npmrc onto stderr,
            // where they would otherwise be the loudest thing in a failure.
            .env("npm_config_loglevel", "error");
        crate::pi_command::prepend_npm_bin_to_path(&mut cmd);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let out = cmd
            .output()
            .map_err(|e| format!("failed to run the skills CLI: {e}"))?;
        Ok(CliResult {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One catalogue hit, in the shape the skills page renders.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillHit {
    /// `<source>/<skillId>` — stable, used as the react key
    pub id: String,
    /// what goes after `--skill`
    pub skill_id: String,
    pub name: String,
    /// `owner/repo`, or a bare domain for well-known sources
    pub source: String,
    pub installs: u64,
}

#[derive(Deserialize)]
struct SearchResponse {
    skills: Option<Vec<SearchSkill>>,
}

#[derive(Deserialize)]
struct SearchSkill {
    id: String,
    #[serde(rename = "skillId")]
    skill_id: Option<String>,
    name: String,
    source: Option<String>,
    installs: Option<u64>,
}

/// reqwest's `Display` stops at the outermost layer — usually just "error
/// sending request for url". The reason a request failed (timed out, tcp connect
/// error, proxy refused) lives further down the source chain.
fn chain(error: &dyn std::error::Error) -> String {
    let mut out = error.to_string();
    let mut source = error.source();
    while let Some(inner) = source {
        out.push_str(": ");
        out.push_str(&inner.to_string());
        source = inner.source();
    }
    out
}

/// Search the skills.sh catalogue.
///
/// This cannot run in the renderer: the endpoint answers without any
/// `Access-Control-Allow-Origin`, so a `fetch` from the webview is blocked by
/// CORS and reports nothing but `TypeError: Failed to fetch`. A native client
/// has no such rule, and reqwest additionally honours the user's proxy — from
/// `HTTP(S)_PROXY` or, on Windows, the Internet Settings registry key — which
/// the webview does not reliably do.
#[tauri::command]
pub async fn skills_search(query: String, limit: u32) -> Result<Vec<SkillHit>, String> {
    let query = query.trim();
    // The endpoint rejects one-character queries.
    if query.len() < 2 {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 50).to_string();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("pi-desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))?;

    let response = client
        .get(SEARCH_URL)
        .query(&[("q", query), ("limit", limit.as_str())])
        .send()
        .await
        .map_err(|e| format!("skills.sh unreachable — {}", chain(&e)))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("skills.sh returned HTTP {status}"));
    }

    let body: SearchResponse = response
        .json()
        .await
        .map_err(|e| format!("unreadable response from skills.sh — {}", chain(&e)))?;

    Ok(body
        .skills
        .unwrap_or_default()
        .into_iter()
        .map(|skill| {
            let SearchSkill {
                id,
                skill_id,
                name,
                source,
                installs,
            } = skill;
            let skill_id = skill_id.filter(|v| !v.is_empty()).unwrap_or_else(|| {
                // `<owner>/<repo>/<skill>` — everything past the source
                id.splitn(3, '/').nth(2).unwrap_or(&id).to_string()
            });
            SkillHit {
                id,
                skill_id,
                name,
                source: source.unwrap_or_default(),
                installs: installs.unwrap_or(0),
            }
        })
        .collect())
}
