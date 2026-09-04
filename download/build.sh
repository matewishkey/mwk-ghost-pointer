#!/usr/bin/env bash
# Assemble the download site into download/public/.
#
# Run on the Mac, after `npm run tauri build -- --target universal-apple-darwin`. The Linux box
# deploys what this produces — it cannot build a Mac app, and this Mac has no Cloudflare token.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
out="$here/public"

dmg="$(ls -t "$repo"/app/src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)"
[ -n "$dmg" ] || { echo "no universal .dmg — run: cd app && npm run tauri build -- --target universal-apple-darwin" >&2; exit 1; }

version="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$repo/app/src-tauri/tauri.conf.json" | head -1)"
name="GhostPointer-${version}-universal.dmg"

rm -rf "$out"; mkdir -p "$out"
cp "$dmg" "$out/$name"
cp "$repo/app/public/brand/mwk-block-512.png" "$out/"
# Calibration target for the test plan. Deliberately not linked from index.html — it is an
# instrument, not a page anyone browsing needs. Public so a guest anywhere can open it.
cp "$here/target.html" "$out/"

size="$(du -h "$out/$name" | cut -f1 | tr -d ' ')"
sha="$(shasum -a 256 "$out/$name" | cut -c1-16)"

# No Windows installer is published right now — the 31 Aug build stopped responding on a real
# machine and was withdrawn the same evening. The CI workflow still builds it, and it has since
# been run on real Windows hardware (1 Sep). The gate is no longer "has it run" but "has a human
# confirmed the hang and cursor fixes on screen" — see app/CLAUDE.md § Windows.

# The default hotkey is defined once, in main.ts. Read it rather than restating it here — a
# restated fact drifts, and a drifted fact on a download page is a support request.
hotkey="$(sed -n 's/.*DEFAULT_HOTKEY = "\([^"]*\)".*/\1/p' "$repo/app/src/main.ts" | head -1)"
pulsekey="$(sed -n 's/.*DEFAULT_PULSE_KEY = "\([^"]*\)".*/\1/p' "$repo/app/src/main.ts" | head -1)"

sed -e "s|{{DMG}}|$name|g" \
    -e "s|{{VERSION}}|v$version|g" \
    -e "s|{{SIZE}}|$size|g" \
    -e "s|{{SHA}}|${sha}…|g" \
    -e "s|{{DATE}}|$(date -u +'%-d %b %Y')|g" \
    -e "s|{{HOTKEY}}|$hotkey|g" \
    -e "s|{{PULSEKEY}}|$pulsekey|g" \
    "$here/template.html" > "$out/index.html"

# Withdrawn downloads have to be redirected, not merely deleted.
#
# Cloudflare Pages keeps an asset addressable across deployments in a project: removing a file
# from the uploaded directory does NOT stop it being served, which is how a broken Windows build
# stayed downloadable after being "pulled" on 31 Aug. Pages also answers 200 with index.html for
# anything it cannot find, so a status-code check cannot tell you either way — compare content.
cat > "$out/_redirects" <<'REDIR'
# Windows 0.1.0 made the whole desktop unresponsive. Send anyone holding a direct link to the
# page, which explains why it is gone, rather than to a file that will lock their machine.
/GhostPointer-0.1.0-windows-setup.exe  /  302
/GhostPointer-0.1.0-windows.msi        /  302
REDIR

# Belt and braces: an unsubstituted token would ship a literal {{...}} to the page.
if grep -q '{{' "$out/index.html"; then
  echo "unsubstituted token left in index.html:" >&2
  grep -o '{{[A-Z]*}}' "$out/index.html" | sort -u >&2
  exit 1
fi

echo "$out ready — $name ($size), hotkey $hotkey"
