import Foundation
import CloudKit

/// Where preferences live between devices.
///
/// The abstraction is the point. CloudKit is right today — zero infrastructure,
/// private to the user's Apple ID, syncs iOS to macOS on its own — but it can
/// never serve Android. When that day comes, a `RemoteSyncStore` conforming to
/// this protocol replaces `CloudKitSyncStore` at one call site in
/// `PreferencesController`, and nothing above it changes.
protocol SyncStore: Sendable {
    /// Returns nil when the backing store has nothing saved yet.
    func load() async throws -> AppPreferences?
    func save(_ preferences: AppPreferences) async throws
}

// MARK: - Local

/// Always-present on-device copy. The app reads this first so it can render
/// immediately, then reconciles with whatever the remote store returns.
struct LocalSyncStore: SyncStore {
    private let key = "cadence.preferences"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() async throws -> AppPreferences? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(AppPreferences.self, from: data)
    }

    func save(_ preferences: AppPreferences) async throws {
        let data = try JSONEncoder().encode(preferences)
        defaults.set(data, forKey: key)
    }
}

// MARK: - CloudKit

/// Stores the whole preferences blob as a single record in the user's private
/// database.
///
/// One record rather than a field per preference: the payload is small, it
/// changes as a unit, and it means adding a preference later needs no schema
/// change in the CloudKit dashboard.
struct CloudKitSyncStore: SyncStore {
    static let containerIdentifier = "iCloud.com.salemseats.cadence"

    private let recordType = "Preferences"
    private let recordID = CKRecord.ID(recordName: "preferences")

    private var database: CKDatabase {
        CKContainer(identifier: Self.containerIdentifier).privateCloudDatabase
    }

    func load() async throws -> AppPreferences? {
        do {
            let record = try await database.record(for: recordID)
            guard let data = record["payload"] as? Data else { return nil }
            return try JSONDecoder().decode(AppPreferences.self, from: data)
        } catch let error as CKError where error.code == .unknownItem {
            // Nothing saved yet — a first run, not a failure.
            return nil
        }
    }

    func save(_ preferences: AppPreferences) async throws {
        let data = try JSONEncoder().encode(preferences)

        // Fetch-then-modify so the record keeps its change tag; saving a fresh
        // CKRecord with an existing ID is rejected as a conflict.
        let record: CKRecord
        do {
            record = try await database.record(for: recordID)
        } catch let error as CKError where error.code == .unknownItem {
            record = CKRecord(recordType: recordType, recordID: recordID)
        }

        record["payload"] = data as CKRecordValue
        _ = try await database.save(record)
    }
}

// MARK: - Controller

/// Owns the live preferences and keeps both stores in step.
@MainActor
final class PreferencesController: ObservableObject {
    @Published private(set) var preferences: AppPreferences = .default
    @Published private(set) var cloudStatusMessage: String?

    private let local: SyncStore
    private let remote: SyncStore?
    private var pushTask: Task<Void, Never>?

    init(local: SyncStore = LocalSyncStore(), remote: SyncStore? = CloudKitSyncStore()) {
        self.local = local
        self.remote = remote
    }

    /// Loads local state immediately, then reconciles with the cloud copy.
    func start() async {
        if let stored = try? await local.load() {
            preferences = stored
        }
        await pullFromCloud()
    }

    func pullFromCloud() async {
        guard let remote else { return }
        do {
            guard let cloud = try await remote.load() else {
                // Nothing up there yet: seed it with what this device has.
                try await remote.save(preferences)
                cloudStatusMessage = nil
                return
            }
            // Last writer wins. The payload is a handful of toggles, so a
            // field-level merge would cost more than it is worth.
            if cloud.updatedAt > preferences.updatedAt {
                preferences = cloud
                try? await local.save(cloud)
            } else if cloud.updatedAt < preferences.updatedAt {
                try await remote.save(preferences)
            }
            cloudStatusMessage = nil
        } catch {
            cloudStatusMessage = "iCloud sync unavailable: \(error.localizedDescription)"
        }
    }

    /// Mutates preferences and schedules a write. Writes are coalesced so
    /// dragging a toggle does not produce a CloudKit request per frame.
    func update(_ mutate: (inout AppPreferences) -> Void) {
        var copy = preferences
        mutate(&copy)
        copy.updatedAt = Date()
        preferences = copy

        pushTask?.cancel()
        pushTask = Task { [copy] in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            try? await local.save(copy)
            do {
                try await remote?.save(copy)
                cloudStatusMessage = nil
            } catch {
                cloudStatusMessage = "iCloud sync unavailable: \(error.localizedDescription)"
            }
        }
    }
}
