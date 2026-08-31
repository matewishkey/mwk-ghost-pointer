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

# Windows installers come from CI — nothing on this Mac can build them. `download/windows/` is
# where `gh run download` drops them, and it is gitignored: installers are build output, not
# source. Missing is a hard error rather than a page that quietly offers a dead link.
winexe="$(ls -t "$here"/windows/*.exe 2>/dev/null | head -1 || true)"
winmsi="$(ls -t "$here"/windows/*.msi 2>/dev/null | head -1 || true)"
if [ -z "$winexe" ] || [ -z "$winmsi" ]; then
  echo "no Windows installer in $here/windows/ — fetch the CI artifact first:" >&2
  echo "  gh run download <run-id> -R matewishkey/mwk-ghost-pointer -n ghost-pointer-windows -D download/windows" >&2
  exit 1
fi
# Spaces in a filename become %20 in a URL and break the download attribute in some browsers.
winname="GhostPointer-${version}-windows-setup.exe"
winmsiname="GhostPointer-${version}-windows.msi"
cp "$winexe" "$out/$winname"
cp "$winmsi" "$out/$winmsiname"
winsize="$(du -h "$out/$winname" | cut -f1 | tr -d ' ')"

# The default hotkey is defined once, in main.ts. Read it rather than restating it here — a
# restated fact drifts, and a drifted fact on a download page is a support request.
hotkey="$(sed -n 's/.*DEFAULT_HOTKEY = "\([^"]*\)".*/\1/p' "$repo/app/src/main.ts" | head -1)"

sed -e "s|{{DMG}}|$name|g" \
    -e "s|{{VERSION}}|v$version|g" \
    -e "s|{{SIZE}}|$size|g" \
    -e "s|{{SHA}}|${sha}…|g" \
    -e "s|{{WIN}}|$winname|g" \
    -e "s|{{WINMSI}}|$winmsiname|g" \
    -e "s|{{WINSIZE}}|$winsize|g" \
    -e "s|{{DATE}}|$(date -u +'%-d %b %Y')|g" \
    -e "s|{{HOTKEY}}|$hotkey|g" \
    "$here/template.html" > "$out/index.html"

# Belt and braces: an unsubstituted token would ship a literal {{...}} to the page.
if grep -q '{{' "$out/index.html"; then
  echo "unsubstituted token left in index.html:" >&2
  grep -o '{{[A-Z]*}}' "$out/index.html" | sort -u >&2
  exit 1
fi

echo "$out ready"
echo "  macOS   $name ($size)"
echo "  Windows $winname ($winsize) + $winmsiname"
echo "  hotkey  $hotkey"
