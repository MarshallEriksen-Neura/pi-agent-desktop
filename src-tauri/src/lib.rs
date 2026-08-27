mod chat_store;
mod fs_bridge;
mod mcp_config;
mod pet_window;
mod pi_bridge;
mod pi_command;
mod pi_models;
mod pi_settings;
mod projects;
mod provider_auth;
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
    App, AppHandle, Manager, RunEvent,
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
    /// Set once teardown has finished (or the watchdog gave up on it). Until
    /// then every exit request is held, so a second quit action cannot cut a
    /// running teardown short.
    cleanup_settled: AtomicBool,
}

const SHUTDOWN_WATCHDOG: Duration = Duration::from_secs(8);

/// True for the caller that claims teardown; false for everyone after it.
fn begin_shutdown(app: &AppHandle) -> bool {
    !app.state::<BackendLifecycle>()
        .shutting_down
        .swap(true, Ordering::AcqRel)
}

fn cleanup_settled(app: &AppHandle) -> bool {
    app.state::<BackendLifecycle>()
        .cleanup_settled
        .load(Ordering::Acquire)
}

/// Mark teardown finished and let the process go. Ordering matters: the flag has
/// to be visible to the event loop *before* the exit it will observe, or the
/// handler could hold the very exit this is requesting.
fn settle_and_exit(app: &AppHandle, exit_code: i32) {
    app.state::<BackendLifecycle>()
        .cleanup_settled
        .store(true, Ordering::Release);
    app.exit(exit_code);
}

fn shutdown_backend_claimed(app: &AppHandle) {
    let pi = app.state::<PiProc>();
    let mut health = backend_health_snapshot(&pi);
    health.shutdown_in_progress = true;
    if let Ok(json) = serde_json::to_string(&health) {
        eprintln!("[backend-health] {json}");
    }
    // Stop the remote listener and cancel remote runtimes before the desktop
    // Pi process is terminated by the coordinator below.
    app.state::<RemoteControlState>().shutdown();
    // Kill any browser-pending login so its loopback callback server dies with
    // the app instead of lingering on a bound port.
    app.state::<provider_auth::ProviderAuthState>().shutdown();
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

fn schedule_shutdown_and_exit(app: AppHandle, exit_code: i32) {
    let cleanup_app = app.clone();
    if std::thread::Builder::new()
        .name("pi-shutdown".to_owned())
        .spawn(move || {
            shutdown_backend_claimed(&cleanup_app);
            settle_and_exit(&cleanup_app, exit_code);
        })
        .is_err()
    {
        // No thread to clean up on — exiting dirty beats never exiting.
        settle_and_exit(&app, exit_code);
        return;
    }

    // Backend teardown includes remote-control waits and child-process joins.
    // Never let those keep a WebView window visibly stuck forever.
    let watchdog_app = app;
    let _ = std::thread::Builder::new()
        .name("pi-exit-watchdog".to_owned())
        .spawn(move || {
            std::thread::sleep(SHUTDOWN_WATCHDOG);
            settle_and_exit(&watchdog_app, exit_code);
        });
}

/// Quit from a menu, the tray, or the frontend. A second call while teardown is
/// running is deliberately dropped rather than forwarded to `AppHandle::exit`:
/// `exit` ignores `prevent_exit`, so forwarding it would kill the process
/// mid-teardown. The in-flight cleanup — or the watchdog — owns the exit.
fn request_shutdown_and_exit(app: AppHandle, exit_code: i32) {
    if begin_shutdown(&app) {
        schedule_shutdown_and_exit(app, exit_code);
    } else if cleanup_settled(&app) {
        app.exit(exit_code);
    }
}

#[tauri::command]
fn app_quit(app: AppHandle, exit_code: i32) {
    request_shutdown_and_exit(app, exit_code);
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
                request_shutdown_and_exit(app.clone(), 0);
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
        .manage(provider_auth::ProviderAuthState::default())
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
            pet_window::pet_window_prewarm,
            pet_window::pet_window_show,
            pet_window::pet_window_hide,
            pet_window::pet_window_toggle,
            pet_window::pet_window_set_position,
            pet_window::list_custom_pets,
            open_external,
            pi_models::pi_fetch_models,
            provider_auth::provider_auth_list,
            provider_auth::provider_auth_begin,
            provider_auth::provider_auth_answer,
            provider_auth::provider_auth_cancel,
            provider_auth::provider_auth_logout,
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
            remote_control::remote_control_set_model_admin,
            app_quit
        ])
        .setup(|app| {
            if let Err(e) = app
                .state::<RemoteControlState>()
                .restore_on_startup(app.handle())
            {
                eprintln!("[remote-control] startup restore failed: {e}");
            }
            // The pet window is intentionally NOT created here. It is a second
            // webview loading the same Next bundle as the main window, so
            // booting it during setup delayed the first screen for everyone,
            // pets enabled or not. The main window pre-warms it (hidden) once it
            // has painted and gone idle — see the pet auto-launch effect in
            // AppShell and pet_window::pet_window_prewarm.
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
        if let RunEvent::ExitRequested { api, .. } = event {
            // Native close / Alt+F4 reaches Rust even when the WebView is sick.
            // Hold the exit, tear down off the event-loop thread, then exit from
            // there — doing it inline would block the loop that has to paint the
            // window closing.
            //
            // Every request is held until teardown settles, not just the first:
            // a tray quit arriving mid-teardown would otherwise be let through
            // and kill the process with the pi child still running. The exit
            // that finally lands is the one from `settle_and_exit`, which sets
            // the flag first and is ignored by `prevent_exit` regardless.
            if !cleanup_settled(app) {
                api.prevent_exit();
                if begin_shutdown(app) {
                    schedule_shutdown_and_exit(app.clone(), 0);
                }
            }
        }
    });
}
