import Foundation
import Combine

/// Holds the Todoist side of the calendar.
///
/// Sync is incremental: the server is asked only for what changed since the
/// last `sync_token`, and the result is merged into the local dictionaries.
/// Because incremental responses carry deletions as `is_deleted` and
/// completions as `checked`, merging — not replacing — is the only correct way
/// to apply them.
@MainActor
final class TodoistStore: ObservableObject {

    @Published private(set) var itemsByID: [String: TodoistItem] = [:]
    @Published private(set) var projectsByID: [String: TodoistProject] = [:]
    @Published private(set) var isConnected = false
    @Published private(set) var isSyncing = false
    @Published private(set) var lastSyncedAt: Date?
    @Published private(set) var lastErrorMessage: String?

    /// Default block length for a timed task that carries no duration.
    static let defaultTaskDuration: TimeInterval = 30 * 60

    private let calendar: Calendar
    private let syncTokenKey = "todoist.syncToken"
    private let defaults: UserDefaults

    private var syncToken: String {
        get { defaults.string(forKey: syncTokenKey) ?? TodoistClient.fullSyncToken }
        set { defaults.set(newValue, forKey: syncTokenKey) }
    }

    init(calendar: Calendar = .autoupdatingCurrent, defaults: UserDefaults = .standard) {
        self.calendar = calendar
        self.defaults = defaults
        self.isConnected = TodoistCredentials.load() != nil
        loadCache()
    }

    // MARK: - Connection

    func connect(token: String) async throws {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Validate before persisting, so a typo does not leave the app in a
        // permanently broken "connected" state.
        let client = TodoistClient(token: trimmed)
        let response = try await client.sync(syncToken: TodoistClient.fullSyncToken)

        try TodoistCredentials.save(token: trimmed)
        syncToken = TodoistClient.fullSyncToken
        itemsByID = [:]
        projectsByID = [:]
        apply(response)

        isConnected = true
        lastErrorMessage = nil
        lastSyncedAt = Date()
    }

    func disconnect() {
        TodoistCredentials.delete()
        defaults.removeObject(forKey: syncTokenKey)
        itemsByID = [:]
        projectsByID = [:]
        isConnected = false
        lastSyncedAt = nil
        lastErrorMessage = nil
        writeCache()
    }

    // MARK: - Sync

    func sync() async {
        guard let token = TodoistCredentials.load() else {
            isConnected = false
            return
        }
        guard !isSyncing else { return }

        isSyncing = true
        defer { isSyncing = false }

        do {
            let client = TodoistClient(token: token)
            let response = try await client.sync(syncToken: syncToken)
            apply(response)
            lastSyncedAt = Date()
            lastErrorMessage = nil
        } catch {
            lastErrorMessage = error.localizedDescription
            if case TodoistClient.ClientError.unauthorized = error {
                // The token was revoked; stop pretending it works.
                isConnected = false
            }
        }
    }

    private func apply(_ response: TodoistSyncResponse) {
        // A full sync replaces the world; an incremental one patches it.
        if response.fullSync == true {
            itemsByID = [:]
            projectsByID = [:]
        }

        for item in response.items ?? [] {
            if item.isRemoved {
                itemsByID.removeValue(forKey: item.id)
            } else {
                itemsByID[item.id] = item
            }
        }

        for project in response.projects ?? [] {
            if project.isDeleted == true {
                projectsByID.removeValue(forKey: project.id)
            } else {
                projectsByID[project.id] = project
            }
        }

        syncToken = response.syncToken
        writeCache()
    }

    // MARK: - Writes

    func setCompleted(_ completed: Bool, taskID: String) async {
        guard let token = TodoistCredentials.load() else { return }

        // Update locally first so the tap feels instant; the sync response
        // below is what makes it true, and an error rolls it back.
        let previous = itemsByID[taskID]
        if var optimistic = previous {
            optimistic = TodoistItem(
                id: optimistic.id,
                content: optimistic.content,
                description: optimistic.description,
                projectID: optimistic.projectID,
                priority: optimistic.priority,
                due: optimistic.due,
                duration: optimistic.duration,
                checked: completed,
                isDeleted: optimistic.isDeleted,
                labels: optimistic.labels
            )
            itemsByID[taskID] = optimistic
        }

        let command = completed
            ? TodoistClient.completeCommand(taskID: taskID)
            : TodoistClient.uncompleteCommand(taskID: taskID)

        do {
            let client = TodoistClient(token: token)
            let response = try await client.execute(commands: [command], syncToken: syncToken)
            apply(response)
            lastErrorMessage = nil
        } catch {
            if let previous { itemsByID[taskID] = previous }
            lastErrorMessage = error.localizedDescription
        }
    }

    /// Moves a task to a new instant, keeping it a timed task.
    func reschedule(taskID: String, to newStart: Date) async {
        guard let token = TodoistCredentials.load() else { return }

        let encoded = TodoistDueParser.encodeFloating(newStart, calendar: calendar)
        let command = TodoistClient.rescheduleCommand(taskID: taskID, dueDate: encoded)

        do {
            let client = TodoistClient(token: token)
            let response = try await client.execute(commands: [command], syncToken: syncToken)
            apply(response)
            lastErrorMessage = nil
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    /// Creates a task from a quick-add line.
    ///
    /// The raw text goes to Todoist as a `due.string` so its own parser handles
    /// scheduling — that keeps a task added here identical to one typed into
    /// Todoist, including recurrence phrasing Cadence does not model.
    func addTask(parsed: ParsedInput, rawText: String) async {
        guard let token = TodoistCredentials.load() else { return }

        let projectID = parsed.projectName.flatMap { name in
            projectsByID.values.first { $0.name.localizedCaseInsensitiveCompare(name) == .orderedSame }?.id
        }

        let dueString: String? = parsed.start.map { start in
            parsed.isAllDay
                ? TodoistDueParser.encodeDateOnly(start, calendar: calendar)
                : TodoistDueParser.encodeFloating(start, calendar: calendar)
        }

        let command = TodoistClient.addCommand(
            content: parsed.title.isEmpty ? rawText : parsed.title,
            projectID: projectID,
            dueString: dueString,
            priority: parsed.priority,
            labels: parsed.labels
        )

        do {
            let client = TodoistClient(token: token)
            let response = try await client.execute(commands: [command], syncToken: syncToken)
            apply(response)
            lastErrorMessage = nil
        } catch {
            lastErrorMessage = error.localizedDescription
        }
    }

    // MARK: - Projection onto the calendar

    /// Tasks that carry a due *time*, as blocks on the grid.
    ///
    /// Date-only tasks are deliberately excluded: they have no position in a
    /// timeline, so they live in the task list instead.
    func calendarItems(
        in interval: DateInterval,
        includeCompleted: Bool
    ) -> [CalendarItem] {
        itemsByID.values.compactMap { item -> CalendarItem? in
            guard !item.isRemoved else { return nil }
            guard includeCompleted || !item.isCompleted else { return nil }
            guard let due = item.due,
                  let resolved = TodoistDueParser.resolve(due, calendar: calendar),
                  resolved.hasTime
            else { return nil }

            let start = resolved.start
            let end = start.addingTimeInterval(item.duration?.timeInterval ?? Self.defaultTaskDuration)
            guard start < interval.end, end > interval.start else { return nil }

            let project = item.projectID.flatMap { projectsByID[$0] }

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
                priority: item.displayPriority
            )
        }
    }

    /// Tasks due on a given day with no time attached, for the task list.
    func dateOnlyTasks(on day: Date, includeCompleted: Bool) -> [TodoistItem] {
        itemsByID.values
            .filter { item in
                guard !item.isRemoved else { return false }
                guard includeCompleted || !item.isCompleted else { return false }
                guard let due = item.due,
                      let resolved = TodoistDueParser.resolve(due, calendar: calendar),
                      !resolved.hasTime
                else { return false }
                return calendar.isDate(resolved.start, inSameDayAs: day)
            }
            .sorted { $0.displayPriority < $1.displayPriority }
    }

    func project(for item: TodoistItem) -> TodoistProject? {
        item.projectID.flatMap { projectsByID[$0] }
    }

    // MARK: - On-disk cache

    private struct Cache: Codable {
        var items: [TodoistItem]
        var projects: [TodoistProject]
    }

    private var cacheURL: URL? {
        guard let directory = try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ) else { return nil }

        let folder = directory.appendingPathComponent("Cadence", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent("todoist-cache.json")
    }

    private func loadCache() {
        guard let cacheURL, let data = try? Data(contentsOf: cacheURL),
              let cache = try? JSONDecoder().decode(Cache.self, from: data) else { return }

        itemsByID = Dictionary(uniqueKeysWithValues: cache.items.map { ($0.id, $0) })
        projectsByID = Dictionary(uniqueKeysWithValues: cache.projects.map { ($0.id, $0) })
    }

    private func writeCache() {
        guard let cacheURL else { return }
        let cache = Cache(items: Array(itemsByID.values), projects: Array(projectsByID.values))
        guard let data = try? JSONEncoder().encode(cache) else { return }
        try? data.write(to: cacheURL, options: .atomic)
    }
}
