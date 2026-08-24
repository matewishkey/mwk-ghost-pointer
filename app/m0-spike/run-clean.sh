#!/bin/bash
cd "$(dirname "$0")"
D="$PWD"
rm -f clean-*.log clean-*.png
# control-ax LAST-but-one and control-im last, so a granted permission can't contaminate
# the earlier phases. Order matters.
for phase in displays cursor modpoll hotkey tap monitor overlay control-im control-ax; do
  echo "=== $phase ==="
  pkill -f 'M0Spike.app/Contents/MacOS/m0' 2>/dev/null
  sleep 0.4
  open -n "$D/M0Spike.app" --args probe "--only=$phase" "--log=$D/clean-$phase.log"
  sleep 3.5
  screencapture -x -m "$D/clean-$phase.png"
  sleep 0.3
  pkill -f 'M0Spike.app/Contents/MacOS/m0' 2>/dev/null
  sleep 0.4
done
echo ALLDONE
