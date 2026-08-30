# app/ — Ghost Pointer desktop app

**It works.** Built, run, and proven end to end on 2026-08-30: a scripted host drove a ghost
onto this Mac's real desktop through the live relay at 22-24 ms, drawn over other applications,
with clicks still passing through the overlay to whatever was underneath.

Download the built app: **https://ghost-pointer-app.matewishkey.com** — unsigned, so macOS
blocks it once; that page walks through it.

## Running it from source

    npm install
    npm run tauri dev                                        # or:
    npm run tauri build -- --target universal-apple-darwin   # what the download page ships

Needs Rust (`rustup`) and node. `npm run tauri icon public/brand/mwk-block-2048.png` regenerates
the icons from the Mate Wish Key block logo.

## How it fits together

Three windows, and the split is the design:

| Window | What it is |
|---|---|
| `main` | The control UI. **Owns the WebSocket** — the wire protocol is written once, in `src/protocol.ts`. |
| `overlay` | Transparent, always-on-top, click-through. Draws the ghost. Both roles use it: the guest draws the incoming pointer, the host draws its own local echo. |
| `aim` | The host's calibration sheet. The one window here that takes clicks. |

`src-tauri/src/platform/` is the only place an OS difference is allowed to exist. Coordinates
are **top-left origin, logical units** everywhere above that boundary — macOS converts once, at
the edge, and nothing else ever thinks about it.

**One directory, both platforms.** This builds macOS and Windows from the same source;
differences live behind `#[cfg(target_os = "…")]`. There is deliberately no `mac/` or
`windows/` sibling. `platform/windows.rs` is still a stub.

## The local echo is not an optimisation

The host draws its own ghost immediately instead of waiting for one to come back. There is no
round trip that would make waiting acceptable — the guest's screen reaches the host through a
video call, one to three seconds behind, and a pointer lagging that far behind the hand moving
it is unusable.

## Relay

Already live, needs no configuration: `wss://ghost-pointer-relay.mergodon.workers.dev`.
Sanity-check it any time with `node ../tools/probe.mjs wss://ghost-pointer-relay.mergodon.workers.dev`
— 13 checks, exits non-zero on failure. If those pass, the relay is fine and the bug is here.

Permissions: **none, on either side.** Measured, not assumed — `m0-findings.md`.
