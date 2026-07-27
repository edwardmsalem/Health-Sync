import Foundation

/// A string that remembers which spans have already been claimed by a matcher.
///
/// The parser works by lifting recognised tokens out of the input one pattern
/// at a time; whatever spans are never claimed become the title. Tracking the
/// claims here — rather than rewriting the string after each match — keeps every
/// pattern matching against the original text, so an early match can never
/// shift the offsets a later one sees.
final class TextCanvas {
    let ns: NSString
    private var claimed: [NSRange] = []

    init(_ text: String) {
        self.ns = text as NSString
    }

    /// The first match of `regex` that does not overlap an already-claimed span.
    func firstUnclaimedMatch(_ regex: NSRegularExpression) -> NSTextCheckingResult? {
        let full = NSRange(location: 0, length: ns.length)
        var found: NSTextCheckingResult?
        regex.enumerateMatches(in: ns as String, options: [], range: full) { match, _, stop in
            guard let match, self.isUnclaimed(match.range) else { return }
            found = match
            stop.pointee = true
        }
        return found
    }

    /// Every non-overlapping match, in order. Used for markers that can repeat,
    /// like `@label`.
    func allUnclaimedMatches(_ regex: NSRegularExpression) -> [NSTextCheckingResult] {
        let full = NSRange(location: 0, length: ns.length)
        return regex.matches(in: ns as String, options: [], range: full)
            .filter { isUnclaimed($0.range) }
    }

    func isUnclaimed(_ range: NSRange) -> Bool {
        !claimed.contains { NSIntersectionRange($0, range).length > 0 }
    }

    func claim(_ range: NSRange) {
        guard range.location != NSNotFound, range.length > 0 else { return }
        claimed.append(range)
    }

    func text(at range: NSRange) -> String? {
        guard range.location != NSNotFound, range.length > 0 else { return nil }
        guard NSMaxRange(range) <= ns.length else { return nil }
        return ns.substring(with: range)
    }

    /// The input with every claimed span blanked out.
    func unclaimedText() -> String {
        guard !claimed.isEmpty else { return ns as String }
        let mutable = NSMutableString(string: ns)
        // Replace back to front so earlier ranges keep their offsets.
        for range in claimed.sorted(by: { $0.location > $1.location }) {
            mutable.replaceCharacters(in: range, with: " ")
        }
        return mutable as String
    }
}

extension NSTextCheckingResult {
    /// Capture group `index` as a string, or nil when the group did not
    /// participate in the match.
    func group(_ index: Int, in ns: NSString) -> String? {
        guard index < numberOfRanges else { return nil }
        let r = range(at: index)
        guard r.location != NSNotFound, NSMaxRange(r) <= ns.length else { return nil }
        return ns.substring(with: r)
    }

    func intGroup(_ index: Int, in ns: NSString) -> Int? {
        group(index, in: ns).flatMap { Int($0) }
    }

    func doubleGroup(_ index: Int, in ns: NSString) -> Double? {
        group(index, in: ns).flatMap { Double($0) }
    }
}
