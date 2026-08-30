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

## Where it got to — 2026-08-30

M0, M1 and the bulk of M2 are done. The app builds, runs, and has been driven end to end. What
exists:

- `src-tauri/src/lib.rs` — commands, the 60 Hz cursor poll loop, the three windows, the hotkey.
- `src-tauri/src/platform/` — the trait and the macOS implementation. Windows is still a stub.
- `src/protocol.ts` — the wire protocol, matching `../docs/spec.md`.
- `src/main.ts` / `src/overlay.ts` / `src/aim.ts` — control window, ghost renderer, aim picker.
- `../download/` — the public download page, built here and deployed from the Linux box.

Proven, not assumed: a scripted host → the live relay → this app as guest → a ghost on the real
desktop, 22-24 ms, drawn over other apps, and a click through the overlay still reached the app
underneath. Click-through is the one bug that would be unforgivable, so it gets re-checked after
any change to the overlay window.

**Still open:** reconnect after a drop, a tray icon, hotkey conflict detection beyond "it failed
to register", Windows, and signing. Room codes, aim calibration, display picker, trail,
interpolation, tap-to-arm, hold-to-point and live RTT are all in.

## The M0 findings that still constrain the code

The spike answered all three questions on 2026-08-24 (macOS 26.6.1, Apple silicon). Full
write-up in **`m0-findings.md`**. Headline: **no permission dialogs appear on any path the app
needs**, on either side. First-run onboarding has nothing to ask for.

- **Poll, don't tap.** Cursor position and modifier state come from the same 60 Hz tick, in
  Rust. Never reach for a `CGEvent` tap — and never treat a non-nil `tapCreate` as proof of
  permission, it returns non-nil and then delivers nothing.
- **Tap-to-arm vs hold-to-point was a free choice**, so the app ships both and lets mate pick by
  feel. The platform layer only reports what is held; it does not decide what "armed" means.
- **Units.** macOS window/cursor APIs speak **points**, not device pixels, and `NSEvent` uses a
  bottom-left origin while `CGEvent` uses top-left. `macos.rs` uses `CGEvent` precisely because
  it is already top-left, which is the convention the whole app runs on. Get this wrong and the
  ghost lands mirrored. Issue #5 proposes `geo` carry `backingScaleFactor`; the app does not
  currently need it, because the guest maps into its own overlay in logical units.

## Known trap, do not solve yet

Tauri needs `macOSPrivateApi` for transparent webview windows — it is on in `tauri.conf.json`,
and it means automatic Mac App Store rejection. Deliberate: distribution is a downloaded `.dmg`,
which is unaffected. The contained fix, for later, is a native `NSWindow` overlay via
`objc2-app-kit` instead of a webview, keeping the webview only for settings. Issue #3.

Note `lib.rs` already reaches into AppKit for one thing: `raise_over_everything` sets the window
level to 25 (`NSStatusWindowLevel`) so the overlay covers the menu bar. Tauri's `always_on_top`
alone lands on level 3, and the ghost would vanish in the top 25 points of the screen.
