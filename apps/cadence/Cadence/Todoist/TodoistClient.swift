import Foundation

/// Thin wrapper over the Todoist v1 sync endpoint.
///
/// Everything — reads and writes alike — goes through `POST /api/v1/sync`.
/// Reads pass a `sync_token` so the server only sends what changed since last
/// time; writes pass a `commands` array. Batching writes this way also gives
/// idempotency for free: each command carries a client-generated uuid, so a
/// retry after a dropped connection cannot double-apply.
struct TodoistClient {
    static let syncURL = URL(string: "https://api.todoist.com/api/v1/sync")!
    static let resourceTypes = ["items", "projects"]
    /// Passed as the sync token to request everything.
    static let fullSyncToken = "*"

    let token: String
    var session: URLSession = .shared

    enum ClientError: LocalizedError {
        case unauthorized
        case rateLimited(retryAfter: TimeInterval?)
        case server(status: Int, body: String)
        case malformedResponse

        var errorDescription: String? {
            switch self {
            case .unauthorized:
                return "Todoist rejected the API token. Reconnect in Settings."
            case .rateLimited(let retryAfter):
                let wait = retryAfter.map { " Try again in \(Int($0))s." } ?? ""
                return "Todoist is rate limiting requests.\(wait)"
            case .server(let status, let body):
                return "Todoist returned \(status): \(body.prefix(200))"
            case .malformedResponse:
                return "Todoist returned a response Cadence could not read."
            }
        }
    }

    // MARK: - Requests

    func sync(syncToken: String) async throws -> TodoistSyncResponse {
        try await perform(syncToken: syncToken, commands: [])
    }

    /// Sends commands and returns the changes they produced.
    ///
    /// Passing the caller's current sync token means the response doubles as
    /// the incremental update for those writes — no follow-up read needed.
    @discardableResult
    func execute(commands: [[String: Any]], syncToken: String) async throws -> TodoistSyncResponse {
        try await perform(syncToken: syncToken, commands: commands)
    }

    private func perform(syncToken: String, commands: [[String: Any]]) async throws -> TodoistSyncResponse {
        var fields: [String: String] = ["sync_token": syncToken]

        if let data = try? JSONSerialization.data(withJSONObject: Self.resourceTypes),
           let encoded = String(data: data, encoding: .utf8) {
            fields["resource_types"] = encoded
        }

        if !commands.isEmpty {
            let data = try JSONSerialization.data(withJSONObject: commands)
            fields["commands"] = String(data: data, encoding: .utf8) ?? "[]"
        }

        var request = URLRequest(url: Self.syncURL)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Self.formEncode(fields).data(using: .utf8)
        request.timeoutInterval = 30

        let (data, response) = try await session.data(for: request)

        guard let http = response as? HTTPURLResponse else { throw ClientError.malformedResponse }

        switch http.statusCode {
        case 200..<300:
            break
        case 401, 403:
            throw ClientError.unauthorized
        case 429:
            let retryAfter = (http.value(forHTTPHeaderField: "Retry-After")).flatMap(TimeInterval.init)
            throw ClientError.rateLimited(retryAfter: retryAfter)
        default:
            throw ClientError.server(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? ""
            )
        }

        do {
            return try JSONDecoder().decode(TodoistSyncResponse.self, from: data)
        } catch {
            throw ClientError.malformedResponse
        }
    }

    static func formEncode(_ fields: [String: String]) -> String {
        // The default `.urlQueryAllowed` set leaves "+" and "&" intact, which
        // corrupts JSON payloads carried in a form body.
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")

        return fields
            .map { key, value in
                let encodedKey = key.addingPercentEncoding(withAllowedCharacters: allowed) ?? key
                let encodedValue = value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
                return "\(encodedKey)=\(encodedValue)"
            }
            .joined(separator: "&")
    }

    // MARK: - Command builders

    static func completeCommand(taskID: String) -> [String: Any] {
        ["type": "item_close", "uuid": UUID().uuidString, "args": ["id": taskID]]
    }

    static func uncompleteCommand(taskID: String) -> [String: Any] {
        ["type": "item_uncomplete", "uuid": UUID().uuidString, "args": ["id": taskID]]
    }

    static func rescheduleCommand(taskID: String, dueDate: String) -> [String: Any] {
        [
            "type": "item_update",
            "uuid": UUID().uuidString,
            "args": ["id": taskID, "due": ["date": dueDate]]
        ]
    }

    /// Adds a task. `dueString` is sent verbatim so Todoist's own natural
    /// language parser handles it server-side, keeping app-created tasks
    /// consistent with ones typed into Todoist directly.
    static func addCommand(
        content: String,
        projectID: String?,
        dueString: String?,
        priority: Int?,
        labels: [String]
    ) -> [String: Any] {
        var args: [String: Any] = ["content": content]
        if let projectID { args["project_id"] = projectID }
        if let dueString { args["due"] = ["string": dueString] }
        // Back to the API's inverted scale: display p1 is API priority 4.
        if let priority, (1...4).contains(priority) { args["priority"] = 5 - priority }
        if !labels.isEmpty { args["labels"] = labels }

        return [
            "type": "item_add",
            "uuid": UUID().uuidString,
            "temp_id": UUID().uuidString,
            "args": args
        ]
    }
}
