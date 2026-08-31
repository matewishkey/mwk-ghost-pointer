# M0 — macOS spike results

Measured 2026-08-24 on **macOS 26.6.1 (25G76), Apple silicon**, two Studio Displays at
2560×1440 points / ×2 backing scale. Spike source and runners: `m0-spike/`.

**Headline: the sender needs no permissions either. Not one dialog, on any path the app
actually needs.** That was the open question the whole build order was gated on, and the
answer is the good one.

---

## How this was measured, and why the method matters

The first run said "no permission needed" for everything. It was worthless: a binary launched
from a terminal inherits the *terminal's* TCC grants, and iTerm2 on this machine already holds
Accessibility, Input Monitoring **and** Post Events. Every API sailed through because the
process was already trusted.

So the real runs use a clean room: an ad-hoc-signed `.app` bundle with its own bundle id
(`com.mergodon.ghostpointer.m0spike`), launched with `open` so it is its own responsible
process. It reports its own baseline every run:

    baseline TCC   Accessibility=no   InputMonitoring=no   PostEvents=no

Every result below was produced by a process holding **none** of the three. Each phase runs in
its own process (`--only=<phase>`) so a dialog can be attributed to exactly one call, and each
phase re-reads TCC state before and after.

**Positive control** — `AXIsProcessTrustedWithOptions(prompt: true)` from the same clean-room
app. It produced a visible, screenshotted effect, so the harness demonstrably *can* catch a
permission event. Without that, "no dialog appeared" would have been an untested claim.

---

## Q1 — transparent, always-on-top, click-through window drawing a dot over other apps

**Yes. No permission, no dialog.**

Borderless `NSWindow`, `isOpaque = false`, `backgroundColor = .clear`, `hasShadow = false`,
level `CGWindowLevelForKey(.screenSaverWindow)` (= 1000), collection behaviour
`[.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]`, shown with
`orderFrontRegardless()` so it never steals focus.

Verified by pixel, not by eye: the spike prints the device pixel its dot *should* land on, an
external `screencapture` grabs the screen, and a separate PNG decoder reads that pixel back.

- dot present at the predicted pixel on display 1 — `rgb(237,106,127)` over a dark terminal
- **absent** at the same pixel on display 2 — the negative control, so the check is not
  matching any old reddish pixel
- gone after the process exits

**It covers the whole display, edge to edge, including under the menu bar.** Markers drawn 12
points in from each corner all rendered, the top pair 8 points from the physical top of the
screen.

**Click-through is proven, not assumed** (added 2026-08-25, after the first write-up left it
open). Tested without touching any other app: the spike puts a solid window of its *own* at
`.floating` level under its *own* overlay, and a click is posted at that point.

| Pass | `ignoresMouseEvents` | target window | overlay | |
|---|---|---|---|---|
| 1 | `true` | **1 hit** | 0 | click passed straight through |
| 2 (control) | `false` | 0 | **1 hit** | overlay caught it — the test can tell the states apart |

Two instrument bugs had to be fixed before this meant anything, and both would silently produce
"no hits" forever: `RunLoop.run(mode:before:)` returns as soon as it services one source rather
than blocking for the duration, and pumping the runloop does not deliver mouse events to windows
at all — `NSApplication` must dequeue and `sendEvent` them. A view also needs
`acceptsFirstMouse` to see a click that arrives while its app is inactive, or AppKit eats it as
an activation click. None of these matter to the shipped app (its overlay is always
click-through) but all three will bite anyone writing a test like this.

⚠️ **`CGWindowList` under-reports the overlay's bounds — don't debug against it.** It reports
`2510×1412 at (25,14)` for a window whose frame is the full `2560×1440 at (0,0)`, while pixels
prove full coverage. Believe the pixels.

## Q2 — global cursor position without a permission prompt

**Yes. No permission, no dialog.**

`NSEvent.mouseLocation` returns the global position with the app unfocused and untrusted.
Tracking confirmed by warping the cursor to three known points and re-polling: **3/3 matched
exactly.** `CGWarpMouseCursorPosition` also needs no permission — it moves the cursor without
posting events, so it is not gated like synthetic input is.

Sustained polling ran at **599 frames in 10 s** — a clean 60 Hz, which is the sample rate the
spec asks for.

⚠️ **Both APIs return POINTS, not device pixels**, and they use opposite origins:

| API | origin | value at the same instant |
|---|---|---|
| `NSEvent.mouseLocation` | bottom-left | `(1508.8, 1392.1)` |
| `CGEvent(source: nil).location` | top-left | `(1508.8, 47.9)` |

On a ×2 display, points × 2 = pixels. The spec's coordinate-mapping section says "physical
pixel"; the normalised 0–1 wire value makes this moot on the wire, but the sender's aim rect
and the viewer's `geo` must agree on which unit they are in. **Recommend `geo` carry points
plus `backingScaleFactor`**, since that is what both platforms' window APIs speak natively.

## Q3 — does modifier-hold detection need Input Monitoring or Accessibility?

**No — if you poll. Yes — if you use an event tap.** The three mechanisms are not equivalent,
and the difference is the single most useful thing M0 found.

Tested by synthesising five discrete ⌥ taps (10 `flagsChanged` events: 5 down, 5 up) from a
*separate* trusted process, while the untrusted clean-room app watched. The TCC gate is on the
**observer**, so this isolates the question cleanly.

| Mechanism | Events seen (of 10) | Needs permission? |
|---|---|---|
| **`NSEvent.modifierFlags`** (poll the class property) | **10 / 10** | **No** |
| `NSEvent.addGlobalMonitorForEvents(.flagsChanged)` | **10 / 10** | No |
| `CGEvent.tapCreate(.listenOnly, .flagsChanged)` | **0 / 10** | **Yes — Input Monitoring** |

☠️ **The event-tap trap: `tapCreate` returned NON-NIL without Input Monitoring, then delivered
nothing.** A non-nil tap is not a working tap. Anyone checking `if tap != nil` to decide
whether permission was granted gets a false pass and a silently dead feature. This is exactly
how you ship a hotkey that works on the developer's machine and on nobody else's.

**Use `NSEvent.modifierFlags` polling.** It needs nothing, it is 10/10 accurate, and it fits
the architecture anyway — the sender is already polling cursor position at 60 Hz, so the
modifier is one more field read in the same tick. No event stream, no monitor, no callback.

### Bonus: `RegisterEventHotKey` — the research doc's open question, answered

**Registers and fires with zero permissions, no dialog.** `InstallEventHandler` → `OSStatus 0`,
`RegisterEventHotKey(⌃⌥⌘J)` → `OSStatus 0`, and the handler **received the press** while the
app held no grants.

This is the Carbon API underneath Tauri's `global-shortcut` plugin, so
`docs/research.md`'s "search results were contradictory" resolves to: **no Accessibility prompt.**

---

## What this means for the build

- **Tap-to-arm vs hold-to-point is now a free choice.** It was pencilled in as tap-to-arm
  partly to dodge a permission cost that does not exist. Both are permission-free: hold-to-point
  reads `NSEvent.modifierFlags` in the 60 Hz tick, tap-to-arm uses `RegisterEventHotKey`.
  Decide it on feel. (Still mate's call — this only removes the technical argument.)
- **First-run onboarding has nothing to ask for.** No permission screen, no "open System
  Settings" detour, on *either* side. The "lightweight, nothing scary" pitch survives contact
  with the platform intact.
- **Poll, don't tap.** Applies to the whole sender: cursor position and modifier state both come
  from polling the same tick.

## Open, and honestly open

- **Synthetic vs hardware modifiers.** The ⌥ events were posted by another process, not typed.
  The TCC gate is on the observer so the permission answer holds, but hardware confirmation is
  free the first time anyone runs the sender by hand.
- **`.keyDown` was not tested**, only `.flagsChanged`. Plausible that plain keystrokes *are*
  TCC-protected while bare modifier state is not — untested, and the app does not need it
  (`RegisterEventHotKey` covers the hotkey case).
- **Not retested on Intel or on an older macOS.** All figures are macOS 26.6.1 / Apple silicon.

## Reproducing

    cd app/m0-spike
    ./build.sh          # compiles + ad-hoc signs M0Spike.app
    ./run-clean.sh      # per-phase clean-room permission runs -> clean-<phase>.log
    ./run-deliver.sh    # modifier-delivery test -> deliver.log
    ./run-clickthru.sh  # click-through, with control -> clickthru.log

`build.sh` re-signs, which resets the app's TCC identity — so the clean room stays clean on
every rebuild. Grant this spike nothing; the whole point is that it never needs anything.

---

# Addendum — 2026-08-31: the mouse buttons (M2 spike)

M2 wants click, drag-to-draw and typing while pointing. That raised one question M0 never
asked: **can an app with no permissions see the mouse BUTTONS, the way it can already see the
modifier flags?**

Instrument: `m0-spike/m2.swift`, wrapped by the same clean-room rules as everything above —
its own bundle id, launched with `open`, so it is its own TCC responsible process.
`m0-spike/pressmouse` synthesises the input from the trusted terminal while the untrusted app
watches, which is the same isolation `presskey` gives for modifiers.

    baseline TCC   Accessibility=no  InputMonitoring=no  PostEvents=no
    left button  observed: YES   (56 ticks held)
    right button observed: YES   (60 ticks held)
    modifiers    observed: YES   (359 ticks held)   <- positive control

Both buttons were held for one second and the poll counted 56 and 60 ticks at 60 Hz. That is
the signal, at the right duration, not noise. The modifier poll is the positive control: M0
measured it working with no grants, so had it stayed silent the run would have proved nothing.

**`CGEventSource.buttonState` needs no permission.** Same family as `flagsState`, same answer.

## What that does and does not buy

Reading a button is not the same as owning it. **The click still goes to whatever is under the
cursor** — hold the left button over the video window to draw, and you are also dragging inside
Zoom. So the interesting table is not "can we read it" but "can we read it *and* does it leak":

| Gesture | Readable with zero grants | Leaks to the app underneath |
|---|---|---|
| Mouse movement | yes — M0 | no |
| Modifier held (⌥ ⌃ ⇧ ⌘) | yes — M0 | no |
| Mouse button held | **yes — this spike** | **yes, it really clicks** |
| Letter/number keys | no — needs Input Monitoring | yes |
| Registered global hotkey | yes — M0 | no, it is consumed |

So the gestures that cost nothing *and* leak nothing are **movement, held modifiers, and
registered hotkeys**. A design built out of those three needs no permission dialog and never
takes the host's screen away from them.

**Typing is the one exception and there is no way around it.** Reading ordinary keys globally
needs Input Monitoring. The alternative is to let a real window take focus while text is being
entered — which costs no permission, but does mean the host's screen is briefly in a mode. That
is a per-feature price, not a whole-app one: only text mode pays it.

**Windows is unverified.** `GetAsyncKeyState` is documented to read keys and buttons globally
with no permission model at all, which would make Windows a superset of these constraints
rather than a subset — but nobody has run it, and this project has no Windows machine yet.
Design to the macOS limits and Windows should follow; do not assume the reverse.

---

# Addendum 2 — 2026-08-31: counting clicks, because polling loses them

The M2 result above ("mouse buttons are readable with no permission") was true and still
misleading. Building click-to-pulse on it produced a feature that worked when tested by hand and
failed on the first synthetic click, and the reason is not macOS-specific:

**A 60 Hz poll cannot see an event shorter than 16 ms.** Sampling *state* asks "is the button
down *now*"; a click that begins and ends between two ticks was never down when anyone looked.

Instrument: `m0-spike/m3.swift` and `m0-spike/quickclick.swift`, same clean room. Three
instantaneous clicks (down and up posted back to back):

    baseline TCC   Accessibility=no  InputMonitoring=no  PostEvents=no
    clicks the 60 Hz POLL noticed:     NONE
    clicks the COUNTER noticed:        3

`CGEventSourceCounterForEventType` counts events rather than sampling state, so the click having
already finished does not matter — it happened, so the number moved. **It needs no permission
either**, measured in the same clean room, and it caught all three.

## What this changes

- **`Platform::clicks()` returns counters, not button state.** Deltas between ticks are the
  signal; the absolute value is meaningless (it is system-wide and monotonic). The first read of
  a session is a baseline — treating it as a delta would fire a pulse for every click since boot.
- **The same trap is waiting on Windows.** `GetAsyncKeyState(VK_LBUTTON)` is *state*, so
  translating the macOS code directly would reproduce the bug on a platform where nobody would
  think to look for it. A `WH_MOUSE_LL` hook counts properly and needs no permission there.
- **Held things stay polls.** Modifiers are held for as long as the gesture lasts, so sampling
  state is right for them. It is only the instantaneous events that need counting. The rule is
  the shape of the input, not the API family.

## The general lesson, since this is the second time

M0 said poll, don't tap. That is still right — but "poll" answers *is it held*, and it silently
answers *did it happen* wrong. Both questions look identical in an API listing and behave
identically under a human hand, which is why hand-testing passed and the first machine-driven
test failed. **Test input paths with synthetic events, not fingers:** a hand cannot produce the
timings that break them.
