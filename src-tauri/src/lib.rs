mod chat_store;
mod fs_bridge;
mod pi_bridge;
mod pi_settings;
mod projects;
mod updater;

use pi_bridge::PiProc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            fs_bridge::fs_write_file,
            pi_settings::pi_settings_read,
            pi_settings::pi_settings_write,
            pi_settings::pi_cli,
            projects::projects_recent,
            projects::project_open,
            projects::project_remove_recent,
            projects::project_pick,
            updater::update_check,
            updater::update_apply
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running Pi desktop");
}
