// presskey — synthesises modifier presses so the spike can be tested without a human.
// Runs from the terminal, which already holds Accessibility/PostEvents. The process being
// TESTED (M0Spike.app) has no permissions, which is the whole point: the TCC gate is on the
// OBSERVER, not on the event's origin.
//   presskey option 2.0     hold ⌥ for 2s
//   presskey hotkey         press ⌃⌥⌘J once
import Cocoa
import Carbon.HIToolbox

let a = CommandLine.arguments
let what = a.count > 1 ? a[1] : "option"
let secs = a.count > 2 ? (Double(a[2]) ?? 2.0) : 2.0
let src = CGEventSource(stateID: .hidSystemState)

func flagsChanged(_ key: CGKeyCode, _ flags: CGEventFlags) {
    // a modifier press is a flagsChanged event, not keyDown/keyUp
    let e = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: true)!
    e.type = .flagsChanged
    e.flags = flags
    e.post(tap: .cghidEventTap)
}

switch what {
case "option":
    print("holding ⌥ for \(secs)s …")
    flagsChanged(CGKeyCode(kVK_Option), [.maskAlternate])
    Thread.sleep(forTimeInterval: secs)
    flagsChanged(CGKeyCode(kVK_Option), [])
    print("released ⌥")
case "hotkey":
    print("pressing ⌃⌥⌘J …")
    let flags: CGEventFlags = [.maskControl, .maskAlternate, .maskCommand]
    let down = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(kVK_ANSI_J), keyDown: true)!
    down.flags = flags; down.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.08)
    let up = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(kVK_ANSI_J), keyDown: false)!
    up.flags = flags; up.post(tap: .cghidEventTap)
    print("released")
case "click":
    // top-left-origin global points
    let x = Double(a[2]) ?? 0, y = Double(a[3]) ?? 0
    let pt = CGPoint(x: x, y: y)
    print("clicking \(Int(x)),\(Int(y)) …")
    let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)!
    down.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.06)
    let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)!
    up.post(tap: .cghidEventTap)
    print("clicked")
default:
    print("usage: presskey option [secs] | presskey hotkey | presskey click <x> <y>"); exit(2)
}
