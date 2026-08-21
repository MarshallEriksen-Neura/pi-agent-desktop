mod chat_store;
mod fs_bridge;
mod mcp_config;
mod pet_window;
mod pi_bridge;
mod pi_command;
mod pi_models;
mod pi_settings;
mod projects;
mod remote_control;
mod updater;
mod wsl;

use pi_backend_core::backend_health::{BackendHealthSnapshot, ComponentStatus};
use pi_backend_core::backend_lifecycle::{ShutdownCoordinator, ShutdownStage};
use pi_backend_core::pi_process::ProcessPhase;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, Manager, RunEvent,
};

use pi_bridge::PiProc;
use remote_control::RemoteControlState;

#[cfg(feature = "remote-control-smoke")]
pub fn run_remote_control_command_smoke() {
    remote_control::run_command_smoke();
}

#[derive(Default)]
struct BackendLifecycle {
    shutting_down: AtomicBool,
}

fn shutdown_backend(app: &tauri::AppHandle) {
    let lifecycle = app.state::<BackendLifecycle>();
    if lifecycle.shutting_down.swap(true, Ordering::AcqRel) {
        return;
    }

    let pi = app.state::<PiProc>();
    let mut health = backend_health_snapshot(&pi);
    health.shutdown_in_progress = true;
    if let Ok(json) = serde_json::to_string(&health) {
        eprintln!("[backend-health] {json}");
    }
    // Stop the remote listener and cancel remote runtimes before the desktop
    // Pi process is terminated by the coordinator below.
    app.state::<RemoteControlState>().shutdown();
    let mut coordinator = ShutdownCoordinator::new();
    coordinator.push(ShutdownStage::StopAccepting, |_| Ok(()));
    coordinator.push(ShutdownStage::CloseInputs, |_| Ok(()));
    coordinator.push(ShutdownStage::CancelWork, |_| Ok(()));
    coordinator.push(ShutdownStage::TerminateProcesses, |remaining| {
        pi.shutdown(remaining.min(Duration::from_secs(5)))
    });
    coordinator.push(ShutdownStage::FlushDiagnostics, |_| Ok(()));
    coordinator.push(ShutdownStage::JoinWorkers, |_| Ok(()));
    if let Err(error) = coordinator.run(Duration::from_secs(6)) {
        eprintln!("[backend-shutdown] {error}");
    }
}

fn backend_health_snapshot(pi: &PiProc) -> BackendHealthSnapshot {
    let process = pi.snapshot();
    let status = match process.as_ref().map(|snapshot| snapshot.phase) {
        Some(ProcessPhase::Running) => ComponentStatus::Healthy,
        Some(ProcessPhase::Stopping) => ComponentStatus::Degraded,
        Some(ProcessPhase::Failed) => ComponentStatus::Failed,
        Some(ProcessPhase::Exited) | None => ComponentStatus::Stopped,
    };
    // Storage owners are still lazy and independent; without probing both the
    // SQLite and durable JSON stores, reporting healthy would be misleading.
    BackendHealthSnapshot::new(status, process, ComponentStatus::Unknown)
}

/// Intercept the executable's `-c <command>` form before Tauri starts. Pi uses
/// this entry point as its WSL-compatible custom shell.
pub fn run_shell_bridge_if_requested() -> Option<i32> {
    wsl::run_shell_bridge_if_requested()
}

/// Open an http(s) URL in the system default browser (terminal web-links).
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("only http(s) urls allowed".into());
    }
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&url).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

/// Build the system tray so the main window can be minimized to tray and
/// restored (or quit) from outside the window. Left-click toggles the window,
/// right-click (or the menu) shows 显示 / 隐藏 / 退出.
fn create_tray(app: &App) -> tauri::Result<()> {
    let show_i = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
    let hide_i = MenuItem::with_id(app, "hide", "隐藏", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &hide_i, &quit_i])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .expect("app must have a default window icon for the tray");

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("Pi")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "hide" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            "quit" => {
                shutdown_backend(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            let is_left_click = matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            );

            if !is_left_click {
                return;
            }

            // Windows fires tray clicks with button_state == Down, while macOS
            // uses Up. Ignore the Up event on Windows because the actual toggle
            // already happened on Down; on macOS Up is the correct state.
            #[cfg(target_os = "windows")]
            let should_toggle = matches!(
                event,
                TrayIconEvent::Click {
                    button_state: MouseButtonState::Down,
                    ..
                } | TrayIconEvent::DoubleClick { .. }
            );

            #[cfg(not(target_os = "windows"))]
            let should_toggle = matches!(
                event,
                TrayIconEvent::Click {
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick { .. }
            );

            if !should_toggle {
                return;
            }

            let app = tray.app_handle();
            if let Some(w) = app.get_webview_window("main") {
                if w.is_visible().unwrap_or(false) {
                    let _ = w.hide();
                } else {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PiProc::default())
        .manage(BackendLifecycle::default())
        .manage(RemoteControlState::default())
        .manage(chat_store::ChatDb::default())
        .invoke_handler(tauri::generate_handler![
            chat_store::chat_sessions_list,
            chat_store::chat_session_load,
            chat_store::chat_session_save,
            chat_store::chat_session_rename,
            chat_store::chat_session_delete,
            pi_bridge::pi_start,
            pi_bridge::pi_send,
            pi_bridge::pi_stop,
            pi_bridge::pi_generate_title,
            fs_bridge::workspace_root,
            fs_bridge::fs_list_dir,
            fs_bridge::fs_read_file,
            fs_bridge::fs_read_file_base64,
            fs_bridge::fs_write_file,
            fs_bridge::fs_create_file,
            fs_bridge::fs_create_dir,
            fs_bridge::fs_delete,
            fs_bridge::fs_rename,
            pi_settings::pi_settings_read,
            pi_settings::pi_settings_write,
            pi_settings::pi_cli,
            mcp_config::mcp_config_read,
            mcp_config::mcp_config_write,
            mcp_config::mcp_config_open_dir,
            mcp_config::mcp_adapter_check,
            mcp_config::mcp_config_discover,
            projects::projects_recent,
            projects::project_resolve,
            projects::project_open,
            projects::project_remove_recent,
            projects::project_pick,
            projects::runtime_config_read,
            projects::runtime_config_write,
            wsl::wsl_list_distros,
            wsl::wsl_shell_bridge_path,
            wsl::wsl_runtime_validate,
            updater::update_check,
            updater::update_apply,
            updater::pi_cli_update_check,
            pet_window::pet_window_show,
            pet_window::pet_window_hide,
            pet_window::pet_window_toggle,
            pet_window::pet_window_set_position,
            pet_window::list_custom_pets,
            open_external,
            pi_models::pi_fetch_models,
            remote_control::remote_control_status,
            remote_control::remote_control_private_addresses,
            remote_control::remote_control_enable,
            remote_control::remote_control_disable,
            remote_control::remote_control_pairing_payload,
            remote_control::remote_control_revoke_device,
            remote_control::remote_control_reset_identity,
            remote_control::remote_conversations_list,
            remote_control::remote_conversation_get,
            remote_control::remote_conversation_messages,
            remote_control::remote_conversation_append,
            remote_control::remote_conversation_cancel,
            remote_control::remote_conversation_archive,
            remote_control::remote_control_set_model_admin
        ])
        .setup(|app| {
            if let Err(e) = app
                .state::<RemoteControlState>()
                .restore_on_startup(app.handle())
            {
                eprintln!("[remote-control] startup restore failed: {e}");
            }
            if let Err(e) = pet_window::create_pet_window(app.handle()) {
                eprintln!("[pet-window] failed to pre-create pet window: {e}");
            }
            if let Err(e) = create_tray(app) {
                eprintln!("[tray] failed to create system tray: {e}");
            }
            // One-shot migration for installs that ran the removed in-app
            // browser pane: it registered a loopback MCP server on every launch,
            // and a leftover entry would point pi at a dead port for the whole
            // session. Non-fatal — a malformed mcp.json must not block startup.
            match mcp_config::deregister_retired_browser_server() {
                Ok(true) => eprintln!("[mcp-config] removed the retired browser MCP entry"),
                Ok(false) => {}
                Err(error) => eprintln!("[mcp-config] browser MCP cleanup skipped: {error}"),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Pi desktop");
    app.run(|app, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            shutdown_backend(app);
        }
    });
}
