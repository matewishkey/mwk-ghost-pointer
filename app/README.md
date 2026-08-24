# app/ — Ghost Pointer desktop app

**M0 done, M1 next.** The macOS spike is finished and the answer is the good one: **neither
role needs any permission** — not the receiver, not the sender, no dialogs on any path the app
actually uses. Results, method and the traps: **`m0-findings.md`**. Instrument: `m0-spike/`
(throwaway).

No app code yet. See `CLAUDE.md` in this directory for the brief, `../docs/spec.md` for the
wire protocol.

**One directory, both platforms.** This builds macOS and Windows from the same source;
platform differences live behind `#[cfg(target_os = "…")]` in `src-tauri/src/platform/`.
There is deliberately no `mac/` or `windows/` sibling.

Relay is already live and needs no configuration:
`wss://ghost-pointer-relay.mergodon.workers.dev`
