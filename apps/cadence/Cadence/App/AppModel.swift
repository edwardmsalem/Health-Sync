import Foundation
import Combine
import SwiftUI

/// Coordinates the three data sources and hands the views a single, already
/// merged picture of a day.
///
/// Views never talk to EventKit or Todoist directly; they read `items(on:)`.
/// That is what lets an event and a task sit in the same timeline and be laid
/// out against each other by the same code.
@MainActor
final class AppModel: ObservableObject {

    let eventStore: EventStoreService
    let todoist: TodoistStore
    let preferencesController: PreferencesController
    let alerts: AlertScheduler

    @Published var selectedDate: Date
    @Published var viewMode: CalendarViewMode = .month
    /// Any date inside the month currently being displayed.
    @Published var anchorMonth: Date

    @Published private(set) var itemsByDay: [Date: [CalendarItem]] = [:]
    @Published private(set) var isLoading = false

    @Published var isPresentingQuickAdd = false
    @Published var isPresentingSettings = false
    /// Set when quick add was opened by tapping an empty slot, so the new item
    /// lands where the user pointed rather than at the next round hour.
    @Published var pendingStart: Date?
    @Published var editingItem: CalendarItem?
    @Published var errorMessage: String?

    private var cancellables = Set<AnyCancellable>()

    var preferences: AppPreferences { preferencesController.preferences }

    /// The app's calendar, with the user's chosen first weekday applied.
    var calendar: Calendar {
        var calendar = Calendar.autoupdatingCurrent
        calendar.firstWeekday = preferences.firstWeekday
        return calendar
    }

    // Defaults are built in the body rather than as default arguments: default
    // argument expressions evaluate in a nonisolated context, so they cannot
    // call these types' @MainActor initialisers.
    init(
        eventStore: EventStoreService? = nil,
        todoist: TodoistStore? = nil,
        preferencesController: PreferencesController? = nil,
        alerts: AlertScheduler? = nil
    ) {
        self.eventStore = eventStore ?? EventStoreService()
        self.todoist = todoist ?? TodoistStore()
        self.preferencesController = preferencesController ?? PreferencesController()
        self.alerts = alerts ?? AlertScheduler()

        let today = Calendar.autoupdatingCurrent.startOfDay(for: Date())
        self.selectedDate = today
        self.anchorMonth = today

        observeSources()
    }

    // MARK: - Lifecycle

    func bootstrap() async {
        await preferencesController.start()
        viewMode = preferences.defaultViewMode

        await eventStore.requestAccess()
        await alerts.refreshAuthorizationStatus()
        if alerts.authorizationStatus == .notDetermined {
            await alerts.requestAuthorization()
        }

        await todoist.sync()
        reload()
    }

    /// Called when the app returns to the foreground.
    func refresh() async {
        await todoist.sync()
        eventStore.refreshCalendars()
        reload()
    }

    private func observeSources() {
        // Each of these changes the merged picture, so each triggers a rebuild.
        // Debounced because a Todoist sync publishes item-by-item and a
        // preferences toggle can fire several times in one gesture.
        let eventChanges = eventStore.$changeCounter.map { _ in () }.eraseToAnyPublisher()
        let taskChanges = todoist.$itemsByID.map { _ in () }.eraseToAnyPublisher()
        let projectChanges = todoist.$projectsByID.map { _ in () }.eraseToAnyPublisher()
        let preferenceChanges = preferencesController.$preferences.map { _ in () }.eraseToAnyPublisher()

        Publishers.MergeMany(eventChanges, taskChanges, projectChanges, preferenceChanges)
            .debounce(for: .milliseconds(150), scheduler: DispatchQueue.main)
            .sink { [weak self] in self?.reload() }
            .store(in: &cancellables)

        $anchorMonth
            .removeDuplicates { [weak self] lhs, rhs in
                guard let self else { return false }
                return self.calendar.isDate(lhs, equalTo: rhs, toGranularity: .month)
            }
            .sink { [weak self] _ in self?.reload() }
            .store(in: &cancellables)
    }

    // MARK: - Loading

    /// Rebuilds the day buckets for the visible window.
    ///
    /// The window is the displayed month plus a month either side, which covers
    /// the leading and trailing days a month grid shows and lets a swipe to the
    /// next month render without a visible refetch.
    func reload() {
        let window = loadWindow()
        isLoading = true
        defer { isLoading = false }

        let visibleCalendarIDs = Set(
            eventStore.calendars
                .filter { preferences.isVisible(calendarID: $0.id) }
                .map(\.id)
        )

        var merged = eventStore.items(in: window, calendarIDs: visibleCalendarIDs)

        // Apply any per-calendar color override the user set in Settings.
        if !preferences.calendarColorOverrides.isEmpty {
            merged = merged.map { item in
                guard let calendarID = item.origin.calendarIdentifier,
                      let override = preferences.calendarColorOverrides[calendarID]
                else { return item }
                var copy = item
                copy.colorHex = override
                return copy
            }
        }

        if preferences.showTodoistTasks {
            merged += todoist.calendarItems(
                in: window,
                includeCompleted: preferences.showCompletedTasks,
                dateOnlyHour: preferences.dateOnlyTaskHour
            )
        }

        itemsByDay = bucket(merged, in: window)

        // Hoisted out of the Task: a capture list cannot name a property, and
        // reading them here keeps the values consistent with what was just laid
        // out even if preferences change while the reconcile is in flight.
        let taskItems = merged.filter { $0.origin.isTask }
        let defaultAlerts = preferences.defaultAlerts
        let scheduler = alerts

        Task {
            await scheduler.reconcile(taskItems: taskItems, defaultAlerts: defaultAlerts)
        }
    }

    private func loadWindow() -> DateInterval {
        let calendar = self.calendar
        let startOfMonth = calendar.date(
            from: calendar.dateComponents([.year, .month], from: anchorMonth)
        ) ?? anchorMonth

        let start = calendar.date(byAdding: .month, value: -1, to: startOfMonth) ?? startOfMonth
        let end = calendar.date(byAdding: .month, value: 2, to: startOfMonth) ?? startOfMonth
        return DateInterval(start: start, end: end)
    }

    /// Places each item under every day it touches, so a multi-day event shows
    /// up on all of them rather than only on the day it began.
    private func bucket(_ items: [CalendarItem], in window: DateInterval) -> [Date: [CalendarItem]] {
        let calendar = self.calendar
        var buckets: [Date: [CalendarItem]] = [:]

        for item in items {
            var cursor = calendar.startOfDay(for: max(item.start, window.start))
            let last = calendar.startOfDay(for: min(item.end, window.end))

            while cursor <= last {
                // An event ending exactly at midnight belongs to the day before,
                // not to the sliver of the next one.
                if item.end > cursor || calendar.isDate(item.start, inSameDayAs: cursor) {
                    buckets[cursor, default: []].append(item)
                }
                guard let next = calendar.date(byAdding: .day, value: 1, to: cursor), next > cursor else { break }
                cursor = next
            }
        }

        for key in buckets.keys {
            buckets[key]?.sort { lhs, rhs in
                if lhs.isAllDay != rhs.isAllDay { return lhs.isAllDay }
                if lhs.start != rhs.start { return lhs.start < rhs.start }
                return lhs.title < rhs.title
            }
        }

        return buckets
    }

    // MARK: - Queries

    func items(on day: Date) -> [CalendarItem] {
        itemsByDay[calendar.startOfDay(for: day)] ?? []
    }

    func timedItems(on day: Date) -> [CalendarItem] {
        items(on: day).filter { !$0.isAllDay }
    }

    func allDayItems(on day: Date) -> [CalendarItem] {
        items(on: day).filter(\.isAllDay)
    }

    func hasItems(on day: Date) -> Bool {
        !(itemsByDay[calendar.startOfDay(for: day)] ?? []).isEmpty
    }

    /// Up to three distinct calendar colors for a month cell's dots.
    func dotColors(on day: Date) -> [String] {
        var seen: [String] = []
        for item in items(on: day) where !seen.contains(item.colorHex) {
            seen.append(item.colorHex)
            if seen.count == 3 { break }
        }
        return seen
    }

    // MARK: - Navigation

    func select(_ day: Date) {
        selectedDate = calendar.startOfDay(for: day)
        if !calendar.isDate(selectedDate, equalTo: anchorMonth, toGranularity: .month) {
            anchorMonth = selectedDate
        }
    }

    func goToToday() {
        select(Date())
    }

    func step(months: Int) {
        guard let next = calendar.date(byAdding: .month, value: months, to: anchorMonth) else { return }
        anchorMonth = next
    }

    func step(days: Int) {
        guard let next = calendar.date(byAdding: .day, value: days, to: selectedDate) else { return }
        select(next)
    }

    func setViewMode(_ mode: CalendarViewMode) {
        viewMode = mode
        preferencesController.update { $0.defaultViewMode = mode }
    }

    /// Opens quick add for the slot the user tapped in a timeline.
    ///
    /// `offsetY` is the tap's distance from the top of the 24-hour column, which
    /// converts to a time of day through the same hour height the grid is drawn
    /// with. Snapped to 15 minutes, because nobody means 10:07.
    func beginQuickAdd(on day: Date, atOffset offsetY: CGFloat) {
        let minutes = Double(offsetY / Theme.Metrics.hourHeight) * 60
        let snapped = Int((minutes / 15).rounded(.down) * 15)
        let dayStart = calendar.startOfDay(for: day)

        pendingStart = calendar.date(byAdding: .minute, value: snapped, to: dayStart)
        select(day)
        isPresentingQuickAdd = true
    }

    // MARK: - Creating

    /// Turns a quick-add line into either an event or a Todoist task.
    ///
    /// Markers decide it: `#project`, `@label`, or a priority means the user is
    /// describing a task. Plain text is an event, which is the common case for
    /// a calendar app.
    func createFromQuickAdd(text: String, forceTask: Bool = false) async {
        let parser = NaturalLanguageParser(calendar: calendar)
        let parsed = parser.parse(text)

        let shouldBeTask = (forceTask || parsed.looksLikeTask) && todoist.isConnected

        if shouldBeTask {
            await todoist.addTask(parsed: parsed, rawText: text)
        } else {
            do {
                var withDefaults = parsed
                if withDefaults.alerts.isEmpty {
                    withDefaults.alerts = preferences.defaultAlerts
                }
                // Text beats the tapped slot: if the line says "3pm", honour it
                // even though quick add was opened from the 10am row.
                if withDefaults.start == nil, let pendingStart {
                    withDefaults.start = pendingStart
                    withDefaults.end = pendingStart.addingTimeInterval(3600)
                }
                try eventStore.createEvent(
                    from: withDefaults,
                    calendarID: preferences.defaultCalendarID,
                    fallbackDay: pendingStart ?? selectedDate
                )
            } catch {
                errorMessage = error.localizedDescription
            }
        }

        if let start = parsed.start {
            select(start)
        }
        pendingStart = nil
        reload()
    }

    func toggleCompletion(for item: CalendarItem) async {
        guard let taskID = item.origin.todoistID else { return }
        await todoist.setCompleted(!item.isCompleted, taskID: taskID)
        reload()
    }

    func delete(_ item: CalendarItem) {
        switch item.origin {
        case .event(let eventIdentifier, _):
            do {
                try eventStore.deleteEvent(identifier: eventIdentifier)
                reload()
            } catch {
                errorMessage = error.localizedDescription
            }
        case .task:
            // Tasks are completed rather than deleted; deleting someone's
            // Todoist task from a calendar view is too destructive to be a
            // swipe away.
            Task { await toggleCompletion(for: item) }
        }
    }

    /// Moves an item to a new start, preserving duration. Used by drag.
    func move(_ item: CalendarItem, to newStart: Date) async {
        switch item.origin {
        case .event(let eventIdentifier, _):
            do {
                try eventStore.moveEvent(identifier: eventIdentifier, to: newStart)
            } catch {
                errorMessage = error.localizedDescription
            }
        case .task(let todoistID):
            await todoist.reschedule(taskID: todoistID, to: newStart)
        }
        reload()
    }
}
