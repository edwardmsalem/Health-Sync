import XCTest
@testable import Cadence

final class TimelineLayoutTests: XCTestCase {

    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        return calendar
    }()

    private lazy var day: Date = calendar.date(
        from: DateComponents(year: 2026, month: 3, day: 10)
    )!

    private func item(
        _ id: String,
        _ startHour: Int, _ startMinute: Int,
        to endHour: Int, _ endMinute: Int,
        isAllDay: Bool = false
    ) -> CalendarItem {
        let start = calendar.date(
            from: DateComponents(year: 2026, month: 3, day: 10, hour: startHour, minute: startMinute)
        )!
        let end = calendar.date(
            from: DateComponents(year: 2026, month: 3, day: 10, hour: endHour, minute: endMinute)
        )!
        return CalendarItem(
            id: id,
            title: id,
            start: start,
            end: end,
            isAllDay: isAllDay,
            origin: .event(eventIdentifier: id, calendarIdentifier: "cal"),
            containerTitle: "Work",
            colorHex: "#4C8DF6"
        )
    }

    func testNonOverlappingItemsEachGetTheFullWidth() {
        let placements = TimelineLayout.place(
            [item("a", 9, 0, to: 10, 0), item("b", 11, 0, to: 12, 0)],
            on: day, calendar: calendar
        )
        XCTAssertEqual(placements["a"], .init(column: 0, columnCount: 1))
        XCTAssertEqual(placements["b"], .init(column: 0, columnCount: 1))
    }

    func testTwoOverlappingItemsSplitIntoColumns() {
        let placements = TimelineLayout.place(
            [item("a", 9, 0, to: 10, 30), item("b", 10, 0, to: 11, 0)],
            on: day, calendar: calendar
        )
        XCTAssertEqual(placements["a"], .init(column: 0, columnCount: 2))
        XCTAssertEqual(placements["b"], .init(column: 1, columnCount: 2))
    }

    func testFreedColumnIsReusedWithinACluster() {
        // b finishes at 10:00, so c can take b's column rather than opening a third.
        let placements = TimelineLayout.place(
            [item("a", 9, 0, to: 11, 0), item("b", 9, 30, to: 10, 0), item("c", 10, 0, to: 11, 0)],
            on: day, calendar: calendar
        )
        XCTAssertEqual(placements["a"], .init(column: 0, columnCount: 2))
        XCTAssertEqual(placements["b"], .init(column: 1, columnCount: 2))
        XCTAssertEqual(placements["c"], .init(column: 1, columnCount: 2))
    }

    func testColumnCountIsPerClusterNotPerDay() {
        // A busy late morning must not shrink the unrelated 9am block.
        let placements = TimelineLayout.place(
            [item("a", 9, 0, to: 10, 0), item("b", 10, 0, to: 11, 0), item("c", 10, 30, to: 11, 30)],
            on: day, calendar: calendar
        )
        XCTAssertEqual(placements["a"], .init(column: 0, columnCount: 1))
        XCTAssertEqual(placements["b"], .init(column: 0, columnCount: 2))
        XCTAssertEqual(placements["c"], .init(column: 1, columnCount: 2))
    }

    func testLongerItemTakesTheLeftmostColumnAtEqualStarts() {
        let placements = TimelineLayout.place(
            [item("short", 9, 0, to: 9, 30), item("long", 9, 0, to: 11, 0)],
            on: day, calendar: calendar
        )
        XCTAssertEqual(placements["long"], .init(column: 0, columnCount: 2))
        XCTAssertEqual(placements["short"], .init(column: 1, columnCount: 2))
    }

    func testZeroLengthItemStillReservesAColumn() {
        let placements = TimelineLayout.place(
            [item("point", 9, 0, to: 9, 0), item("block", 9, 0, to: 10, 0)],
            on: day, calendar: calendar
        )
        XCTAssertEqual(placements["block"], .init(column: 0, columnCount: 2))
        XCTAssertEqual(placements["point"], .init(column: 1, columnCount: 2))
    }

    func testAllDayItemsAreExcluded() {
        let placements = TimelineLayout.place(
            [item("allday", 0, 0, to: 23, 59, isAllDay: true), item("a", 9, 0, to: 10, 0)],
            on: day, calendar: calendar
        )
        XCTAssertNil(placements["allday"])
        XCTAssertEqual(placements["a"], .init(column: 0, columnCount: 1))
    }

    func testItemsFromOtherDaysAreExcluded() {
        let otherDay = calendar.date(from: DateComponents(year: 2026, month: 3, day: 12))!
        let placements = TimelineLayout.place(
            [item("a", 9, 0, to: 10, 0)],
            on: otherDay, calendar: calendar
        )
        XCTAssertTrue(placements.isEmpty)
    }
}
