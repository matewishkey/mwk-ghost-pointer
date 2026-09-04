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
   last silently wins. `download/` is built on the Mac — only a Mac can build a Mac app — and
   deployed from Linux, which holds the Cloudflare token. The `.dmg` travels between them on the
   shared drive, never through git.

   **The Mac drives that deploy over SSH**, and that is the intended route, not a workaround
   (mate, 3 Sep: *"always push the new version to the website do not hold it back"*). It builds,
   copies the assembled site to the share, then runs `wrangler` **on the dev box**, so the one
   deployer rule still holds and the token never leaves the machine that owns it:

       ssh mergodon@192.168.172.25
       cd ~/projects/td-sops && set -a && eval "$(sops -d apps/claude-cloudflare.enc.env | grep -E '^CLOUDFLARE_')" && set +a
       cd ~/share/work/mat-<repo>/<slug>/site-<version> && wrangler pages deploy . --project-name ghost-pointer-app

   This Mac **does** hold an age key (registered 4 Sep), but it is scoped to the `td-pw` registry
   alone and cannot decrypt the Cloudflare token. `.sops.yaml` in `td-sops` says observer Macs are
   never added to an `apps/` rule — do not widen it to save an SSH hop.

   **Verify a deploy by content, never by status code.** Pages answers `200` with `index.html`
   for a file that has not propagated yet, which produced a false "verified" during the 4 Sep
   session. Compare bytes or content type.
5. **Coordinate through GitHub Issues**, not through the docs. Both machines have `gh`. An
   issue is the only channel that reaches the other session, since neither can see the other's
   conversation.

## State as of 2026-09-04

- **This repo is public** (`matewishkey/mwk-ghost-pointer`). Nothing secret has ever been in
  it — history was scanned before publishing. Keep it that way: no account ids, no tokens, no
  keys, not even in a comment or a test fixture.
- Relay live at `wss://ghost-pointer-relay.mergodon.workers.dev`, 13/13 probe checks passing
  over the internet. RTT from Brisbane has ranged p50 17-40 ms / p95 22-47 ms across runs on
  different days — quote the range, not one measurement.
- **A room holds one pointer and one viewer and refuses everyone else** (4 Sep). This, not code
  length, is what stops someone with a correct code joining a live session — they cannot watch
  and cannot send. Codes are 10 chars now (6-12 accepted, so installed builds keep working).
  **It has a cost:** someone who takes the free seat *before* your guest arrives locks the
  legitimate person out, which is a denial-of-service the open design did not have. The endpoint
  is still unauthenticated, and the signed join token is still the real fix — issue #4.
- `node tools/probe.mjs <ws-url>` is the regression test. Run it after any relay change.
  It exits non-zero on failure. Local: `cd relay && npm run dev`, then probe `ws://127.0.0.1:8787`.
- **App: M0-M2 done, and most of M3.** Proven end to end: a scripted host drove a ghost onto a
  real desktop through the live relay, drawn over other apps, with clicks still passing through
  the overlay. In: room codes, aim calibration, display picker, trail, interpolation, tap-to-arm
  and hold-to-point, live RTT, **reconnect with backoff**, **click pulses**, **text marks with a
  Copy button on the guest side**, settings in a JSON file, session logging with a 5 s heartbeat.
  Not done: tray icon, Windows, signing, ink/drawing, and marks do not survive a rejoin.
- **The 3 Sep client call is the reference bug report** — laggy, dropped, stopped working. Causes
  and, importantly, the one theory that was *disproven* are in `app/CLAUDE.md`. Read it before
  re-investigating lag: webview throttling under occlusion is measurably not the cause, and the
  remaining lag has no identified root cause.
- **Windows: built, published, withdrawn** (31 Aug). It locked up a real machine — the overlay
  covered the screen and ate every click. Diagnosis and the unverified fix are in
  `app/CLAUDE.md` § Windows; read it before touching that path. macOS is unaffected and is what
  the site serves.
- **Distribution is unsigned, on purpose.** `https://ghost-pointer-app.matewishkey.com` serves a
  universal (Apple silicon + Intel) `.dmg` and the Gatekeeper walkthrough. Every release is
  published there immediately — see rule 4 above; do not leave a build sitting on the share. Signing needs a $99/yr
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
- **Annotation is in scope** (mate, 2026-08-31): click, draw, type. `docs/spec.md` now carries
  `c`, `txt` and `clr`, so the reversal is recorded in the contract rather than only in an issue.
  Ink strokes and stored marks are still out — issue #6.
- **A pulse is a key or a side button, never a plain click** (mate, 3 Sep). Reading a click costs
  no permission but the app cannot *consume* one, so it still lands in whatever window is under
  the cursor and runs it. That was found in real use, not in review.
- **The guest's escape hotkey is never the host's arm key** (4 Sep). The guest registers one
  global shortcut and it disconnects them, so it has to be a chord nobody hits by accident.
  Unifying them ended a live client session mid-call.

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
