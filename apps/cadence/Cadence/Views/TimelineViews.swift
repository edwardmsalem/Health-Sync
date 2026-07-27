import SwiftUI

// MARK: - Day

struct DayTimelineView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            AllDayStrip(days: [model.selectedDate])
            TimelineScroller(days: [model.selectedDate])
        }
    }
}

// MARK: - Week

struct WeekTimelineView: View {
    @EnvironmentObject private var model: AppModel

    private var weekDays: [Date] {
        let calendar = model.calendar
        guard let interval = calendar.dateInterval(of: .weekOfYear, for: model.selectedDate) else {
            return [model.selectedDate]
        }
        return (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: interval.start) }
    }

    var body: some View {
        VStack(spacing: 0) {
            weekHeader
            Divider()
            AllDayStrip(days: weekDays)
            TimelineScroller(days: weekDays)
        }
    }

    private var weekHeader: some View {
        HStack(spacing: 0) {
            // Matches the timeline's hour gutter so the columns line up.
            Color.clear.frame(width: Theme.Metrics.gutterWidth)

            ForEach(weekDays, id: \.timeIntervalSince1970) { day in
                let isToday = model.calendar.isDateInToday(day)
                let isSelected = model.calendar.isDate(day, inSameDayAs: model.selectedDate)

                VStack(spacing: 2) {
                    Text(model.calendar.veryShortStandaloneWeekdaySymbols[
                        model.calendar.component(.weekday, from: day) - 1
                    ].uppercased())
                        .font(Theme.Typography.weekdayHeader)
                        .foregroundStyle(.secondary)

                    Text("\(model.calendar.component(.day, from: day))")
                        .font(Theme.Typography.monthDayEmphasised)
                        .foregroundStyle(isSelected ? .white : (isToday ? Color.accentColor : .primary))
                        .frame(width: 26, height: 26)
                        .background {
                            if isSelected { Circle().fill(Color.accentColor) }
                            else if isToday { Circle().fill(Color.accentColor.opacity(0.14)) }
                        }
                }
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
                .onTapGesture { model.select(day) }
            }
        }
        .padding(.vertical, 6)
    }
}

// MARK: - Scrolling container

/// Wraps the hour grid in a scroll view and opens it at the user's preferred
/// start hour rather than at midnight, which is almost never what they want to
/// look at.
struct TimelineScroller: View {
    @EnvironmentObject private var model: AppModel
    let days: [Date]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                HStack(alignment: .top, spacing: 0) {
                    HourGutter()

                    ForEach(days, id: \.timeIntervalSince1970) { day in
                        TimelineColumn(day: day)
                            .frame(maxWidth: .infinity)
                            .overlay(alignment: .leading) {
                                Rectangle()
                                    .fill(Color.cadenceSeparator.opacity(0.35))
                                    .frame(width: 0.5)
                            }
                    }
                }
                .frame(height: Theme.Metrics.hourHeight * 24)
            }
            .onAppear {
                // A beat of delay: the anchors do not exist until after the
                // first layout pass.
                DispatchQueue.main.async {
                    proxy.scrollTo(hourAnchor, anchor: .top)
                }
            }
        }
    }

    /// Opens on the current hour when looking at today, otherwise the preferred
    /// start of day.
    private var hourAnchor: Int {
        let isToday = days.contains { model.calendar.isDateInToday($0) }
        guard isToday else { return model.preferences.preferredDayStartHour }
        return max(0, model.calendar.component(.hour, from: Date()) - 1)
    }
}

// MARK: - Grid parts

struct HourGutter: View {
    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                VStack(spacing: 0) {
                    Text(Self.label(for: hour))
                        .font(Theme.Typography.hourLabel)
                        .foregroundStyle(.secondary)
                        // Sits astride its grid line rather than below it.
                        .offset(y: -5)
                    Spacer(minLength: 0)
                }
                .frame(height: Theme.Metrics.hourHeight, alignment: .top)
                .id(hour)
            }
        }
        .frame(width: Theme.Metrics.gutterWidth)
    }

    /// Midnight is left blank: the label would sit half off the top of the grid,
    /// and the row is unambiguous without it.
    static func label(for hour: Int) -> String {
        guard hour > 0 else { return "" }
        return hourLabel(for: hour)
    }

    /// Always renders a label, for places like Settings where every hour needs
    /// a name.
    static func hourLabel(for hour: Int) -> String {
        let reference = Calendar.current.startOfDay(for: Date())
        guard let date = Calendar.current.date(byAdding: .hour, value: hour, to: reference) else {
            return "\(hour)"
        }
        return DateFormat.hourOnly.string(from: date)
    }
}

struct HourLines: View {
    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { _ in
                VStack(spacing: 0) {
                    Rectangle()
                        .fill(Color.cadenceSeparator.opacity(0.45))
                        .frame(height: 0.5)
                    Spacer(minLength: 0)
                }
                .frame(height: Theme.Metrics.hourHeight)
            }
        }
    }
}

/// One day's worth of timed items, positioned and column-packed.
struct TimelineColumn: View {
    @EnvironmentObject private var model: AppModel
    let day: Date

    var body: some View {
        GeometryReader { proxy in
            let items = model.timedItems(on: day)
            let placements = TimelineLayout.place(items, on: day, calendar: model.calendar)

            ZStack(alignment: .topLeading) {
                HourLines()
                    .contentShape(Rectangle())
                    .gesture(
                        SpatialTapGesture().onEnded { value in
                            model.beginQuickAdd(on: day, atOffset: value.location.y)
                        }
                    )

                ForEach(items) { item in
                    if let placement = placements[item.id] {
                        let layout = frame(for: item, placement: placement, width: proxy.size.width)

                        EventChip(item: item, height: layout.height)
                            .frame(width: layout.width, height: layout.height)
                            .offset(x: layout.minX, y: layout.minY)
                            .onTapGesture { model.editingItem = item }
                    }
                }

                if model.calendar.isDateInToday(day) {
                    NowLine()
                }
            }
        }
    }

    private func frame(
        for item: CalendarItem,
        placement: TimelineLayout.Placement,
        width: CGFloat
    ) -> CGRect {
        let calendar = model.calendar
        let dayStart = calendar.startOfDay(for: day)
        let clamped = item.clamped(to: day, calendar: calendar)

        let minutesFromMidnight = clamped.start.timeIntervalSince(dayStart) / 60
        let y = CGFloat(minutesFromMidnight / 60) * Theme.Metrics.hourHeight

        let durationMinutes = max(clamped.end.timeIntervalSince(clamped.start) / 60, 1)
        let height = max(
            CGFloat(durationMinutes / 60) * Theme.Metrics.hourHeight,
            Theme.Metrics.minimumChipHeight
        )

        let columnWidth = width / CGFloat(max(placement.columnCount, 1))
        let inset = Theme.Metrics.chipInset

        return CGRect(
            x: columnWidth * CGFloat(placement.column) + inset,
            y: y,
            width: max(columnWidth - inset * 2, 1),
            height: height - inset
        )
    }
}

/// The current-time line. Redraws every minute.
struct NowLine: View {
    var body: some View {
        SwiftUI.TimelineView(.periodic(from: .now, by: 60)) { context in
            let calendar = Calendar.current
            let minutes = context.date.timeIntervalSince(calendar.startOfDay(for: context.date)) / 60

            ZStack(alignment: .leading) {
                Rectangle()
                    .fill(Theme.nowIndicator)
                    .frame(height: 1.5)
                Circle()
                    .fill(Theme.nowIndicator)
                    .frame(width: 7, height: 7)
                    .offset(x: -3.5)
            }
            .frame(height: 7)
            .offset(y: CGFloat(minutes / 60) * Theme.Metrics.hourHeight - 3.5)
            .allowsHitTesting(false)
        }
    }
}

/// All-day and multi-day items, pinned above the scrolling hour grid so they do
/// not scroll away from the day they belong to.
struct AllDayStrip: View {
    @EnvironmentObject private var model: AppModel
    let days: [Date]

    private var hasAny: Bool {
        days.contains { !model.allDayItems(on: $0).isEmpty }
    }

    var body: some View {
        if hasAny {
            HStack(alignment: .top, spacing: 0) {
                Text("all-day")
                    .font(Theme.Typography.hourLabel)
                    .foregroundStyle(.secondary)
                    .frame(width: Theme.Metrics.gutterWidth, alignment: .trailing)
                    .padding(.trailing, 4)
                    .padding(.top, 4)

                ForEach(days, id: \.timeIntervalSince1970) { day in
                    VStack(spacing: 2) {
                        ForEach(model.allDayItems(on: day).prefix(3)) { item in
                            EventChip(item: item, height: 20)
                                .frame(height: 20)
                                .onTapGesture { model.editingItem = item }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .top)
                    .padding(.horizontal, 1)
                }
            }
            .padding(.vertical, 4)
            .background(Color.cadenceSecondaryBackground.opacity(0.4))

            Divider()
        }
    }
}
