import SwiftUI

/// A continuous list of upcoming days, in the spirit of a paper diary.
///
/// Days with nothing on them are skipped rather than shown empty — scrolling
/// past a run of blank Saturdays is what makes list views tedious.
struct AgendaListView: View {
    @EnvironmentObject private var model: AppModel

    /// Days carrying at least one item, from the start of the displayed month
    /// through the end of the following one.
    private var populatedDays: [Date] {
        let calendar = model.calendar
        guard let monthStart = calendar.dateInterval(of: .month, for: model.anchorMonth)?.start
        else { return [] }

        return (0..<62)
            .compactMap { calendar.date(byAdding: .day, value: $0, to: monthStart) }
            .filter { model.hasItems(on: $0) }
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    if populatedDays.isEmpty {
                        EmptyDayView(message: "Nothing scheduled this month")
                    }

                    ForEach(populatedDays, id: \.timeIntervalSince1970) { day in
                        Section {
                            ForEach(model.items(on: day)) { item in
                                AgendaRow(item: item) {
                                    Task { await model.toggleCompletion(for: item) }
                                }
                                .padding(.horizontal, Theme.Metrics.horizontalPadding)
                                .onTapGesture { model.editingItem = item }

                                Divider().padding(.leading, Theme.Metrics.horizontalPadding + 15)
                            }
                        } header: {
                            dayHeader(day)
                        }
                        .id(day.timeIntervalSince1970)
                    }
                }
            }
            .onAppear {
                proxy.scrollTo(
                    model.calendar.startOfDay(for: model.selectedDate).timeIntervalSince1970,
                    anchor: .top
                )
            }
        }
    }

    private func dayHeader(_ day: Date) -> some View {
        let isToday = model.calendar.isDateInToday(day)

        return HStack {
            Text(DateFormat.weekdayLong.string(from: day))
                .font(Theme.Typography.sectionHeader)
                .foregroundStyle(isToday ? Color.accentColor : .secondary)
            Spacer()
            if isToday {
                Text("TODAY")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Color.accentColor)
            }
        }
        .padding(.horizontal, Theme.Metrics.horizontalPadding)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
    }
}
