import Foundation
import Security

/// Keychain-backed storage for the Todoist API token.
///
/// v1 authenticates with a personal API token (Todoist → Settings →
/// Integrations → Developer). That is the right trade for a personal app: a
/// native client cannot keep an OAuth *client secret* secret, so shipping one
/// would be security theatre. `TodoistClient` only ever sees a bearer token, so
/// swapping in a full OAuth flow later means replacing this type and nothing
/// else.
struct TodoistCredentials {
    private static let service = "com.salemseats.cadence.todoist"
    private static let account = "api-token"

    static func save(token: String) throws {
        let data = Data(token.utf8)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]

        // Upsert: try to update an existing item, fall back to adding one.
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            // Tokens are needed by the background refresh task, which can run
            // before the first unlock after a reboot is *not* an issue for
            // ThisDeviceOnly... but it is for locked devices, hence AfterFirstUnlock.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }

        guard updateStatus == errSecItemNotFound else {
            throw KeychainError(status: updateStatus)
        }

        var addQuery = query
        addQuery.merge(attributes) { current, _ in current }
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
    }

    static func load() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8),
              !token.isEmpty
        else { return nil }

        return token
    }

    static func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }

    struct KeychainError: LocalizedError {
        let status: OSStatus
        var errorDescription: String? {
            let message = SecCopyErrorMessageString(status, nil) as String? ?? "unknown error"
            return "Could not save the Todoist token to the keychain: \(message)"
        }
    }
}
