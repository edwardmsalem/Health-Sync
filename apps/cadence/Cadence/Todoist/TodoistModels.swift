import Foundation

// MARK: - Wire types

/// A Todoist due date.
///
/// The `date` field arrives in one of three shapes, and they mean different
/// things:
///   - `2026-03-10`                  a whole day, no time
///   - `2026-03-10T14:30:00`         a *floating* time, read in the user's zone
///   - `2026-03-10T18:30:00Z`        a fixed instant, with `timezone` set
// These are `Codable` rather than just `Decodable` so the store can write the
// last sync straight back to disk and open with content before the network
// answers.
struct TodoistDue: Codable, Equatable {
    let date: String
    let timezone: String?
    let string: String?
    let isRecurring: Bool?

    enum CodingKeys: String, CodingKey {
        case date, timezone, string
        case isRecurring = "is_recurring"
    }
}

struct TodoistDuration: Codable, Equatable {
    let amount: Int
    /// "minute" or "day".
    let unit: String

    var timeInterval: TimeInterval {
        unit == "day" ? Double(amount) * 86_400 : Double(amount) * 60
    }
}

struct TodoistItem: Codable, Equatable, Identifiable {
    let id: String
    let content: String
    let description: String?
    let projectID: String?
    /// Todoist's API numbering is the inverse of its UI: 4 is urgent (p1) and
    /// 1 is the default (p4). Read this through `displayPriority`.
    let priority: Int?
    let due: TodoistDue?
    let duration: TodoistDuration?
    let checked: Bool?
    let isDeleted: Bool?
    let labels: [String]?

    enum CodingKeys: String, CodingKey {
        case id, content, description, priority, due, duration, checked, labels
        case projectID = "project_id"
        case isDeleted = "is_deleted"
    }

    /// 1 (urgent) to 4 (none), matching what the Todoist UI calls p1-p4.
    var displayPriority: Int {
        guard let priority, (1...4).contains(priority) else { return 4 }
        return 5 - priority
    }

    var isCompleted: Bool { checked ?? false }
    var isRemoved: Bool { isDeleted ?? false }
}

struct TodoistProject: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    /// A palette name like "berry_red", not a hex string.
    let color: String?
    let isDeleted: Bool?

    enum CodingKeys: String, CodingKey {
        case id, name, color
        case isDeleted = "is_deleted"
    }

    var colorHex: String { TodoistPalette.hex(for: color) }
}

struct TodoistSyncResponse: Decodable {
    let syncToken: String
    let fullSync: Bool?
    let items: [TodoistItem]?
    let projects: [TodoistProject]?

    enum CodingKeys: String, CodingKey {
        case items, projects
        case syncToken = "sync_token"
        case fullSync = "full_sync"
    }
}

// MARK: - Colors

/// Todoist sends project colors as palette names; these are the corresponding
/// hex values from its published palette.
enum TodoistPalette {
    static let fallback = "#B8B8B8"

    private static let table: [String: String] = [
        "berry_red": "#B8256F", "red": "#DB4035", "orange": "#FF9933",
        "yellow": "#FAD000", "olive_green": "#AFB83B", "lime_green": "#7ECC49",
        "green": "#299438", "mint_green": "#6ACCBC", "teal": "#158FAD",
        "sky_blue": "#14AAF5", "light_blue": "#96C3EB", "blue": "#4073FF",
        "grape": "#884DFF", "violet": "#AF38EB", "lavender": "#EB96EB",
        "magenta": "#E05194", "salmon": "#FF8D85", "charcoal": "#808080",
        "grey": "#B8B8B8", "gray": "#B8B8B8", "taupe": "#CCAC93"
    ]

    static func hex(for name: String?) -> String {
        guard let name else { return fallback }
        return table[name.lowercased()] ?? fallback
    }
}

// MARK: - Due date interpretation

enum TodoistDueParser {
    struct Resolved: Equatable {
        var start: Date
        /// True when the due date carried a time of day. Only these become
        /// blocks on the calendar grid; date-only tasks stay in the task list.
        var hasTime: Bool
    }

    static func resolve(_ due: TodoistDue, calendar: Calendar) -> Resolved? {
        // Fractional seconds appear inconsistently, so normalise them away
        // rather than juggling two formatters per shape.
        let raw = due.date.replacingOccurrences(
            of: "\\.\\d+",
            with: "",
            options: .regularExpression
        )

        guard raw.contains("T") else {
            guard let date = formatter(format: "yyyy-MM-dd", timeZone: calendar.timeZone).date(from: raw) else {
                return nil
            }
            return Resolved(start: calendar.startOfDay(for: date), hasTime: false)
        }

        if raw.hasSuffix("Z") {
            // A fixed instant. Parse in UTC; display converts to local.
            guard let date = formatter(
                format: "yyyy-MM-dd'T'HH:mm:ss'Z'",
                timeZone: TimeZone(identifier: "UTC")!
            ).date(from: raw) else { return nil }
            return Resolved(start: date, hasTime: true)
        }

        // Floating time: the wall-clock reading is what the user meant, so it is
        // interpreted in their own zone rather than UTC.
        guard let date = formatter(
            format: "yyyy-MM-dd'T'HH:mm:ss",
            timeZone: calendar.timeZone
        ).date(from: raw) else { return nil }
        return Resolved(start: date, hasTime: true)
    }

    private static func formatter(format: String, timeZone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = format
        return formatter
    }

    /// Renders a date back into the floating form Todoist expects on write.
    static func encodeFloating(_ date: Date, calendar: Calendar) -> String {
        formatter(format: "yyyy-MM-dd'T'HH:mm:ss", timeZone: calendar.timeZone).string(from: date)
    }

    static func encodeDateOnly(_ date: Date, calendar: Calendar) -> String {
        formatter(format: "yyyy-MM-dd", timeZone: calendar.timeZone).string(from: date)
    }
}
