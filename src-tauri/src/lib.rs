mod chat_store;
mod fs_bridge;
mod pet_window;
mod pi_bridge;
mod pi_settings;
mod projects;
mod updater;

use pi_bridge::PiProc;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PiProc::default())
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
            fs_bridge::workspace_root,
            fs_bridge::fs_list_dir,
            fs_bridge::fs_read_file,
            fs_bridge::fs_read_file_base64,
            fs_bridge::fs_write_file,
            pi_settings::pi_settings_read,
            pi_settings::pi_settings_write,
            pi_settings::pi_cli,
            projects::projects_recent,
            projects::project_open,
            projects::project_remove_recent,
            projects::project_pick,
            updater::update_check,
            updater::update_apply,
            updater::pi_cli_update_check,
            pet_window::pet_window_show,
            pet_window::pet_window_hide,
            pet_window::pet_window_toggle,
            pet_window::pet_window_set_position,
            pet_window::list_custom_pets,
            open_external
        ])
        .setup(|app| {
            if let Err(e) = pet_window::create_pet_window(app.handle()) {
                eprintln!("[pet-window] failed to pre-create pet window: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Pi desktop");
}
