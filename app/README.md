# app/ — Ghost Pointer desktop app

Not started. See `CLAUDE.md` in this directory for the brief, `../docs/spec.md` for the wire
protocol.

**One directory, both platforms.** This builds macOS and Windows from the same source;
platform differences live behind `#[cfg(target_os = "…")]` in `src-tauri/src/platform/`.
There is deliberately no `mac/` or `windows/` sibling.

Relay is already live and needs no configuration:
`wss://ghost-pointer-relay.mergodon.workers.dev`
