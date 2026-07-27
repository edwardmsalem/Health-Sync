import Foundation
import EventKit
import Combine

/// The app's single door onto EventKit.
///
/// Going through EventKit rather than talking to providers directly is what
/// makes both requested accounts work at once: iCloud has no public web API, and
/// a Google account added in system Settings is exposed here over CalDAV. Both
/// arrive as ordinary `EKCalendar`s, so neither needs an OAuth flow.
@MainActor
final class EventStoreService: ObservableObject {

    enum AccessError: LocalizedError {
        case denied
        case noWritableCalendar
        case calendarNotFound(String)
        case eventNotFound(String)

        var errorDescription: String? {
            switch self {
            case .denied:
                return "Cadence needs calendar access. Grant it in Settings > Privacy > Calendars."
            case .noWritableCalendar:
                return "No writable calendar is available to save this to."
            case .calendarNotFound(let id):
                return "That calendar is no longer available (\(id))."
            case .eventNotFound(let id):
                return "That event no longer exists (\(id))."
            }
        }
    }

    private let store = EKEventStore()
    private var cancellables = Set<AnyCancellable>()

    @Published private(set) var calendars: [CalendarSource] = []
    @Published private(set) var authorizationStatus: EKAuthorizationStatus
    /// Bumped whenever EventKit reports external changes, so views can refetch.
    @Published private(set) var changeCounter = 0

    var hasFullAccess: Bool { authorizationStatus == .fullAccess }

    init() {
        self.authorizationStatus = EKEventStore.authorizationStatus(for: .event)

        // Fires when anything changes the store — including the Calendar app,
        // or a push from iCloud/Google.
        NotificationCenter.default.publisher(for: .EKEventStoreChanged)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self else { return }
                self.refreshCalendars()
                self.changeCounter += 1
            }
            .store(in: &cancellables)
    }

    // MARK: - Access

    @discardableResult
    func requestAccess() async -> Bool {
        do {
            // iOS 17 / macOS 14 split calendar permission into read-only and
            // full access. Cadence creates and edits events, so it needs full.
            let granted = try await store.requestFullAccessToEvents()
            authorizationStatus = EKEventStore.authorizationStatus(for: .event)
            if granted { refreshCalendars() }
            return granted
        } catch {
            authorizationStatus = EKEventStore.authorizationStatus(for: .event)
            return false
        }
    }

    func refreshCalendars() {
        guard hasFullAccess else {
            calendars = []
            return
        }
        calendars = store.calendars(for: .event)
            .map(CalendarSource.init(calendar:))
            .sorted {
                // Group by account, then alphabetically inside it.
                if $0.accountTitle != $1.accountTitle { return $0.accountTitle < $1.accountTitle }
                return $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
            }
    }

    // MARK: - Reading

    /// Events overlapping `interval`, restricted to `calendarIDs` when given.
    ///
    /// Runs synchronously against EventKit's local store. Callers keep the
    /// window tight — the visible month plus a month of padding — which keeps
    /// this comfortably inside a frame even on a busy calendar.
    func items(in interval: DateInterval, calendarIDs: Set<String>?) -> [CalendarItem] {
        guard hasFullAccess else { return [] }

        let selected: [EKCalendar]?
        if let calendarIDs {
            let matching = store.calendars(for: .event).filter { calendarIDs.contains($0.calendarIdentifier) }
            // An empty filter means "show nothing"; passing nil to EventKit
            // would instead mean "show everything", so short-circuit here.
            if matching.isEmpty { return [] }
            selected = matching
        } else {
            selected = nil
        }

        let predicate = store.predicateForEvents(
            withStart: interval.start,
            end: interval.end,
            calendars: selected
        )

        return store.events(matching: predicate).map(Self.makeItem(from:))
    }

    static func makeItem(from event: EKEvent) -> CalendarItem {
        let colorHex = ColorHex.string(from: event.calendar?.cgColor)
        let identifier = event.eventIdentifier ?? UUID().uuidString

        // Every occurrence of a repeating event shares one `eventIdentifier`, so
        // the start date has to be part of the id or occurrences collide in any
        // dictionary keyed by item id — the timeline layout being the one that
        // matters most.
        let occurrenceID = "\(identifier)@\(Int(event.startDate.timeIntervalSince1970))"

        return CalendarItem(
            id: occurrenceID,
            title: event.title ?? "(No title)",
            notes: event.notes,
            location: event.location,
            start: event.startDate,
            end: event.endDate,
            isAllDay: event.isAllDay,
            origin: .event(
                eventIdentifier: identifier,
                calendarIdentifier: event.calendar?.calendarIdentifier ?? ""
            ),
            containerTitle: event.calendar?.title ?? "Calendar",
            colorHex: colorHex,
            alerts: (event.alarms ?? []).map {
                AlertOffset(minutesBefore: Int((-$0.relativeOffset / 60).rounded()))
            },
            isRecurring: event.hasRecurrenceRules,
            url: event.url
        )
    }

    // MARK: - Writing

    var defaultCalendarID: String? {
        store.defaultCalendarForNewEvents?.calendarIdentifier
    }

    @discardableResult
    func createEvent(from parsed: ParsedInput, calendarID: String?, fallbackDay: Date) throws -> String {
        guard hasFullAccess else { throw AccessError.denied }

        let calendar = try resolveCalendar(id: calendarID)
        let event = EKEvent(eventStore: store)
        event.calendar = calendar
        event.title = parsed.title.isEmpty ? "New event" : parsed.title

        // No time in the text means the user is adding something to the day
        // they are already looking at.
        if let start = parsed.start {
            event.startDate = start
            event.endDate = parsed.end ?? start.addingTimeInterval(3600)
            event.isAllDay = parsed.isAllDay
        } else {
            let start = Self.defaultStart(on: fallbackDay)
            event.startDate = start
            event.endDate = start.addingTimeInterval(3600)
        }

        if let recurrence = parsed.recurrence {
            event.addRecurrenceRule(Self.recurrenceRule(from: recurrence))
        }

        for alert in parsed.alerts {
            event.addAlarm(EKAlarm(relativeOffset: alert.relativeOffset))
        }

        try store.save(event, span: .futureEvents, commit: true)
        return event.eventIdentifier ?? ""
    }

    func updateEvent(
        identifier: String,
        title: String,
        start: Date,
        end: Date,
        isAllDay: Bool,
        location: String?,
        notes: String?,
        alerts: [AlertOffset]
    ) throws {
        guard hasFullAccess else { throw AccessError.denied }
        guard let event = store.event(withIdentifier: identifier) else {
            throw AccessError.eventNotFound(identifier)
        }

        event.title = title
        event.startDate = start
        event.endDate = max(end, start)
        event.isAllDay = isAllDay
        event.location = location
        event.notes = notes

        // Alarms have no stable identity, so reconciling means replacing.
        for existing in event.alarms ?? [] { event.removeAlarm(existing) }
        for alert in alerts { event.addAlarm(EKAlarm(relativeOffset: alert.relativeOffset)) }

        try store.save(event, span: .thisEvent, commit: true)
    }

    /// Moves an event to a new start, preserving its duration. Used by drag.
    func moveEvent(identifier: String, to newStart: Date) throws {
        guard hasFullAccess else { throw AccessError.denied }
        guard let event = store.event(withIdentifier: identifier) else {
            throw AccessError.eventNotFound(identifier)
        }
        let duration = event.endDate.timeIntervalSince(event.startDate)
        event.startDate = newStart
        event.endDate = newStart.addingTimeInterval(duration)
        try store.save(event, span: .thisEvent, commit: true)
    }

    func deleteEvent(identifier: String, span: EKSpan = .thisEvent) throws {
        guard hasFullAccess else { throw AccessError.denied }
        guard let event = store.event(withIdentifier: identifier) else {
            throw AccessError.eventNotFound(identifier)
        }
        try store.remove(event, span: span, commit: true)
    }

    // MARK: - Helpers

    private func resolveCalendar(id: String?) throws -> EKCalendar {
        if let id, let match = store.calendar(withIdentifier: id), match.allowsContentModifications {
            return match
        }
        if let fallback = store.defaultCalendarForNewEvents, fallback.allowsContentModifications {
            return fallback
        }
        guard let any = store.calendars(for: .event).first(where: { $0.allowsContentModifications }) else {
            throw AccessError.noWritableCalendar
        }
        return any
    }

    /// Next round hour on the given day, or 9am if that day is not today.
    static func defaultStart(on day: Date, now: Date = Date(), calendar: Calendar = .autoupdatingCurrent) -> Date {
        if calendar.isDate(day, inSameDayAs: now) {
            let nextHour = calendar.date(byAdding: .hour, value: 1, to: now) ?? now
            return calendar.date(
                bySettingHour: calendar.component(.hour, from: nextHour),
                minute: 0, second: 0, of: nextHour
            ) ?? nextHour
        }
        return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: day) ?? day
    }

    static func recurrenceRule(from spec: RecurrenceSpec) -> EKRecurrenceRule {
        let frequency: EKRecurrenceFrequency
        switch spec.frequency {
        case .daily: frequency = .daily
        case .weekly: frequency = .weekly
        case .monthly: frequency = .monthly
        case .yearly: frequency = .yearly
        }

        // EKWeekday and Foundation both number Sunday as 1, so these map across
        // without adjustment.
        var daysOfTheWeek: [EKRecurrenceDayOfWeek]?
        if spec.frequency == .weekly, !spec.weekdays.isEmpty {
            daysOfTheWeek = spec.weekdays.compactMap { number in
                EKWeekday(rawValue: number).map { EKRecurrenceDayOfWeek($0) }
            }
        }

        return EKRecurrenceRule(
            recurrenceWith: frequency,
            interval: max(1, spec.interval),
            daysOfTheWeek: daysOfTheWeek,
            daysOfTheMonth: nil,
            monthsOfTheYear: nil,
            weeksOfTheYear: nil,
            daysOfTheYear: nil,
            setPositions: nil,
            end: nil
        )
    }
}
