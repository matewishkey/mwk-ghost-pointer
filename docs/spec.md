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

One room holds exactly one of each and refuses anyone else — see Room capacity below.

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

WebSocket, JSON, one object per frame. At 60 Hz a sample is ~60 bytes — about 3.5 KB/s.
Binary packing is a later optimisation with no reason to do it now.

**Connect:** `wss://<relay>/r/<CODE>?role=point|view&name=<label>[&hint=<region>]`

`<CODE>` is 6-12 chars (the app mints 10) from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no I/O/0/1 — they get misread
when someone reads a code aloud on a call). Anything else → HTTP 400. **Codes are
case-insensitive** — the relay uppercases before validating, so `prbe27` and `PRBE27` are the
same room.

**The code is not the access control — capacity is.** 10 chars over a 32-char alphabet is
32¹⁰ ≈ 1.1 quadrillion, but that is not what makes a leaked code survivable: a room holds one
pointer and one viewer and refuses everyone else, so a correct code buys nothing once both
people are connected. See Room capacity below.

Two earlier arguments here have expired and are recorded so nobody reinstates them. *"6 chars
is a deliberate usability choice, the code gets read aloud"* stopped being true on 3 Sep 2026,
when the app began masking the code and offering Copy — nobody reads it out, so length is close
to free. *"The realistic risk is griefing, not data theft, because the payload is only
coordinates"* stopped being true on 4 Sep, when `txt` began carrying commands and URLs.

The endpoint is still unauthenticated and the real fix is still a signed join token (issue #4).

`hint` optionally pins the room's Durable Object to a region (`oc`, `apac`, `weur`, `eeur`,
`wnam`, `enam`, `sam`, `afr`, `me`); anything else → HTTP 400. Without it the object is
created near whoever connects first. Worth setting to `oc` if the host is always in Brisbane.

### Client → server

| Message | Meaning |
|---|---|
| `{"k":"p","x":0.51,"y":0.33,"a":1,"t":1787529600000}` | Pointer sample. `x`/`y` normalised, `a` = 1 visible / 0 fading out, `t` = sender's `Date.now()`. Fanned out to everyone else. |
| `{"k":"geo","g":{"w":3024,"h":1964,"label":"Built-in"}}` | Viewer announcing its target display. Cached per socket and replayed to late joiners. **Viewers only** — the relay drops `geo` from a pointer. |
| `{"k":"ping","t":1787529600000}` | Latency probe. Answered directly, never fanned out. |

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

Measured 2026-08-24 from the Brisbane LAN, 120 pings per run, three runs: p50 **17-18 ms**,
p95 **22-36 ms**. Quote the range, not one run — it moves by tens of ms. One-way
sender→viewer is roughly half that. Negligible against any screen share.

Cost, from [the pricing docs](https://developers.cloudflare.com/durable-objects/platform/pricing/):
incoming WebSocket messages bill 20:1, duration bills against a fixed 128 MB. One room at
full 60 Hz works out around **$0.007/hour**, and the included allowance covers ~92 room-hours
a month (requests bind before duration — see `docs/research.md` § Cost). Rate-limiting a free
tier saves nothing at this scale — if tiers happen, sell them on feel, not on hosting cost.

## MVP scope

**In:** two modes, room code, aim-rect calibration, display picker, ghost + ~600 ms fading
trail, local echo on the sender, connection status with live RTT, reconnect with backoff, and —
added 4 Sep 2026 — **click pulses and text marks** (`c`, `txt`, `clr`).

**Out:** ink strokes, persistent marks that survive a rejoin, accounts, billing, app stores, key
injection, Linux, auto display detection, installers/signing.

### Room capacity (4 Sep 2026)

**A room holds one `point` and one `view`, and refuses everyone else.** A join naming a role that
is already taken gets `409 {"error":"room_full","role":"…"}` before the WebSocket upgrade, so a
client sees a failed connection rather than a socket that opens and goes quiet.

This is what makes a leaked code survivable: guessing one only helps while a seat is free, so
once both parties are connected a correct code buys nothing — no watching, no sending. It is not
authentication and does not pretend to be. Two consequences a client has to handle:

- **A dropped socket does not hold its seat.** Capacity counts only sockets still open, so an
  automatic reconnect gets back into its own slot instead of being locked out by the corpse of
  the old one.
- **Taking a free seat denies it to the rightful owner.** Someone who joins before the second
  party arrives locks that party out. That is a denial-of-service the unrestricted design did not
  have, and it is the reason the signed join token in issue #4 is still the real fix.

Codes are **6 to 12 characters**; the app mints 10 (32^10 ≈ 1.1 quadrillion). The range stays
open at 6 so builds already installed keep working — narrow it once nothing shorter is in the
wild.

### Annotation messages (4 Sep 2026)

Mate reversed the earlier "no annotation" scope on 31 Aug; the app side shipped first and sat
unusable because the relay dropped everything it did not recognise. These are **senders only** —
a `view` sending one is dropped, mirroring how `geo` is viewers-only — and stamped with the
sender's `id` on the way out, like `p`.

| Message | Meaning |
|---|---|
| `{"k":"c","x":…,"y":…,"b":0,"t":…}` | Click pulse. `b`: 0 left, 2 right. Fanned out, never stored. |
| `{"k":"txt","m":"<markId>","x":…,"y":…,"s":"…","end":0,"keep":1}` | Text mark, streamed as typed. `end:1` commits it. `keep:1` persists on screen, `keep:0` fades. |
| `{"k":"clr"}` | Clear every mark. Broadcast only. |

`m` is a mark id minted by the sender — not the sender's id, which is `id` as everywhere else.

`s` is forwarded **byte for byte**: not trimmed, normalised or re-encoded. Leading whitespace is
meaningful in a pasted command block. Over `MAX_TEXT` (2000 characters) the message is
**rejected, not truncated**, and the sender receives `{"k":"err","why":"text_too_long","max":…,"m":…}`.
A command that arrives looking whole while missing its tail is worse than one that never
arrives — the first one gets run.

**Still out, deliberately:** nothing is stored. There is no `marks` replay, so a guest who joins
late, or reconnects, sees only what is sent after they arrive. Ink strokes are not carried at
all. Both are tracked in issue #6; storage is the part that turns the room from a pipe into a
small document, and it was not needed to make pointing and pulsing useful.

## Platform notes

Verified during research; sources in `docs/research.md`.

- **Receiver on macOS needs no permissions.** Borderless transparent `NSWindow`, high window
  level, `ignoresMouseEvents`. This is the side a stranger installs, and it asks for nothing.
- **Sender on macOS needs no permissions either** (verified M0, 2026-08-24, macOS 26.6.1 on
  Apple silicon, in a clean room holding zero TCC grants). Poll `NSEvent.mouseLocation` and
  `NSEvent.modifierFlags`; hotkey via `RegisterEventHotKey`. Do **not** use a `CGEvent` tap — it
  needs Input Monitoring, and `tapCreate` returns non-nil without the grant and then silently
  delivers nothing, so a nil-check is a false pass. Mouse buttons and side-button state read the
  same way, through `CGEventSource`, and cost nothing either. Method and evidence:
  `app/m0-findings.md`.
- **Windows needs no permission either, but the overlay is not solved.** `GetCursorPos` +
  `RegisterHotKey`; `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW` + topmost. The
  permission half held; the rest did not. A build published on 31 Aug 2026 locked up a real
  machine — creating a second webview from a live command hangs, and `transparent(true)` puts
  WebView2 in a composition mode that never applies cursor updates. Both are diagnosed and fixed
  in `app/`, neither is confirmed on screen by a human. `app/CLAUDE.md` § Windows before touching it.
- **Linux is dropped from scope** (2026-08-23). Wayland makes global pointer position
  deliberately unavailable and GNOME refuses layer-shell; it's blocked, not merely hard.

## Known store trap — do not solve yet

Tauri's `macOSPrivateApi` flag means automatic Mac App Store rejection. Deferred deliberately;
full detail and the contained fix live in `docs/research.md` § Platform findings and issue #3.
