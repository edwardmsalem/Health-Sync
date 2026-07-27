import Foundation
import UserNotifications

/// Schedules local notifications for Todoist task blocks.
///
/// Calendar *events* are deliberately not handled here. An `EKAlarm` attached to
/// an event is delivered by the system calendar daemon, so it fires whether or
/// not Cadence is running — and it fires exactly once even though the same
/// event is visible on the iPhone and the Mac. Scheduling our own notification
/// alongside it would double every alert.
///
/// Todoist tasks have no such system owner, so they do need locally scheduled
/// notifications.
@MainActor
final class AlertScheduler: ObservableObject {
    static let identifierPrefix = "cadence.task."

    /// iOS keeps at most 64 pending local notifications per app and silently
    /// drops the rest, so the nearest ones are scheduled and the tail is left
    /// for a later reconcile to pick up.
    static let maxPendingNotifications = 60

    @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var scheduledCount = 0

    private let center = UNUserNotificationCenter.current()

    func refreshAuthorizationStatus() async {
        let settings = await center.notificationSettings()
        authorizationStatus = settings.authorizationStatus
    }

    @discardableResult
    func requestAuthorization() async -> Bool {
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            await refreshAuthorizationStatus()
            return granted
        } catch {
            await refreshAuthorizationStatus()
            return false
        }
    }

    /// Rebuilds the pending notification set from the current tasks.
    ///
    /// Reconciling wholesale rather than diffing keeps this correct when a task
    /// is rescheduled or completed elsewhere: there is no state to get stale.
    func reconcile(
        taskItems: [CalendarItem],
        defaultAlerts: [AlertOffset],
        now: Date = Date()
    ) async {
        await refreshAuthorizationStatus()
        guard authorizationStatus == .authorized || authorizationStatus == .provisional else {
            scheduledCount = 0
            return
        }

        let pending = await center.pendingNotificationRequests()
        let ours = pending.map(\.identifier).filter { $0.hasPrefix(Self.identifierPrefix) }
        center.removePendingNotificationRequests(withIdentifiers: ours)

        // Tasks carry no per-item alert of their own — Todoist reminders are a
        // separate resource delivered by Todoist's own apps — so the user's
        // default offsets are what apply here.
        let offsets = defaultAlerts.isEmpty ? [AlertOffset.atTimeOfEvent] : defaultAlerts

        struct PendingAlert {
            let identifier: String
            let fireDate: Date
            let item: CalendarItem
            let offset: AlertOffset
        }

        var candidates: [PendingAlert] = []
        for item in taskItems where !item.isCompleted {
            guard let taskID = item.origin.todoistID else { continue }
            for offset in offsets {
                let fireDate = item.start.addingTimeInterval(offset.relativeOffset)
                guard fireDate > now else { continue }
                candidates.append(
                    PendingAlert(
                        identifier: "\(Self.identifierPrefix)\(taskID).\(offset.minutesBefore)",
                        fireDate: fireDate,
                        item: item,
                        offset: offset
                    )
                )
            }
        }

        let scheduled = candidates
            .sorted { $0.fireDate < $1.fireDate }
            .prefix(Self.maxPendingNotifications)

        for alert in scheduled {
            let content = UNMutableNotificationContent()
            content.title = alert.item.title
            content.body = Self.body(for: alert.item, offset: alert.offset)
            content.sound = .default
            content.userInfo = [
                "todoistID": alert.item.origin.todoistID ?? "",
                "startDate": alert.item.start.timeIntervalSince1970
            ]

            let components = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute],
                from: alert.fireDate
            )
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)

            let request = UNNotificationRequest(
                identifier: alert.identifier,
                content: content,
                trigger: trigger
            )
            try? await center.add(request)
        }

        scheduledCount = scheduled.count
    }

    func cancelAll() {
        center.removeAllPendingNotificationRequests()
        scheduledCount = 0
    }

    private static func body(for item: CalendarItem, offset: AlertOffset) -> String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        let time = formatter.string(from: item.start)

        let lead = offset.minutesBefore == 0 ? "Now" : "In \(offset.shortLabel.replacingOccurrences(of: " before", with: ""))"
        return "\(lead) · \(time) · \(item.containerTitle)"
    }
}
