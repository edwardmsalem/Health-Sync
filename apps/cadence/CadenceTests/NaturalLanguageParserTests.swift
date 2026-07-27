import XCTest
@testable import Cadence

/// All cases run against a fixed reference instant so the relative-date rules
/// are deterministic.
///
/// Reference "now": Tuesday 10 March 2026, 09:00, America/New_York.
final class NaturalLanguageParserTests: XCTestCase {

    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        calendar.locale = Locale(identifier: "en_US_POSIX")
        return calendar
    }()

    private lazy var parser = NaturalLanguageParser(calendar: calendar)

    private lazy var now: Date = calendar.date(
        from: DateComponents(year: 2026, month: 3, day: 10, hour: 9, minute: 0)
    )!

    // MARK: - Helpers

    private func assertDate(
        _ date: Date?,
        _ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int,
        _ message: String = "",
        file: StaticString = #filePath, line: UInt = #line
    ) {
        guard let date else {
            return XCTFail("expected a date but got nil. \(message)", file: file, line: line)
        }
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        XCTAssertEqual(parts.year, year, "year. \(message)", file: file, line: line)
        XCTAssertEqual(parts.month, month, "month. \(message)", file: file, line: line)
        XCTAssertEqual(parts.day, day, "day. \(message)", file: file, line: line)
        XCTAssertEqual(parts.hour, hour, "hour. \(message)", file: file, line: line)
        XCTAssertEqual(parts.minute, minute, "minute. \(message)", file: file, line: line)
    }

    // MARK: - Times and dates

    func testTomorrowAtSingleTime() {
        let result = parser.parse("Lunch with Sam tomorrow at 1pm", now: now)
        XCTAssertEqual(result.title, "Lunch with Sam")
        assertDate(result.start, 2026, 3, 11, 13, 0)
        assertDate(result.end, 2026, 3, 11, 14, 0, "defaults to a one hour block")
        XCTAssertFalse(result.isAllDay)
    }

    func testNextWeekdaySkipsTodayEvenWhenTodayMatches() {
        // "now" is itself a Tuesday, so this proves "next" moves a full week.
        let result = parser.parse("Dentist next Tuesday 3-4:30", now: now)
        XCTAssertEqual(result.title, "Dentist")
        assertDate(result.start, 2026, 3, 17, 15, 0)
        assertDate(result.end, 2026, 3, 17, 16, 30)
    }

    func testBareWeekdayUsesTheNextOccurrence() {
        let result = parser.parse("Team sync friday 11-1pm", now: now)
        XCTAssertEqual(result.title, "Team sync")
        assertDate(result.start, 2026, 3, 13, 11, 0, "11 should inherit am, not pm")
        assertDate(result.end, 2026, 3, 13, 13, 0)
    }

    func testDateWithNoTimeIsAllDay() {
        let result = parser.parse("Review deck tomorrow", now: now)
        XCTAssertEqual(result.title, "Review deck")
        XCTAssertTrue(result.isAllDay)
        assertDate(result.start, 2026, 3, 11, 0, 0)
        assertDate(result.end, 2026, 3, 12, 0, 0)
    }

    func testTimeAlreadyPassedTodayRollsToTomorrow() {
        let result = parser.parse("Call mom at 8", now: now)
        XCTAssertEqual(result.title, "Call mom")
        assertDate(result.start, 2026, 3, 11, 8, 0, "08:00 is behind the 09:00 reference")
    }

    func testBareAfternoonHourAssumesPM() {
        let result = parser.parse("Coffee at 3", now: now)
        assertDate(result.start, 2026, 3, 10, 15, 0)
    }

    func testRangeCrossingMidnightPushesEndToNextDay() {
        let result = parser.parse("Flight 10pm-1am", now: now)
        XCTAssertEqual(result.title, "Flight")
        assertDate(result.start, 2026, 3, 10, 22, 0)
        assertDate(result.end, 2026, 3, 11, 1, 0)
    }

    func testMonthAndDayRollsForwardToTheNextOccurrence() {
        let result = parser.parse("Dec 5 party", now: now)
        XCTAssertEqual(result.title, "party")
        XCTAssertTrue(result.isAllDay)
        assertDate(result.start, 2026, 12, 5, 0, 0)
    }

    func testNoonIsMidday() {
        let result = parser.parse("Standup at noon", now: now)
        assertDate(result.start, 2026, 3, 10, 12, 0)
    }

    func testMiddayIsNotMidnight() {
        let result = parser.parse("Standup at midday", now: now)
        assertDate(result.start, 2026, 3, 10, 12, 0)
    }

    func testDayPartDisambiguatesAnExplicitHour() {
        let result = parser.parse("Meeting at 7 in the evening", now: now)
        XCTAssertEqual(result.title, "Meeting")
        assertDate(result.start, 2026, 3, 10, 19, 0)
    }

    func testDurationOverridesTheDefaultBlockLength() {
        let result = parser.parse("Gym for 90 minutes at 6am", now: now)
        XCTAssertEqual(result.title, "Gym")
        assertDate(result.start, 2026, 3, 11, 6, 0, "6am has passed, so tomorrow")
        assertDate(result.end, 2026, 3, 11, 7, 30)
    }

    func testAmbiguousBareNumberRangeIsNotTreatedAsATime() {
        // "2-3" with no meridiem and no minutes is far more likely a quantity.
        let result = parser.parse("Order 2-3 boxes", now: now)
        XCTAssertNil(result.start)
        XCTAssertEqual(result.title, "Order 2-3 boxes")
    }

    func testTextWithNoScheduleKeepsTheWholeTitle() {
        let result = parser.parse("Think about the roadmap", now: now)
        XCTAssertFalse(result.hasSchedule)
        XCTAssertEqual(result.title, "Think about the roadmap")
    }

    // MARK: - Markers

    func testTodoistMarkersAreLiftedOutOfTheTitle() {
        let result = parser.parse(
            "Submit report friday 5pm #Work @laptop p1 remind me 30 min before",
            now: now
        )
        XCTAssertEqual(result.title, "Submit report")
        XCTAssertEqual(result.projectName, "Work")
        XCTAssertEqual(result.labels, ["laptop"])
        XCTAssertEqual(result.priority, 1)
        XCTAssertEqual(result.alerts, [AlertOffset(minutesBefore: 30)])
        XCTAssertTrue(result.looksLikeTask)
        assertDate(result.start, 2026, 3, 13, 17, 0)
    }

    func testBangBangPriorityNotation() {
        let result = parser.parse("Pay rent !!2", now: now)
        XCTAssertEqual(result.priority, 2)
        XCTAssertEqual(result.title, "Pay rent")
    }

    func testHourAlertOffsetConvertsToMinutes() {
        let result = parser.parse("Board call tomorrow 2pm alert 1 hour before", now: now)
        XCTAssertEqual(result.alerts, [AlertOffset(minutesBefore: 60)])
        XCTAssertEqual(result.title, "Board call")
    }

    // MARK: - Recurrence

    func testEveryWeekday() {
        let result = parser.parse("Standup every weekday at 9:15", now: now)
        XCTAssertEqual(result.title, "Standup")
        XCTAssertEqual(result.recurrence, .everyWeekday)
        assertDate(result.start, 2026, 3, 10, 9, 15)
    }

    func testEveryNamedDay() {
        let result = parser.parse("Yoga every monday 7pm", now: now)
        XCTAssertEqual(result.title, "Yoga")
        XCTAssertEqual(result.recurrence, RecurrenceSpec(frequency: .weekly, weekdays: [2]))
    }

    func testEveryOtherWeek() {
        let result = parser.parse("1:1 every other week", now: now)
        XCTAssertEqual(result.recurrence, RecurrenceSpec(frequency: .weekly, interval: 2))
    }

    func testAdverbialRecurrence() {
        let result = parser.parse("Water plants weekly", now: now)
        XCTAssertEqual(result.title, "Water plants")
        XCTAssertEqual(result.recurrence, .weekly)
    }

    // MARK: - Title cleanup

    func testHyphenatedOpenerSurvivesTitleCleanup() {
        // Regression: a naive leading-preposition strip turns this into
        // "laws dinner" by matching the "In" in "In-laws".
        let result = parser.parse("In-laws dinner saturday 7pm", now: now)
        XCTAssertEqual(result.title, "In-laws dinner")
        assertDate(result.start, 2026, 3, 14, 19, 0)
    }

    func testStrandedPrepositionIsTrimmed() {
        let result = parser.parse("Sales review on friday", now: now)
        XCTAssertEqual(result.title, "Sales review")
    }

    func testLeadingPrepositionInARealTitleIsKept() {
        let result = parser.parse("In the office tomorrow", now: now)
        XCTAssertEqual(result.title, "In the office")
    }
}
