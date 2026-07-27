import Foundation

/// The structured result of reading a quick-add line like
/// `"lunch with Sam tomorrow 1-2:30pm #Personal remind me 15 min before"`.
///
/// Everything is optional except the title, because the parser degrades
/// gracefully: text it cannot interpret stays in the title rather than being
/// dropped, which is the behaviour people expect from a quick-add field.
public struct ParsedInput: Equatable {
    /// What is left after every recognised token has been lifted out.
    public var title: String
    public var start: Date?
    public var end: Date?
    public var isAllDay: Bool
    public var recurrence: RecurrenceSpec?
    public var alerts: [AlertOffset]
    /// From a `#Project` marker.
    public var projectName: String?
    /// From `@label` markers.
    public var labels: [String]
    /// From `p1`-`p4` or `!!1`-`!!4`. Todoist convention: 1 is highest.
    public var priority: Int?

    public init(
        title: String,
        start: Date? = nil,
        end: Date? = nil,
        isAllDay: Bool = false,
        recurrence: RecurrenceSpec? = nil,
        alerts: [AlertOffset] = [],
        projectName: String? = nil,
        labels: [String] = [],
        priority: Int? = nil
    ) {
        self.title = title
        self.start = start
        self.end = end
        self.isAllDay = isAllDay
        self.recurrence = recurrence
        self.alerts = alerts
        self.projectName = projectName
        self.labels = labels
        self.priority = priority
    }

    /// True when the text pinned the item to a moment in time.
    public var hasSchedule: Bool { start != nil }

    /// The presence of a `#project`, `@label`, or priority marker is how the
    /// quick-add bar decides you meant a Todoist task rather than an event.
    public var looksLikeTask: Bool {
        projectName != nil || !labels.isEmpty || priority != nil
    }
}
