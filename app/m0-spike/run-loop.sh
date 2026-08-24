#!/bin/bash
# End-to-end: node sender -> live relay -> Swift overlay. Verified by pixel, not by eye.
cd "$(dirname "$0")"; D="$PWD"
rm -f view.log loop-*.png
pkill -f 'M0Spike.app/Contents/MacOS/m0' 2>/dev/null; sleep 0.4
open -n "$D/M0Spike.app" --args view GHSTPT "--log=$D/view.log"
sleep 2.0
node test-sender.mjs GHSTPT hold "$1" "$2" > sender.out 2>&1 &
SP=$!
sleep 3.0
screencapture -x -D 1 loop-hold.png
kill $SP 2>/dev/null
sleep 0.3
pkill -f 'M0Spike.app/Contents/MacOS/m0' 2>/dev/null
echo ALLDONE
