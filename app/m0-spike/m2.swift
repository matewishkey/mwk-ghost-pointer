// M2 spike — throwaway, same clean-room rules as m0.swift.
//
// One question: can an app with ZERO TCC grants observe the mouse BUTTONS, the way M0 proved
// it can observe the modifier flags? That decides whether "hold the mouse button to draw" is
// reachable on macOS without Input Monitoring.
//
// The modifier poll runs alongside as a POSITIVE CONTROL. M0 measured it working with no
// grants, so if this run sees no modifiers either, the harness is broken and the mouse result
// means nothing.
import CoreGraphics
import ApplicationServices
import Foundation

let logPath = CommandLine.arguments.first(where: { $0.hasPrefix("--log=") })?.dropFirst(6)
var out = ""
func say(_ s: String) {
    print(s)
    out += s + "\n"
    if let p = logPath { try? out.write(toFile: String(p), atomically: true, encoding: .utf8) }
}

let ax = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false] as CFDictionary)
say("baseline TCC   Accessibility=\(ax ? "YES" : "no")  InputMonitoring=\(CGPreflightListenEventAccess() ? "YES" : "no")  PostEvents=\(CGPreflightPostEventAccess() ? "YES" : "no")")
say("(if that line is not all 'no', the clean room is dirty and this run is worthless)")

var sawLeft = false, sawRight = false, sawFlags = false
var leftTicks = 0, rightTicks = 0, flagTicks = 0
let deadline = Date().addingTimeInterval(8)
say("polling CGEventSource.buttonState + flagsState for 8s at 60 Hz…")

while Date() < deadline {
    let l = CGEventSource.buttonState(.combinedSessionState, button: .left)
    let r = CGEventSource.buttonState(.combinedSessionState, button: .right)
    let f = CGEventSource.flagsState(.combinedSessionState)
    if l { sawLeft = true; leftTicks += 1 }
    if r { sawRight = true; rightTicks += 1 }
    // .maskNonCoalesced is always set; ignore it when deciding "a modifier is held".
    if !f.subtracting(.maskNonCoalesced).isEmpty { sawFlags = true; flagTicks += 1 }
    usleep(16000)
}

say("")
say("  left button  observed: \(sawLeft ? "YES" : "no")   (\(leftTicks) ticks held)")
say("  right button observed: \(sawRight ? "YES" : "no")   (\(rightTicks) ticks held)")
say("  modifiers    observed: \(sawFlags ? "YES" : "no")   (\(flagTicks) ticks held)   <- positive control")
say("")
if !sawFlags {
    say("  VERDICT: INCONCLUSIVE — the control never fired, so nothing was pressed or the harness is wrong.")
} else if sawLeft && sawRight {
    say("  VERDICT: mouse buttons ARE readable with zero grants.")
} else {
    say("  VERDICT: modifiers readable, mouse buttons NOT — reading buttons needs a permission.")
}
