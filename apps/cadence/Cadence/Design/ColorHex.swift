import SwiftUI
import CoreGraphics

/// Colors travel through the app as hex strings because they have to survive a
/// round trip through CloudKit and through EventKit's `CGColor`, neither of
/// which speaks SwiftUI `Color`.
public enum ColorHex {
    public static let fallback = "#4C8DF6"

    /// Converts an EventKit calendar color to a hex string.
    ///
    /// Calendar colors can arrive in any color space (Google's CalDAV colors in
    /// particular are not always sRGB), so this converts before reading
    /// components rather than trusting the raw values.
    public static func string(from cgColor: CGColor?) -> String {
        guard let cgColor,
              let sRGB = CGColorSpace(name: CGColorSpace.sRGB),
              let converted = cgColor.converted(to: sRGB, intent: .defaultIntent, options: nil),
              let components = converted.components,
              components.count >= 3
        else { return fallback }

        let red = Int((components[0] * 255).rounded())
        let green = Int((components[1] * 255).rounded())
        let blue = Int((components[2] * 255).rounded())
        return String(format: "#%02X%02X%02X", clamp(red), clamp(green), clamp(blue))
    }

    private static func clamp(_ value: Int) -> Int { min(max(value, 0), 255) }

    public static func components(_ hex: String) -> (red: Double, green: Double, blue: Double) {
        var cleaned = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.hasPrefix("#") { cleaned.removeFirst() }

        // Expand the three-digit shorthand, e.g. "#F0A" -> "#FF00AA".
        if cleaned.count == 3 {
            cleaned = cleaned.map { "\($0)\($0)" }.joined()
        }

        guard cleaned.count == 6, let value = UInt32(cleaned, radix: 16) else {
            return (0.30, 0.55, 0.96)
        }

        return (
            Double((value >> 16) & 0xFF) / 255.0,
            Double((value >> 8) & 0xFF) / 255.0,
            Double(value & 0xFF) / 255.0
        )
    }

    /// Relative luminance, used to decide whether text on this color should be
    /// black or white.
    public static func luminance(_ hex: String) -> Double {
        let (red, green, blue) = components(hex)
        func linear(_ channel: Double) -> Double {
            channel <= 0.03928 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }
}

public extension Color {
    init(hex: String) {
        let (red, green, blue) = ColorHex.components(hex)
        self.init(.sRGB, red: red, green: green, blue: blue, opacity: 1)
    }

    /// Black or white, whichever stays legible on top of `hex`.
    static func legibleForeground(on hex: String) -> Color {
        ColorHex.luminance(hex) > 0.45 ? Color.black.opacity(0.82) : Color.white
    }
}
