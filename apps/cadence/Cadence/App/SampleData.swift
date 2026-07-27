#if DEBUG
import Foundation

/// Debug-only fixture data, active when the CADENCE_SAMPLE_DATA=1 environment
/// variable is set (simulator screenshots, design review). Never compiled into
/// Release builds.
enum SampleData {
    struct Feed {
        let name: String
        let colorHex: String
    }

    static let work = Feed(name: "Work", colorHex: "#4C8DF6")
    static let personal = Feed(name: "Personal", colorHex: "#57B95B")
    static let family = Feed(name: "Family", colorHex: "#F2994A")
    static let todoist = Feed(name: "Errands", colorHex: "#DB4035")

    /// A believable few weeks of items surrounding `month`.
    static func items(around month: Date, calendar: Calendar) -> [CalendarItem] {
        var results: [CalendarItem] = []
        let today = calendar.startOfDay(for: Date())

        func event(
            _ title: String, day: Date, hour: Int, minute: Int = 0,
            durationMinutes: Int = 60, feed: Feed, location: String? = nil,
            recurring: Bool = false
        ) {
            guard let start = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) else { return }
            results.append(
                CalendarItem(
                    id: "sample-\(title)-\(Int(start.timeIntervalSince1970))",
                    title: title,
                    location: location,
                    start: start,
                    end: start.addingTimeInterval(TimeInterval(durationMinutes * 60)),
                    origin: .event(eventIdentifier: UUID().uuidString, calendarIdentifier: feed.name),
                    containerTitle: feed.name,
                    colorHex: feed.colorHex,
                    isRecurring: recurring
                )
            )
        }

        func allDay(_ title: String, day: Date, feed: Feed) {
            let start = calendar.startOfDay(for: day)
            let end = calendar.date(byAdding: .day, value: 1, to: start) ?? start
            results.append(
                CalendarItem(
                    id: "sample-\(title)",
                    title: title, start: start, end: end, isAllDay: true,
                    origin: .event(eventIdentifier: UUID().uuidString, calendarIdentifier: feed.name),
                    containerTitle: feed.name, colorHex: feed.colorHex
                )
            )
        }

        func task(
            _ title: String, day: Date, hour: Int, minute: Int = 0,
            priority: Int = 4, completed: Bool = false, inferred: Bool = false
        ) {
            guard let start = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) else { return }
            results.append(
                CalendarItem(
                    id: "sample-task-\(title)",
                    title: title,
                    start: start,
                    end: start.addingTimeInterval(30 * 60),
                    origin: .task(todoistID: UUID().uuidString),
                    containerTitle: todoist.name,
                    colorHex: todoist.colorHex,
                    isCompleted: completed,
                    priority: priority,
                    hasInferredTime: inferred
                )
            )
        }

        func day(_ offset: Int) -> Date {
            calendar.date(byAdding: .day, value: offset, to: today) ?? today
        }

        // Weekday standups across five weeks either side of today.
        for offset in -21...21 {
            let d = day(offset)
            let weekday = calendar.component(.weekday, from: d)
            if (2...6).contains(weekday) {
                event("Standup", day: d, hour: 9, minute: 15, durationMinutes: 15, feed: work, recurring: true)
            }
        }

        event("Design review", day: day(0), hour: 11, durationMinutes: 60, feed: work, location: "Zoom")
        event("Lunch with Sam", day: day(0), hour: 13, durationMinutes: 75, feed: personal, location: "Causwells")
        event("1:1 with Dana", day: day(0), hour: 15, minute: 30, durationMinutes: 30, feed: work)
        task("Submit expense report", day: day(0), hour: 9, priority: 1)
        task("Pick up dry cleaning", day: day(0), hour: 9, inferred: true)

        event("Dentist", day: day(1), hour: 15, durationMinutes: 90, feed: personal, location: "451 Sutter St")
        event("Sprint planning", day: day(1), hour: 10, durationMinutes: 90, feed: work)
        task("Renew car registration", day: day(1), hour: 9, priority: 2)

        event("Parent-teacher conference", day: day(2), hour: 17, durationMinutes: 45, feed: family)
        event("Gym", day: day(2), hour: 6, minute: 30, durationMinutes: 60, feed: personal, recurring: true)

        allDay("Q3 offsite", day: day(3), feed: work)
        event("Team dinner", day: day(3), hour: 19, durationMinutes: 120, feed: work, location: "Che Fico")

        event("Flight to Denver", day: day(5), hour: 22, durationMinutes: 180, feed: personal, location: "SFO T2")
        allDay("Mom's birthday", day: day(6), feed: family)

        event("Board call", day: day(-1), hour: 14, durationMinutes: 60, feed: work)
        task("Send invoices", day: day(-1), hour: 9, priority: 1, completed: true)

        event("Soccer practice", day: day(7), hour: 16, durationMinutes: 90, feed: family, recurring: true)
        event("Soccer practice", day: day(14), hour: 16, durationMinutes: 90, feed: family, recurring: true)
        event("Date night", day: day(8), hour: 19, minute: 30, durationMinutes: 150, feed: personal)
        event("Quarterly review", day: day(9), hour: 13, durationMinutes: 120, feed: work)
        task("Book hotel for Denver", day: day(4), hour: 9, priority: 2)
        event("Haircut", day: day(10), hour: 12, durationMinutes: 45, feed: personal)
        event("All-hands", day: day(15), hour: 10, durationMinutes: 60, feed: work, recurring: true)
        allDay("No school (teacher day)", day: day(11), feed: family)

        return results
    }
}
#endif
