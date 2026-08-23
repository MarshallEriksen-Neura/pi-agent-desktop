use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const PET_WINDOW_LABEL: &str = "pet";
const PET_WINDOW_WIDTH: f64 = 200.0;
const PET_WINDOW_HEIGHT: f64 = 250.0;

/// Create the pet window (hidden) so a later `show` is instant. Using a
/// *relative* `WebviewUrl::App("pet")` (no trailing slash) lets Tauri resolve it
/// through the dev server in dev (`http://localhost:3000/pet`, which Next
/// redirects to `/pet/`) and the bundled `tauri://` asset protocol in release —
/// no external http scope (e.g. `http:default`) is required, which is exactly
/// why the earlier `WebviewUrl::External(...)` approach stayed blank.
///
/// Deliberately NOT called from `setup()` any more. The pet is a second webview
/// loading the same Next bundle as the main window, so booting it next to the
/// main window made the two fight over the same renderer budget (and, in dev,
/// the same on-demand Next compile) and visibly delayed the first screen — for
/// every user, including the majority who never enable a pet. The main window
/// now calls `pet_window_prewarm` once it has painted and gone idle, and only
/// when a pet is actually enabled (see `AppShell`).
pub fn create_pet_window(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if app.get_webview_window(PET_WINDOW_LABEL).is_some() {
        return Ok(());
    }
    let _window = WebviewWindowBuilder::new(app, PET_WINDOW_LABEL, WebviewUrl::App("pet".into()))
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

    // Dev diagnostics are opt-in: auto-opening devtools spins up yet another
    // webview during startup, which is exactly the cost this window is trying
    // to stay out of. Set PI_PET_DEVTOOLS=1 when debugging the pet itself.
    #[cfg(debug_assertions)]
    {
        let want_devtools = std::env::var("PI_PET_DEVTOOLS")
            .map(|value| value == "1" || value == "true")
            .unwrap_or(false);
        if want_devtools {
            _window.open_devtools();
        }
    }

    Ok(())
}

/// Load the pet window in the background without showing it.
///
/// Idempotent, and cheap when the window already exists — the main window calls
/// this once it is idle so the pet's boot never competes with the first screen.
/// The window stays hidden until `/pet` reports it has content (the
/// `pet-window-ready` event), which keeps the silent load invisible instead of
/// flashing the prerendered "No pet selected" placeholder.
#[tauri::command]
pub fn pet_window_prewarm(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window(PET_WINDOW_LABEL).is_some() {
        return Ok(());
    }
    create_pet_window(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pet_window_show(app: AppHandle) -> Result<(), String> {
    let existing = app.get_webview_window(PET_WINDOW_LABEL).is_some();
    eprintln!(
        "[pet-window] pet_window_show called; existing_window={}",
        existing
    );
    if app.get_webview_window(PET_WINDOW_LABEL).is_none() {
        create_pet_window(&app).map_err(|e| e.to_string())?;
    }
    let window = app
        .get_webview_window(PET_WINDOW_LABEL)
        .ok_or_else(|| "pet window missing after create".to_string())?;
    // No set_focus(): the pet is a 200x250 always-on-top overlay, so focusing it
    // only steals the caret from whatever the user was typing in — and on the
    // startup auto-launch path it stole focus from the main window itself.
    // always_on_top already guarantees it is visible above the main window.
    window.show().map_err(|e| e.to_string())?;
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
            // See pet_window_show: revealing the overlay must not take focus.
            window.show().map_err(|e| e.to_string())?;
            Ok(true)
        }
    } else {
        pet_window_show(app)?;
        Ok(true)
    }
}

#[tauri::command]
pub fn pet_window_set_position(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        use tauri::Position;
        window
            .set_position(Position::Physical((x, y).into()))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Metadata for a user-installed custom pet, as returned by list_custom_pets.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomPetEntry {
    pub id: String,
    pub display_name: String,
    pub description: String,
    /// Absolute filesystem path to the pet directory.
    /// Pass to loadCustomPetFromDisk() on the frontend.
    pub base_path: String,
}

/// List custom pets the user has installed in the app data directory.
///
/// Scans <AppLocalData>/pets/custom/ for subdirectories that contain a
/// valid pet.json. Returns basic metadata so the UI can populate the list
/// without a separate round-trip per pet.
#[tauri::command]
pub fn list_custom_pets(app: AppHandle) -> Result<Vec<CustomPetEntry>, String> {
    let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let pets_dir = data_dir.join("pets").join("custom");

    if !pets_dir.exists() {
        return Ok(vec![]);
    }

    let mut entries: Vec<CustomPetEntry> = Vec::new();

    for entry in std::fs::read_dir(&pets_dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let manifest_path = path.join("pet.json");
        if !manifest_path.exists() {
            continue;
        }

        let id = match entry.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue, // skip non-UTF-8 directory names
        };

        let content = match std::fs::read_to_string(&manifest_path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let manifest: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let display_name = manifest["displayName"]
            .as_str()
            .unwrap_or(&id)
            .trim()
            .to_string();
        let description = manifest["description"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_string();

        entries.push(CustomPetEntry {
            id,
            display_name,
            description,
            base_path: path.to_string_lossy().into_owned(),
        });
    }

    // Stable order so the UI list doesn't shuffle on re-scan
    entries.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(entries)
}
