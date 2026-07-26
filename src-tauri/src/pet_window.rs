use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const PET_WINDOW_LABEL: &str = "pet";
const PET_WINDOW_WIDTH: f64 = 200.0;
const PET_WINDOW_HEIGHT: f64 = 250.0;

#[tauri::command]
pub fn pet_window_show(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Create new pet window
    let window = WebviewWindowBuilder::new(
        &app,
        PET_WINDOW_LABEL,
        WebviewUrl::App("/pet".into()),
    )
    .title("Pi Pet")
    .inner_size(PET_WINDOW_WIDTH, PET_WINDOW_HEIGHT)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(true)
    .build()
    .map_err(|e| e.to_string())?;

    window.set_focus().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn pet_window_hide(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pet_window_toggle(app: AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        let visible = window.is_visible().map_err(|e| e.to_string())?;
        if visible {
            window.hide().map_err(|e| e.to_string())?;
            Ok(false)
        } else {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            Ok(true)
        }
    } else {
        pet_window_show(app)?;
        Ok(true)
    }
}

#[tauri::command]
pub fn pet_window_set_position(
    app: AppHandle,
    x: i32,
    y: i32,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        use tauri::Position;
        window
            .set_position(Position::Physical((x, y).into()))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
