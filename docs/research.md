# Research findings — 2026-08-23 (cost + latency figures corrected 2026-08-24)

Concept validation and architecture review done before any code. Full write-up with the
reasoning: kept with the operator, outside this repo.

## Does this exist? No.

Four adjacent categories, none of which do it:

| Category | Examples | Why it isn't this |
|---|---|---|
| Local annotation overlays | [Presentify](https://presentifyapp.com/), Laser Cursor, annotation-overlay | Draws on your own screen only. Useless when *they* present. |
| Meeting tools with annotation | Zoom Annotate, Teams, Zoho Cliq, CoScreen | Does the thing — but only inside their own screen share. This coupling is what we're breaking. |
| Remote support / RMM | [Splashtop](https://support-splashtopbusiness.splashtop.com/hc/en-us/articles/360054770391-Cursor-Control), Zoho Assist, TeamViewer | Heavy install, full remote-control stack, and their cursor feature runs the *other* direction. |
| Multi-cursor / software KVM | [ShareMouse](https://www.sharemouse.com/doc/remote-control/), [Cursr](https://cursr.app/), MouseMux | Same-LAN, and they inject real input. Different trust model entirely. |

Closest prior art is [CoShare](https://dl.acm.org/doi/fullHtml/10.1145/3603555.3608524)
(UIST '23) — which is itself a screen-sharing tool, so again coupled.

**The unoccupied slot:** *the video comes from wherever you like, the pointer comes from us.*

**Honest caveat:** a gap this clean is usually a small market, not an oversight. Everyone with
this problem inside Zoom/Teams/Meet already has a solution. The buyers are people who
deliberately stream over something else. The v1 wedge is mate himself.

## Latency — resolved

The original concern was that the pointer would arrive *after* the video frame mate was
reacting to, making it land wrong on a moving screen. **Mate confirmed 2026-08-23** that he's
the host and sees the guest's screen essentially immediately — a low-latency meeting-style
share, not an OBS→Twitch pipeline. So the concern is largely moot. It would come back if the
product were ever aimed at high-latency broadcast streaming; worth remembering, not worth
designing around now.

Relay latency measured live, 120 pings per run, three runs, Brisbane → Cloudflare → back:
**p50 17-18 ms, p95 22-36 ms** (2026-08-24). Quote the range — a single run is not the number. An earlier figure of
"p95 87 ms" was wrong methodology, not a slower network — the probe sent only 12 pings, over
which `p(0.95)` resolves to the maximum. It now pings every sample and refuses to print
percentiles below 20 points.

## Cost

From the [Durable Objects pricing docs](https://developers.cloudflare.com/durable-objects/platform/pricing/):
incoming WebSocket messages bill 20:1, outgoing are free, and duration bills against a fixed
128 MB allocation while the object is active and **not eligible for hibernation** — the relay
uses the Hibernation API, so a room with connected-but-idle sockets stops accruing duration.
$0.15/M requests, $12.50/M GB-s, with 1M requests + 400,000 GB-s included on the $5 Workers
Paid plan.

```
one room, one hour, 60 Hz:
  216,000 msgs in  /20  = 10,800 requests  = $0.0016
  3600 s × 0.125 GB     =    450 GB-s      = $0.0056
                                     total ≈ $0.007/hour

included allowance, and which one runs out first:
  requests  1,000,000 / 10,800  =  ~92 room-hours   ← binds
  duration    400,000 /    450  =  ~889 room-hours
```

**Requests bind roughly 10x sooner than duration.** An earlier version of this doc said ~889
by dividing only the duration allowance — worth re-checking whichever line you are about to
quote, because the two differ by an order of magnitude.

**Implication for pricing:** throttling a free tier saves nothing. If tiers ever ship, sell
them on feel, not on hosting cost. The line item that would eventually grow is duration
(concurrent rooms), not messages.

## Platform findings

Verified in the Tauri v2 [window API reference](https://v2.tauri.app/reference/javascript/api/namespacewindow/):
`setIgnoreCursorEvents()`, `setAlwaysOnTop()`, `setVisibleOnAllWorkspaces()`,
`availableMonitors()` all exist — that's the whole receiver toolkit. Hotkey via the
[global-shortcut plugin](https://v2.tauri.app/plugin/global-shortcut/).

**Mac App Store trap:** Tauri requires the `macOSPrivateApi` config flag for transparent
windows, and [Tauri's own docs](https://github.com/tauri-apps/tauri-docs/issues/463) state
private API use means App Store rejection. Notarised distribution outside the store is
unaffected. Contained fix for later: native `NSWindow` overlay via `objc2-app-kit` instead of
a webview.

**Linux/Wayland is blocked by design** — global pointer position is deliberately unavailable
and GNOME has refused layer-shell ([wl-find-cursor](https://github.com/cjacker/wl-find-cursor/)
documents the workaround and its limits). Dropped from scope 2026-08-23.

## Explicitly NOT verified

Do not treat these as settled — they need real hardware or an hour of digging:

- Whether polling `NSEvent.mouseLocation` is permission-free on current macOS. Expected yes,
  untested. **This is M0.**
- Whether modifier-hold detection needs Input Monitoring or Accessibility. Expected yes,
  untested. **This is M0.**
- Whether `RegisterEventHotKey` (what the Tauri global-shortcut plugin uses) triggers an
  Accessibility prompt. Search results were contradictory.
- Whether Tauri can emit an MSIX package for the Microsoft Store. It ships `.msi` and NSIS
  `.exe` natively.
- Whether the Mac App Store sandbox permits whichever global-hotkey path gets chosen.
