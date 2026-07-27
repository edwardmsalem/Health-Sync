import SwiftUI

/// The app's home surface: a compact month grid with the selected day's agenda
/// living directly underneath it.
///
/// Keeping both on screen at once — rather than pushing the day onto a separate
/// screen — is the defining move of this style of calendar. You see the shape of
/// the month and the detail of one day without navigating.
struct MonthView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            MonthGrid()
            Divider()
            selectedDayHeader
            Divider().opacity(0.5)
            agenda
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

/// Six-week month grid.
struct MonthGrid: View {
    @EnvironmentObject private var model: AppModel

    private var calendar: Calendar { model.calendar }

    var body: some View {
        VStack(spacing: 4) {
            weekdayHeader

            let days = Self.gridDays(for: model.anchorMonth, calendar: calendar)
            let columns = Array(repeating: GridItem(.flexible(), spacing: 0), count: 7)

            LazyVGrid(columns: columns, spacing: 0) {
                ForEach(days, id: \.timeIntervalSince1970) { day in
                    MonthCell(
                        day: day,
                        isSelected: calendar.isDate(day, inSameDayAs: model.selectedDate),
                        isToday: calendar.isDateInToday(day),
                        isInDisplayedMonth: calendar.isDate(day, equalTo: model.anchorMonth, toGranularity: .month),
                        dotColors: model.dotColors(on: day)
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

    private var weekdayHeader: some View {
        // `veryShortStandaloneWeekdaySymbols` is Sunday-first regardless of
        // locale, so it has to be rotated to match the user's first weekday.
        let symbols = calendar.veryShortStandaloneWeekdaySymbols
        let offset = calendar.firstWeekday - 1
        let ordered = Array(symbols[offset...] + symbols[..<offset])

        return HStack(spacing: 0) {
            ForEach(Array(ordered.enumerated()), id: \.offset) { _, symbol in
                Text(symbol.uppercased())
                    .font(Theme.Typography.weekdayHeader)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.top, 2)
    }

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
}

struct MonthCell: View {
    let day: Date
    let isSelected: Bool
    let isToday: Bool
    let isInDisplayedMonth: Bool
    let dotColors: [String]

    private var numberColor: Color {
        if isSelected { return .white }
        if isToday { return Color.accentColor }
        return isInDisplayedMonth ? .primary : .secondary.opacity(0.5)
    }

    var body: some View {
        VStack(spacing: 3) {
            Text("\(Calendar.current.component(.day, from: day))")
                .font(isToday || isSelected ? Theme.Typography.monthDayEmphasised : Theme.Typography.monthDay)
                .foregroundStyle(numberColor)
                .frame(width: 30, height: 30)
                .background {
                    if isSelected {
                        Circle().fill(Color.accentColor)
                    } else if isToday {
                        Circle().fill(Color.accentColor.opacity(0.14))
                    }
                }

            // Dots stand in for the day's events; three is enough to signal
            // "busy" without turning the grid into confetti.
            HStack(spacing: 3) {
                ForEach(Array(dotColors.enumerated()), id: \.offset) { _, hex in
                    Circle()
                        .fill(Color(hex: hex))
                        .frame(width: Theme.Metrics.monthDotSize, height: Theme.Metrics.monthDotSize)
                }
            }
            .frame(height: Theme.Metrics.monthDotSize)
            .opacity(isInDisplayedMonth ? 1 : 0.4)
        }
        .frame(maxWidth: .infinity)
        .frame(height: Theme.Metrics.monthCellHeight)
    }
}
