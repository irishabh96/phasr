#!/usr/bin/env swift
import AppKit

let width = 660
let height = 400
let scale = 2 // @2x for retina

let totalW = width * scale
let totalH = height * scale

guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
      let ctx = CGContext(
        data: nil,
        width: totalW,
        height: totalH,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      )
else {
  fputs("Failed to create graphics context\n", stderr)
  exit(1)
}

ctx.scaleBy(x: CGFloat(scale), y: CGFloat(scale))

// Background — same dark tone as the app
ctx.setFillColor(CGColor(red: 0.075, green: 0.086, blue: 0.102, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

// Helper: draw a centred NSAttributedString, y measured from the top
func drawCentred(_ string: NSAttributedString, centreX: CGFloat, topY: CGFloat) {
  let size = string.size()
  let x = centreX - size.width / 2
  let flippedY = CGFloat(height) - topY - size.height
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
  string.draw(at: NSPoint(x: x, y: flippedY))
  NSGraphicsContext.restoreGraphicsState()
}

let cx = CGFloat(width) / 2

// Icons sit at y≈170 (128 px tall) so the bottom of the icon area is ≈ y=310.
// Place the copy hint in the remaining ~90 px below that.

let labelAttrs: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: 10.5, weight: .regular),
  .foregroundColor: NSColor(white: 1, alpha: 0.35),
]
let label = NSAttributedString(
  string: "If macOS blocks Phasr, run in Terminal:",
  attributes: labelAttrs
)
drawCentred(label, centreX: cx, topY: 316)

let cmdAttrs: [NSAttributedString.Key: Any] = [
  .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
  .foregroundColor: NSColor(white: 1, alpha: 0.70),
]
let cmd = NSAttributedString(
  string: "xattr -dr com.apple.quarantine /Applications/Phasr.app",
  attributes: cmdAttrs
)
drawCentred(cmd, centreX: cx, topY: 333)

guard let cgImage = ctx.makeImage() else {
  fputs("Failed to create image\n", stderr)
  exit(1)
}

let outputURL = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "dmg-background.png")
guard let dest = CGImageDestinationCreateWithURL(outputURL as CFURL, kUTTypePNG, 1, nil) else {
  fputs("Failed to create image destination\n", stderr)
  exit(1)
}
CGImageDestinationAddImage(dest, cgImage, [kCGImagePropertyDPIWidth: 144, kCGImagePropertyDPIHeight: 144] as CFDictionary)
guard CGImageDestinationFinalize(dest) else {
  fputs("Failed to write image\n", stderr)
  exit(1)
}
print("Written: \(outputURL.path)")
