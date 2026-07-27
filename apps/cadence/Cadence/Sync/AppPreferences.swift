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
        self.updatedAt = updatedAt
    }

    public static let `default` = AppPreferences()

    public func isVisible(calendarID: String) -> Bool {
        !hiddenCalendarIDs.contains(calendarID)
    }

    public func color(for source: CalendarSource) -> String {
        calendarColorOverrides[source.id] ?? source.colorHex
    }
}
