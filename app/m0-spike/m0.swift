// M0 spike — throwaway. Answers three macOS questions for mwk-ghost-pointer.
//   1. transparent, always-on-top, click-through window that draws a dot over other apps
//   2. global cursor position without a permission prompt
//   3. modifier-hold detection — does it need Input Monitoring or Accessibility
// Every phase prints the TCC state before and after, so a prompt can be attributed to a call.
//
// build: swiftc -O m0.swift -o m0
// run:   ./m0 probe          (non-interactive, ~8s)
//        ./m0 live 30        (overlay follows cursor, counts modifier/hotkey events)

import AppKit
import Carbon.HIToolbox
import CoreGraphics

// ---------------------------------------------------------------- reporting

var log: [String] = []
let logPath: String? = CommandLine.arguments.first(where: { $0.hasPrefix("--log=") }).map { String($0.dropFirst(6)) }
let t0 = Date()
func say(_ s: String) {
    let stamped = String(format: "[%6.2fs] ", Date().timeIntervalSince(t0)) + s
    print(stamped)
    log.append(stamped)
    if let p = logPath { try? log.joined(separator: "\n").appending("\n").write(toFile: p, atomically: true, encoding: .utf8) }
}
func hdr(_ s: String) { say(""); say("── \(s) ".padding(toLength: 74, withPad: "─", startingAt: 0)) }

struct TCC: Equatable {
    let ax: Bool, listen: Bool, post: Bool
    static func now() -> TCC {
        TCC(ax: AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false] as CFDictionary),
            listen: CGPreflightListenEventAccess(),
            post: CGPreflightPostEventAccess())
    }
    var line: String { "Accessibility=\(ax ? "GRANTED" : "no")  InputMonitoring=\(listen ? "GRANTED" : "no")  PostEvents=\(post ? "GRANTED" : "no")" }
}

var baseline = TCC.now()
func checkTCC(_ what: String) {
    let n = TCC.now()
    if n == baseline { say("    TCC unchanged after \(what): \(n.line)") }
    else { say("    ** TCC CHANGED after \(what): \(baseline.line)  ->  \(n.line)"); baseline = n }
}

// ---------------------------------------------------------------- overlay

final class DotView: NSView {
    var dot = NSPoint.zero          // view coords
    var extras: [NSPoint] = []      // view coords, fixed markers
    var armed = true
    override var isFlipped: Bool { false }
    override func mouseDown(with e: NSEvent) { overlayHits += 1 }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func draw(_ r: NSRect) {
        NSColor.clear.set(); r.fill()
        for e in extras {
            NSColor(calibratedRed: 1, green: 0.15, blue: 0.35, alpha: 0.95).setFill()
            NSBezierPath(ovalIn: NSRect(x: e.x - 9, y: e.y - 9, width: 18, height: 18)).fill()
        }
        let radius: CGFloat = 11
        // outer glow ring so it reads over any background
        let ring = NSBezierPath(ovalIn: NSRect(x: dot.x - radius - 4, y: dot.y - radius - 4,
                                               width: (radius + 4) * 2, height: (radius + 4) * 2))
        NSColor(calibratedRed: 1, green: 0.15, blue: 0.35, alpha: armed ? 0.30 : 0.10).setFill()
        ring.fill()
        let core = NSBezierPath(ovalIn: NSRect(x: dot.x - radius, y: dot.y - radius,
                                               width: radius * 2, height: radius * 2))
        NSColor(calibratedRed: 1, green: 0.15, blue: 0.35, alpha: armed ? 0.95 : 0.35).setFill()
        core.fill()
        NSColor.white.withAlphaComponent(armed ? 0.9 : 0.3).setStroke()
        core.lineWidth = 2
        core.stroke()
    }
}

final class TargetView: NSView {
    override func draw(_ r: NSRect) {
        NSColor(calibratedRed: 0.15, green: 0.5, blue: 0.9, alpha: 1).setFill(); r.fill()
    }
    override func mouseDown(with e: NSEvent) { targetHits += 1 }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class KeyableWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

final class UnconstrainedWindow: NSWindow {
    // macOS shrinks even a borderless window to the "usable" area unless you refuse.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

final class Overlay {
    let window: NSWindow
    let view = DotView()
    let screen: NSScreen

    init(on screen: NSScreen) {
        self.screen = screen
        window = UnconstrainedWindow(contentRect: screen.frame, styleMask: [.borderless],
                                    backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true                       // click-through
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.screenSaverWindow)))
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        window.setFrame(screen.frame, display: false)
        view.frame = NSRect(origin: .zero, size: screen.frame.size)
        window.contentView = view
        window.orderFrontRegardless()                          // show without stealing focus
    }

    /// place the dot at a global (Cocoa, bottom-left origin) screen point
    func place(_ global: NSPoint) {
        view.dot = NSPoint(x: global.x - screen.frame.origin.x, y: global.y - screen.frame.origin.y)
        view.needsDisplay = true
    }

    /// where that global point lands in the screencapture PNG (top-left origin, device px)
    func devicePixel(for global: NSPoint) -> (Int, Int) {
        let s = screen.backingScaleFactor
        let x = (global.x - screen.frame.origin.x) * s
        let y = (screen.frame.origin.y + screen.frame.height - global.y) * s
        return (Int(x.rounded()), Int(y.rounded()))
    }
}

// ---------------------------------------------------------------- globals for C callbacks

var targetHits = 0
var overlayHits = 0
var hotkeyPresses = 0
var tapFlagEvents = 0
var monitorFlagEvents = 0
var lastMonitorFlags: NSEvent.ModifierFlags = []

// ---------------------------------------------------------------- probe

func phaseIdentity() {
    hdr("0. identity")
    say("    executable        \(CommandLine.arguments[0])")
    say("    bundle id         \(Bundle.main.bundleIdentifier ?? "(none — plain binary, not an .app)")")
    say("    pid               \(getpid())")
    say("    macOS             \(ProcessInfo.processInfo.operatingSystemVersionString)")
    say("    baseline TCC      \(baseline.line)")
    say("    NOTE: TCC attributes a prompt to the RESPONSIBLE process, which for a binary")
    say("          launched from a terminal is the terminal app, not this binary.")
}

func phaseDisplays() {
    hdr("1. displays  (viewer's display picker + spec `geo`)")
    for (i, s) in NSScreen.screens.enumerated() {
        let f = s.frame, sc = s.backingScaleFactor
        say("    [\(i)] \(s.localizedName)")
        say("         frame(points)  x=\(f.origin.x) y=\(f.origin.y) w=\(f.width) h=\(f.height)")
        say("         backingScale   \(sc)   ->  device px  \(Int(f.width * sc))x\(Int(f.height * sc))")
        say("         visibleFrame   \(s.visibleFrame)")
    }
    say("    main screen       \(NSScreen.main?.localizedName ?? "?")")
    checkTCC("NSScreen enumeration")
}

func phaseCursor() {
    hdr("2. global cursor position  (Q2)")
    let start = NSEvent.mouseLocation
    say("    NSEvent.mouseLocation      \(start)   (Cocoa, bottom-left origin, POINTS)")
    if let e = CGEvent(source: nil) {
        say("    CGEvent(source:nil).location \(e.location)   (Quartz, top-left origin, POINTS)")
    }
    say("    -> both are POINTS, not device pixels. Multiply by backingScaleFactor for pixels.")

    // move the cursor ourselves and confirm the poll tracks it. CGWarpMouseCursorPosition is
    // not event posting, so it should not need Accessibility — that is itself a finding.
    guard let screen = NSScreen.main else { return }
    let f = screen.frame
    let targets = [NSPoint(x: f.midX - 200, y: f.midY - 120),
                   NSPoint(x: f.midX + 200, y: f.midY + 120),
                   NSPoint(x: f.minX + 60,  y: f.maxY - 60)]
    var tracked = 0
    say("    warping cursor and re-polling:")
    for t in targets {
        // CGWarp takes top-left-origin points
        let q = CGPoint(x: t.x, y: f.origin.y + f.height - t.y)
        CGWarpMouseCursorPosition(q)
        CGAssociateMouseAndMouseCursorPosition(1)
        usleep(120_000)
        let got = NSEvent.mouseLocation
        let ok = abs(got.x - t.x) < 2 && abs(got.y - t.y) < 2
        if ok { tracked += 1 }
        say("       warp to \(Int(t.x)),\(Int(t.y))  ->  polled \(Int(got.x)),\(Int(got.y))   \(ok ? "MATCH" : "MISMATCH")")
    }
    say("    tracking: \(tracked)/\(targets.count) matched")
    CGWarpMouseCursorPosition(CGPoint(x: start.x, y: f.origin.y + f.height - start.y))
    checkTCC("mouseLocation polling + CGWarpMouseCursorPosition")
}

func phaseModifierPoll() {
    hdr("3a. modifier state by POLLING  (Q3, no event delivery)")
    let flags = NSEvent.modifierFlags
    say("    NSEvent.modifierFlags (class property) = \(describe(flags))")
    say("    This is a snapshot of CURRENT hardware modifier state, no event stream, no monitor.")
    say("    (nothing held right now, so an empty set is expected — `live` mode proves delivery)")
    checkTCC("NSEvent.modifierFlags poll")
}

func phaseHotkey() {
    hdr("3b. Carbon RegisterEventHotKey  (what Tauri's global-shortcut plugin uses)")
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let installStatus = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
        hotkeyPresses += 1
        return noErr
    }, 1, &spec, nil, nil)
    say("    InstallEventHandler   OSStatus=\(installStatus) \(installStatus == noErr ? "(ok)" : "(FAILED)")")

    var ref: EventHotKeyRef?
    let id = EventHotKeyID(signature: OSType(0x4D305350), id: 1)   // 'M0SP'
    let status = RegisterEventHotKey(UInt32(kVK_ANSI_J), UInt32(controlKey | optionKey | cmdKey), id,
                                     GetApplicationEventTarget(), 0, &ref)
    say("    RegisterEventHotKey ⌃⌥⌘J  OSStatus=\(status) \(status == noErr ? "(REGISTERED)" : "(FAILED)")")
    checkTCC("RegisterEventHotKey")
}

func phaseEventTap() {
    hdr("3c. CGEvent tap on .flagsChanged  (listen-only)")
    say("    calling CGEvent.tapCreate — if Input Monitoring is required and not granted,")
    say("    this returns nil and macOS may raise a TCC dialog.")
    let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)
    let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                options: .listenOnly, eventsOfInterest: mask,
                                callback: { _, _, event, _ in
                                    tapFlagEvents += 1
                                    return Unmanaged.passUnretained(event)
                                }, userInfo: nil)
    if let tap {
        say("    tapCreate -> NON-NIL  (tap created; no Input Monitoring grant was needed to create it)")
        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    } else {
        say("    tapCreate -> nil  (REFUSED — this path needs Input Monitoring)")
    }
    checkTCC("CGEvent.tapCreate")
}

func phaseGlobalMonitor() {
    hdr("3d. NSEvent.addGlobalMonitorForEvents(.flagsChanged)")
    let m = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged]) { e in
        monitorFlagEvents += 1
        lastMonitorFlags = e.modifierFlags
    }
    say("    monitor object -> \(m == nil ? "nil" : "non-nil")")
    say("    NOTE: this API returns non-nil whether or not it is permitted; it just silently")
    say("          delivers nothing when it isn't. Only an actual keypress separates the two.")
    checkTCC("addGlobalMonitorForEvents")
}

func phaseOverlay() -> Overlay? {
    hdr("1. overlay window  (Q1)")
    // screens[0] is display 1, which is what `screencapture -D 1` grabs. NSScreen.main
    // follows keyboard focus and can be the OTHER display — that mismatch silently made an
    // earlier run capture a screen the dot was never drawn on.
    guard let screen = NSScreen.screens.first else { say("    no screen"); return nil }
    say("    drawing on \(screen.localizedName)  (NSScreen.main is \(NSScreen.main?.localizedName ?? "?"))")
    let o = Overlay(on: screen)
    let target = NSPoint(x: screen.frame.midX, y: screen.frame.midY)
    if CommandLine.arguments.contains("--corners") {
        let w = screen.frame.width, h = screen.frame.height, m: CGFloat = 12
        o.view.extras = [NSPoint(x: m, y: m), NSPoint(x: w - m, y: m),
                         NSPoint(x: m, y: h - m), NSPoint(x: w - m, y: h - m)]
        for e in o.view.extras {
            let g = NSPoint(x: e.x + screen.frame.origin.x, y: e.y + screen.frame.origin.y)
            let (cx, cy) = o.devicePixel(for: g)
            say("CORNER \(cx) \(cy)")
        }
    }
    o.place(target)
    o.view.display()
    say("    window level      \(o.window.level.rawValue)  (screenSaver = \(CGWindowLevelForKey(.screenSaverWindow)))")
    say("    isOpaque          \(o.window.isOpaque)")
    say("    backgroundColor   \(o.window.backgroundColor)")
    say("    ignoresMouseEvents \(o.window.ignoresMouseEvents)")
    say("    sharingType       \(o.window.sharingType.rawValue)  (0=none 1=readOnly 2=readWrite; readOnly means it DOES show in a screen share)")
    say("    isVisible         \(o.window.isVisible)")
    say("    windowNumber      \(o.window.windowNumber)")

    // independent confirmation from the window server. The earlier "NOT FOUND" was this
    // query racing the window server — it needs a beat after orderFrontRegardless().
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.4))
    if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] {
        let mine = list.first { ($0[kCGWindowNumber as String] as? Int) == o.window.windowNumber }
        if let m = mine {
            say("    CGWindowList: ON-SCREEN, layer=\(m[kCGWindowLayer as String] ?? "?") alpha=\(m[kCGWindowAlpha as String] ?? "?") bounds=\(m[kCGWindowBounds as String] ?? "?")")
            let idx = list.firstIndex { ($0[kCGWindowNumber as String] as? Int) == o.window.windowNumber } ?? -1
            say("    front-to-back index \(idx) of \(list.count) on-screen windows (0 = frontmost)")
        } else {
            say("    CGWindowList: NOT FOUND among on-screen windows")
        }
    }
    // BEHAVIOURAL click-through test: ask the window server which window owns the point.
    // ignoresMouseEvents=true is a property; this is the property actually taking effect.
    // The second half is the positive control — flip it off and the same query must find US,
    // otherwise the query proves nothing.
    let probe = NSPoint(x: screen.frame.midX, y: screen.frame.midY)
    let hitThrough = NSWindow.windowNumber(at: probe, belowWindowWithWindowNumber: 0)
    o.window.ignoresMouseEvents = false
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.3))
    let hitBlocking = NSWindow.windowNumber(at: probe, belowWindowWithWindowNumber: 0)
    o.window.ignoresMouseEvents = true
    say("    click-through hit-test at \(Int(probe.x)),\(Int(probe.y)):")
    say("       ignoresMouseEvents=true  -> window \(hitThrough)  \(hitThrough == o.window.windowNumber ? "US (NOT click-through!)" : "someone else — CLICK PASSES THROUGH")")
    say("       ignoresMouseEvents=false -> window \(hitBlocking)  \(hitBlocking == o.window.windowNumber ? "US (control OK: the test can see us)" : "someone else (CONTROL FAILED — test is meaningless)")")

    let (px, py) = o.devicePixel(for: target)
    say("    dot drawn at global point \(Int(target.x)),\(Int(target.y))  ->  capture pixel \(px),\(py)")
    say("PIXEL \(px) \(py)")            // machine-readable for the verifier
    checkTCC("borderless transparent always-on-top click-through NSWindow")
    return o
}

// POSITIVE CONTROLS — these are SUPPOSED to raise a TCC dialog. If the harness cannot
// catch these, it could never have caught a surprise one, and every "no dialog" is worthless.
func phaseControlAX() {
    hdr("CONTROL-A. AXIsProcessTrustedWithOptions(prompt: TRUE) — must raise the Accessibility dialog")
    let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    say("    returned \(trusted)  — a dialog should be on screen now if not already trusted")
    checkTCC("AX prompt")
}
func phaseControlIM() {
    hdr("CONTROL-B. CGRequestListenEventAccess() — must raise the Input Monitoring dialog")
    let ok = CGRequestListenEventAccess()
    say("    returned \(ok)  — a dialog should be on screen now if not already granted")
    checkTCC("Input Monitoring request")
}

// Click-through, tested behaviourally and WITHOUT touching any other app: the click lands on
// a window this same process owns, sitting under this same process's overlay. Two passes, the
// second of which is the control — with click-through off, the overlay must swallow the click,
// otherwise the test cannot tell the two states apart and proves nothing.
func phaseClickThrough() {
    hdr("Q1b. click-through — behavioural, self-contained")
    guard let screen = NSScreen.screens.first else { return }
    let side: CGFloat = 360
    let rect = NSRect(x: screen.frame.midX - side/2, y: screen.frame.midY - side/2, width: side, height: side)
    let target = KeyableWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
    target.contentView = TargetView()
    target.level = .floating                  // above other apps, below our overlay
    target.ignoresMouseEvents = false
    target.orderFrontRegardless()

    let o = Overlay(on: screen)               // level 1000, ignoresMouseEvents = true
    o.place(NSPoint(x: rect.midX, y: rect.midY))
    say("    target window (ours) at \(Int(rect.minX)),\(Int(rect.minY)) \(Int(side))x\(Int(side)), level .floating")
    say("    overlay above it at level \(o.window.level.rawValue), ignoresMouseEvents=true")
    let q = CGPoint(x: rect.midX, y: screen.frame.origin.y + screen.frame.height - rect.midY)
    say("CLICKAT \(Int(q.x)) \(Int(q.y))")
    say("    >>> PASS 1 (click-through ON) — click now")
    pumpApp(2.2)
    say("    PASS 1 result: target=\(targetHits) overlay=\(overlayHits)  -> \(targetHits > 0 && overlayHits == 0 ? "CLICK PASSED THROUGH" : "no")")

    targetHits = 0; overlayHits = 0
    o.window.ignoresMouseEvents = false
    say("    >>> PASS 2 (control: click-through OFF) — click now")
    pumpApp(2.2)
    say("    PASS 2 result: target=\(targetHits) overlay=\(overlayHits)  -> \(overlayHits > 0 && targetHits == 0 ? "OVERLAY BLOCKED IT (control OK)" : "CONTROL FAILED — test proves nothing")")
    checkTCC("click-through test")
    target.orderOut(nil)
}

func pump(_ seconds: Double) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02)) }
}

/// Pumping the runloop is NOT enough to deliver mouse events to windows — AppKit only routes
/// them when NSApplication dequeues and sends them, which normally happens inside app.run().
func pumpApp(_ seconds: Double) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if let e = NSApp.nextEvent(matching: .any, until: Date().addingTimeInterval(0.02),
                                   inMode: .default, dequeue: true) {
            NSApp.sendEvent(e)
        }
    }
}

func describe(_ f: NSEvent.ModifierFlags) -> String {
    var p: [String] = []
    if f.contains(.command) { p.append("⌘cmd") }
    if f.contains(.option) { p.append("⌥option") }
    if f.contains(.control) { p.append("⌃control") }
    if f.contains(.shift) { p.append("⇧shift") }
    if f.contains(.function) { p.append("fn") }
    if f.contains(.capsLock) { p.append("caps") }
    return p.isEmpty ? "(none)" : p.joined(separator: "+")
}

// ---------------------------------------------------------------- main

let app = NSApplication.shared
app.setActivationPolicy(.accessory)          // no dock icon, no menu bar takeover

let only = CommandLine.arguments.first(where: { $0.hasPrefix("--only=") }).map { String($0.dropFirst(7)) }
func want(_ name: String) -> Bool { only == nil || only == name }
let positional = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("--") }
let mode = positional.first ?? "probe"
let liveSeconds = positional.count > 1 ? (Double(positional[1]) ?? 30) : 30

say("Ghost Pointer — M0 macOS spike   mode=\(mode)")
say("only=\(only ?? "(all phases)")")
phaseIdentity()
if want("displays") { phaseDisplays() }
if want("cursor")   { phaseCursor() }
if want("modpoll")  { phaseModifierPoll() }
if want("hotkey")   { phaseHotkey() }
if want("tap")      { phaseEventTap() }
if want("monitor")  { phaseGlobalMonitor() }
if only == "clickthru" { phaseClickThrough() }
if only == "control-ax" { phaseControlAX() }
if only == "control-im" { phaseControlIM() }
let noOverlay = CommandLine.arguments.contains("--no-overlay")
let overlay = (want("overlay") && !noOverlay) ? phaseOverlay() : nil

let probeHold = Double(CommandLine.arguments.first(where: { $0.hasPrefix("--hold=") }).map { String($0.dropFirst(7)) } ?? "") ?? 6
if mode == "probe" {
    hdr("holding for \(Int(probeHold))s so an external screencapture can prove it renders")
    say("    (also gives any TCC dialog time to appear in that capture)")
    let deadline = Date().addingTimeInterval(probeHold)
    while Date() < deadline { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
    hdr("results")
    say("    hotkey ⌃⌥⌘J presses seen   \(hotkeyPresses)")
    say("    event-tap flagsChanged     \(tapFlagEvents)")
    say("    global-monitor flagsChanged \(monitorFlagEvents)")
    say("    final TCC: \(TCC.now().line)")
    exit(0)
}

// live: follow the cursor, count modifier events, report continuously
hdr("live mode — \(Int(liveSeconds))s. Move the mouse. Hold ⌥. Press ⌃⌥⌘J.")
var lastPolledFlags: NSEvent.ModifierFlags = []
var pollSawModifier = false
var frames = 0
let started = Date()
let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { _ in
    frames += 1
    let p = NSEvent.mouseLocation
    let f = NSEvent.modifierFlags.intersection(.deviceIndependentFlagsMask)
    if f != lastPolledFlags {
        lastPolledFlags = f
        if !f.isEmpty { pollSawModifier = true }
        say("    [poll  \(String(format: "%5.1fs", Date().timeIntervalSince(started)))] modifierFlags -> \(describe(f))")
    }
    overlay?.view.armed = f.contains(.option)
    overlay?.place(p)
    if frames % 120 == 0 {
        say("    [\(String(format: "%5.1fs", Date().timeIntervalSince(started)))] cursor \(Int(p.x)),\(Int(p.y))  poll=\(describe(f))  monitor=\(monitorFlagEvents) tap=\(tapFlagEvents) hotkey=\(hotkeyPresses)")
    }
    if Date().timeIntervalSince(started) > liveSeconds {
        hdr("live results")
        say("    frames rendered              \(frames)")
        say("    polling saw a held modifier  \(pollSawModifier ? "YES" : "no")")
        say("    global monitor flagsChanged  \(monitorFlagEvents)  (last: \(describe(lastMonitorFlags)))")
        say("    event tap flagsChanged       \(tapFlagEvents)")
        say("    hotkey ⌃⌥⌘J presses           \(hotkeyPresses)")
        say("    final TCC: \(TCC.now().line)")
        exit(0)
    }
}
RunLoop.current.add(timer, forMode: .common)
app.run()
