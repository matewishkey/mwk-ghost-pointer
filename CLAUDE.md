# mwk-ghost-pointer — agent instructions

Point at things on someone else's screen, over the internet, decoupled from whatever tool is
sharing the screen. `docs/spec.md` is the contract — read it before touching anything.

## Where the work happens

- **`relay/`** — Cloudflare Worker + Durable Object. **Done and deployed.** Built and verified
  on the Linux dev box; platform-independent, no reason to touch it from the Mac.
- **`app/`** — the Tauri desktop app. **Not started.** Built on mate's Mac, macOS first,
  Windows after it works.

## State as of 2026-08-23

- Relay live at `wss://ghost-pointer-relay.mergodon.workers.dev`, 12/12 probe checks passing
  over the internet, p50 17 ms RTT from Brisbane.
- `node tools/probe.mjs <ws-url>` is the regression test. Run it after any relay change.
  It exits non-zero on failure. Local: `cd relay && npm run dev`, then probe `ws://127.0.0.1:8787`.
- App: nothing yet. M0 (the macOS permission spike) is the next thing and everything is gated
  on it.

## Decisions already made — don't relitigate

- **Relay, not P2P.** Deliberate: no WebRTC, no STUN, no TURN fallback. Mate's call, and the
  payload is ~3.5 KB/s so there's no bandwidth argument the other way.
- **Linux is out of scope** (mate, 2026-08-23). Wayland blocks global pointer position by
  design. Don't add Linux branches to any path.
- **macOS first, Windows second, stores a distant third.** Mate wants a real guest test, not
  a submission.
- **Tap-to-arm hotkey, not hold-to-point**, unless M0 shows otherwise — easier on the hands
  and the cheaper path on macOS permissions. Mate hasn't objected to this; confirm if it
  turns out to matter.
- **No screen capture, ever.** The app draws and reads its own cursor. Asking for Screen
  Recording permission would wreck the "lightweight, nothing scary" pitch that is the whole
  product.

## Build order

**M0 — the macOS spike. Everything is gated on this. Throwaway code, do not polish.**
On the Mac, prove three things and *write down which permission dialogs appear*:
transparent click-through always-on-top window that draws a dot; global cursor position in a
loop; modifier-hold detection. The answer picks the sender UX and the first-run onboarding.

**M1 — loopback.** Both roles on one Mac, hardcoded coordinates, against the live relay.
Proves the render loop and the wire format.

**M2 — two machines.** Room codes, aim-rect calibration, display picker. First genuinely
useful build; this is the one mate tests with a guest.

**M3 — feel.** Interpolation between samples, trail tuning, tray icon, reconnect, hotkey config.

## Conventions

- Cloudflare account is shared across every project — scope anything destructive by name.
  This project owns exactly one Worker: `ghost-pointer-relay`.
- Never widen the wire protocol without updating `docs/spec.md` in the same commit. Unknown
  `k` values are ignored by design, so additions are backwards-compatible.
- Research findings and their sources live in `docs/research.md`. If a platform claim there
  turns out wrong once tested on real hardware, fix the doc — several of them are explicitly
  marked unverified.
