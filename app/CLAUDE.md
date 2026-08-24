# app/ — the desktop app

Read `../CLAUDE.md` first: it has the decisions already made, the two-machine rules, and the
build order. `../docs/spec.md` is the wire protocol you must speak — it is owned by the relay
side, so treat it as read-only and file a GitHub issue if it needs to change.

## Your lane

You own `app/`. You do **not** touch `relay/`, `tools/` or `docs/spec.md`, and you never run
`wrangler deploy` — the relay is already live and deployed from the Linux box.

## One app, both OSes

This directory builds macOS **and** Windows. Do not add a `mac/` or `windows/` sibling.
Platform differences go behind `#[cfg(target_os = "…")]` inside `src-tauri/src/platform/`,
against a shared trait. You are writing the macOS implementation and, in doing so, defining
the trait that Windows will later implement. Keep the trait honest and minimal:

- `cursor_position() -> (f64, f64)` — global, screen coordinates
- `register_hotkey(...)` / arm-disarm signalling
- `overlay_window()` — transparent, always-on-top, click-through
- `displays() -> Vec<Display>` — for the viewer's display picker

## The relay is live — develop against it

    wss://ghost-pointer-relay.mergodon.workers.dev

No auth, no key, nothing to configure. Join a room with
`wss://…/r/<CODE>?role=point|view&name=<label>`, where `<CODE>` is 6 chars from
`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. Full message list in `../docs/spec.md`.

Sanity-check the relay any time with `node ../tools/probe.mjs wss://ghost-pointer-relay.mergodon.workers.dev`
— 13 checks, exits non-zero on failure. If those pass, the relay is fine and the bug is here.

## M0 is done — start at M1

The spike answered all three questions on 2026-08-24 (macOS 26.6.1, Apple silicon). Full
write-up in **`m0-findings.md`**; `../docs/research.md` has been corrected. Headline:

1. Transparent always-on-top click-through window drawing over other apps — **yes, no permission.**
   Covers the full display including under the menu bar.
2. Global cursor position — **yes, no permission.** `NSEvent.mouseLocation`, 60 Hz, exact.
3. Modifier-hold — **no permission needed, if you POLL.** `NSEvent.modifierFlags` 10/10; a
   `CGEvent` tap 0/10 and needs Input Monitoring. `RegisterEventHotKey` also fires with nothing
   granted, so Tauri's global-shortcut plugin is clear too.

**No permission dialogs appear on any path the app needs.** First-run onboarding has nothing
to ask for, on either side.

### What that changes

- **Poll, don't tap.** Cursor position and modifier state come from the same 60 Hz tick. Never
  reach for a `CGEvent` tap — and never treat a non-nil `tapCreate` as proof of permission, it
  returns non-nil and then delivers nothing.
- **Tap-to-arm vs hold-to-point is now a free choice**, not a permissions dodge. Decide on feel,
  and it stays mate's call.
- **Units.** macOS window/cursor APIs speak **points**, not device pixels, and `NSEvent` uses a
  bottom-left origin while `CGEvent` uses top-left. Get this wrong and the ghost lands in a
  mirrored position. Issue #5 proposes the `geo` message carry `backingScaleFactor`.

Then M1 (loopback on one machine), M2 (two machines, calibration + display picker), M3 (feel).

**First thing in M1**, because M0 could not close it: post a real click over the overlay and
confirm `ignoresMouseEvents` actually passes it through. M0's hit-test failed its own positive
control, so click-through is asserted, not proven.

## Known trap, do not solve yet

Tauri needs `macOSPrivateApi` for transparent webview windows, which means automatic Mac App
Store rejection. Fine for now — notarised distribution outside the store is unaffected. The
contained fix, for later, is a native `NSWindow` overlay via `objc2-app-kit` instead of a
webview, keeping the webview only for settings.
