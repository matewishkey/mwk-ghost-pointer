# mwk-ghost-pointer — agent instructions

Point at things on someone else's screen, over the internet, decoupled from whatever tool is
sharing the screen. `docs/spec.md` is the contract — read it before touching anything.

## Where the work happens

- **`relay/`** — Cloudflare Worker + Durable Object. **Done and deployed.** Built and verified
  on the Linux dev box; platform-independent, no reason to touch it from the Mac.
- **`app/`** — the Tauri desktop app. **Not started.** Built on mate's Mac, macOS first,
  Windows after it works.

### There is ONE app directory, not one per OS

`app/` builds **both** macOS and Windows from the same source. Do not create `mac/` and
`windows/` siblings — that is two apps, two implementations of the wire protocol, and
guaranteed divergence, which is the exact thing Tauri exists to avoid.

Platform differences live *inside* `app/`, behind conditional compilation:

    app/src/                     shared UI (overlay canvas, settings, room join)
    app/src-tauri/src/
      main.rs                    shared
      platform/mod.rs            trait: cursor position, hotkey, overlay window
      platform/macos.rs          #[cfg(target_os = "macos")]
      platform/windows.rs        #[cfg(target_os = "windows")]

The macOS session fills in `macos.rs` and defines the trait. Windows later fills in
`windows.rs` against that same trait, and nothing else has to change. If a platform needs
something the trait can't express, widen the trait — don't fork the app.

## Two machines, one repo

The Linux dev box owns the relay; a Mac owns the app. Same repo, same `main` branch. They
almost never collide because they touch disjoint directories — the rules exist for the
handful of files that are shared.

**Directory ownership**

| Path | Owner | Other machine |
|---|---|---|
| `relay/`, `tools/` | Linux box | read-only |
| `docs/spec.md` | Linux box — it's the protocol contract | read-only; file an issue to change it |
| `app/` | Mac | read-only |
| `app/CLAUDE.md`, `app/README.md` | Mac — they live in `app/` | read-only |
| `download/` — the public download page | Mac builds it, **Linux deploys it** | see below |
| root `README.md`, `docs/research.md`, root `CLAUDE.md` | either | pull first, say so in the commit |

**Rules**

1. **Both work directly on `main`.** No feature branches — disjoint directories make them
   ceremony without benefit. `git config pull.rebase true` is set in this repo so history
   stays linear and nobody generates merge commits.
2. **Pull before you start, push when you stop.** The real failure mode here is not a merge
   conflict, it's the Mac working two hours against a stale spec. Pushing often is what
   prevents it.
3. **`docs/spec.md` is the contract between the two halves and only the relay side changes
   it.** If the app needs a protocol change, `gh issue create` against this repo and say what
   and why. Same instinct as the cross-repo rule — don't reach into the other side's lane.
4. **Only the Linux box runs `wrangler`.** One Worker name, so two deployers means whoever ran
   last silently wins. The Mac develops against the deployed URL, never redeploys it. The same
   split is why `download/` is built on the Mac and deployed from Linux: only a Mac can build a
   Mac app, and only the Linux box holds the Cloudflare token — the Mac deliberately has no age
   key, so it cannot decrypt one. The `.dmg` travels between them on the shared drive, never
   through git.
5. **Coordinate through GitHub Issues**, not through the docs. Both machines have `gh`. An
   issue is the only channel that reaches the other session, since neither can see the other's
   conversation.

## State as of 2026-08-30

- **This repo is public** (`matewishkey/mwk-ghost-pointer`). Nothing secret has ever been in
  it — history was scanned before publishing. Keep it that way: no account ids, no tokens, no
  keys, not even in a comment or a test fixture.
- Relay live at `wss://ghost-pointer-relay.mergodon.workers.dev`, 13/13 probe checks passing
  over the internet, p50 17-18 ms / p95 22-36 ms RTT from Brisbane (range across runs, not one measurement).
- That relay URL is now in a public README and the endpoint has no auth, so anyone can join
  any room code and use the account as a WebSocket relay. Fine at this scale (~$0.007/room-hour)
  and correct for an MVP. The fix when it matters is a signed join token from a `/token`
  endpoint, not obscurity — don't bother before there are real users.
- `node tools/probe.mjs <ws-url>` is the regression test. Run it after any relay change.
  It exits non-zero on failure. Local: `cd relay && npm run dev`, then probe `ws://127.0.0.1:8787`.
- **App: M0, M1 and most of M2 are done. It builds, runs, and has been proven end to end.**
  A scripted host on the LAN drove a ghost onto this Mac's real desktop through the live relay,
  at 22-24 ms, drawn over other apps, and clicks still went through the overlay to the app
  underneath. Room codes, aim-rect calibration, display picker, trail, tap-to-arm *and*
  hold-to-point, live RTT — all in. Not done: reconnect, tray icon, Windows, signing.
- **Distribution is unsigned, on purpose.** `https://ghost-pointer-app.matewishkey.com` serves a
  universal (Apple silicon + Intel) `.dmg` and the Gatekeeper walkthrough. Signing needs a $99/yr
  Apple Developer account and only buys a clean double-click for someone who isn't mate — it is
  **not** the App Store, and the store is closed to us anyway (`macOSPrivateApi`, issue #3).
- The macOS permission spike came back clean — **neither role needs any permission, and no
  dialog appears on any path the app uses.** Evidence and method: `app/m0-findings.md`;
  instrument: `app/m0-spike/` (throwaway, safe to delete now that M1 stands alone).

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
- **Zero permissions, on both sides, is a hard constraint — not a nice-to-have** (2026-08-31).
  It has survived every feature so far, including typing, and each time only because a design
  was chosen that did not need one. Before adding anything that wants a TCC grant, assume there
  is a design that does not and go find it. See `app/m0-findings.md` for which gestures are free.
- **Annotation is in scope now** (mate, 2026-08-31): click, draw, type. This reverses
  `docs/spec.md` § MVP scope, which still lists it as out — the spec is the relay side's to
  change, so it is tracked in issue #6 rather than edited here.

## Build order

**M0 — the macOS spike. DONE 2026-08-24.** Throwaway code, do not polish.
On the Mac, prove three things and *write down which permission dialogs appear*:
transparent click-through always-on-top window that draws a dot; global cursor position in a
loop; modifier-hold detection. The answer picks the sender UX and the first-run onboarding.

**M1 — loopback. DONE 2026-08-30.** Both roles on one Mac, hardcoded coordinates, against the live relay.
Proves the render loop and the wire format.

**M2 — two machines. Built 2026-08-30, not yet tested with a real guest.** Room codes, aim-rect calibration, display picker. First genuinely
useful build; this is the one mate tests with a guest.

**M3 — feel. Interpolation and the trail are in; the rest is open.** Interpolation between samples, trail tuning, tray icon, reconnect, hotkey config.

## Secrets

**This repo is public and holds zero secrets. Keep it that way.** Nothing encrypted, nothing
"just for local dev", not in a comment, not in a test fixture, not in a commit message.

- **The encrypted operator store is the single source of truth** for every credential this
  project ever needs — SOPS + age, in a private repo, outside this tree. The machine-level
  conventions name it. Never a second copy anywhere: a copy drifts, and a drifted credential
  is worse than none.
- **The Worker gets secrets pushed, never committed:** `wrangler secret put <NAME>`, with the
  value read out of the store. `.dev.vars` is the local equivalent and is gitignored.
- **Signing material** (Apple Developer cert, App Store Connect key, notarisation password,
  any Windows cert) goes in the store and reaches CI as GitHub Actions secrets. It never
  touches the working tree — `.gitignore` blocks the usual extensions as a backstop, but the
  backstop is not the policy.
- **Nothing to store yet.** As of 2026-08-23 this project genuinely has no secrets: the relay
  is unauthenticated by design and its only binding is the `ROOM` Durable Object. The first
  real ones will be macOS signing/notarisation credentials, then a join-token HMAC if the
  relay ever gets auth. Create the store entry when the first one exists, not before.

## Conventions

- Cloudflare account is shared across every project — scope anything destructive by name.
  This project owns exactly one Worker: `ghost-pointer-relay`.
- Never widen the wire protocol without updating `docs/spec.md` in the same commit. Unknown
  `k` values are ignored by design, so additions are backwards-compatible.
- Research findings and their sources live in `docs/research.md`. If a platform claim there
  turns out wrong once tested on real hardware, fix the doc — several of them are explicitly
  marked unverified.
