// An instantaneous click: down and up posted back to back, no hold. This is the shape a 60 Hz
// poll cannot see, and the reason the event counter exists in this codebase.
import CoreGraphics
import Foundation
let x = Double(CommandLine.arguments[1])!, y = Double(CommandLine.arguments[2])!
let n = Int(CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "3")!
let pt = CGPoint(x: x, y: y)
let src = CGEventSource(stateID: .hidSystemState)
Thread.sleep(forTimeInterval: 1.5)
for _ in 0..<n {
  CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseUp,   mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
  Thread.sleep(forTimeInterval: 0.4)
}
print("posted \(n) instantaneous clicks")
