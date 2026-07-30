// Prevents an extra console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = pi_desktop_lib::run_shell_bridge_if_requested() {
        std::process::exit(code);
    }
    pi_desktop_lib::run()
}
