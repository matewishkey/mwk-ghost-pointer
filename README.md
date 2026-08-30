# Ghost Pointer

Point at things on someone else's screen, over the internet — decoupled from whatever tool is
sharing the screen.

You host a call, they share their screen, you see it in some third-party window. Arm a hotkey,
move your mouse over that window, and a ghost cursor appears **on their actual desktop** with a
short fading trail. No screen capture, no remote control, no input injection. It only draws.

macOS first, Windows next. Linux is out of scope — Wayland blocks global pointer position by design.

## Download it

**https://ghost-pointer-app.matewishkey.com** — universal macOS build (Apple silicon + Intel).

It is **not signed**, so macOS blocks it on first launch and you allow it by hand, once, per
machine. That page walks through it. Signing is a $99/yr Apple Developer account and only buys
a clean double-click for someone else; it is not the App Store, and the store is closed to this
app anyway (transparent overlay windows use an API Apple bans there).

## Status — 2026-08-30

| Piece | State |
|---|---|
| `relay/` — Cloudflare Worker + Durable Object | **Live.** `wss://ghost-pointer-relay.mergodon.workers.dev` |
| `app/` — Tauri desktop app, macOS | **Works.** Proven end to end 2026-08-30. |
| `app/` — Windows | Stub. Same source tree, `platform/windows.rs` unimplemented. |
| `download/` — the download page | **Live.** Built on the Mac, deployed from the Linux box. |

Proven, not assumed: a scripted host → the live relay → the app as guest → a ghost drawn on a
real desktop at 22-24 ms, over other applications, with clicks still passing through the overlay
to the app underneath.

**In:** host/guest roles, six-character room codes, aim-rect calibration, display picker, ghost
with a ~600 ms fading trail, interpolation, tap-to-arm and hold-to-point, instant local echo for
the host, live latency.
**Not yet:** drawing or annotation, persistent marks, accounts, reconnect, tray icon, Windows,
signing.

## On a new machine

    git clone git@github.com:matewishkey/mwk-ghost-pointer.git
    cd mwk-ghost-pointer
    git config pull.rebase true && git config rebase.autoStash true   # keeps history linear

Then read `CLAUDE.md` — it carries the decisions, the directory ownership rules and the build
order. Run your editor/agent from the **repo root**, not from inside a subdirectory, so those
rules are in scope.

## Layout

    relay/            Cloudflare Worker, one Durable Object per room code   (Linux box owns)
    app/              Tauri desktop app — macOS AND Windows, one codebase   (Mac owns)
    download/         the public download page                             (Mac builds, Linux deploys)
    tools/probe.mjs   relay regression test — 13 checks, exits non-zero on failure
    docs/spec.md      wire protocol, coordinate mapping, MVP scope
    docs/research.md  concept validation, cost model, platform findings + what's unverified

## Relay

    cd relay && npm install
    npm run dev                                          # local on :8787
    npm run deploy                                       # to Cloudflare

    node tools/probe.mjs ws://127.0.0.1:8787             # test local
    node tools/probe.mjs wss://ghost-pointer-relay.mergodon.workers.dev

Last run against production: 13/13 checks passed, p50 17-18 ms / p95 22-36 ms round-trip from Brisbane.

## Building the app yourself

    cd app && npm install
    npm run tauri build -- --target universal-apple-darwin
    ../download/build.sh          # assembles the download site into download/public/

Needs Rust and node. The deploy runs from the Linux box, which holds the Cloudflare token:
`wrangler pages deploy download/public --project-name ghost-pointer-app`.

## Next

`CLAUDE.md` has the build order and what is deliberately left out. The open question is not
technical — it is whether pointing at someone else's screen feels good enough to keep. That
needs a real guest on a real call.
