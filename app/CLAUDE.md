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

## M2 annotation — decided 2026-08-31, blocked on the relay (#6)

Mate expanded the scope: click, draw and type on the guest's screen. This **reverses**
`../docs/spec.md` § MVP scope, which lists drawing and persistent marks as out. His call, made
explicitly. `relay/src/index.ts` ends its switch with `default: return`, so none of it can ship
until #6 lands — do not start the wire work against a guessed shape.

Settled, and not to be relitigated:

- **Count clicks, do not poll for them.** `Platform::clicks()` returns monotonic counters and
  the app watches deltas. Polling button *state* loses any click shorter than one 16 ms tick —
  measured, three synthetic clicks, poll saw none (`m0-findings.md` § Addendum 2). Held
  modifiers stay polls, because "is it held" is a state question. The rule is the shape of the
  input, not the API.
- **A click may pulse; only a modifier may draw.** The M2 spike proved buttons are readable with
  no permission (`m0-findings.md` § Addendum) — but reading is not owning: the click still lands
  in whatever is under the cursor. For a *pulse* that is fine, because while pointing the thing
  under the cursor is a video of someone else's screen, where a click does nothing. For *ink* it
  is not: a drag would drag inside the call app too. So click-to-pulse uses a real click
  (shipped 2026-08-31), and drawing will be bound to a held modifier. Do not "simplify" these
  into one gesture — the difference is the whole reason one is safe.
- **Typing is a composer window, not a keyboard grab.** Point, press the text hotkey, the ghost
  freezes as the anchor, type into a real focused window, Enter sends (Shift+Enter for a
  newline), pointing resumes. Intended shape is a **non-activating panel** so the video call
  behind it does not lose focus — unverified through Tauri so far. This is what keeps the app at
  **zero permissions on both sides**, which is the whole pitch; do not trade it away.
- **Text is for handing over things to paste** — commands, URLs. So the guest keeps it as *text*
  and gets a **Copy button in their own window**; the overlay stays click-through and pure. Never
  write to their clipboard unprompted, and never show a truncated command as copyable.
- **Text streams live** as it is typed. **Right-click clears everything** — no undo stack yet.
- **Marks have two modes, both wanted:** persistent and fading. That is a per-mark flag on the
  wire, not a room setting, so switching mid-session leaves existing marks alone.

## Windows — START HERE if you are on the Windows box (1 Sep 2026)

**A Windows build was published on 31 Aug and it locked up a real machine.** Connected as a
viewer, the whole desktop stopped responding to the mouse. It was withdrawn the same evening;
`download/` publishes nothing for Windows and the two installer URLs redirect to the page.
CI still builds Windows on every push to `app/` — building is not the problem.

### What is already known, so you do not re-derive it

Three defects in `open_overlay`, found by reading, all fixed in `lib.rs` but **run on neither
platform**:

1. The overlay was created **visible** and made click-through afterwards, so a full-screen
   window existed before it was harmless.
2. If `set_ignore_cursor_events` failed, the error returned but **the window stayed up**.
3. `startViewing` calls `invoke("open_overlay")` with no `try`/`catch`, so that error was a
   silent unhandled rejection — no message, no log.

Together those produce the exact symptom. The fix inverts the order — build hidden, arm,
verify, then show — and destroys the window if arming fails. On Windows it now reads the
ex-style back and requires `WS_EX_LAYERED | WS_EX_TRANSPARENT`, because "the setter returned
Ok" and "the mouse passes through" turned out to be different claims.

**Defect 3 is still not fixed.** The frontend still swallows the error. Do that first — it is
five lines and it is why the failure was invisible.

### Do these before anything else

1. **Verify the fix on macOS too.** `open_overlay` is shared and the reordering is unrun there.
   Regression to check: overlay still appears, still passes clicks. Still open.
2. ~~Confirm the ex-style readback compiles on Windows.~~ **Done, 1 Sep 2026.**
3. ~~Test click-through in a bounded way.~~ **Done, 1 Sep 2026, on a real Windows machine.**
   Click-through itself was never actually broken — see the real bug below.
4. ~~There are still no logs, anywhere.~~ **Done, 1 Sep 2026.** `tauri-plugin-log` writes to
   stdout in dev and a file everywhere else; the overlay path is instrumented. A `diagnostics`
   command bundles build info with the log tail, wired to a "Copy diagnostics" button in the
   footer.

### The real bug, found and fixed 1 Sep 2026 — read this before touching `open_overlay` again

The 31 Aug lock-up was three real defects (above), all fixed, all re-verified on real hardware —
and the machine still froze the same way on the first live retest. The actual cause was
underneath all of them and every earlier fix attempt: DirectComposition/RDP-compositing flags
and explicit `run_on_main_thread` dispatch were both tried as fixes **for the hang** and both
disproven for that purpose (kept in this history on purpose, so the next person doesn't retry
them for *this* bug — DirectComposition came back for a different, real bug below).

**Building a *second* `WebviewWindow` from inside a `#[tauri::command]` that was itself invoked
over the real frontend IPC path hangs outright on this machine, permanently, with zero log
output — not even the function's first line.** Reproduced cleanly and repeatedly with a local
debug build (see "Local toolchain" below) once the actual bug was isolated from a broken test
harness (`cargo build` loads `devUrl`, not the bundled frontend — running it without `npm run
dev` also serving `localhost:1420` looks exactly like a hang and is not one). Ruled out, each
confirmed with a real rebuild-and-click cycle: transparency, every other window-builder option,
a separate `data_directory`, `additional_browser_args`, explicit main-thread dispatch. What
mattered was only ever *creating a new webview at all from a live command* — calling the exact
same builder code from a background thread that bypasses IPC entirely works fine, every time,
in under 200ms. **Why this happens is still not understood** — only isolated by elimination.
Treat "never call `.build()` from a live command" as the rule, not a specific flag or version.

**The fix:** `create_overlay_window` and `create_aim_window` build both picker/overlay windows
once, hidden, from `.setup()` — before the app is handling any IPC — and `open_overlay`/`open_aim`
now only reposition, arm and show the window that already exists; `close_overlay`/`close_aim`
hide rather than destroy, so nothing ever needs a second `.build()` for the rest of the app's
life. `open_aim` used to bake its per-call params (display origin, guest aspect ratio) into the
window's URL, which needed a fresh window every time — that state now travels as an `aim-params`
event to `aim.ts` instead. Both directions of the open→close→open cycle are verified for both
windows. Overlay pre-creation failure is fatal at startup (`.setup()` returns `Err`, Tauri shows
its own error dialog) since every role depends on it; aim pre-creation failure is only logged,
since the host role isn't reachable on Windows yet.

**Two independent fresh-context reviews of this fix (1 Sep 2026) converged on the same two gaps,
both now closed:** `open_aim` had the identical bug shape (destroy-and-rebuild on every call,
worse than the original), masked only by a frontend UI toggle (`applyPlatformLimits` disables
the host role on Windows) rather than closed structurally — fixed as above. The host/pointer
path (`startHosting`/`openHostOverlay` in `main.ts`) never got the try/catch fix that the guest
path (`startViewing`) did for the exact "Defect 3" this file already documents — fixed, same
shape, both roles now guard against `open_overlay` rejecting. Both reviews also independently
recommended **against** a native C# rewrite for Windows: the failure looks like a WebView2
controller-creation issue, not a Tauri-specific one (so C# using WebView2 would carry the same
risk), and a separate implementation would break this project's one-`app/`-two-platforms rule —
see the "Decisions already made" section at the top of the root `CLAUDE.md`.

**Still open, not yet independently confirmed:**
- No recovery path if the hidden overlay's or aim's WebView2 process dies while hidden — nothing
  detects it, `get_webview_window` still returns `Some`, `open_overlay`/`open_aim` would report
  success while showing nothing. Not hit yet; not guarded against.
- `open_overlay`'s explicit `run_on_main_thread` dispatch is no longer justified by anything that
  actually hung (`.build()` doesn't happen there anymore) and is kept only as defense-in-depth
  against the bug generalizing to simpler window methods under some untested condition. Worth a
  deliberate "does it work without it" test on real hardware before trusting either way.
- The cursor-invisible-over-RDP fix below is untested by a human looking at the screen.

### Cursor invisible even though click-through works — found and fixed, 1 Sep 2026

The click-through self-test passes and `GetCursorInfo` (a Windows-only `cursor_visible` command
added for this) reports the cursor as showing, but nothing was actually visible on screen —
first suspected as an RDP-transmission artifact (`GetCursorInfo` only sees this machine's own OS
state, not what a remote viewer's display driver renders), and a DirectComposition-software-
compositing workaround was tried on that theory. **Wrong** — confirmed real on this machine's own
physical console too, not just over RDP, so it was never an RDP artifact and the compositing
workaround (`additional_browser_args`/`data_directory`) has been removed; it didn't address the
actual cause and only added complexity.

**The real cause:** `transparent(true)` puts WebView2 into "composition mode" on Windows, and
Microsoft's own docs are explicit that composition mode does **not** apply cursor updates on its
own — the host application must set the cursor itself, "through `::SetCursor` or set on the
corresponding parent/ancestor HWND ... through `::SetClassLongPtr`". wry does not appear to do
this for transparent windows. That is exactly consistent with everything observed: `GetCursorInfo`
reports "showing" because nothing is hiding it, while nothing is visible because nobody is
asserting it either — true regardless of RDP.

**Fix:** `fix_composition_mode_cursor` (`lib.rs`) calls `SetClassLongPtrW(hwnd, GCLP_HCURSOR,
LoadCursorW(NULL, IDC_ARROW))` on every `transparent(true)` window — both the overlay
(`arm_click_through`, so it's reasserted on every arm) and the aim picker (`create_aim_window`,
once, since aim is never re-armed). No custom `WM_SETCURSOR` handler needed; setting the window
class's default cursor is the documented fix. **Not yet confirmed by a human looking at the
screen** — verified locally only that it doesn't hang or regress anything already working; the
actual visual result needs real eyes, same caveat as everything else in this file that says so.

### The app didn't exit when the control window closed — fixed 1 Sep 2026

Direct consequence of the fix above: keeping the overlay (and now aim) window alive, hidden, for
the app's whole life means Tauri's default "exit once every window is closed" never fires on its
own, because a hidden window still counts as open. `.on_window_event` now calls `app_handle.exit(0)`
explicitly when the `main` window gets a `CloseRequested` event. Verified locally by posting a
real `WM_CLOSE` to the main window's HWND and confirming the process — and its WebView2 child
processes — fully exit, not just force-killed.

### Local toolchain — installed on this Windows box, 1 Sep 2026

`rustc`/`cargo` (via `rustup`, winget) and MSVC Build Tools (`Microsoft.VisualStudio.2022.BuildTools`
with the C++ workload, also winget) are now on this machine. Use them — a local
`cargo build` + run is a ~10s loop; CI is a ~5 minute one. To get a working app locally (not just
a compile), `npm run dev` (Vite on `localhost:1420`) must be running first, because a debug
`cargo build` loads `devUrl`, not the bundled `dist/`. Logs land at
`%LOCALAPPDATA%\com.matewishkey.ghostpointer\logs\ghost-pointer.log` — read that file directly
rather than only trusting the in-app "Copy diagnostics" button, which needs the UI to be
responsive to click.

### Escape hatch, already shipped

The guest registers the hotkey (default `Ctrl+Alt+Shift+G`) purely to close the overlay and
disconnect. A global hotkey still works when the mouse cannot reach anything. Keep it.

### Publishing rules paid for on 31 Aug

`download/README.md` has them and they are not optional: **bump the version for every published
build**; Cloudflare Pages does not un-publish a file when you stop uploading it; and Pages
answers `200` with `index.html` for anything missing, so **a status-code check proves nothing**
— compare bytes or content type.

## Displays — AppKit knows things CoreGraphics does not

`displays()` joins the two: bounds and ids from `CGDisplay` (top-left origin, the app's
convention), names and scale from `NSScreen`. Two traps, both hit for real:

- **`pixels_wide / bounds.width` does not give you the scale.** On a Studio Display running a
  scaled 2560x1440 mode CoreGraphics reports 2560 device pixels, so that expression returns 1.0
  while the real backing scale is 2. Ask `NSScreen.backingScaleFactor`.
- **AppKit is main-thread-only** and Tauri runs sync commands on a worker, so `displays()`
  marshals through `run_on_main_thread`. Nothing already on the main thread may call it.

Both sides pick their own display, one at a time. The guest picks from the dropdown; the host's
aim picker opens on whichever screen the mouse is on and then *names* the screen it framed. A
ghost that crosses two of the guest's displays is not supported and was not asked for.

## Known trap, do not solve yet

Tauri needs `macOSPrivateApi` for transparent webview windows — it is on in `tauri.conf.json`,
and it means automatic Mac App Store rejection. Deliberate: distribution is a downloaded `.dmg`,
which is unaffected. The contained fix, for later, is a native `NSWindow` overlay via
`objc2-app-kit` instead of a webview, keeping the webview only for settings. Issue #3.

Note `lib.rs` already reaches into AppKit for one thing: `raise_over_everything` sets the window
level to 25 (`NSStatusWindowLevel`) so the overlay covers the menu bar. Tauri's `always_on_top`
alone lands on level 3, and the ghost would vanish in the top 25 points of the screen.
