import SwiftUI

/// The month surface, in the Calendars-by-Readdle idiom.
///
/// The defining element is that events live *inside* the day cells as solid
/// colored bars with their titles, not as abstract dots — you read your month
/// without tapping anything. On a wide layout (Mac, iPad) the grid fills the
/// window; on iPhone the cells are too small for titled bars, so they carry
/// mini color bars and the selected day's agenda sits underneath, which is the
/// same compromise Readdle makes on the phone.
struct MonthView: View {
    @EnvironmentObject private var model: AppModel

    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    private var isExpanded: Bool { horizontalSizeClass == .regular }
    #else
    private let isExpanded = true
    #endif

    var body: some View {
        if isExpanded {
            ExpandedMonthGrid()
        } else {
            VStack(spacing: 0) {
                CompactMonthGrid()
                Divider()
                selectedDayHeader
                Divider().opacity(0.5)
                agenda
            }
        }
    }

    private var selectedDayHeader: some View {
        HStack {
            Text(DateFormat.weekdayLong.string(from: model.selectedDate))
                .font(Theme.Typography.sectionHeader)
                .foregroundStyle(.secondary)
            Spacer()
            if model.calendar.isDateInToday(model.selectedDate) {
                Text("TODAY")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Color.accentColor)
            }
        }
        .padding(.horizontal, Theme.Metrics.horizontalPadding)
        .padding(.vertical, 8)
        .background(Color.cadenceSecondaryBackground.opacity(0.5))
    }

    private var agenda: some View {
        ScrollView {
            let items = model.items(on: model.selectedDate)

            if items.isEmpty {
                EmptyDayView()
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(items) { item in
                        AgendaRow(item: item) {
                            Task { await model.toggleCompletion(for: item) }
                        }
                        .padding(.horizontal, Theme.Metrics.horizontalPadding)
                        .onTapGesture { model.editingItem = item }

                        Divider().padding(.leading, Theme.Metrics.horizontalPadding + 15)
                    }
                }
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Shared grid helpers

enum MonthGridLayout {
    /// The 42 days a six-week grid shows, starting from the first day of the
    /// week that contains the first of the month.
    static func gridDays(for month: Date, calendar: Calendar) -> [Date] {
        guard let monthInterval = calendar.dateInterval(of: .month, for: month),
              let firstWeek = calendar.dateInterval(of: .weekOfMonth, for: monthInterval.start)
        else { return [] }

        var days: [Date] = []
        var cursor = calendar.startOfDay(for: firstWeek.start)
        for _ in 0..<42 {
            days.append(cursor)
            guard let next = calendar.date(byAdding: .day, value: 1, to: cursor) else { break }
            cursor = next
        }
        return days
    }

    /// Weekday symbols rotated to the user's first weekday.
    static func weekdaySymbols(calendar: Calendar) -> [String] {
        let symbols = calendar.shortStandaloneWeekdaySymbols
        let offset = calendar.firstWeekday - 1
        return Array(symbols[offset...] + symbols[..<offset])
    }

    static func isWeekend(_ day: Date, calendar: Calendar) -> Bool {
        calendar.isDateInWeekend(day)
    }
}

/// The day number, drawn the Readdle way: today is a filled accent circle,
/// every other day is plain text.
struct DayNumber: View {
    let day: Date
    let isToday: Bool
    let isInDisplayedMonth: Bool
    var size: CGFloat = 24

    var body: some View {
        Text("\(Calendar.current.component(.day, from: day))")
            .font(.system(size: size * 0.58, weight: isToday ? .bold : .medium))
            .foregroundStyle(
                isToday ? .white : (isInDisplayedMonth ? Color.primary : Color.secondary.opacity(0.45))
            )
            .frame(width: size, height: size)
            .background {
                if isToday {
                    Circle().fill(Color.accentColor)
                }
            }
    }
}

// MARK: - Expanded (Mac / iPad): titled event bars inside the cells

struct ExpandedMonthGrid: View {
    @EnvironmentObject private var model: AppModel

    private var calendar: Calendar { model.calendar }

    var body: some View {
        GeometryReader { proxy in
            let days = MonthGridLayout.gridDays(for: model.anchorMonth, calendar: calendar)
            let headerHeight: CGFloat = 24
            let cellWidth = proxy.size.width / 7
            let cellHeight = max((proxy.size.height - headerHeight) / 6, 60)

            VStack(spacing: 0) {
                weekdayHeader(height: headerHeight)

                ForEach(0..<6, id: \.self) { row in
                    HStack(spacing: 0) {
                        ForEach(0..<7, id: \.self) { column in
                            let index = row * 7 + column
                            if index < days.count {
                                MonthDayCell(day: days[index], height: cellHeight)
                                    .frame(width: cellWidth, height: cellHeight)
                            }
                        }
                    }
                }
            }
        }
        .background(Color.cadenceBackground)
    }

    private func weekdayHeader(height: CGFloat) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(MonthGridLayout.weekdaySymbols(calendar: calendar).enumerated()), id: \.offset) { _, symbol in
                Text(symbol.uppercased())
                    .font(Theme.Typography.weekdayHeader)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.trailing, 8)
            }
        }
        .frame(height: height)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.cadenceSeparator.opacity(0.6)).frame(height: 0.5)
        }
    }
}

/// One day cell: number top-left, then as many titled event bars as fit.
struct MonthDayCell: View {
    @EnvironmentObject private var model: AppModel
    let day: Date
    let height: CGFloat

    private var calendar: Calendar { model.calendar }
    private var isToday: Bool { calendar.isDateInToday(day) }
    private var isSelected: Bool { calendar.isDate(day, inSameDayAs: model.selectedDate) }
    private var isInMonth: Bool { calendar.isDate(day, equalTo: model.anchorMonth, toGranularity: .month) }

    private var visibleCount: Int {
        // Number row ~28pt, each event bar 17pt + 2 spacing, "+N more" 13pt.
        max(0, Int((height - 28) / 19))
    }

    var body: some View {
        let items = model.items(on: day)
        let shown = Array(items.prefix(items.count > visibleCount ? max(visibleCount - 1, 0) : visibleCount))
        let overflow = items.count - shown.count

        VStack(alignment: .leading, spacing: 2) {
            HStack {
                DayNumber(day: day, isToday: isToday, isInDisplayedMonth: isInMonth, size: 22)
                Spacer(minLength: 0)
            }
            .padding(.top, 3)
            .padding(.leading, 4)

            ForEach(shown) { item in
                MonthEventBar(item: item)
                    .onTapGesture { model.editingItem = item }
            }

            if overflow > 0 {
                Text("+\(overflow) more")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(.leading, 5)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 2)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            // Readdle tints weekends and fades the neighbouring months' cells.
            if !isInMonth {
                Color.cadenceFill.opacity(0.35)
            } else if MonthGridLayout.isWeekend(day, calendar: calendar) {
                Color.cadenceFill.opacity(0.55)
            }
        }
        .overlay {
            if isSelected {
                Rectangle().strokeBorder(Color.accentColor, lineWidth: 2)
            }
        }
        .overlay(alignment: .trailing) {
            Rectangle().fill(Color.cadenceSeparator.opacity(0.45)).frame(width: 0.5)
        }
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.cadenceSeparator.opacity(0.45)).frame(height: 0.5)
        }
        .contentShape(Rectangle())
        .onTapGesture { model.select(day) }
    }
}

/// A solid, titled event bar — the Readdle month-cell signature.
struct MonthEventBar: View {
    let item: CalendarItem

    private var color: Color { Color(hex: item.colorHex) }

    var body: some View {
        HStack(spacing: 3) {
            if item.origin.isTask {
                Image(systemName: item.isCompleted ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 8, weight: .bold))
            }
            Text(item.title)
                .font(.system(size: 11, weight: .semibold))
                .lineLimit(1)
                .strikethrough(item.isCompleted)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Color.legibleForeground(on: item.colorHex))
        .padding(.horizontal, 4)
        .frame(height: 16)
        .frame(maxWidth: .infinity)
        .background(color.opacity(item.isCompleted || item.hasInferredTime ? 0.55 : 1))
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        .padding(.horizontal, 2)
    }
}

// MARK: - Compact (iPhone): mini color bars + agenda underneath

struct CompactMonthGrid: View {
    @EnvironmentObject private var model: AppModel

    private var calendar: Calendar { model.calendar }

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 0) {
                ForEach(Array(MonthGridLayout.weekdaySymbols(calendar: calendar).enumerated()), id: \.offset) { _, symbol in
                    Text(symbol.uppercased())
                        .font(Theme.Typography.weekdayHeader)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.top, 2)

            let days = MonthGridLayout.gridDays(for: model.anchorMonth, calendar: calendar)
            let columns = Array(repeating: GridItem(.flexible(), spacing: 0), count: 7)

            LazyVGrid(columns: columns, spacing: 0) {
                ForEach(days, id: \.timeIntervalSince1970) { day in
                    CompactMonthCell(
                        day: day,
                        isSelected: calendar.isDate(day, inSameDayAs: model.selectedDate),
                        isToday: calendar.isDateInToday(day),
                        isInDisplayedMonth: calendar.isDate(day, equalTo: model.anchorMonth, toGranularity: .month),
                        barColors: model.dotColors(on: day)
                    )
                    .contentShape(Rectangle())
                    .onTapGesture {
                        withAnimation(.snappy(duration: 0.18)) { model.select(day) }
                    }
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 8)
    }
}

struct CompactMonthCell: View {
    let day: Date
    let isSelected: Bool
    let isToday: Bool
    let isInDisplayedMonth: Bool
    let barColors: [String]

    private var numberColor: Color {
        if isSelected || isToday { return .white }
        return isInDisplayedMonth ? .primary : .secondary.opacity(0.5)
    }

    var body: some View {
        VStack(spacing: 3) {
            Text("\(Calendar.current.component(.day, from: day))")
                .font(isToday || isSelected ? Theme.Typography.monthDayEmphasised : Theme.Typography.monthDay)
                .foregroundStyle(numberColor)
                .frame(width: 30, height: 30)
                .background {
                    if isToday {
                        Circle().fill(Color.accentColor)
                    } else if isSelected {
                        Circle().fill(Color.secondary.opacity(0.35))
                    }
                }

            // Mini bars in the calendars' own colors — a phone-sized echo of
            // the titled bars the expanded grid shows.
            VStack(spacing: 2) {
                ForEach(Array(barColors.enumerated()), id: \.offset) { _, hex in
                    Capsule()
                        .fill(Color(hex: hex))
                        .frame(height: 3)
                        .padding(.horizontal, 7)
                }
            }
            .frame(height: 13, alignment: .top)
            .opacity(isInDisplayedMonth ? 1 : 0.4)
        }
        .frame(maxWidth: .infinity)
        .frame(height: Theme.Metrics.monthCellHeight + 6)
        .background {
            if MonthGridLayout.isWeekend(day, calendar: Calendar.current) {
                Color.cadenceFill.opacity(0.4)
            }
        }
    }
}
