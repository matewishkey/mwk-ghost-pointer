# m0-spike — throwaway

Not part of the app. This is the instrument that produced `../m0-findings.md`; it is kept only
so the claims there can be re-run rather than believed. **Do not build on it, do not polish it,
delete it once M1 stands on its own.**

    ./build.sh        # compile + ad-hoc sign M0Spike.app

## Two-machine test rig (added 2026-08-25)

The spike also speaks the real wire protocol, so the whole path can be exercised before the
Tauri app exists — and, once it does, the app can be tested against an end that is not itself.

    open -n M0Spike.app --args view GHSTPT --log=$PWD/view.log   # viewer: draws what arrives
    python3 -m http.server 8765 --bind 0.0.0.0                   # serve sender.html to the LAN
    # then open http://<this-mac>:8765/sender.html on any other machine and move the pointer

    ./run-loop.sh 0.25 0.25   # headless end-to-end check, verified by pixel

`sender.html` is a browser sender (no install on the other machine). `test-sender.mjs` is the
same thing headless, for verifying without a human hand. Verified 2026-08-25: `0.25,0.25`
landed on screen point `640,1080` on a 2560x1440 display, confirmed by pixel.

**Two things this rig does NOT prove.** The sender is a *page*, so no real global cursor is
read — that is the app's job. And it assumes normalised `y = 0` means **top**; `docs/spec.md`
does not state the origin (issue #5). Both ends here agree, so it works; if the spec settles
the other way, one line changes in each.

    ./run-clean.sh    # one process per phase -> clean-<phase>.log
    ./run-deliver.sh  # modifier-delivery test -> deliver.log

## The one idea worth keeping

**A binary launched from a terminal inherits the terminal's TCC grants.** iTerm2 on this
machine holds Accessibility, Input Monitoring and Post Events, so the first version of this
spike reported "no permission needed" for every API — including the ones that definitely need
permission. The result was pure noise.

`build.sh` therefore wraps the binary in an ad-hoc signed `.app` with its own bundle id, and
the runners launch it with `open`, making it its own TCC responsible process. Every run prints
its own baseline; if it does not say

    baseline TCC   Accessibility=no  InputMonitoring=no  PostEvents=no

then the clean room is dirty and the run is worthless. Check that line first, always.

Two habits are baked in and worth carrying to M1:

- **Positive controls.** `--only=control-ax` deliberately triggers a permission request, to
  prove the harness can detect one. "No dialog appeared" means nothing from a harness that has
  never caught a dialog. Note it opens System Settings — don't run it on a screen someone is
  sharing.
- **Verify by pixel, not by eye.** The spike prints the device pixel its dot should land on;
  `pixel` reads that pixel back out of an external screencapture. The same check against
  display 2 (where nothing was drawn) is the negative control.

`presskey` synthesises modifier events from *this* trusted terminal while the untrusted app
watches — the TCC gate is on the observer, so that isolates the question properly.
