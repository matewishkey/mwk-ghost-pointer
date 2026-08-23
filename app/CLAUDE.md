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
— 12 checks, exits non-zero on failure. If those pass, the relay is fine and the bug is here.

## Start at M0 — and it is throwaway

Do not scaffold the app first. M0 is a spike that answers three questions about macOS, and
its only deliverable is **written-down answers**, including which permission dialogs appear:

1. Can a transparent, always-on-top, click-through window draw a dot over other apps?
2. Can global cursor position be polled without a permission prompt?
3. Does modifier-hold detection need Input Monitoring or Accessibility?

`../docs/research.md` § "Explicitly NOT verified" lists what is expected but untested. When
you have real answers, correct that file — several entries there are guesses and are labelled
as such.

Then M1 (loopback on one machine), M2 (two machines, calibration + display picker), M3 (feel).

## Known trap, do not solve yet

Tauri needs `macOSPrivateApi` for transparent webview windows, which means automatic Mac App
Store rejection. Fine for now — notarised distribution outside the store is unaffected. The
contained fix, for later, is a native `NSWindow` overlay via `objc2-app-kit` instead of a
webview, keeping the webview only for settings.
