//! Ghost Pointer — the desktop app.
//!
//! Everything OS-specific lives in `platform/`; this file is the wiring that both platforms
//! share. Three windows, and the split between them is deliberate:
//!
//! * **main** — the control UI. Owns the WebSocket, because the wire protocol is written once,
//!   in TypeScript, against the same relay the browser test rig already talks to.
//! * **overlay** — transparent, click-through, one per role. The guest draws the incoming ghost
//!   on it; the host draws its own local echo on it, so pointing feels instant instead of
//!   waiting for the video round-trip.
//! * **aim** — the host's calibration picker. The one window here that *does* take clicks.

mod platform;

use platform::{Display, Modifiers, Platform, Point};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl,
            WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// One tick of the sender's poll loop: where the cursor is, and what is held.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
struct Sample {
    x: f64,
    y: f64,
    #[serde(flatten)]
    mods: Modifiers,
}

/// Owns the poll loop's stop flag. One loop at a time, ever.
#[derive(Default)]
struct Stream {
    running: Arc<AtomicBool>,
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

/// Global cursor position, top-left origin, logical units.
#[tauri::command]
fn cursor_position() -> Option<Point> {
    platform::Impl::cursor_position()
}

/// Modifier keys held right now. Polled — see `platform::Modifiers` for why.
#[tauri::command]
fn modifiers() -> Modifiers {
    platform::Impl::modifiers()
}

/// Every active display, for the viewer's picker and the `geo` message.
#[tauri::command]
fn displays() -> Vec<Display> {
    platform::Impl::displays()
}

// ---------------------------------------------------------------------------------------------
// The sender's poll loop
// ---------------------------------------------------------------------------------------------

/// Start emitting `cursor` events at 60 Hz. Idempotent — calling it twice does not start
/// two loops.
///
/// This runs in Rust rather than as a 60 Hz `invoke` from JS because a poll that has to make a
/// round trip through the IPC boundary to ask its question is a poll that jitters. It emits
/// only on change, so a still mouse costs nothing.
#[tauri::command]
fn start_cursor_stream(app: AppHandle, stream: tauri::State<'_, Stream>) {
    if stream.running.swap(true, Ordering::SeqCst) {
        return; // already running
    }
    let running = stream.running.clone();
    std::thread::spawn(move || {
        let mut last: Option<Sample> = None;
        while running.load(Ordering::SeqCst) {
            if let Some(p) = platform::Impl::cursor_position() {
                let s = Sample { x: p.x, y: p.y, mods: platform::Impl::modifiers() };
                if last != Some(s) {
                    let _ = app.emit("cursor", s);
                    last = Some(s);
                }
            }
            std::thread::sleep(Duration::from_millis(16)); // ~60 Hz
        }
    });
}

#[tauri::command]
fn stop_cursor_stream(stream: tauri::State<'_, Stream>) {
    stream.running.store(false, Ordering::SeqCst);
}

// ---------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------

/// Put a window above the menu bar and onto every Space, including over a full-screen app.
///
/// Tauri's `always_on_top` lands on `NSFloatingWindowLevel` (3), which is above ordinary
/// windows but *below* the menu bar (24). M0 proved a native window can cover the whole
/// display; this is what keeps that true through Tauri. Without it the ghost vanishes the
/// moment it crosses into the top 25 points of the screen.
#[cfg(target_os = "macos")]
fn raise_over_everything(win: &WebviewWindow) {
    use objc2::runtime::AnyObject;
    let Ok(ptr) = win.ns_window() else { return };
    let ns = ptr as *mut AnyObject;
    unsafe {
        // NSStatusWindowLevel = 25. Above the menu bar, below the screen saver.
        let _: () = objc2::msg_send![ns, setLevel: 25isize];
        // CanJoinAllSpaces | Stationary | IgnoresCycle | FullScreenAuxiliary
        let behavior: usize = (1 << 0) | (1 << 4) | (1 << 6) | (1 << 8);
        let _: () = objc2::msg_send![ns, setCollectionBehavior: behavior];
    }
}

#[cfg(not(target_os = "macos"))]
fn raise_over_everything(_win: &WebviewWindow) {}

/// Create or reposition the transparent click-through overlay covering one display.
///
/// `x`/`y`/`w`/`h` are that display's rect in the global desktop space, top-left origin,
/// logical units — i.e. straight out of `displays()`.
#[tauri::command]
fn open_overlay(app: AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("overlay") {
        win.set_position(LogicalPosition::new(x, y)).map_err(e)?;
        win.set_size(LogicalSize::new(w, h)).map_err(e)?;
        win.show().map_err(e)?;
        raise_over_everything(&win);
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("Ghost Pointer overlay")
        .position(x, y)
        .inner_size(w, h)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .focused(false)
        .accept_first_mouse(false)
        .build()
        .map_err(e)?;

    // The whole promise of this window: the pointer goes straight through it. Without this the
    // guest's desktop becomes unclickable, which is the single worst bug this app could ship.
    win.set_ignore_cursor_events(true).map_err(e)?;
    raise_over_everything(&win);
    Ok(())
}

#[tauri::command]
fn close_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("overlay") {
        win.close().map_err(e)?;
    }
    Ok(())
}

/// The host's aim-rect picker: a translucent sheet over one display that *does* take clicks.
///
/// Always rebuilt rather than reused. The picker needs the display origin and the guest's
/// aspect ratio, and it gets them as query params — a reused window would still be carrying
/// the previous room's numbers, and a stale aspect ratio silently produces a stretched ghost.
#[tauri::command]
fn open_aim(app: AppHandle, x: f64, y: f64, w: f64, h: f64, ratio: f64) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("aim") {
        win.close().map_err(e)?;
    }
    let url = format!("aim.html?ox={x}&oy={y}&ar={ratio}");
    let win = WebviewWindowBuilder::new(&app, "aim", WebviewUrl::App(url.into()))
        .title("Set the aim area")
        .position(x, y)
        .inner_size(w, h)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .build()
        .map_err(e)?;
    raise_over_everything(&win);
    win.set_focus().map_err(e)?;
    Ok(())
}

#[tauri::command]
fn close_aim(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("aim") {
        win.close().map_err(e)?;
    }
    Ok(())
}

/// Hand the aim rect back to the control window and dismiss the picker.
///
/// It goes via Rust rather than window-to-window because the picker lives on a different
/// webview and `emit` from the backend is the one channel both are guaranteed to see.
#[tauri::command]
fn commit_aim(app: AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    app.emit("aim-set", serde_json::json!({ "x": x, "y": y, "w": w, "h": h })).map_err(e)?;
    close_aim(app)
}

#[tauri::command]
fn cancel_aim(app: AppHandle) -> Result<(), String> {
    app.emit("aim-cancelled", ()).map_err(e)?;
    close_aim(app)
}

/// Forward a pointer position to the overlay.
///
/// The control window owns the socket, the overlay owns the drawing, and they are separate
/// webviews — so every sample the overlay draws arrives through here.
#[tauri::command]
fn draw(app: AppHandle, payload: serde_json::Value) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.emit("ghost", payload);
    }
}

// ---------------------------------------------------------------------------------------------
// Hotkey
// ---------------------------------------------------------------------------------------------

/// Register the arm/disarm hotkey, replacing whatever was registered before.
///
/// M0: `RegisterEventHotKey` — which is what this plugin uses — fires with no TCC grant at all,
/// so this costs the user no permission dialog.
#[tauri::command]
fn set_hotkey(app: AppHandle, accelerator: String) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let shortcut: Shortcut = accelerator.parse().map_err(|_| {
        format!("'{accelerator}' is not a shortcut this platform can register")
    })?;
    gs.register(shortcut).map_err(e)
}

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

// ---------------------------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // Fire on press only. A key that toggles on both edges toggles twice.
                    if event.state == ShortcutState::Pressed {
                        let _ = app.emit("hotkey", ());
                    }
                })
                .build(),
        )
        .manage(Stream::default())
        .invoke_handler(tauri::generate_handler![
            cursor_position,
            modifiers,
            displays,
            start_cursor_stream,
            stop_cursor_stream,
            open_overlay,
            close_overlay,
            open_aim,
            close_aim,
            commit_aim,
            cancel_aim,
            draw,
            set_hotkey,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
