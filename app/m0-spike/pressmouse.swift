// Synthesises clicks and a modifier hold from THIS trusted terminal, while the untrusted spike
// watches. The TCC gate is on the observer, so driving it from a granted process isolates the
// question properly — same trick as presskey.swift.
//
// Clicks land at a caller-supplied point; pass one that is harmless to click.
import CoreGraphics
import Foundation

let args = CommandLine.arguments
let x = Double(args.count > 1 ? args[1] : "1280") ?? 1280
let y = Double(args.count > 2 ? args[2] : "836") ?? 836
let pt = CGPoint(x: x, y: y)
let src = CGEventSource(stateID: .hidSystemState)

func post(_ type: CGEventType, _ button: CGMouseButton) {
    CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: pt, mouseButton: button)?
        .post(tap: .cghidEventTap)
}

print("clicking at \(Int(x)),\(Int(y))")
Thread.sleep(forTimeInterval: 1.5)

// Hold left for ~1s, so a 60 Hz poller cannot miss it.
post(.leftMouseDown, .left);  Thread.sleep(forTimeInterval: 1.0); post(.leftMouseUp, .left)
Thread.sleep(forTimeInterval: 0.5)
post(.rightMouseDown, .right); Thread.sleep(forTimeInterval: 1.0); post(.rightMouseUp, .right)
Thread.sleep(forTimeInterval: 0.5)

// Positive control: hold Shift for ~1s the same way.
let down = CGEvent(keyboardEventSource: src, virtualKey: 0x38, keyDown: true)
down?.flags = .maskShift
down?.post(tap: .cghidEventTap)
Thread.sleep(forTimeInterval: 1.0)
let up = CGEvent(keyboardEventSource: src, virtualKey: 0x38, keyDown: false)
up?.flags = []
up?.post(tap: .cghidEventTap)
print("done")
