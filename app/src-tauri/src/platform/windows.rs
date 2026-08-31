//! Windows implementation — NOT WRITTEN YET. macOS is first (see `../../../CLAUDE.md`).
//!
//! This file exists so the shape is obvious when someone picks Windows up, and so the trait is
//! never quietly macOS-only. Research says none of it needs a permission either:
//!
//! - `cursor_position` -> `GetCursorPos`. Already top-left origin, so no flip. Call
//!   `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` at startup or the coordinates come
//!   back scaled and the ghost lands wrong on any non-100% display.
//! - `modifiers` -> `GetAsyncKeyState(VK_MENU / VK_CONTROL / VK_SHIFT / VK_LWIN)`. A poll, same
//!   as macOS, which is why the trait is shaped as a poll rather than a callback.
//! - `clicks` has no direct Windows equivalent and needs thought, not a translation.
//!   `GetAsyncKeyState(VK_LBUTTON)` is *state*, and macOS proved state-polling silently drops
//!   clicks shorter than a tick. A low-level `WH_MOUSE_LL` hook counts them properly and needs
//!   no permission on Windows — that is the shape to reach for, not the polling one.
//! - `displays` -> `EnumDisplayMonitors` + `GetMonitorInfoW`, with `GetDpiForMonitor` for scale.
//!
//! The overlay is the other half: `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW` plus
//! topmost, which is the Windows equivalent of the click-through `NSWindow` M0 proved.

use super::{Clicks, Display, Modifiers, Platform, Point};

pub struct Impl;

impl Platform for Impl {
    fn cursor_position() -> Option<Point> {
        unimplemented!("Windows: GetCursorPos — see module docs")
    }

    fn modifiers() -> Modifiers {
        unimplemented!("Windows: GetAsyncKeyState — see module docs")
    }

    fn clicks() -> Clicks {
        unimplemented!("Windows: count via WH_MOUSE_LL, do not poll state — see module docs")
    }

    fn displays() -> Vec<Display> {
        unimplemented!("Windows: EnumDisplayMonitors — see module docs")
    }
}
