#!/bin/bash
# Compiles the spike and wraps it in an ad-hoc signed .app with its OWN bundle id.
# That bundle id is what makes the clean room clean: launched with `open`, the app is its own
# TCC responsible process and starts with zero grants. A binary run straight from a terminal
# inherits the TERMINAL's grants instead, which silently invalidates every permission result.
set -e
cd "$(dirname "$0")"
BUNDLE=com.mergodon.ghostpointer.m0spike
swiftc -O m0.swift -o m0
swiftc -O pixel.swift -o pixel
swiftc -O presskey.swift -o presskey
rm -rf M0Spike.app
mkdir -p M0Spike.app/Contents/MacOS
cp m0 M0Spike.app/Contents/MacOS/m0
cat > M0Spike.app/Contents/Info.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>m0</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE</string>
  <key>CFBundleName</key><string>Ghost Pointer M0 Spike</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - --identifier "$BUNDLE" M0Spike.app
echo "built M0Spike.app ($BUNDLE)"
