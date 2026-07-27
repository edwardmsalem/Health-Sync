import XCTest
@testable import Cadence

final class TaskProjectionTests: XCTestCase {

    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        calendar.locale = Locale(identifier: "en_US_POSIX")
        return calendar
    }()

    private lazy var window = DateInterval(
        start: calendar.date(from: DateComponents(year: 2026, month: 3, day: 1))!,
        end: calendar.date(from: DateComponents(year: 2026, month: 4, day: 1))!
    )

    private let projects = [
        "p1": TodoistProject(id: "p1", name: "Work", color: "blue", isDeleted: false)
    ]

    // MARK: - Fixtures

    private func task(
        id: String = "t1",
        content: String = "Task",
        dueDate: String?,
        duration: TodoistDuration? = nil,
        checked: Bool = false,
        isDeleted: Bool = false,
        priority: Int? = nil
    ) -> TodoistItem {
        TodoistItem(
            id: id,
            content: content,
            description: nil,
            projectID: "p1",
            priority: priority,
            due: dueDate.map { TodoistDue(date: $0, timezone: nil, string: nil, isRecurring: false) },
            duration: duration,
            checked: checked,
            isDeleted: isDeleted,
            labels: nil
        )
    }

    private func project(
        _ items: [TodoistItem],
        options: TaskProjection.Options = TaskProjection.Options()
    ) -> [CalendarItem] {
        TaskProjection.calendarItems(
            items: items,
            projects: projects,
            in: window,
            calendar: calendar,
            options: options
        )
    }

    private func parts(_ date: Date) -> DateComponents {
        calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
    }

    // MARK: - Date-only placement

    func testDateOnlyTaskIsPlacedAtTheConfiguredHour() throws {
        let results = project([task(dueDate: "2026-03-10")])

        XCTAssertEqual(results.count, 1)
        let item = try XCTUnwrap(results.first)

        XCTAssertEqual(parts(item.start).hour, 9, "defaults to 9am")
        XCTAssertEqual(parts(item.start).minute, 0)
        XCTAssertEqual(parts(item.start).day, 10)
        XCTAssertFalse(item.isAllDay, "it is a timed block, not an all-day row")
        XCTAssertTrue(item.hasInferredTime)
    }

    func testDateOnlyHourIsConfigurable() {
        let results = project(
            [task(dueDate: "2026-03-10")],
            options: TaskProjection.Options(dateOnlyHour: 14)
        )
        XCTAssertEqual(parts(results[0].start).hour, 14)
    }

    func testDateOnlyHourIsClampedToAValidHour() {
        let options = TaskProjection.Options(dateOnlyHour: 99)
        XCTAssertEqual(options.dateOnlyHour, 23)
        XCTAssertEqual(TaskProjection.Options(dateOnlyHour: -4).dateOnlyHour, 0)
    }

    func testDateOnlyTaskUsesTheDefaultDuration() {
        let results = project([task(dueDate: "2026-03-10")])
        XCTAssertEqual(results[0].duration, 30 * 60)
    }

    // MARK: - Timed tasks

    func testTaskWithAFloatingTimeKeepsThatTime() {
        let results = project([task(dueDate: "2026-03-10T14:30:00")])

        XCTAssertEqual(parts(results[0].start).hour, 14)
        XCTAssertEqual(parts(results[0].start).minute, 30)
        XCTAssertFalse(results[0].hasInferredTime, "the user chose this time")
    }

    func testTaskWithAUTCTimeConvertsToLocal() {
        // 18:30Z on 10 March 2026 is 14:30 in New York (EDT, UTC-4).
        let results = project([task(dueDate: "2026-03-10T18:30:00Z")])

        XCTAssertEqual(parts(results[0].start).hour, 14)
        XCTAssertEqual(parts(results[0].start).minute, 30)
        XCTAssertFalse(results[0].hasInferredTime)
    }

    func testExplicitDurationOverridesTheDefault() {
        let results = project([
            task(dueDate: "2026-03-10T14:00:00", duration: TodoistDuration(amount: 90, unit: "minute"))
        ])
        XCTAssertEqual(results[0].duration, 90 * 60)
    }

    // MARK: - Filtering

    func testCompletedTasksAreExcludedByDefault() {
        XCTAssertTrue(project([task(dueDate: "2026-03-10", checked: true)]).isEmpty)
    }

    func testCompletedTasksCanBeIncluded() {
        let results = project(
            [task(dueDate: "2026-03-10", checked: true)],
            options: TaskProjection.Options(includeCompleted: true)
        )
        XCTAssertEqual(results.count, 1)
        XCTAssertTrue(results[0].isCompleted)
    }

    func testDeletedTasksAreExcluded() {
        XCTAssertTrue(project([task(dueDate: "2026-03-10", isDeleted: true)]).isEmpty)
    }

    func testTasksWithNoDueDateAreExcluded() {
        XCTAssertTrue(project([task(dueDate: nil)]).isEmpty)
    }

    func testTasksOutsideTheWindowAreExcluded() {
        XCTAssertTrue(project([task(dueDate: "2026-06-01")]).isEmpty)
    }

    // MARK: - Mapping

    func testProjectSuppliesTheContainerAndColor() {
        let results = project([task(dueDate: "2026-03-10T09:00:00")])
        XCTAssertEqual(results[0].containerTitle, "Work")
        XCTAssertEqual(results[0].colorHex, "#4073FF", "Todoist's 'blue'")
        XCTAssertEqual(results[0].origin, .task(todoistID: "t1"))
    }

    func testApiPriorityIsInvertedToDisplayPriority() {
        // Todoist's API calls the most urgent level 4; its UI calls it p1.
        let results = project([task(dueDate: "2026-03-10T09:00:00", priority: 4)])
        XCTAssertEqual(results[0].priority, 1)
    }
}
