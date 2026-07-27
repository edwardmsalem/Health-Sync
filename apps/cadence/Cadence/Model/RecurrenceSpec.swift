import Foundation

/// A repeat rule, in the small subset that natural language actually produces.
///
/// This deliberately does not model everything RFC 5545 can express. It covers
/// what someone types into a quick-add field; anything more elaborate is edited
/// in the detail view, which hands EventKit a rule directly.
public struct RecurrenceSpec: Equatable, Hashable, Codable, Sendable {
    public enum Frequency: String, Codable, Sendable, CaseIterable {
        case daily
        case weekly
        case monthly
        case yearly
    }

    public var frequency: Frequency
    /// Every N periods. 1 for "every week", 2 for "every other week".
    public var interval: Int
    /// Foundation weekday numbers (1 = Sunday ... 7 = Saturday). Only
    /// meaningful for `.weekly`; empty means "same weekday as the start date".
    public var weekdays: [Int]

    public init(frequency: Frequency, interval: Int = 1, weekdays: [Int] = []) {
        self.frequency = frequency
        self.interval = max(1, interval)
        self.weekdays = weekdays.sorted()
    }

    public static let daily = RecurrenceSpec(frequency: .daily)
    public static let weekly = RecurrenceSpec(frequency: .weekly)
    public static let monthly = RecurrenceSpec(frequency: .monthly)
    public static let yearly = RecurrenceSpec(frequency: .yearly)

    /// Monday through Friday.
    public static let everyWeekday = RecurrenceSpec(frequency: .weekly, weekdays: [2, 3, 4, 5, 6])

    public var displayLabel: String {
        if self == .everyWeekday { return "Every weekday" }

        let unit: String
        switch frequency {
        case .daily: unit = interval == 1 ? "day" : "days"
        case .weekly: unit = interval == 1 ? "week" : "weeks"
        case .monthly: unit = interval == 1 ? "month" : "months"
        case .yearly: unit = interval == 1 ? "year" : "years"
        }

        let base = interval == 1 ? "Every \(unit)" : "Every \(interval) \(unit)"

        guard frequency == .weekly, !weekdays.isEmpty else { return base }
        let names = weekdays.compactMap { Self.weekdayAbbreviation($0) }
        return "\(base) on \(names.joined(separator: ", "))"
    }

    static func weekdayAbbreviation(_ weekday: Int) -> String? {
        let names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        guard (1...7).contains(weekday) else { return nil }
        return names[weekday - 1]
    }
}
