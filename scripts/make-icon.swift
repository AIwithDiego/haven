import AppKit

// A small native vector mark, rendered at every macOS icon size.
let destination = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("build/Haven.iconset")
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
let sizes = [("icon_16x16.png", 16), ("icon_16x16@2x.png", 32), ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64), ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256), ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512), ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024)]
let dark = NSColor(srgbRed: 0.12, green: 0.23, blue: 0.20, alpha: 1)
let mint = NSColor(srgbRed: 0.65, green: 0.85, blue: 0.75, alpha: 1)
for (name, size) in sizes {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let context = NSGraphicsContext.current!.cgContext
    context.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
    let tile = NSBezierPath(roundedRect: NSRect(x: 64, y: 64, width: 896, height: 896), xRadius: 200, yRadius: 200)
    NSGradient(starting: dark, ending: NSColor(srgbRed: 0.23, green: 0.40, blue: 0.32, alpha: 1))!.draw(in: tile, angle: 70)
    let circle = NSBezierPath(ovalIn: NSRect(x: 264, y: 264, width: 496, height: 496))
    NSGraphicsContext.saveGraphicsState()
    circle.addClip()
    mint.setFill(); circle.fill()
    let sky = NSBezierPath()
    sky.move(to: NSPoint(x: 250, y: 432)); sky.line(to: NSPoint(x: 780, y: 626))
    sky.line(to: NSPoint(x: 780, y: 780)); sky.line(to: NSPoint(x: 250, y: 780)); sky.close()
    dark.setFill(); sky.fill()
    NSGraphicsContext.restoreGraphicsState()
    mint.setStroke(); circle.lineWidth = 13; circle.stroke()
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: destination.appendingPathComponent(name))
}
print("Rendered Haven's app icon at every native size.")
