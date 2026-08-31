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
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use std::collections::HashMap;

// core-graphics 0.24 exposes only `new`/`type_id` on CGEventSource, so the modifier-state call
// is declared here directly. It is a plain C function taking the state id — not a method on a
// source — which is why there is nothing to wrap.
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceFlagsState(state_id: u32) -> u64;
}

/// Real monitor name and backing scale for each display, keyed by `CGDirectDisplayID`.
///
/// Two things CoreGraphics alone will not tell you, and both matter to a human:
///
/// * **The name.** `CGDisplay` has none, so the picker used to say "Display at -2560,0", which
///   is not something you can say out loud to a guest. AppKit knows them, and it even
///   disambiguates two identical monitors as "Studio Display (1)" and "(2)".
/// * **The scale.** `pixels_wide / bounds.width` looks like it derives it, and on a *scaled*
///   Retina mode it silently returns 1.0 — measured on a Studio Display running 2560x1440,
///   where CoreGraphics reports 2560 device pixels and AppKit reports a backing scale of 2.
///   Deriving it was simply wrong; ask for it.
///
/// **Main thread only.** AppKit is, and `displays()` is reached from a Tauri command, which
/// does not run there — see the marshalling in `lib.rs`.
fn appkit_screens() -> HashMap<u32, (String, f64)> {
    let mut map = HashMap::new();
    unsafe {
        let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
        if screens.is_null() {
            return map;
        }
        let key: *mut AnyObject =
            msg_send![class!(NSString), stringWithUTF8String: c"NSScreenNumber".as_ptr()];
        let count: usize = msg_send![screens, count];
        for i in 0..count {
            let screen: *mut AnyObject = msg_send![screens, objectAtIndex: i];
            if screen.is_null() {
                continue;
            }
            let desc: *mut AnyObject = msg_send![screen, deviceDescription];
            if desc.is_null() {
                continue;
            }
            let number: *mut AnyObject = msg_send![desc, objectForKey: key];
            if number.is_null() {
                continue;
            }
            let id: u32 = msg_send![number, unsignedIntValue];
            let scale: f64 = msg_send![screen, backingScaleFactor];

            let name_obj: *mut AnyObject = msg_send![screen, localizedName];
            let name = if name_obj.is_null() {
                String::new()
            } else {
                let utf8: *const std::os::raw::c_char = msg_send![name_obj, UTF8String];
                if utf8.is_null() {
                    String::new()
                } else {
                    std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()
                }
            };
            map.insert(id, (name, scale));
        }
    }
    map
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
        // Bounds and ids from CoreGraphics — it is the one that reports a top-left origin, which
        // is the convention the whole app runs on. Names and scale from AppKit, which is the only
        // one that knows them. Joined on the display id, which both agree on.
        let named = appkit_screens();
        ids.into_iter()
            .map(|id| {
                let d = CGDisplay::new(id);
                let b = d.bounds(); // already top-left origin, in points
                let (name, scale) = named.get(&id).cloned().unwrap_or_default();
                let label = if !name.is_empty() {
                    name
                } else if d.is_main() {
                    // Only reached if AppKit did not list this display at all.
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
                    scale: if scale > 0.0 { scale } else { 1.0 },
                    is_primary: d.is_main(),
                }
            })
            .collect()
    }
}
