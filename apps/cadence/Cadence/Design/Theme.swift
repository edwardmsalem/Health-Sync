import SwiftUI

/// Shared visual language.
///
/// The look follows the iOS calendar idiom this app is modelled on: a compact
/// month grid sitting above a live agenda, muted chrome, and color carried
/// almost entirely by the calendars themselves rather than by the UI. Values
/// live here so the day, week, and month surfaces stay in proportion with each
/// other — the hour height in particular is load-bearing across three views.
enum Theme {

    enum Metrics {
        /// Height of one hour in the day and week timelines.
        static let hourHeight: CGFloat = 56
        /// Width of the hour gutter down the left of a timeline.
        static let gutterWidth: CGFloat = 52
        static let chipCornerRadius: CGFloat = 6
        static let chipInset: CGFloat = 2
        static let minimumChipHeight: CGFloat = 18
        static let monthCellHeight: CGFloat = 46
        static let monthDotSize: CGFloat = 5
        static let cardCornerRadius: CGFloat = 14
        static let horizontalPadding: CGFloat = 16
        /// Leading rail carrying the calendar color on an agenda row.
        static let agendaRailWidth: CGFloat = 3
    }

    enum Typography {
        static let monthDay = Font.system(size: 16, weight: .regular, design: .rounded)
        static let monthDayEmphasised = Font.system(size: 16, weight: .semibold, design: .rounded)
        static let weekdayHeader = Font.system(size: 11, weight: .semibold)
        static let hourLabel = Font.system(size: 10, weight: .medium)
        static let chipTitle = Font.system(size: 11, weight: .semibold)
        static let chipDetail = Font.system(size: 10, weight: .regular)
        static let agendaTitle = Font.system(size: 15, weight: .medium)
        static let agendaDetail = Font.system(size: 13, weight: .regular)
        static let sectionHeader = Font.system(size: 13, weight: .semibold)
    }

    /// The "now" line drawn across the day and week timelines.
    static let nowIndicator = Color(hex: "#E8574A")
}

// MARK: - Cross-platform semantic colors

/// AppKit and UIKit spell the system colors differently, so the shared views
/// go through these rather than `#if os(...)` at every use site.
extension Color {
    static var cadenceBackground: Color {
        #if os(macOS)
        Color(nsColor: .windowBackgroundColor)
        #else
        Color(uiColor: .systemBackground)
        #endif
    }

    static var cadenceGroupedBackground: Color {
        #if os(macOS)
        Color(nsColor: .underPageBackgroundColor)
        #else
        Color(uiColor: .systemGroupedBackground)
        #endif
    }

    static var cadenceSecondaryBackground: Color {
        #if os(macOS)
        Color(nsColor: .controlBackgroundColor)
        #else
        Color(uiColor: .secondarySystemBackground)
        #endif
    }

    static var cadenceSeparator: Color {
        #if os(macOS)
        Color(nsColor: .separatorColor)
        #else
        Color(uiColor: .separator)
        #endif
    }

    static var cadenceFill: Color {
        #if os(macOS)
        Color(nsColor: .quaternaryLabelColor)
        #else
        Color(uiColor: .quaternarySystemFill)
        #endif
    }
}

// MARK: - Date formatting

/// Formatters are expensive to build, so the handful the UI needs are made once.
enum DateFormat {
    static let time: DateFormatter = {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter
    }()

    /// "9:30 AM" — used inside chips, where there is room for minutes.
    static let compactTime: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("j:mm")
        return formatter
    }()

    /// "9 AM" — the hour gutter is only 52pt wide, so it drops the minutes it
    /// would always render as ":00" anyway.
    static let hourOnly: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("j")
        return formatter
    }()

    static let monthYear: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("MMMM yyyy")
        return formatter
    }()

    // Split month/year formatters: the header sets "July" bold and "2026"
    // light, which one combined string cannot do.
    static let monthOnly: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("MMMM")
        return formatter
    }()

    static let yearOnly: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("yyyy")
        return formatter
    }()

    static let weekdayLong: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("EEEE d MMMM")
        return formatter
    }()

    static let weekdayShort: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("EEE d")
        return formatter
    }()

    static func range(_ item: CalendarItem) -> String {
        if item.isAllDay { return "All day" }
        return "\(time.string(from: item.start)) – \(time.string(from: item.end))"
    }
}
