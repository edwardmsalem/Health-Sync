import Foundation

/// Turns Todoist tasks into calendar blocks.
///
/// Pulled out of `TodoistStore` as free functions so the rules here — which
/// tasks appear, where a task with no time is placed, how long a block is — can
/// be unit tested without a network, a keychain, or a main actor.
enum TaskProjection {

    struct Options {
        var includeCompleted: Bool
        /// Hour of day used for a task due on a date with no time.
        var dateOnlyHour: Int
        /// Block length for a task that carries no duration of its own.
        var defaultDuration: TimeInterval

        init(
            includeCompleted: Bool = false,
            dateOnlyHour: Int = 9,
            defaultDuration: TimeInterval = 30 * 60
        ) {
            self.includeCompleted = includeCompleted
            self.dateOnlyHour = min(max(dateOnlyHour, 0), 23)
            self.defaultDuration = defaultDuration
        }
    }

    /// Every task that should be drawn in `interval`, as calendar items.
    ///
    /// Tasks due on a date with no time are placed at `dateOnlyHour` rather
    /// than dropped. That keeps them visible and gives them an alert, at the
    /// cost of asserting a time the user never picked — which is why the
    /// resulting item is flagged with `hasInferredTime`.
    static func calendarItems(
        items: [TodoistItem],
        projects: [String: TodoistProject],
        in interval: DateInterval,
        calendar: Calendar,
        options: Options
    ) -> [CalendarItem] {
        items.compactMap { item in
            calendarItem(for: item, projects: projects, calendar: calendar, options: options)
        }
        .filter { $0.start < interval.end && $0.end > interval.start }
    }

    /// The projection for a single task, or nil when it should not be drawn.
    static func calendarItem(
        for item: TodoistItem,
        projects: [String: TodoistProject],
        calendar: Calendar,
        options: Options
    ) -> CalendarItem? {
        guard !item.isRemoved else { return nil }
        guard options.includeCompleted || !item.isCompleted else { return nil }
        guard let due = item.due,
              let resolved = TodoistDueParser.resolve(due, calendar: calendar)
        else { return nil }

        let start: Date
        if resolved.hasTime {
            start = resolved.start
        } else {
            // `resolved.start` is already the start of the due day, so this
            // only has to move the clock forward to the configured hour.
            start = calendar.date(
                bySettingHour: options.dateOnlyHour,
                minute: 0,
                second: 0,
                of: resolved.start
            ) ?? resolved.start
        }

        let end = start.addingTimeInterval(item.duration?.timeInterval ?? options.defaultDuration)
        let project = item.projectID.flatMap { projects[$0] }

        return CalendarItem(
            id: "todoist:\(item.id)",
            title: item.content,
            notes: item.description,
            start: start,
            end: end,
            isAllDay: false,
            origin: .task(todoistID: item.id),
            containerTitle: project?.name ?? "Todoist",
            colorHex: project?.colorHex ?? TodoistPalette.fallback,
            isRecurring: due.isRecurring ?? false,
            isCompleted: item.isCompleted,
            priority: item.displayPriority,
            hasInferredTime: !resolved.hasTime
        )
    }
}
