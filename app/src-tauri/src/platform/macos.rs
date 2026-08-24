//! macOS implementation. Everything here was measured in M0 — see `app/m0-findings.md`.
//!
//! **None of this needs a permission.** No Accessibility, no Input Monitoring, no dialog. That
//! was verified in a clean room (an app holding zero TCC grants), not assumed. Keep it that way:
//! the moment anything here reaches for a `CGEvent` tap, the app starts demanding Input
//! Monitoring and the "nothing scary to install" pitch is gone.

use super::{Display, Modifiers, Platform, Point};
use core_graphics::display::CGDisplay;
use core_graphics::event::{CGEvent, CGEventFlags};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

// core-graphics 0.24 exposes only `new`/`type_id` on CGEventSource, so the modifier-state call
// is declared here directly. It is a plain C function taking the state id — not a method on a
// source — which is why there is nothing to wrap.
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceFlagsState(state_id: u32) -> u64;
}

pub struct Impl;

impl Platform for Impl {
    fn cursor_position() -> Option<Point> {
        // A CGEvent created with a null source carries the current cursor location, already in
        // TOP-LEFT origin points — which is exactly the convention this app uses everywhere, so
        // no flip is needed. NSEvent.mouseLocation would need one (it is bottom-left).
        let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
        let event = CGEvent::new(source).ok()?;
        let p = event.location();
        Some(Point { x: p.x, y: p.y })
    }

    fn modifiers() -> Modifiers {
        // Snapshot of the hardware modifier state. Permission-free (M0: 10/10 events observed
        // by an app with no TCC grants at all).
        let bits = unsafe { CGEventSourceFlagsState(CGEventSourceStateID::CombinedSessionState as u32) };
        let f = CGEventFlags::from_bits_truncate(bits);
        Modifiers {
            alt: f.contains(CGEventFlags::CGEventFlagAlternate),
            ctrl: f.contains(CGEventFlags::CGEventFlagControl),
            shift: f.contains(CGEventFlags::CGEventFlagShift),
            meta: f.contains(CGEventFlags::CGEventFlagCommand),
        }
    }

    fn displays() -> Vec<Display> {
        let Ok(ids) = CGDisplay::active_displays() else {
            return Vec::new();
        };
        ids.into_iter()
            .map(|id| {
                let d = CGDisplay::new(id);
                let b = d.bounds(); // already top-left origin, in points
                // CGDisplay has no localized name without pulling in IOKit, so displays are
                // labelled by position for now. The viewer's picker shows this; if it turns out
                // people cannot tell two identical monitors apart, that is when it earns IOKit.
                let label = if d.is_main() {
                    "Main display".to_string()
                } else {
                    format!("Display at {},{}", b.origin.x as i64, b.origin.y as i64)
                };
                Display {
                    id: id.to_string(),
                    label,
                    x: b.origin.x,
                    y: b.origin.y,
                    w: b.size.width,
                    h: b.size.height,
                    // points -> device pixels. 2.0 on Retina.
                    scale: if b.size.width > 0.0 {
                        d.pixels_wide() as f64 / b.size.width
                    } else {
                        1.0
                    },
                    is_primary: d.is_main(),
                }
            })
            .collect()
    }
}
