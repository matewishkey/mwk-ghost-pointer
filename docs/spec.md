# Ghost Pointer — spec

## What it does

Mate hosts a call. The guest shares their screen. Mate sees it live in some third-party
app's window. He holds/arms a hotkey, moves his mouse over that window, and a ghost cursor
appears **on the guest's actual desktop**, tracking his movement, leaving a short fading trail.

No screen capture. No remote control. No input injection. The app only ever *draws*.

## Roles

| Role | Who | Does |
|---|---|---|
| **point** | Mate (host) | Reads its own global cursor position, maps it into the aim rect, sends samples. |
| **view** | Guest | Draws the incoming ghost on a transparent click-through overlay. |

One room can hold several of each; MVP assumes one of each.

## Coordinate mapping

This is the part that makes or breaks it. Mate's cursor is over a *video* of the guest's
screen, at an arbitrary size and position on his own desktop.

```
mate's physical cursor       e.g. 1840,620 on a 2560×1440 desktop
        │  subtract the aim rect — the region of MATE's screen showing the guest's screen
        ▼
normalised 0.0–1.0           ← this, and only this, goes on the wire
        │  scale to the viewer's chosen display
        ▼
guest's physical pixel       e.g. 2280,1004 on a 3024×1964 display
```

Rules:

- **The sender owns the aim rect.** Hotkey opens a translucent full-screen picker; mate drags
  a rectangle over the video window. Stored per room, re-draggable any time the video moves.
- **The viewer owns the display choice.** A dropdown of `availableMonitors()`, remembered.
  Do **not** try to auto-detect which display is being shared — that needs screen-capture
  permission we deliberately don't ask for.
- **Letterbox-fit, never stretch.** If aspect ratios differ, fit inside and letterbox. The
  viewer announces its display size via `geo`, so the sender's picker should snap the drag
  rect to that aspect ratio — then a mismatch is impossible by construction.
- **Clamp to 0..1** before sending. Off-rect movement parks the ghost at the edge rather than
  flinging it somewhere wrong.

## Wire protocol

WebSocket, JSON, one message per line. At 60 Hz a sample is ~60 bytes — about 3.5 KB/s.
Binary packing is a later optimisation with no reason to do it now.

**Connect:** `wss://<relay>/r/<CODE>?role=point|view&name=<label>[&hint=<region>]`

`<CODE>` is 6 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no I/O/0/1 — they get misread
when someone reads a code aloud on a call). Anything else → HTTP 400.

`hint` optionally pins the room's Durable Object to a region (`oc`, `apac`, `weur`, `eeur`,
`wnam`, `enam`, `sam`, `afr`, `me`). Without it the object is created near whoever connects
first. Worth setting to `oc` if mate is always the host.

### Client → server

| Message | Meaning |
|---|---|
| `{"k":"p","x":0.51,"y":0.33,"a":1,"t":1724...}` | Pointer sample. `x`/`y` normalised, `a` = 1 visible / 0 fading out, `t` = sender's `Date.now()`. Fanned out to everyone else. |
| `{"k":"geo","g":{"w":3024,"h":1964,"label":"Built-in"}}` | Viewer announcing its target display. Cached per socket and replayed to late joiners. |
| `{"k":"ping","t":1724...}` | Latency probe. Answered directly, never fanned out. |

### Server → client

| Message | Meaning |
|---|---|
| `{"k":"hello","you":{...},"peers":[{id,role,name,geo}]}` | Sent on connect. `peers` carries each viewer's last-known `geo`. |
| `{"k":"join","id","role","name"}` / `{"k":"leave","id"}` | Presence. |
| `{"k":"geo","id","g":{...}}` | A viewer changed display. |
| `{"k":"p", ...,"id":"<sender>"}` | A pointer sample, with the sender's id stamped on. |
| `{"k":"pong","t":<echoed>}` | Reply to `ping`. |

Senders never receive their own `p` messages back — the sender draws its own ghost locally
and instantly, because waiting for the video round-trip to see your own pointer feels awful.

Unknown `k` values are ignored, so adding message types is backwards-compatible.

### Rate

The relay drops anything above 200 msg/s per socket — a runaway guard, not a product tier.
Client should sample at 60 Hz, send only on actual movement, and the viewer should
**interpolate between samples**. With interpolation plus the trail, 15 Hz looks close to
60 Hz, which is what makes a throttled free tier viable later.

## Relay

`relay/` — Cloudflare Worker, one Durable Object per room code, WebSocket Hibernation API
so idle rooms stop billing duration.

Deployed: `wss://ghost-pointer-relay.mergodon.workers.dev`
Verify: `node tools/probe.mjs wss://ghost-pointer-relay.mergodon.workers.dev`

Measured 2026-08-23 from the Brisbane LAN: p50 17 ms round-trip, p95 87 ms. One-way
sender→viewer is roughly half that. Negligible against any screen share.

Cost, from [the pricing docs](https://developers.cloudflare.com/durable-objects/platform/pricing/):
incoming WebSocket messages bill 20:1, duration bills against a fixed 128 MB. One room at
full 60 Hz works out around **$0.007/hour**. Rate-limiting a free tier saves nothing —
if tiers happen, sell them on feel, not on hosting cost.

## MVP scope

**In:** two modes, room code, aim-rect calibration, display picker, ghost + ~600 ms fading
trail, local echo on the sender, connection status with live RTT.

**Out:** drawing/annotation, persistent marks, accounts, billing, app stores, click or key
injection, Linux, auto display detection, reconnect polish, installers/signing.

## Platform notes

Verified during research; sources in `docs/research.md`.

- **Receiver on macOS needs no permissions.** Borderless transparent `NSWindow`, high window
  level, `ignoresMouseEvents`. This is the side a stranger installs, and it asks for nothing.
- **Sender on macOS is the open question.** Global cursor position and a global hotkey.
  Polling `NSEvent.mouseLocation` is expected to be permission-free; a *held modifier* likely
  needs Input Monitoring or Accessibility. **Unverified — this is M0.**
- **Windows needs nothing either way.** `GetCursorPos` + `RegisterHotKey`;
  `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW` + topmost.
- **Linux is dropped from scope** (2026-08-23). Wayland makes global pointer position
  deliberately unavailable and GNOME refuses layer-shell; it's blocked, not merely hard.

## Known store trap — do not solve yet

Tauri needs the `macOSPrivateApi` flag for transparent webview windows, and private API use
means automatic Mac App Store rejection. Notarised distribution outside the store is fine.
The fix is contained: draw the overlay in a native `NSWindow` via `objc2-app-kit` instead of
a webview, keep the webview for settings. Do that once the concept is proven, not before.
