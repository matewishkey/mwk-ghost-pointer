#!/bin/bash
# Behavioural click-through test. The click lands on a window the spike itself owns, under the
# spike's own overlay — no other app is ever clicked.
cd "$(dirname "$0")"; D="$PWD"
rm -f clickthru.log
pkill -f 'M0Spike.app/Contents/MacOS/m0' 2>/dev/null; sleep 0.4
CUR=$(./m0 probe --only=nothing 2>/dev/null | grep mouseLocation | head -1)
open -n "$D/M0Spike.app" --args probe --only=clickthru --hold=1 "--log=$D/clickthru.log"
sleep 1.2
XY=$(awk '/CLICKAT/{print $4" "$5}' clickthru.log)
CX=$(echo $XY | cut -d' ' -f1); CY=$(echo $XY | cut -d' ' -f2)
echo ">>> pass 1 click at $CX,$CY"; ./presskey click "$CX" "$CY"
sleep 2.0
echo ">>> pass 2 click at $CX,$CY"; ./presskey click "$CX" "$CY"
sleep 2.5
pkill -f 'M0Spike.app/Contents/MacOS/m0' 2>/dev/null
echo ALLDONE
