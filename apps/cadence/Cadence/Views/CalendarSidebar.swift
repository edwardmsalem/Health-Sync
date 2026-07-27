import SwiftUI

#if os(macOS)
/// The Mac sidebar, Readdle-style: every calendar as a row with a colored
/// round checkbox, grouped under the account it belongs to, plus a Todoist
/// section. Unchecking hides that calendar everywhere instantly.
struct CalendarSidebar: View {
    @EnvironmentObject private var model: AppModel

    private var grouped: [(account: String, symbol: String, calendars: [CalendarSource])] {
        Dictionary(grouping: model.eventStore.calendars, by: \.accountTitle)
            .map { key, value in
                (
                    account: "\(value.first?.account.displayName ?? "Calendars") · \(key)",
                    symbol: value.first?.account.symbolName ?? "calendar",
                    calendars: value.sorted {
                        $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
                    }
                )
            }
            .sorted { $0.account < $1.account }
    }

    var body: some View {
        List {
            ForEach(grouped, id: \.account) { group in
                Section {
                    ForEach(group.calendars) { source in
                        CalendarToggleRow(source: source)
                    }
                } header: {
                    Label(group.account, systemImage: group.symbol)
                }
            }

            Section {
                if model.todoist.isConnected {
                    Button {
                        showTasksBinding.wrappedValue.toggle()
                    } label: {
                        HStack(spacing: 8) {
                            ColorCheckCircle(
                                colorHex: TodoistPalette.fallback,
                                isOn: model.preferences.showTodoistTasks
                            )
                            Text("Tasks on calendar")
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                } else {
                    Button {
                        model.isPresentingSettings = true
                    } label: {
                        Label("Connect Todoist…", systemImage: "link")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                }
            } header: {
                Label("Todoist", systemImage: "checklist")
            }
        }
        .listStyle(.sidebar)
    }

    private var showTasksBinding: Binding<Bool> {
        Binding(
            get: { model.preferences.showTodoistTasks },
            set: { value in model.preferencesController.update { $0.showTodoistTasks = value } }
        )
    }
}

struct CalendarToggleRow: View {
    @EnvironmentObject private var model: AppModel
    let source: CalendarSource

    private var isVisible: Bool {
        model.preferences.isVisible(calendarID: source.id)
    }

    var body: some View {
        Button {
            model.preferencesController.update { preferences in
                if isVisible {
                    preferences.hiddenCalendarIDs.insert(source.id)
                } else {
                    preferences.hiddenCalendarIDs.remove(source.id)
                }
            }
        } label: {
            HStack(spacing: 8) {
                ColorCheckCircle(
                    colorHex: model.preferences.color(for: source),
                    isOn: isVisible
                )
                Text(source.title)
                    .lineLimit(1)
                    .foregroundStyle(isVisible ? .primary : .secondary)
                Spacer(minLength: 0)
                if !source.allowsModification {
                    Image(systemName: "lock")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The colored round checkbox Readdle uses for calendar visibility: a filled
/// circle in the calendar's color with a white tick when on, a hollow ring
/// when off.
struct ColorCheckCircle: View {
    let colorHex: String
    let isOn: Bool

    var body: some View {
        ZStack {
            if isOn {
                Circle().fill(Color(hex: colorHex))
                Image(systemName: "checkmark")
                    .font(.system(size: 8, weight: .heavy))
                    .foregroundStyle(.white)
            } else {
                Circle().strokeBorder(Color(hex: colorHex), lineWidth: 1.8)
            }
        }
        .frame(width: 15, height: 15)
    }
}
#endif
