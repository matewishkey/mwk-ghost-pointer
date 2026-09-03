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
        fix_composition_mode_cursor(hwnd.0 as isize);
    }
    Ok(())
}

/// `transparent(true)` puts WebView2 into "composition mode" on Windows, and composition mode
/// does not apply cursor updates on its own — Microsoft's own docs say the host application must
/// set the cursor itself, "through ::SetCursor or set on the corresponding parent/ancestor HWND
/// ... through ::SetClassLongPtr". wry does not appear to do this for transparent windows, which
/// is why `GetCursorInfo` (see `cursor_visible`) reports the cursor as showing — nothing is
/// hiding it — while nothing is visible — nobody is asserting it either. True on a real
/// machine's own physical console, not just over Remote Desktop, so this was never an RDP
/// artifact. Setting the window class's default cursor is the documented fix and does not need a
/// custom `WM_SETCURSOR` handler. Applies to every `transparent(true)` window, not just the
/// click-through overlay — the aim picker uses composition mode too.
#[cfg(target_os = "windows")]
fn fix_composition_mode_cursor(hwnd: isize) {
    extern "system" {
        fn LoadCursorW(hinstance: isize, cursor_name: isize) -> isize;
        fn SetClassLongPtrW(hwnd: isize, index: i32, new_long: isize) -> isize;
    }
    const IDC_ARROW: isize = 32512;
    const GCLP_HCURSOR: i32 = -12;

    let arrow = unsafe { LoadCursorW(0, IDC_ARROW) };
    if arrow != 0 {
        unsafe { SetClassLongPtrW(hwnd, GCLP_HCURSOR, arrow) };
    } else {
        log::warn!("fix_composition_mode_cursor: LoadCursorW(IDC_ARROW) failed");
    }
}

/// Ask the OS whether the system cursor is currently showing — objective, not "look at your
/// screen and tell me". `None` off Windows, where nothing has ever shown this failure mode.
///
/// Exists because click-through and cursor visibility turned out to be two different claims,
/// same as the ex-style readback above: a real Windows machine (1 Sep 2026) passed clicks
/// through to the desktop correctly while `GetCursorInfo` would have shown the cursor hidden the
/// whole time — `overlay.html`'s `cursor: none` was the cause, since fixed, but this is what
/// would have caught it without eyes on the screen, and what proves the fix instead of assuming
/// it.
#[cfg(target_os = "windows")]
#[tauri::command]
fn cursor_visible() -> Option<bool> {
    #[repr(C)]
    struct CursorInfo {
        cb_size: u32,
        flags: u32,
        h_cursor: isize,
        pt_x: i32,
        pt_y: i32,
    }
    extern "system" {
        fn GetCursorInfo(info: *mut CursorInfo) -> i32;
    }
    const CURSOR_SHOWING: u32 = 0x0000_0001;

    let mut info = CursorInfo { cb_size: std::mem::size_of::<CursorInfo>() as u32, flags: 0, h_cursor: 0, pt_x: 0, pt_y: 0 };
    if unsafe { GetCursorInfo(&mut info) } == 0 {
        log::warn!("cursor_visible: GetCursorInfo failed");
        return None;
    }
    let showing = info.flags & CURSOR_SHOWING != 0;
    log::info!("cursor_visible: {showing} (flags=0x{:X}, hCursor=0x{:X})", info.flags, info.h_cursor);
    Some(showing)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn cursor_visible() -> Option<bool> {
    None
}

/// Reposition, re-arm and show the overlay window that `create_overlay_window` already built.
///
/// `x`/`y`/`w`/`h` are that display's rect in the global desktop space, top-left origin,
/// logical units — i.e. straight out of `displays()`.
///
/// Dispatched explicitly onto the main thread — **not** because these particular calls
/// (`set_position`/`set_size`/`arm_click_through`/`show`) are known to need it the way AppKit
/// calls in `displays()` do. They were never the thing that hung; `.build()` was, and `.build()`
/// no longer happens here. This is kept as defense-in-depth precisely *because* the original
/// bug was never fully explained beyond "creating a second webview from a live command" — if
/// that turns out to generalize to these simpler window methods too under some condition not
/// yet hit, a bounded 5s timeout beats an unbounded hang. Untested without it; remove only after
/// deliberately trying that on real hardware, not by inference from this comment.
#[tauri::command]
fn open_overlay(app: AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    if app
        .run_on_main_thread(move || {
            let _ = tx.send(open_overlay_on_main_thread(&handle, x, y, w, h));
        })
        .is_err()
    {
        return Err("open_overlay: could not dispatch to the main thread".into());
    }
    rx.recv_timeout(Duration::from_secs(5)).unwrap_or_else(|_| {
        Err("open_overlay: main thread did not respond within 5s".into())
    })
}

fn open_overlay_on_main_thread(
    app: &AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    log::info!("open_overlay: {w}x{h} at ({x},{y})");
    // The window always exists by the time any command can run — `create_overlay_window` builds
    // it, hidden, during `.setup()`. This command only ever repositions, arms and shows it.
    //
    // That split exists because building a *second* WebviewWindow from inside a command that was
    // itself invoked over the real frontend IPC path hung outright on a real Windows machine over
    // Remote Desktop (1 Sep 2026) — reproduced cleanly, independent of transparency, of every
    // other window option, and of which explicit-dispatch shape called `.build()`. Every fix
    // aimed at the overlay's own configuration was chasing the wrong layer; the actual trigger is
    // creating a *new* webview from a live command handler, at all, in this environment. Since
    // that trigger is avoidable — nothing requires the window to be built lazily — building it
    // once at startup, before any IPC has happened, sidesteps the bug entirely rather than
    // depending on ever fully explaining it.
    let Some(win) = app.get_webview_window("overlay") else {
        return Err("open_overlay: the overlay window was never created at startup".into());
    };
    win.set_position(LogicalPosition::new(x, y)).map_err(e)?;
    win.set_size(LogicalSize::new(w, h)).map_err(e)?;
    // Re-armed on every move. Nothing guarantees an ex-style survives a resize, and an overlay
    // that has quietly stopped being click-through looks identical to one that has not — until
    // someone tries to click.
    log::info!("open_overlay: arming");
    if let Err(why) = arm_click_through(&win) {
        let _ = win.hide();
        return Err(why);
    }
    log::info!("open_overlay: armed, showing");
    win.show().map_err(e)?;
    raise_over_everything(&win);
    log::info!("open_overlay: repositioned and shown");
    Ok(())
}

/// Build the overlay window once, hidden, before the app is doing anything else.
///
/// Called only from `.setup()` — see `open_overlay_on_main_thread` for why creating this window
/// from a live command is the thing to avoid, not creating it at all.
fn create_overlay_window(app: &AppHandle) -> Result<(), String> {
    let win = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("Ghost Pointer overlay")
        .inner_size(1.0, 1.0)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .focused(false)
        .accept_first_mouse(false)
        .visible(false)
        .build()
        .map_err(e)?;
    // Armed once up front too, so a `close_overlay` -> `open_overlay` cycle that skips resizing
    // (same display picked again) does not show an un-armed window even for one frame.
    arm_click_through(&win)
}

/// Hide, never destroy — the window is built once at startup (`create_overlay_window`) and
/// reused for the rest of the app's life, so there is no second `WebviewWindow::build()` left to
/// hang on.
#[tauri::command]
fn close_overlay(app: AppHandle) -> Result<(), String> {
    log::info!("close_overlay");
    if let Some(win) = app.get_webview_window("overlay") {
        win.hide().map_err(e)?;
    }
    Ok(())
}

/// Reposition, resize, hand over fresh params and show the aim picker `create_aim_window`
/// already built.
///
/// The display origin and the guest's aspect ratio used to be baked into the window's URL —
/// read once at page load, which needed a fresh window (and therefore a live `.build()`) every
/// time the picker opened. That is the exact shape of window-creation-from-a-live-command that
/// hung real Windows hardware for `open_overlay`; nothing about `open_aim` made it exempt, it
/// was just never reached on Windows because the host role is disabled there (`applyPlatformLimits`
/// in `main.ts`). Same fix: the window is built once, hidden, at startup, and the numbers that
/// used to be query params now go over as an `aim-params` event instead — see `aim.ts`.
#[tauri::command]
fn open_aim(app: AppHandle, x: f64, y: f64, w: f64, h: f64, ratio: f64) -> Result<(), String> {
    log::info!("open_aim: {w}x{h} at ({x},{y}), ratio {ratio}");
    let Some(win) = app.get_webview_window("aim") else {
        return Err("open_aim: the aim window was never created at startup".into());
    };
    win.set_position(LogicalPosition::new(x, y)).map_err(e)?;
    win.set_size(LogicalSize::new(w, h)).map_err(e)?;
    // Targeted at this window specifically, not app.emit's broadcast — the picker is the only
    // thing that should hear it, and a stale rect from the last session must not survive to
    // the next one (aim.ts resets its drag state on receipt).
    win.emit("aim-params", serde_json::json!({ "ox": x, "oy": y, "ar": ratio })).map_err(e)?;
    win.show().map_err(e)?;
    raise_over_everything(&win);
    win.set_focus().map_err(e)?;
    log::info!("open_aim: shown");
    Ok(())
}

/// Build the aim picker once, hidden, before the app is doing anything else — see
/// `create_overlay_window` for why creating this window from a live command is the thing to
/// avoid, not creating it at all.
fn create_aim_window(app: &AppHandle) -> Result<(), String> {
    #[allow(unused_variables)]
    let win = WebviewWindowBuilder::new(app, "aim", WebviewUrl::App("aim.html".into()))
        .title("Set the aim area")
        .inner_size(1.0, 1.0)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .visible(false)
        .build()
        .map_err(e)?;
    // `transparent(true)` here too — see `fix_composition_mode_cursor` for why that alone
    // leaves the cursor invisible without this.
    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = win.hwnd() {
        fix_composition_mode_cursor(hwnd.0 as isize);
    }
    Ok(())
}

/// Hide, never destroy — same reasoning as `close_overlay`.
#[tauri::command]
fn close_aim(app: AppHandle) -> Result<(), String> {
    log::info!("close_aim");
    if let Some(win) = app.get_webview_window("aim") {
        win.hide().map_err(e)?;
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

/// Forward a text mark, or a chunk of one still being typed, to the overlay.
///
/// The payload is passed through untouched. Nothing on this path may trim or re-encode the
/// string: text exists to hand over things to paste, and a mangled command is worse than none.
#[tauri::command]
fn text(app: AppHandle, payload: serde_json::Value) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.emit("text", payload);
    }
}

/// Drop every mark the overlay is holding.
#[tauri::command]
fn clear_marks(app: AppHandle) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.emit("clear-marks", ());
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
    // A command that panics drops its response channel without sending anything, so the
    // frontend's `invoke` just hangs forever instead of rejecting — and `main.rs` sets
    // `windows_subsystem = "windows"` in release, which means there is no console for the
    // default panic message to land on either. Route it to the same log a normal error would
    // use, so "it got stuck" leaves a stack trace instead of nothing.
    std::panic::set_hook(Box::new(|info| {
        log::error!("panic: {info}");
    }));

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
        .setup(|app| {
            // Built once, here, rather than lazily from `open_overlay`/`open_aim` — see
            // `create_overlay_window`'s doc comment for why. `.setup()` runs before the app is
            // handling any live IPC, which is the one difference that mattered.
            let handle = app.handle().clone();
            // Fatal for the overlay: every role's core function depends on it existing, and a
            // failure here would otherwise only surface much later as an opaque "never created
            // at startup" error from a command nobody would think to suspect.
            create_overlay_window(&handle).map_err(std::io::Error::other)?;
            // Not fatal for aim: the host role isn't reachable on Windows yet (`applyPlatformLimits`
            // in `main.ts`), so refusing to boot the whole app over a window nothing can use yet
            // would be a worse failure than logging it.
            if let Err(why) = create_aim_window(&handle) {
                log::error!("failed to pre-create the aim window at startup: {why}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // The overlay is now kept alive, hidden, for the app's whole life instead of being
            // destroyed on close_overlay (see create_overlay_window) — which means Tauri's
            // default "exit once every window is closed" never fires on its own, because the
            // hidden overlay still counts as an open window. Force it explicitly when the
            // control window specifically closes, or the process would linger in the background
            // forever after someone thinks they've quit.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                window.app_handle().exit(0);
            }
        })
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
            text,
            clear_marks,
            set_hotkey,
            diagnostics,
            cursor_visible,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
