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

use platform::{Clicks, Display, Modifiers, Platform, Point};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl,
            WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// One tick of the sender's poll loop: where the cursor is, and what is held.
///
/// Clicks ride the same tick as the position deliberately. A click arriving on its own clock
/// could be reported against a stale cursor position, and a pulse drawn a few pixels away from
/// where it was clicked is worse than no pulse at all.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
struct Sample {
    x: f64,
    y: f64,
    #[serde(flatten)]
    mods: Modifiers,
    /// Nested rather than flattened: `Clicks` and `Modifiers` would otherwise both want to be
    /// merged into the same object, and `left` means very different things in each.
    clicks: Clicks,
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

/// Running click counts. See `platform::Clicks` — deltas only, never the absolute value.
#[tauri::command]
fn clicks() -> Clicks {
    platform::Impl::clicks()
}

/// Which build this is. The app ships as an unsigned `.dmg` that people re-download by hand, so
/// "which one am I running?" is otherwise unanswerable — and the first question asked of any bug
/// report.
#[tauri::command]
fn build_info() -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "commit": env!("GP_COMMIT"),
        "built": env!("GP_BUILT"),
        // The UI needs this to hide the pointing side on platforms that cannot send yet.
        "os": std::env::consts::OS,
    })
}

/// Every active display, for the viewer's picker and the `geo` message.
///
/// Marshalled onto the main thread because the macOS implementation asks AppKit for the monitor
/// names, and AppKit's screen list is main-thread-only. Tauri dispatches sync commands onto a
/// worker, so blocking on the main thread from here is safe — the reverse would deadlock, so
/// nothing already running on the main thread may call this.
#[tauri::command]
fn displays(app: AppHandle) -> Vec<Display> {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    if app
        .run_on_main_thread(move || {
            let _ = tx.send(platform::Impl::displays(&handle));
        })
        .is_err()
    {
        return Vec::new();
    }
    // A display list that never arrives must not wedge the UI thread that asked for it.
    rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default()
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
                let s = Sample {
                    x: p.x,
                    y: p.y,
                    mods: platform::Impl::modifiers(),
                    clicks: platform::Impl::clicks(),
                };
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

/// Make the overlay click-through, and **prove it** rather than assume it.
///
/// This is the single most dangerous thing in the app. An overlay that covers a display and
/// does not pass clicks makes the machine unusable, and on 31 Aug it did exactly that on
/// Windows — the call below returned, the window stayed up, and the error never reached the UI.
///
/// On Windows the ex-style is read back, because "the setter returned Ok" and "the window is
/// actually transparent to the mouse" turned out to be different claims.
fn arm_click_through(win: &WebviewWindow) -> Result<(), String> {
    win.set_ignore_cursor_events(true).map_err(e)?;

    #[cfg(target_os = "windows")]
    {
        // GWL_EXSTYLE. WS_EX_LAYERED is what makes a window composited; WS_EX_TRANSPARENT is
        // what makes it invisible to hit-testing. Both are required, and both are observable —
        // so observe them instead of hoping.
        extern "system" {
            fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
        }
        const GWL_EXSTYLE: i32 = -20;
        const WS_EX_LAYERED: isize = 0x0008_0000;
        const WS_EX_TRANSPARENT: isize = 0x0000_0020;

        let hwnd = win.hwnd().map_err(e)?;
        let style = unsafe { GetWindowLongPtrW(hwnd.0 as isize, GWL_EXSTYLE) };
        let layered = style & WS_EX_LAYERED != 0;
        let transparent = style & WS_EX_TRANSPARENT != 0;
        if !(layered && transparent) {
            let msg = format!(
                "overlay would not be click-through (ex-style 0x{style:X}: layered={layered}, transparent={transparent})"
            );
            log::error!("{msg}");
            return Err(msg);
        }
        log::info!("overlay armed click-through (ex-style 0x{style:X})");
    }
    Ok(())
}

/// Create or reposition the transparent click-through overlay covering one display.
///
/// `x`/`y`/`w`/`h` are that display's rect in the global desktop space, top-left origin,
/// logical units — i.e. straight out of `displays()`.
///
/// **The window is never visible before it is click-through.** It is built hidden, armed,
/// checked, and only then shown; if arming fails the window is destroyed rather than left on
/// screen. That ordering is the whole lesson of the Windows lock-up — the previous version
/// created the window visible and armed it afterwards, so a failure left a full-screen
/// click-eating sheet with no way to remove it but Task Manager.
#[tauri::command]
fn open_overlay(app: AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    log::info!("open_overlay: {w}x{h} at ({x},{y})");
    if let Some(win) = app.get_webview_window("overlay") {
        win.set_position(LogicalPosition::new(x, y)).map_err(e)?;
        win.set_size(LogicalSize::new(w, h)).map_err(e)?;
        // Re-armed on every move. Nothing guarantees an ex-style survives a resize, and an
        // overlay that has quietly stopped being click-through looks identical to one that has
        // not — until someone tries to click.
        if let Err(why) = arm_click_through(&win) {
            let _ = win.close();
            return Err(why);
        }
        win.show().map_err(e)?;
        raise_over_everything(&win);
        log::info!("open_overlay: repositioned and shown");
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
        // Hidden until proven harmless.
        .visible(false)
        .build()
        .map_err(e)?;

    if let Err(why) = arm_click_through(&win) {
        // Destroy it. A window that cannot pass clicks must not exist, let alone be shown.
        let _ = win.close();
        return Err(why);
    }
    win.show().map_err(e)?;
    raise_over_everything(&win);
    log::info!("open_overlay: created and shown");
    Ok(())
}

#[tauri::command]
fn close_overlay(app: AppHandle) -> Result<(), String> {
    log::info!("close_overlay");
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

/// Fire a click pulse on the overlay: a ring that expands and fades where the click landed.
///
/// Separate from `draw` because a pulse is an *event*, not a state. The ghost has one position
/// that keeps being overwritten; pulses accumulate and each lives out its own short life.
#[tauri::command]
fn pulse(app: AppHandle, payload: serde_json::Value) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.emit("pulse", payload);
    }
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

/// A bug report's first ten minutes, already assembled.
///
/// The overlay is the one thing in this app that can fail invisibly — see `arm_click_through` —
/// which is exactly what happened on 31 Aug with nothing to show for it afterwards. This turns
/// "it didn't work" into a build number plus a log tail, copyable in one click.
#[tauri::command]
fn diagnostics(app: AppHandle) -> String {
    let info = build_info();
    let field = |k: &str| info[k].as_str().unwrap_or("?").to_string();

    let log_tail = app
        .path()
        .app_log_dir()
        .ok()
        .and_then(|dir| std::fs::read_dir(dir).ok())
        .and_then(|entries| {
            // Only one thing writes to this directory, so the most recently modified file in it
            // is the current log — no need to guess the plugin's exact naming scheme.
            entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_file())
                .max_by_key(|e| e.metadata().ok().and_then(|m| m.modified().ok()))
        })
        .and_then(|entry| std::fs::read_to_string(entry.path()).ok())
        .map(|s| {
            let lines: Vec<&str> = s.lines().collect();
            lines[lines.len().saturating_sub(200)..].join("\n")
        })
        .unwrap_or_else(|| "(no log file found)".to_string());

    format!(
        "Ghost Pointer v{} · {} · built {} · {}\n\n--- log tail ---\n{}",
        field("version"), field("commit"), field("built"), field("os"), log_tail
    )
}

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

// ---------------------------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            // There were no logs anywhere for the 31 Aug lock-up, which is why it produced no
            // evidence. Stdout for a dev run, a file for everyone else's bug report.
            tauri_plugin_log::Builder::new()
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout))
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                    file_name: Some("ghost-pointer".into()),
                }))
                .level(log::LevelFilter::Info)
                .build(),
        )
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
            clicks,
            build_info,
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
            pulse,
            set_hotkey,
            diagnostics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
