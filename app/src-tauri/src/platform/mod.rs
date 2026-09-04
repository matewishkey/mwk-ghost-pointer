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

// Which modifier counts as "armed" is deliberately NOT decided here. The app offers both
// tap-to-arm and hold-to-point, and that is a feel question the UI owns — the platform layer's
// job is only to report, honestly and cheaply, what is held right now.

/// A running count of mouse clicks, as reported by the OS.
///
/// **Counts, not state — and the difference is a bug I shipped and had to take back.** The
/// obvious design is to poll whether the button is down and watch for a rising edge. The M3
/// spike measured what that actually does: three instantaneous clicks, and a 60 Hz poll saw
/// *none* of them, because a click that begins and ends between two ticks was never down when
/// anyone looked. A counter cannot miss one — the click still happened, so the number still
/// moved.
///
/// These are monotonic and system-wide, so only the delta between two reads means anything, and
/// the first read of a session is a baseline rather than a delta. Treating the absolute value as
/// a count of clicks would fire thousands of pulses at once.
///
/// Permission-free, measured in a clean room holding zero TCC grants — see
/// `app/m0-findings.md` § Addendum.
///
/// **Reading a click is not owning it.** It still reaches whatever is under the cursor. That is
/// fine for a pulse, because while pointing the thing under the cursor is a video of someone
/// else's screen. It is not fine for drag-to-draw, which is why ink is bound to a held modifier.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
pub struct Clicks {
    pub left: u32,
    pub right: u32,
}

/// Whether the mouse's two side buttons are held right now.
///
/// **State, not counters** — the opposite of `Clicks`, and deliberately so. Counters exist
/// because a fast click can finish inside one 16 ms tick and a state poll would miss it. These
/// are not clicks: they are a held gesture, pressed with a modifier the way a hotkey is, and
/// "is it down" is exactly the question. Same `CGEventSource` family as the modifier flags, so
/// the same permission answer applies (`m0-findings.md`).
///
/// `b4` and `b5` are what a mouse labels buttons 4 and 5 — usually back and forward. Plenty of
/// mice have neither, which is why this can only ever be an *alternative* binding to a key.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SideButtons {
    pub b4: bool,
    pub b5: bool,
}

/// Everything the app needs from the operating system.
///
/// **Not every method is needed by every role.** The guest only ever calls `displays()`; the
/// cursor, modifiers and clicks are read solely by the pointing side. That is what makes a
/// viewer-only build on a platform possible long before a complete one — see `windows.rs`.
pub trait Platform {
    /// Global cursor position, top-left origin, logical units. `None` if it cannot be read.
    fn cursor_position() -> Option<Point>;

    /// Modifier keys held right now.
    fn modifiers() -> Modifiers;

    /// Running count of mouse clicks. See `Clicks` — deltas only, never the absolute value.
    fn clicks() -> Clicks;

    /// Whether the side buttons are held. See `SideButtons` for why this one is state.
    fn side_buttons() -> SideButtons;

    /// All active displays. First entry is not guaranteed to be primary — check `is_primary`.
    ///
    /// Takes the app handle because Windows answers this from Tauri's own monitor list rather
    /// than from Win32 directly. The trait widened rather than the app forking — which is the
    /// rule this module exists to enforce. macOS ignores it.
    fn displays(app: &tauri::AppHandle) -> Vec<Display>;
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::Impl;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::Impl;
