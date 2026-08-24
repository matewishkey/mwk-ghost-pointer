//! The one place a platform difference is allowed to exist.
//!
//! macOS fills this in first and, in doing so, defines the contract Windows implements later.
//! If Windows needs something this cannot express, WIDEN THE TRAIT — do not fork the app.
//!
//! Two conventions the whole app depends on, both chosen because they are the only ones that
//! survive crossing a platform boundary:
//!
//! 1. **Coordinates are TOP-LEFT origin**, always, on every platform. macOS is the odd one out
//!    here — `NSEvent.mouseLocation` is bottom-left — so `macos.rs` converts once, at the edge,
//!    and nothing above this module ever thinks about it. (M0 measured both origins returning
//!    the same cursor as y=1392.1 and y=47.9. That is the bug this convention prevents.)
//! 2. **Coordinates are LOGICAL units, not device pixels** — points on macOS, logical pixels on
//!    Windows. `Display::scale` carries the multiplier for anyone who needs real pixels.

use serde::Serialize;

/// A point in the global desktop coordinate space, top-left origin, logical units.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// One display, for the viewer's picker and the `geo` message.
#[derive(Debug, Clone, Serialize)]
pub struct Display {
    /// Stable enough to remember a choice across a session.
    pub id: String,
    pub label: String,
    /// Position of this display in the global desktop space, top-left origin, logical units.
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Logical -> device pixel multiplier. 2.0 on a Retina display.
    pub scale: f64,
    pub is_primary: bool,
}

/// Which modifier keys are held *right now*.
///
/// Deliberately a poll, not an event stream or a callback. M0 measured the difference and it is
/// not cosmetic: polling modifier state needs no permission on macOS, while a `CGEvent` tap
/// needs Input Monitoring — and worse, `tapCreate` returns non-nil without the grant and then
/// silently delivers nothing. Polling has no such failure mode, and it costs one read per frame
/// in a loop that is already running.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
pub struct Modifiers {
    pub alt: bool,
    pub ctrl: bool,
    pub shift: bool,
    /// Command on macOS, Windows key on Windows.
    pub meta: bool,
}

impl Modifiers {
    /// The arm gesture. Hold-to-point: the ghost is visible exactly while this is true.
    pub fn is_arm_held(&self) -> bool {
        self.alt
    }
}

/// Everything the app needs from the operating system.
pub trait Platform {
    /// Global cursor position, top-left origin, logical units. `None` if it cannot be read.
    fn cursor_position() -> Option<Point>;

    /// Modifier keys held right now.
    fn modifiers() -> Modifiers;

    /// All active displays. First entry is not guaranteed to be primary — check `is_primary`.
    fn displays() -> Vec<Display>;
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::Impl;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::Impl;
