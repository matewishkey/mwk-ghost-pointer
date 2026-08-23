# Ghost Pointer

Point at things on someone else's screen, over the internet — decoupled from whatever tool is
sharing the screen.

You host a call, they share their screen, you see it in some third-party window. Arm a hotkey,
move your mouse over that window, and a ghost cursor appears **on their actual desktop** with a
short fading trail. No screen capture, no remote control, no input injection. It only draws.

macOS first, Windows next. Linux is out of scope — Wayland blocks global pointer position by design.

## Status — 2026-08-23

| Piece | State |
|---|---|
| `relay/` — Cloudflare Worker + Durable Object | **Live.** `wss://ghost-pointer-relay.mergodon.workers.dev` |
| `app/` — Tauri desktop app | Not started. M0 is the macOS permission spike. |

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
    tools/probe.mjs   relay regression test — 12 checks, exits non-zero on failure
    docs/spec.md      wire protocol, coordinate mapping, MVP scope
    docs/research.md  concept validation, cost model, platform findings + what's unverified

## Relay

    cd relay && npm install
    npm run dev                                          # local on :8787
    npm run deploy                                       # to Cloudflare

    node tools/probe.mjs ws://127.0.0.1:8787             # test local
    node tools/probe.mjs wss://ghost-pointer-relay.mergodon.workers.dev

Last run against production: 12/12 checks passed, p50 17 ms round-trip from Brisbane.

## Next

`CLAUDE.md` has the build order. M0 first — the macOS spike that proves the transparent
click-through overlay, global cursor polling and modifier-hold, and records which permission
dialogs appear. Everything else is gated on that answer.
