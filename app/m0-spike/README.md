# m0-spike — throwaway

Not part of the app. This is the instrument that produced `../m0-findings.md`; it is kept only
so the claims there can be re-run rather than believed. **Do not build on it, do not polish it,
delete it once M1 stands on its own.**

    ./build.sh        # compile + ad-hoc sign M0Spike.app
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
