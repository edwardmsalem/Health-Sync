import Foundation

public enum CalendarViewMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case month
    case week
    case day
    case agenda

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .month: return "Month"
        case .week: return "Week"
        case .day: return "Day"
        case .agenda: return "List"
        }
    }

    public var symbolName: String {
        switch self {
        case .month: return "calendar"
        case .week: return "calendar.day.timeline.left"
        case .day: return "rectangle.grid.1x2"
        case .agenda: return "list.bullet"
        }
    }
}

/// Everything the app knows that is not already stored by iCloud, Google, or
/// Todoist.
///
/// This is the *only* thing that needs cross-device sync: calendar events sync
/// themselves through their own accounts, and tasks sync through Todoist. What
/// is left is preference state, which is small, and which is why CloudKit is
/// enough for now.
public struct AppPreferences: Codable, Equatable, Sendable {
    public var hiddenCalendarIDs: Set<String>
    /// Overrides the color EventKit reports, keyed by calendar identifier.
    public var calendarColorOverrides: [String: String]
    public var defaultViewMode: CalendarViewMode
    public var showTodoistTasks: Bool
    public var showCompletedTasks: Bool
    /// 1 = Sunday, 2 = Monday.
    public var firstWeekday: Int
    /// The hour the day timeline scrolls to by default.
    public var preferredDayStartHour: Int
    /// Applied to events created through quick add when the text names none.
    public var defaultAlerts: [AlertOffset]
    public var defaultCalendarID: String?
    /// Hour of day a Todoist task due on a date with no time is drawn at.
    ///
    /// Such a task has no position of its own in a timeline, so it is given
    /// one rather than being hidden — that way it is visible, and it gets an
    /// alert like anything else on the calendar.
    public var dateOnlyTaskHour: Int
    /// Last-writer-wins discriminator for the CloudKit merge.
    public var updatedAt: Date

    public init(
        hiddenCalendarIDs: Set<String> = [],
        calendarColorOverrides: [String: String] = [:],
        defaultViewMode: CalendarViewMode = .month,
        showTodoistTasks: Bool = true,
        showCompletedTasks: Bool = false,
        firstWeekday: Int = 1,
        preferredDayStartHour: Int = 8,
        defaultAlerts: [AlertOffset] = [.fifteenMinutes],
        defaultCalendarID: String? = nil,
        dateOnlyTaskHour: Int = 9,
        updatedAt: Date = Date()
    ) {
        self.hiddenCalendarIDs = hiddenCalendarIDs
        self.calendarColorOverrides = calendarColorOverrides
        self.defaultViewMode = defaultViewMode
        self.showTodoistTasks = showTodoistTasks
        self.showCompletedTasks = showCompletedTasks
        self.firstWeekday = firstWeekday
        self.preferredDayStartHour = preferredDayStartHour
        self.defaultAlerts = defaultAlerts
        self.defaultCalendarID = defaultCalendarID
        self.dateOnlyTaskHour = min(max(dateOnlyTaskHour, 0), 23)
        self.updatedAt = updatedAt
    }

    /// Decoded field by field with fallbacks rather than relying on the
    /// synthesised initialiser.
    ///
    /// Swift's synthesised `Decodable` ignores default property values and
    /// fails on any missing key, so adding a preference would otherwise make
    /// every previously stored blob — on disk *and* in CloudKit — undecodable,
    /// silently resetting the user's settings on upgrade.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        self.hiddenCalendarIDs = try container.decodeIfPresent(Set<String>.self, forKey: .hiddenCalendarIDs) ?? []
        self.calendarColorOverrides = try container.decodeIfPresent([String: String].self, forKey: .calendarColorOverrides) ?? [:]
        self.defaultViewMode = try container.decodeIfPresent(CalendarViewMode.self, forKey: .defaultViewMode) ?? .month
        self.showTodoistTasks = try container.decodeIfPresent(Bool.self, forKey: .showTodoistTasks) ?? true
        self.showCompletedTasks = try container.decodeIfPresent(Bool.self, forKey: .showCompletedTasks) ?? false
        self.firstWeekday = try container.decodeIfPresent(Int.self, forKey: .firstWeekday) ?? 1
        self.preferredDayStartHour = try container.decodeIfPresent(Int.self, forKey: .preferredDayStartHour) ?? 8
        self.defaultAlerts = try container.decodeIfPresent([AlertOffset].self, forKey: .defaultAlerts) ?? [.fifteenMinutes]
        self.defaultCalendarID = try container.decodeIfPresent(String.self, forKey: .defaultCalendarID)
        let hour = try container.decodeIfPresent(Int.self, forKey: .dateOnlyTaskHour) ?? 9
        self.dateOnlyTaskHour = min(max(hour, 0), 23)
        // `.distantPast` so a blob written before this field existed always
        // loses the last-writer-wins comparison against a freshly saved one.
        self.updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? .distantPast
    }

    public static let `default` = AppPreferences()

    public func isVisible(calendarID: String) -> Bool {
        !hiddenCalendarIDs.contains(calendarID)
    }

    public func color(for source: CalendarSource) -> String {
        calendarColorOverrides[source.id] ?? source.colorHex
    }
}
