use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const PET_WINDOW_LABEL: &str = "pet";
const PET_WINDOW_WIDTH: f64 = 200.0;
const PET_WINDOW_HEIGHT: f64 = 250.0;

/// Pre-create the pet window (hidden) at app startup, mirroring deeting's
/// `create_island_window` for its Dynamic Island. Using a *relative*
/// `WebviewUrl::App("pet")` lets Tauri resolve it through the dev server in dev
/// (`http://localhost:3000/pet`) and the bundled `tauri://` asset protocol in
/// release — no external http scope (e.g. `http:default`) is required, which is
/// exactly why the earlier `WebviewUrl::External(...)` approach stayed blank.
pub fn create_pet_window(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if app.get_webview_window(PET_WINDOW_LABEL).is_some() {
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, PET_WINDOW_LABEL, WebviewUrl::App("pet".into()))
        .title("Pi Pet")
        .inner_size(PET_WINDOW_WIDTH, PET_WINDOW_HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .on_page_load(|_window, payload| {
            // Diagnostic: confirm the webview actually navigates to /pet.
            eprintln!(
                "[pet-window] page_load event={:?} url={}",
                payload.event(),
                payload.url()
            );
        })
        .build()?;

    // In dev, open devtools so the real URL / console errors are directly visible.
    #[cfg(debug_assertions)]
    {
        let _ = window.open_devtools();
    }

    Ok(())
}

#[tauri::command]
pub fn pet_window_show(app: AppHandle) -> Result<(), String> {
    let existing = app.get_webview_window(PET_WINDOW_LABEL).is_some();
    eprintln!("[pet-window] pet_window_show called; existing_window={}", existing);
    if app.get_webview_window(PET_WINDOW_LABEL).is_none() {
        create_pet_window(&app).map_err(|e| e.to_string())?;
    }
    let window = app
        .get_webview_window(PET_WINDOW_LABEL)
        .ok_or_else(|| "pet window missing after create".to_string())?;
    window.show().map_err(|e| e.to_string())?;
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
