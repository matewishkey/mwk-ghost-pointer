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
//! - `displays` -> `EnumDisplayMonitors` + `GetMonitorInfoW`, with `GetDpiForMonitor` for scale.
//!
//! The overlay is the other half: `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW` plus
//! topmost, which is the Windows equivalent of the click-through `NSWindow` M0 proved.

use super::{Display, Modifiers, Platform, Point};

pub struct Impl;

impl Platform for Impl {
    fn cursor_position() -> Option<Point> {
        unimplemented!("Windows: GetCursorPos — see module docs")
    }

    fn modifiers() -> Modifiers {
        unimplemented!("Windows: GetAsyncKeyState — see module docs")
    }

    fn displays() -> Vec<Display> {
        unimplemented!("Windows: EnumDisplayMonitors — see module docs")
    }
}
