import Foundation

/// Turns a typed line into a scheduled item.
///
/// The parser is deliberately free of any UIKit/EventKit dependency and takes
/// its "now" as a parameter, so every rule below is exercised by unit tests
/// against fixed reference dates rather than the wall clock.
///
/// Strategy: run a series of patterns from least ambiguous to most ambiguous,
/// claiming the text each one consumes. `#project` and `@label` sigils can only
/// mean one thing, so they go first; a bare number like "3" is the most
/// ambiguous token in the language, so it goes last and only in a context that
/// makes it a time. Whatever text survives is the title.
public struct NaturalLanguageParser {
    public var calendar: Calendar
    /// Applied when a start time is found but no end time or duration is.
    public var defaultEventDuration: TimeInterval

    public init(calendar: Calendar = .autoupdatingCurrent, defaultEventDuration: TimeInterval = 3600) {
        self.calendar = calendar
        self.defaultEventDuration = defaultEventDuration
    }

    public func parse(_ text: String, now: Date = Date()) -> ParsedInput {
        let canvas = TextCanvas(text)
        let ns = canvas.ns

        var draft = Draft()

        extractMarkers(canvas, ns, into: &draft)
        extractAlerts(canvas, ns, into: &draft)
        extractRecurrence(canvas, ns, into: &draft)
        extractDuration(canvas, ns, into: &draft)
        extractExplicitDate(canvas, ns, now: now, into: &draft)
        extractRelativeDate(canvas, ns, now: now, into: &draft)
        extractWeekday(canvas, ns, now: now, into: &draft)
        extractTimeRange(canvas, ns, into: &draft)
        extractSingleTime(canvas, ns, into: &draft)
        extractDayPart(canvas, ns, into: &draft)

        let (start, end, isAllDay) = resolveSchedule(draft, now: now)

        return ParsedInput(
            title: cleanTitle(canvas.unclaimedText()),
            start: start,
            end: end,
            isAllDay: isAllDay,
            recurrence: draft.recurrence,
            alerts: draft.alerts,
            projectName: draft.projectName,
            labels: draft.labels,
            priority: draft.priority
        )
    }

    // MARK: - Intermediate state

    private struct Draft {
        var day: Date?              // start-of-day of the resolved calendar date
        var startTime: TimeOfDay?
        var endTime: TimeOfDay?
        var timeHint: TimeOfDay?    // from "morning"/"evening", used only if no explicit time
        var duration: TimeInterval?
        var recurrence: RecurrenceSpec?
        var alerts: [AlertOffset] = []
        var projectName: String?
        var labels: [String] = []
        var priority: Int?
    }

    struct TimeOfDay: Equatable {
        var hour: Int
        var minute: Int
    }

    private enum Meridiem {
        case am, pm

        init?(_ raw: String?) {
            guard let first = raw?.lowercased().first else { return nil }
            switch first {
            case "a": self = .am
            case "p": self = .pm
            default: return nil
            }
        }
    }

    // MARK: - Markers (#project, @label, p1)

    private func extractMarkers(_ canvas: TextCanvas, _ ns: NSString, into draft: inout Draft) {
        if let m = canvas.firstUnclaimedMatch(Patterns.priority) {
            // Either the `p3` group or the `!!3` group carries the digit.
            let value = m.intGroup(1, in: ns) ?? m.intGroup(2, in: ns)
            if let value, (1...4).contains(value) {
                draft.priority = value
                canvas.claim(m.range)
            }
        }

        if let m = canvas.firstUnclaimedMatch(Patterns.project), let name = m.group(1, in: ns) {
            draft.projectName = name
            canvas.claim(m.range)
        }

        for m in canvas.allUnclaimedMatches(Patterns.label) {
            guard let name = m.group(1, in: ns) else { continue }
            draft.labels.append(name)
            canvas.claim(m.range)
        }
    }

    // MARK: - Alerts

    private func extractAlerts(_ canvas: TextCanvas, _ ns: NSString, into draft: inout Draft) {
        // "remind me 15 minutes before", "alert 1 hour before", "10 min before"
        for m in canvas.allUnclaimedMatches(Patterns.alertOffset) {
            guard let value = m.doubleGroup(1, in: ns),
                  let unit = m.group(2, in: ns) else { continue }
            draft.alerts.append(AlertOffset(minutesBefore: minutes(value, unit: unit)))
            canvas.claim(m.range)
        }

        // "remind me at the time", "alert at start"
        if let m = canvas.firstUnclaimedMatch(Patterns.alertAtStart) {
            draft.alerts.append(.atTimeOfEvent)
            canvas.claim(m.range)
        }
    }

    // MARK: - Recurrence

    private func extractRecurrence(_ canvas: TextCanvas, _ ns: NSString, into draft: inout Draft) {
        // "every weekday" / "every weekend"
        if let m = canvas.firstUnclaimedMatch(Patterns.everyWeekday) {
            let word = (m.group(1, in: ns) ?? "").lowercased()
            draft.recurrence = word.hasPrefix("weekend")
                ? RecurrenceSpec(frequency: .weekly, weekdays: [1, 7])
                : .everyWeekday
            canvas.claim(m.range)
            return
        }

        // "every monday", "every tue and thu"
        if let m = canvas.firstUnclaimedMatch(Patterns.everyNamedDay) {
            var weekdays: [Int] = []
            for group in 1..<m.numberOfRanges {
                if let name = m.group(group, in: ns), let weekday = weekdayNumber(name) {
                    weekdays.append(weekday)
                }
            }
            if !weekdays.isEmpty {
                draft.recurrence = RecurrenceSpec(frequency: .weekly, weekdays: Array(Set(weekdays)))
                canvas.claim(m.range)
                return
            }
        }

        // "every 2 weeks", "every other day", "every month"
        if let m = canvas.firstUnclaimedMatch(Patterns.everyInterval) {
            let interval = m.group(1, in: ns).flatMap { Int($0) }
                ?? (m.group(2, in: ns) != nil ? 2 : 1)  // "every other X"
            if let unit = m.group(3, in: ns), let frequency = frequency(forUnit: unit) {
                draft.recurrence = RecurrenceSpec(frequency: frequency, interval: interval)
                canvas.claim(m.range)
                return
            }
        }

        // "daily", "weekly", "biweekly", "monthly", "yearly"
        if let m = canvas.firstUnclaimedMatch(Patterns.adverbialRecurrence),
           let word = m.group(1, in: ns)?.lowercased() {
            switch word {
            case "daily": draft.recurrence = .daily
            case "weekly": draft.recurrence = .weekly
            case "biweekly", "fortnightly": draft.recurrence = RecurrenceSpec(frequency: .weekly, interval: 2)
            case "monthly": draft.recurrence = .monthly
            case "quarterly": draft.recurrence = RecurrenceSpec(frequency: .monthly, interval: 3)
            case "yearly", "annually": draft.recurrence = .yearly
            default: break
            }
            if draft.recurrence != nil { canvas.claim(m.range) }
        }
    }

    private func frequency(forUnit unit: String) -> RecurrenceSpec.Frequency? {
        switch unit.lowercased().first {
        case "d": return .daily
        case "w": return .weekly
        case "m": return .monthly
        case "y": return .yearly
        default: return nil
        }
    }

    // MARK: - Duration

    private func extractDuration(_ canvas: TextCanvas, _ ns: NSString, into draft: inout Draft) {
        // "for 90 minutes", "for 1.5 hours", "for 2h"
        if let m = canvas.firstUnclaimedMatch(Patterns.forDuration),
           let value = m.doubleGroup(1, in: ns),
           let unit = m.group(2, in: ns) {
            draft.duration = Double(minutes(value, unit: unit)) * 60
            canvas.claim(m.range)
            return
        }

        // "90 min long", "2 hour long"
        if let m = canvas.firstUnclaimedMatch(Patterns.durationLong),
           let value = m.doubleGroup(1, in: ns),
           let unit = m.group(2, in: ns) {
            draft.duration = Double(minutes(value, unit: unit)) * 60
            canvas.claim(m.range)
        }
    }

    private func minutes(_ value: Double, unit: String) -> Int {
        switch unit.lowercased().first {
        case "h": return Int((value * 60).rounded())
        case "d": return Int((value * 60 * 24).rounded())
        default: return Int(value.rounded())
        }
    }

    // MARK: - Explicit dates

    private func extractExplicitDate(_ canvas: TextCanvas, _ ns: NSString, now: Date, into draft: inout Draft) {
        // 2026-12-05
        if let m = canvas.firstUnclaimedMatch(Patterns.isoDate),
           let year = m.intGroup(1, in: ns),
           let month = m.intGroup(2, in: ns),
           let day = m.intGroup(3, in: ns) {
            draft.day = date(year: year, month: month, day: day)
            canvas.claim(m.range)
            return
        }

        // 12/5 or 12/5/26 — US month/day ordering.
        if let m = canvas.firstUnclaimedMatch(Patterns.numericDate),
           let month = m.intGroup(1, in: ns),
           let day = m.intGroup(2, in: ns),
           (1...12).contains(month), (1...31).contains(day) {
            let year = m.intGroup(3, in: ns).map(normalizeYear)
            draft.day = date(year: year, month: month, day: day, rollingForwardFrom: now)
            canvas.claim(m.range)
            return
        }

        // "Dec 5", "December 5th, 2026"
        if let m = canvas.firstUnclaimedMatch(Patterns.monthNameDay),
           let monthName = m.group(1, in: ns),
           let month = monthNumber(monthName),
           let day = m.intGroup(2, in: ns) {
            let year = m.intGroup(3, in: ns).map(normalizeYear)
            draft.day = date(year: year, month: month, day: day, rollingForwardFrom: now)
            canvas.claim(m.range)
            return
        }

        // "5 December", "5th of Dec"
        if let m = canvas.firstUnclaimedMatch(Patterns.dayMonthName),
           let day = m.intGroup(1, in: ns),
           let monthName = m.group(2, in: ns),
           let month = monthNumber(monthName) {
            let year = m.intGroup(3, in: ns).map(normalizeYear)
            draft.day = date(year: year, month: month, day: day, rollingForwardFrom: now)
            canvas.claim(m.range)
        }
    }

    private func normalizeYear(_ raw: Int) -> Int {
        raw < 100 ? 2000 + raw : raw
    }

    private func date(year: Int, month: Int, day: Int) -> Date? {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        return calendar.date(from: components).map { calendar.startOfDay(for: $0) }
    }

    /// Builds a date, defaulting to whichever year puts it in the future when no
    /// year was written. "Dec 5" in January means this year; in December it
    /// means next year.
    private func date(year: Int?, month: Int, day: Int, rollingForwardFrom now: Date) -> Date? {
        if let year { return date(year: year, month: month, day: day) }

        let currentYear = calendar.component(.year, from: now)
        guard let thisYear = date(year: currentYear, month: month, day: day) else { return nil }
        if thisYear >= calendar.startOfDay(for: now) { return thisYear }
        return date(year: currentYear + 1, month: month, day: day)
    }

    // MARK: - Relative dates

    private func extractRelativeDate(_ canvas: TextCanvas, _ ns: NSString, now: Date, into draft: inout Draft) {
        let today = calendar.startOfDay(for: now)

        if draft.day == nil, let m = canvas.firstUnclaimedMatch(Patterns.relativeDay),
           let word = m.group(1, in: ns)?.lowercased() {
            switch word {
            case "today":
                draft.day = today
            case "tonight":
                draft.day = today
                draft.timeHint = TimeOfDay(hour: 19, minute: 0)
            case "tomorrow", "tmrw", "tmw":
                draft.day = calendar.date(byAdding: .day, value: 1, to: today)
            case "yesterday":
                draft.day = calendar.date(byAdding: .day, value: -1, to: today)
            case "overmorrow":
                draft.day = calendar.date(byAdding: .day, value: 2, to: today)
            default:
                break
            }
            if draft.day != nil { canvas.claim(m.range) }
        }

        // "in 3 days", "in 2 weeks"
        if draft.day == nil, let m = canvas.firstUnclaimedMatch(Patterns.inNUnits),
           let amount = m.intGroup(1, in: ns),
           let unit = m.group(2, in: ns) {
            let component: Calendar.Component
            switch unit.lowercased().first {
            case "d": component = .day
            case "w": component = .weekOfYear
            case "m": component = .month
            case "y": component = .year
            default: component = .day
            }
            draft.day = calendar.date(byAdding: component, value: amount, to: today)
            canvas.claim(m.range)
        }

        // "next week", "this month"
        if draft.day == nil, let m = canvas.firstUnclaimedMatch(Patterns.nextPeriod),
           let qualifier = m.group(1, in: ns)?.lowercased(),
           let unit = m.group(2, in: ns)?.lowercased() {
            let step = (qualifier == "next" || qualifier == "coming") ? 1 : 0
            switch unit {
            case "week": draft.day = calendar.date(byAdding: .weekOfYear, value: step, to: today)
            case "month": draft.day = calendar.date(byAdding: .month, value: step, to: today)
            case "year": draft.day = calendar.date(byAdding: .year, value: step, to: today)
            default: break
            }
            if draft.day != nil { canvas.claim(m.range) }
        }
    }

    // MARK: - Weekday names

    private func extractWeekday(_ canvas: TextCanvas, _ ns: NSString, now: Date, into draft: inout Draft) {
        guard draft.day == nil,
              let m = canvas.firstUnclaimedMatch(Patterns.weekday),
              let name = m.group(2, in: ns),
              let weekday = weekdayNumber(name) else { return }

        // "next Tuesday" skips today even if today is Tuesday; a bare "Tuesday"
        // or "this Tuesday" means the next one including today.
        let qualifier = m.group(1, in: ns)?.lowercased()
        let skipToday = (qualifier == "next")

        draft.day = nextOccurrence(ofWeekday: weekday, from: now, skippingToday: skipToday)
        canvas.claim(m.range)
    }

    private func nextOccurrence(ofWeekday weekday: Int, from now: Date, skippingToday: Bool) -> Date {
        let today = calendar.startOfDay(for: now)
        let current = calendar.component(.weekday, from: today)
        var delta = (weekday - current + 7) % 7
        if delta == 0 && skippingToday { delta = 7 }
        return calendar.date(byAdding: .day, value: delta, to: today) ?? today
    }

    // MARK: - Times

    private func extractTimeRange(_ canvas: TextCanvas, _ ns: NSString, into draft: inout Draft) {
        guard let m = canvas.firstUnclaimedMatch(Patterns.timeRange) else { return }

        let prefix = m.group(1, in: ns)?.lowercased()
        guard let startHour = m.intGroup(2, in: ns), let endHour = m.intGroup(6, in: ns) else { return }
        let startMinute = m.intGroup(3, in: ns)
        let startMeridiem = Meridiem(m.group(4, in: ns))
        let separator = m.group(5, in: ns)?.lowercased() ?? "-"
        let endMinute = m.intGroup(7, in: ns)
        let endMeridiem = Meridiem(m.group(8, in: ns))

        // A bare "2-3" is far more often a quantity than a time range. Require
        // some corroborating signal: an explicit "from"/"between", a meridiem,
        // or written-out minutes.
        let hasSignal = prefix != nil
            || startMeridiem != nil || endMeridiem != nil
            || startMinute != nil || endMinute != nil
        guard hasSignal else { return }

        // "and" only joins a range when "between" introduced it.
        if separator == "and" && prefix != "between" { return }
        guard (0...23).contains(startHour), (0...23).contains(endHour) else { return }

        // "11-1pm" means 11am to 1pm: inherit the stated meridiem, but fall back
        // to the other one when inheriting would invert the range.
        var resolvedStart = resolve(hour: startHour, minute: startMinute ?? 0, meridiem: startMeridiem ?? endMeridiem)
        var resolvedEnd = resolve(hour: endHour, minute: endMinute ?? 0, meridiem: endMeridiem ?? startMeridiem)

        if startMeridiem == nil, endMeridiem != nil, minutesSinceMidnight(resolvedStart) >= minutesSinceMidnight(resolvedEnd) {
            let flipped: Meridiem = (endMeridiem == .pm) ? .am : .pm
            resolvedStart = resolve(hour: startHour, minute: startMinute ?? 0, meridiem: flipped)
        } else if endMeridiem == nil, minutesSinceMidnight(resolvedEnd) < minutesSinceMidnight(resolvedStart) {
            // "9-1" with no meridiem anywhere: push the end past the start.
            resolvedEnd = resolve(hour: endHour, minute: endMinute ?? 0, meridiem: .pm)
        }

        draft.startTime = resolvedStart
        draft.endTime = resolvedEnd
        canvas.claim(m.range)
    }

    private func extractSingleTime(_ canvas: TextCanvas, _ ns: NSString, into draft: inout Draft) {
        guard draft.startTime == nil else { return }

        // "noon" / "midnight" are unambiguous, so try them first.
        if let m = canvas.firstUnclaimedMatch(Patterns.namedTime),
           let word = m.group(1, in: ns)?.lowercased() {
            draft.startTime = (word == "noon" || word == "midday")
                ? TimeOfDay(hour: 12, minute: 0)
                : TimeOfDay(hour: 0, minute: 0)
            canvas.claim(m.range)
            return
        }

        // Each pattern is progressively less certain: an "at" keyword, then a
        // colon, then a meridiem. A number with none of those is left alone.
        for pattern in [Patterns.timeWithKeyword, Patterns.timeWithColon, Patterns.timeWithMeridiem] {
            guard let m = canvas.firstUnclaimedMatch(pattern), let hour = m.intGroup(1, in: ns) else { continue }
            let minute = m.intGroup(2, in: ns) ?? 0
            guard (0...23).contains(hour), (0...59).contains(minute) else { continue }
            draft.startTime = resolve(hour: hour, minute: minute, meridiem: Meridiem(m.group(3, in: ns)))
            canvas.claim(m.range)
            return
        }
    }

    private func extractDayPart(_ canvas: TextCanvas, _ ns: NSString, into draft: inout Draft) {
        guard let m = canvas.firstUnclaimedMatch(Patterns.dayPart),
              let word = m.group(1, in: ns)?.lowercased() else { return }

        let hint: TimeOfDay
        switch word {
        case "morning": hint = TimeOfDay(hour: 9, minute: 0)
        case "afternoon": hint = TimeOfDay(hour: 14, minute: 0)
        case "evening", "night": hint = TimeOfDay(hour: 19, minute: 0)
        default: return
        }

        // With an explicit time already in hand, a day part only disambiguates
        // meridiem — "meeting at 7 in the evening" should be 19:00, not 07:00.
        if let existing = draft.startTime {
            if existing.hour < 12 && hint.hour >= 12 {
                draft.startTime = TimeOfDay(hour: existing.hour + 12, minute: existing.minute)
            }
        } else {
            draft.timeHint = hint
        }
        canvas.claim(m.range)
    }

    private func resolve(hour: Int, minute: Int, meridiem: Meridiem?) -> TimeOfDay {
        var resolved = hour

        if let meridiem {
            if hour == 12 {
                resolved = (meridiem == .am) ? 0 : 12
            } else if meridiem == .pm, hour < 12 {
                resolved = hour + 12
            }
        } else if hour < 12 {
            // No meridiem written. Assume people mean the working-hours reading:
            // "at 3" is 3pm, "at 9" is 9am. Hours 13-23 are already unambiguous.
            if (1...6).contains(hour) { resolved = hour + 12 }
        }

        return TimeOfDay(hour: min(max(resolved, 0), 23), minute: min(max(minute, 0), 59))
    }

    private func minutesSinceMidnight(_ time: TimeOfDay) -> Int {
        time.hour * 60 + time.minute
    }

    // MARK: - Composition

    private func resolveSchedule(_ draft: Draft, now: Date) -> (start: Date?, end: Date?, isAllDay: Bool) {
        let time = draft.startTime ?? draft.timeHint

        guard let time else {
            // A date with no time at all is an all-day item.
            guard let day = draft.day else { return (nil, nil, false) }
            let end = calendar.date(byAdding: .day, value: 1, to: day) ?? day
            return (day, end, true)
        }

        // A time with no date means today, unless today's slot has already gone
        // by, in which case people mean tomorrow.
        let baseDay: Date
        if let day = draft.day {
            baseDay = day
        } else {
            let today = calendar.startOfDay(for: now)
            let candidate = apply(time, to: today)
            baseDay = (candidate ?? today) < now
                ? (calendar.date(byAdding: .day, value: 1, to: today) ?? today)
                : today
        }

        guard let start = apply(time, to: baseDay) else { return (nil, nil, false) }

        var end: Date
        if let endTime = draft.endTime, let candidate = apply(endTime, to: baseDay) {
            // "10pm-1am" wraps past midnight.
            end = candidate <= start ? (calendar.date(byAdding: .day, value: 1, to: candidate) ?? candidate) : candidate
        } else if let duration = draft.duration {
            end = start.addingTimeInterval(duration)
        } else {
            end = start.addingTimeInterval(defaultEventDuration)
        }

        return (start, end, false)
    }

    private func apply(_ time: TimeOfDay, to day: Date) -> Date? {
        calendar.date(bySettingHour: time.hour, minute: time.minute, second: 0, of: day)
    }

    // MARK: - Title cleanup

    private func cleanTitle(_ raw: String) -> String {
        // Collapse the gaps left where tokens were lifted out.
        var title = raw.replacingOccurrences(
            of: "\\s+",
            with: " ",
            options: .regularExpression
        ).trimmingCharacters(in: .whitespacesAndNewlines)

        // Strip connector words and punctuation stranded at either edge by the
        // removal — "lunch with Sam on" reads badly.
        var changed = true
        while changed {
            changed = false
            let before = title

            // Both patterns require surrounding whitespace so a hyphenated or
            // compound opener survives: "In-laws dinner" must not become
            // "laws dinner". The leading set is also narrower than the trailing
            // one, because words like "in" and "for" legitimately start titles
            // ("In the office"), whereas a token lifted from the end of a line
            // strands its preposition far more often.
            title = title.replacingOccurrences(
                of: "^(?:on|at|from|to|by|starts?|starting)\\s+",
                with: "",
                options: [.regularExpression, .caseInsensitive]
            )
            title = title.replacingOccurrences(
                of: "\\s+(?:on|at|from|to|by|in|for|the|of|every|starts?|starting)$",
                with: "",
                options: [.regularExpression, .caseInsensitive]
            )
            title = title.trimmingCharacters(in: CharacterSet(charactersIn: " ,;:-–—@#"))

            if title != before { changed = true }
        }

        return title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Name tables

    private func monthNumber(_ name: String) -> Int? {
        let key = name.lowercased().prefix(3)
        let months = ["jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
                      "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12]
        return months[String(key)]
    }

    /// Foundation weekday numbering: 1 = Sunday through 7 = Saturday.
    private func weekdayNumber(_ name: String) -> Int? {
        let key = name.lowercased().prefix(3)
        let days = ["sun": 1, "mon": 2, "tue": 3, "wed": 4, "thu": 5, "fri": 6, "sat": 7]
        return days[String(key)]
    }
}

// MARK: - Patterns

/// Compiled once and reused. `NSRegularExpression` is safe to match from
/// multiple threads concurrently.
private enum Patterns {
    static func compile(_ pattern: String) -> NSRegularExpression {
        // These are compile-time literals; a failure here is a programmer error
        // that would fail on the very first parse in any test run.
        // swiftlint:disable:next force_try
        try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    }

    static let meridiem = "(a\\.?m\\.?|p\\.?m\\.?)"
    static let monthNames = "(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\\.?"
    static let dayNames = "(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)"
    static let timeUnits = "(minutes|minute|mins|min|m|hours|hour|hrs|hr|h|days|day|d)"

    static let priority = compile("(?:\\bp([1-4])\\b|!!([1-4])\\b)")
    static let project = compile("#([\\p{L}\\p{N}_\\-]+)")
    static let label = compile("@([\\p{L}\\p{N}_\\-]+)")

    static let alertOffset = compile(
        "\\b(?:remind(?:\\s+me)?|alert|alarm|notify(?:\\s+me)?|ping\\s+me)?\\s*(\\d+(?:\\.\\d+)?)\\s*\(timeUnits)\\s+(?:before|prior|ahead|early)\\b"
    )
    static let alertAtStart = compile(
        "\\b(?:remind(?:\\s+me)?|alert|notify(?:\\s+me)?)\\s+at\\s+(?:the\\s+)?(?:time|start)(?:\\s+of\\s+(?:the\\s+)?event)?\\b"
    )

    static let everyWeekday = compile("\\bevery\\s+(weekdays?|weekends?)\\b")
    static let everyNamedDay = compile(
        "\\bevery\\s+\(dayNames)(?:\\s*(?:,|and|&)\\s*\(dayNames))?(?:\\s*(?:,|and|&)\\s*\(dayNames))?\\b"
    )
    static let everyInterval = compile("\\bevery\\s+(?:(\\d+)\\s+|(other)\\s+)?(day|days|week|weeks|month|months|year|years)\\b")
    static let adverbialRecurrence = compile("\\b(daily|weekly|biweekly|fortnightly|monthly|quarterly|yearly|annually)\\b")

    static let forDuration = compile("\\bfor\\s+(\\d+(?:\\.\\d+)?)\\s*\(timeUnits)\\b")
    static let durationLong = compile("\\b(\\d+(?:\\.\\d+)?)\\s*\(timeUnits)\\s+long\\b")

    static let isoDate = compile("\\b(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b")
    static let numericDate = compile("\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b")
    static let monthNameDay = compile("\\b\(monthNames)\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b")
    static let dayMonthName = compile("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?\(monthNames)(?:,?\\s*(\\d{4}))?\\b")

    static let relativeDay = compile("\\b(today|tonight|tomorrow|tmrw|tmw|yesterday|overmorrow)\\b")
    static let inNUnits = compile("\\bin\\s+(\\d+)\\s+(days?|weeks?|months?|years?)\\b")
    static let nextPeriod = compile("\\b(next|this|coming)\\s+(week|month|year)\\b")
    static let weekday = compile("\\b(?:(next|this|coming|on)\\s+)?\(dayNames)\\b")

    static let timeRange = compile(
        "(?:\\b(from|between)\\s+)?\\b(\\d{1,2})(?::(\\d{2}))?\\s*\(meridiem)?\\s*(-|–|—|to|until|till|til|and)\\s*(\\d{1,2})(?::(\\d{2}))?\\s*\(meridiem)?\\b"
    )
    static let namedTime = compile("\\b(noon|midday|midnight)\\b")
    static let timeWithKeyword = compile("\\b(?:at|@)\\s*(\\d{1,2})(?::(\\d{2}))?\\s*\(meridiem)?\\b")
    static let timeWithColon = compile("\\b(\\d{1,2}):(\\d{2})\\s*\(meridiem)?\\b")
    static let timeWithMeridiem = compile("\\b(\\d{1,2})(?::(\\d{2}))?\\s*\(meridiem)\\b")

    // No "tomorrow" alternative here: the relative-date pass claims that word
    // first, and a wider match would then overlap it and be skipped entirely,
    // losing the day part along with it.
    static let dayPart = compile("\\b(?:this\\s+|in\\s+the\\s+)?(morning|afternoon|evening|night)\\b")
}
