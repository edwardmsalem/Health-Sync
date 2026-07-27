import Foundation
import EventKit

/// One calendar the user can toggle on or off, flattened out of EventKit.
///
/// The account distinction matters for the settings screen: the whole point of
/// going through EventKit is that iCloud and Gmail calendars both land here, and
/// the user needs to see which is which.
public struct CalendarSource: Identifiable, Hashable {
    public enum Account: Hashable {
        case iCloud
        case google
        case exchange
        case subscribed
        case birthdays
        case local
        case other(String)

        public var displayName: String {
            switch self {
            case .iCloud: return "iCloud"
            case .google: return "Google"
            case .exchange: return "Exchange"
            case .subscribed: return "Subscribed"
            case .birthdays: return "Birthdays"
            case .local: return "On My Device"
            case .other(let name): return name
            }
        }

        public var symbolName: String {
            switch self {
            case .iCloud: return "icloud"
            case .google: return "envelope"
            case .exchange: return "building.2"
            case .subscribed: return "link"
            case .birthdays: return "gift"
            case .local: return "iphone"
            case .other: return "calendar"
            }
        }
    }

    public let id: String
    public let title: String
    public let colorHex: String
    public let account: Account
    /// Name of the owning EventKit source, e.g. the Google account's address.
    public let accountTitle: String
    public let allowsModification: Bool

    public init(
        id: String,
        title: String,
        colorHex: String,
        account: Account,
        accountTitle: String,
        allowsModification: Bool
    ) {
        self.id = id
        self.title = title
        self.colorHex = colorHex
        self.account = account
        self.accountTitle = accountTitle
        self.allowsModification = allowsModification
    }

    init(calendar: EKCalendar) {
        self.id = calendar.calendarIdentifier
        self.title = calendar.title
        self.colorHex = ColorHex.string(from: calendar.cgColor)
        self.accountTitle = calendar.source?.title ?? "Unknown"
        self.allowsModification = calendar.allowsContentModifications
        self.account = Self.classify(calendar.source)
    }

    /// EventKit does not label accounts by provider, so this infers it.
    ///
    /// iCloud reports as `.calDAV` on current OS versions (it was `.mobileMe`
    /// historically), and Google also reports as `.calDAV` — the source title is
    /// the only thing that separates them.
    static func classify(_ source: EKSource?) -> Account {
        guard let source else { return .other("Unknown") }

        let title = source.title.lowercased()

        switch source.sourceType {
        case .local:
            return .local
        case .exchange:
            return .exchange
        case .subscribed:
            return .subscribed
        case .birthdays:
            return .birthdays
        case .mobileMe:
            return .iCloud
        case .calDAV:
            if title.contains("icloud") { return .iCloud }
            if title.contains("gmail") || title.contains("google") { return .google }
            return .other(source.title)
        @unknown default:
            return .other(source.title)
        }
    }
}
