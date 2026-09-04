//! Windows implementation — **viewer only**, and deliberately so.
//!
//! The trait splits cleanly by role: the guest calls `displays()` and nothing else, while the
//! cursor, modifiers and clicks are read only by the pointing side. So a Windows machine can
//! receive a ghost today, on one implemented function, long before it can send one.
//!
//! **Parts of this have now run on real Windows hardware** (1 Sep) — click-through and cursor
//! visibility were tested there, and that box has rustup and MSVC Build Tools. See
//! `../../../CLAUDE.md` § Windows before touching the overlay path. What follows
//! is written to be as boring as possible: no Win32, no unsafe, no new dependency. `displays()`
//! goes through Tauri's own monitor list, which is code that is already tested by everyone else
//! using Tauri, rather than through `EnumDisplayMonitors` written blind by someone who cannot
//! run it. Being clever here would only add ways to be wrong.
//!
//! ## When someone picks up the sending side
//!
//! - `cursor_position` -> `GetCursorPos`. Already top-left origin, so no flip. Call
//!   `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` at startup or the coordinates come
//!   back scaled and the ghost lands wrong on any non-100% display.
//! - `modifiers` -> `GetAsyncKeyState(VK_MENU / VK_CONTROL / VK_SHIFT / VK_LWIN)`. A poll, same
//!   as macOS, which is why the trait is shaped as a poll rather than a callback.
//! - `clicks` has no direct equivalent and needs thought, not a translation.
//!   `GetAsyncKeyState(VK_LBUTTON)` is *state*, and macOS proved state-polling silently drops
//!   any click shorter than one tick (`app/m0-findings.md` § Addendum 2). A low-level
//!   `WH_MOUSE_LL` hook counts them properly and needs no permission on Windows — reach for
//!   that, not for the polling shape.
//!
//! The overlay is the other half, and it is Tauri's job: `transparent` plus
//! `set_ignore_cursor_events` map onto `WS_EX_LAYERED | WS_EX_TRANSPARENT` and topmost.
//! `raise_over_everything` in `lib.rs` is a no-op here — Windows has no menu bar to sit above.

use super::{Clicks, Display, Modifiers, Platform, Point, SideButtons};
use tauri::Manager;

pub struct Impl;

impl Platform for Impl {
    /// Never reached on the viewer path. Returns `None` rather than panicking: a Windows build
    /// is guest-only, and the UI disables the pointing side — but a crash would be a terrible
    /// way to discover that guard had a hole in it.
    fn cursor_position() -> Option<Point> {
        None
    }

    /// See `cursor_position` — sending is not implemented on Windows yet.
    fn modifiers() -> Modifiers {
        Modifiers::default()
    }

    /// See `cursor_position`. Note that returning a constant is *safe* here in a way it would
    /// not be for a real implementation: the app reads deltas, and a counter that never moves
    /// simply never fires a pulse.
    fn clicks() -> Clicks {
        Clicks::default()
    }

    fn side_buttons() -> SideButtons {
        SideButtons::default()
    }

    fn displays(app: &tauri::AppHandle) -> Vec<Display> {
        let Ok(monitors) = app.available_monitors() else {
            return Vec::new();
        };
        let primary = app.primary_monitor().ok().flatten();

        monitors
            .into_iter()
            .enumerate()
            .map(|(i, m)| {
                // Tauri reports monitors in PHYSICAL pixels; everything above this module speaks
                // logical units. Dividing here is the whole conversion — get it wrong and the
                // ghost lands at half or double position on any scaled display, which is the
                // default on most Windows laptops.
                let scale = m.scale_factor();
                let pos = m.position();
                let size = m.size();

                // Windows names monitors things like `\\.\DISPLAY1`, which is not something you
                // can say out loud to a guest. Anything that looks like a device path gets a
                // human number instead.
                let raw = m.name().map(String::as_str).unwrap_or("");
                let label = if raw.is_empty() || raw.starts_with(r"\\") {
                    format!("Display {}", i + 1)
                } else {
                    raw.to_string()
                };

                Display {
                    id: format!("{},{}", pos.x, pos.y), // stable while the arrangement is
                    label,
                    x: f64::from(pos.x) / scale,
                    y: f64::from(pos.y) / scale,
                    w: f64::from(size.width) / scale,
                    h: f64::from(size.height) / scale,
                    scale,
                    is_primary: primary
                        .as_ref()
                        .is_some_and(|p| p.position() == pos && p.size() == size),
                }
            })
            .collect()
    }
}
