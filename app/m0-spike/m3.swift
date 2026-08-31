// M3 spike — throwaway, same clean-room rules as m0/m2.
//
// M2 proved the mouse buttons are readable with no permission. Building on it exposed the flaw
// in *polling* them: a click shorter than one tick is never observed at all. A synthesised
// click is missed outright, and a trackpad tap is not far off.
//
// CGEventSourceCounterForEventType counts events rather than sampling state, so a click that
// began and ended between two ticks still shows up as +1. Question: does it need a permission?
import CoreGraphics
import ApplicationServices
import Foundation

let logPath = CommandLine.arguments.first(where: { $0.hasPrefix("--log=") })?.dropFirst(6)
var out = ""
func say(_ s: String) {
    print(s); out += s + "\n"
    if let p = logPath { try? out.write(toFile: String(p), atomically: true, encoding: .utf8) }
}

let ax = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false] as CFDictionary)
say("baseline TCC   Accessibility=\(ax ? "YES" : "no")  InputMonitoring=\(CGPreflightListenEventAccess() ? "YES" : "no")  PostEvents=\(CGPreflightPostEventAccess() ? "YES" : "no")")
say("(if that line is not all 'no', the clean room is dirty and this run is worthless)")

func downs() -> UInt32 {
    CGEventSource.counterForEventType(.combinedSessionState, eventType: .leftMouseDown)
}

let start = downs()
if start == 0 { say("NOTE: counter reads 0 at start — may be unsupported, watch whether it moves") }

var polledSaw = false
var counterDelta: UInt32 = 0
let deadline = Date().addingTimeInterval(8)
say("polling buttonState AND the event counter for 8s at 60 Hz…")
while Date() < deadline {
    if CGEventSource.buttonState(.combinedSessionState, button: .left) { polledSaw = true }
    counterDelta = downs() &- start
    usleep(16000)
}

say("")
say("  clicks the 60 Hz POLL noticed:     \(polledSaw ? "at least one" : "NONE")")
say("  clicks the COUNTER noticed:        \(counterDelta)")
say("")
if counterDelta > 0 && !polledSaw {
    say("  VERDICT: the counter catches clicks the poll misses entirely, with zero grants.")
} else if counterDelta > 0 {
    say("  VERDICT: counter works with zero grants (poll also happened to catch these).")
} else {
    say("  VERDICT: counter saw nothing — either nothing was clicked, or it needs a permission.")
}
