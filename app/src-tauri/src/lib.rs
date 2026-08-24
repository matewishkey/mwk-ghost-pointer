mod platform;

use platform::{Display, Modifiers, Platform, Point};

/// Global cursor position, top-left origin, logical units.
#[tauri::command]
fn cursor_position() -> Option<Point> {
    platform::Impl::cursor_position()
}

/// Modifier keys held right now. Polled — see platform::Modifiers for why.
#[tauri::command]
fn modifiers() -> Modifiers {
    platform::Impl::modifiers()
}

/// Every active display, for the viewer's picker and the `geo` message.
#[tauri::command]
fn displays() -> Vec<Display> {
    platform::Impl::displays()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![cursor_position, modifiers, displays])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
