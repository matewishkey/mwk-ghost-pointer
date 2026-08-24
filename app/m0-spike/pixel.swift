// pixel <png> <x> <y> [radius] — reads pixels out of a PNG. Image decoding, not screen capture.
import AppKit

let a = CommandLine.arguments
guard a.count >= 4, let img = NSImage(contentsOfFile: a[1]),
      let rep = img.representations.first as? NSBitmapImageRep,
      let x = Int(a[2]), let y = Int(a[3]) else {
    print("usage: pixel <png> <x> <y> [radius]"); exit(2)
}
let r = a.count > 4 ? (Int(a[4]) ?? 0) : 0
print("image \(rep.pixelsWide)x\(rep.pixelsHigh)")
var best = (score: -1.0, x: 0, y: 0, desc: "")
for dy in -r...r {
    for dx in -r...r {
        let px = x + dx, py = y + dy
        guard px >= 0, py >= 0, px < rep.pixelsWide, py < rep.pixelsHigh,
              let c = rep.colorAt(x: px, y: py)?.usingColorSpace(.deviceRGB) else { continue }
        let R = c.redComponent, G = c.greenComponent, B = c.blueComponent
        // how much does this look like the dot (strong red, weak green)?
        let score = R - max(G, B)
        if score > best.score {
            best = (score, px, py, String(format: "rgb(%.0f,%.0f,%.0f)", R*255, G*255, B*255))
        }
    }
}
if let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) {
    print(String(format: "center  (%d,%d) rgb(%.0f,%.0f,%.0f)", x, y, c.redComponent*255, c.greenComponent*255, c.blueComponent*255))
}
print("reddest (\(best.x),\(best.y)) \(best.desc)  redness=\(String(format: "%.2f", best.score))  offset=(\(best.x - x),\(best.y - y))")
print(best.score > 0.35 ? "VERDICT: dot found" : "VERDICT: no dot at this location")
