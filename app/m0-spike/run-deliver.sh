#!/bin/bash
cd "$(dirname "$0")"; D="$PWD"
rm -f deliver.log
pkill -f 'M0Spike.app/Contents/MacOS/m0' 2>/dev/null; sleep 0.4
# observer = the signed app with ZERO permissions. no overlay: nothing drawn on screen.
open -n "$D/M0Spike.app" --args live 10 "--no-overlay" "--log=$D/deliver.log"
sleep 2.5
echo ">>> synthesising ⌥ hold"
./presskey option 2.0
sleep 1.0
echo ">>> synthesising ⌃⌥⌘J"
./presskey hotkey
sleep 5.0
pkill -f 'M0Spike.app/Contents/MacOS/m0' 2>/dev/null
echo ALLDONE
