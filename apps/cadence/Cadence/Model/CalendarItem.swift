import Foundation

/// Where a row on the calendar came from.
///
/// Events and tasks render side by side in the same grid, so everything above
/// the data layer works on `CalendarItem` and never needs to know whether it is
/// talking to EventKit or Todoist.
public enum ItemOrigin: Equatable, Hashable {
    /// An EventKit event. `calendarIdentifier` is the `EKCalendar` it lives on,
    /// which may be backed by iCloud, Google (via CalDAV), Exchange, or local.
    case event(eventIdentifier: String, calendarIdentifier: String)

    /// A Todoist task that has a due date *with a time*, so it can be drawn in
    /// a time slot. Date-only tasks stay in the task list and never reach here.
    case task(todoistID: String)

    public var isTask: Bool {
        if case .task = self { return true }
        return false
    }

    public var todoistID: String? {
        if case .task(let id) = self { return id }
        return nil
    }

    public var calendarIdentifier: String? {
        if case .event(_, let calendarID) = self { return calendarID }
        return nil
    }
}

/// A minutes-before-start notification offset.
///
/// Stored as a positive number of minutes because that is how people say it
/// ("fifteen minutes before"); the EventKit and UserNotifications layers negate
/// it at the boundary.
public struct AlertOffset: Equatable, Hashable, Codable, Sendable {
    public var minutesBefore: Int

    public init(minutesBefore: Int) {
        self.minutesBefore = max(0, minutesBefore)
    }

    public static let atTimeOfEvent = AlertOffset(minutesBefore: 0)
    public static let fiveMinutes = AlertOffset(minutesBefore: 5)
    public static let fifteenMinutes = AlertOffset(minutesBefore: 15)
    public static let thirtyMinutes = AlertOffset(minutesBefore: 30)
    public static let oneHour = AlertOffset(minutesBefore: 60)
    public static let oneDay = AlertOffset(minutesBefore: 60 * 24)

    /// Seconds relative to the start date, negative, as `EKAlarm` wants it.
    public var relativeOffset: TimeInterval { -Double(minutesBefore) * 60 }

    public var shortLabel: String {
        switch minutesBefore {
        case 0: return "At time"
        case 1..<60: return "\(minutesBefore)m before"
        case 60..<(60 * 24):
            let hours = minutesBefore / 60
            let remainder = minutesBefore % 60
            return remainder == 0 ? "\(hours)h before" : "\(hours)h \(remainder)m before"
        default:
            let days = minutesBefore / (60 * 24)
            return days == 1 ? "1 day before" : "\(days) days before"
        }
    }
}

/// A single row on the calendar, whether it started life as an event or a task.
public struct CalendarItem: Identifiable, Equatable, Hashable {
    public var id: String
    public var title: String
    public var notes: String?
    public var location: String?
    public var start: Date
    public var end: Date
    public var isAllDay: Bool
    public var origin: ItemOrigin
    /// Display name of the owning calendar or Todoist project.
    public var containerTitle: String
    /// Hex color of the owning calendar/project, e.g. "#E8574A".
    public var colorHex: String
    public var alerts: [AlertOffset]
    public var isRecurring: Bool
    /// Tasks only. Completed tasks stay visible but render struck through.
    public var isCompleted: Bool
    /// Tasks only. Todoist priority, 1 (highest) to 4 (default).
    public var priority: Int?
    public var url: URL?
    /// True when this item's time was supplied by the app rather than by the
    /// user — a Todoist task due on a date with no time, placed at the default
    /// hour. Rendered slightly differently so a row of defaulted tasks is not
    /// mistaken for a row of real commitments.
    public var hasInferredTime: Bool

    public init(
        id: String,
        title: String,
        notes: String? = nil,
        location: String? = nil,
        start: Date,
        end: Date,
        isAllDay: Bool = false,
        origin: ItemOrigin,
        containerTitle: String,
        colorHex: String,
        alerts: [AlertOffset] = [],
        isRecurring: Bool = false,
        isCompleted: Bool = false,
        priority: Int? = nil,
        url: URL? = nil,
        hasInferredTime: Bool = false
    ) {
        self.id = id
        self.title = title
        self.notes = notes
        self.location = location
        self.start = start
        // A zero-length item is invisible in a timeline; give it a floor so it
        // still gets a tappable chip.
        self.end = max(end, start)
        self.isAllDay = isAllDay
        self.origin = origin
        self.containerTitle = containerTitle
        self.colorHex = colorHex
        self.alerts = alerts
        self.isRecurring = isRecurring
        self.isCompleted = isCompleted
        self.priority = priority
        self.url = url
        self.hasInferredTime = hasInferredTime
    }

    public var duration: TimeInterval { end.timeIntervalSince(start) }

    /// True when the item covers any part of the given day.
    public func occurs(on day: Date, calendar: Calendar) -> Bool {
        let dayStart = calendar.startOfDay(for: day)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return false }
        // Half-open on both sides so an event ending exactly at midnight does
        // not bleed into the next day.
        return start < dayEnd && end > dayStart
    }

    /// The portion of this item that falls inside the given day, for items that
    /// span midnight.
    public func clamped(to day: Date, calendar: Calendar) -> (start: Date, end: Date) {
        let dayStart = calendar.startOfDay(for: day)
        let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) ?? dayStart
        return (max(start, dayStart), min(end, dayEnd))
    }
}
