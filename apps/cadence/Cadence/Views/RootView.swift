import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()

            if model.eventStore.hasFullAccess {
                content
            } else {
                CalendarAccessGate()
            }
        }
        .background(Color.cadenceBackground)
        .overlay(alignment: .bottomTrailing) {
            #if os(iOS)
            quickAddButton
            #endif
        }
        .sheet(isPresented: $model.isPresentingQuickAdd) {
            QuickAddView().environmentObject(model)
        }
        .sheet(item: $model.editingItem) { item in
            EventDetailView(item: item).environmentObject(model)
        }
        .sheet(isPresented: $model.isPresentingSettings) {
            SettingsView().environmentObject(model)
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(DateFormat.monthYear.string(from: model.anchorMonth))
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .contentTransition(.numericText())

                Spacer()

                Button { step(-1) } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Previous")

                Button("Today") { withAnimation { model.goToToday() } }
                    .font(.system(size: 13, weight: .semibold))
                    .buttonStyle(.plain)

                Button { step(1) } label: { Image(systemName: "chevron.right") }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Next")

                #if os(macOS)
                Button { model.isPresentingQuickAdd = true } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Quick add")
                #endif

                Button { model.isPresentingSettings = true } label: {
                    Image(systemName: "gearshape")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Settings")
            }
            .foregroundStyle(.primary)

            Picker("View", selection: viewModeBinding) {
                ForEach(CalendarViewMode.allCases) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
        .padding(.horizontal, Theme.Metrics.horizontalPadding)
        .padding(.top, 10)
        .padding(.bottom, 10)
    }

    private var viewModeBinding: Binding<CalendarViewMode> {
        Binding(
            get: { model.viewMode },
            set: { model.setViewMode($0) }
        )
    }

    /// Month and week views page by month; day pages by day, which is what the
    /// arrows should follow.
    private func step(_ direction: Int) {
        withAnimation(.snappy(duration: 0.22)) {
            switch model.viewMode {
            case .day: model.step(days: direction)
            case .week: model.step(days: direction * 7)
            case .month, .agenda: model.step(months: direction)
            }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        switch model.viewMode {
        case .month: MonthView()
        case .week: WeekTimelineView()
        case .day: DayTimelineView()
        case .agenda: AgendaListView()
        }
    }

    #if os(iOS)
    private var quickAddButton: some View {
        Button {
            model.isPresentingQuickAdd = true
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 54, height: 54)
                .background(Circle().fill(Color.accentColor))
                .shadow(color: .black.opacity(0.18), radius: 8, y: 4)
        }
        .buttonStyle(.plain)
        .padding(.trailing, 20)
        .padding(.bottom, 24)
        .accessibilityLabel("Quick add")
    }
    #endif
}

/// Shown until EventKit access is granted. Without it there is nothing to draw,
/// so this replaces the calendar rather than sitting on top of it.
struct CalendarAccessGate: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "calendar.badge.exclamationmark")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(.secondary)

            Text("Cadence needs access to your calendars")
                .font(.headline)

            Text("Your iCloud and Google calendars are read through the system calendar store, so nothing leaves your devices and no accounts need connecting.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)

            Button("Grant Access") {
                Task { await model.eventStore.requestAccess(); model.reload() }
            }
            .buttonStyle(.borderedProminent)

            if model.eventStore.authorizationStatus == .denied {
                Text("Access was denied. Turn it on in Settings › Privacy & Security › Calendars.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
