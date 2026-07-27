import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var todoistToken = ""
    @State private var isConnecting = false
    @State private var connectionError: String?

    /// Overrides offered for a calendar whose own color is unhelpful — Google
    /// calendars in particular often arrive as near-identical blues.
    private static let palette = [
        "#E8574A", "#F2994A", "#F2C94C", "#57B95B", "#2FA9A0",
        "#4C8DF6", "#5C6BC0", "#9B59B6", "#E0669A", "#8D8D93"
    ]

    var body: some View {
        VStack(spacing: 0) {
            #if os(iOS)
            header
            Divider()
            #endif

            Form {
                calendarsSection
                todoistSection
                alertsSection
                displaySection
                syncSection
            }
            .formStyle(.grouped)
        }
    }

    #if os(iOS)
    private var header: some View {
        HStack {
            Spacer()
            Text("Settings").font(.headline)
            Spacer()
            Button("Done") { dismiss() }.fontWeight(.semibold).buttonStyle(.plain)
        }
        .padding(.horizontal, Theme.Metrics.horizontalPadding)
        .padding(.vertical, 12)
        .overlay(alignment: .trailing) { Color.clear }
    }
    #endif

    // MARK: - Calendars

    /// Calendars grouped under the account they came from, so iCloud and Gmail
    /// read as separate sources rather than one flat list.
    ///
    /// This is a named struct rather than a tuple because Swift has no key paths
    /// into tuple elements, and `ForEach(_:id:)` needs one.
    private struct CalendarGroup: Identifiable {
        let id: String
        let calendars: [CalendarSource]
    }

    private var groupedCalendars: [CalendarGroup] {
        Dictionary(grouping: model.eventStore.calendars, by: \.accountTitle)
            .map { CalendarGroup(id: $0.key, calendars: $0.value) }
            .sorted { $0.id < $1.id }
    }

    @ViewBuilder
    private var calendarsSection: some View {
        ForEach(groupedCalendars) { group in
            Section {
                ForEach(group.calendars) { source in
                    HStack(spacing: 10) {
                        Menu {
                            Button("Use calendar color") { setColor(nil, for: source) }
                            Divider()
                            ForEach(Self.palette, id: \.self) { hex in
                                Button {
                                    setColor(hex, for: source)
                                } label: {
                                    Label {
                                        Text(hex)
                                    } icon: {
                                        Image(systemName: "circle.fill").foregroundStyle(Color(hex: hex))
                                    }
                                }
                            }
                        } label: {
                            Circle()
                                .fill(Color(hex: model.preferences.color(for: source)))
                                .frame(width: 14, height: 14)
                        }
                        .fixedSize()

                        Toggle(source.title, isOn: visibilityBinding(for: source))

                        if !source.allowsModification {
                            Image(systemName: "lock")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .help("This calendar is read-only")
                        }
                    }
                }
            } header: {
                Label(
                    "\(group.calendars.first?.account.displayName ?? "Calendars") · \(group.id)",
                    systemImage: group.calendars.first?.account.symbolName ?? "calendar"
                )
            }
        }

        if model.eventStore.calendars.isEmpty {
            Section {
                Text("No calendars found. Add your accounts in system Settings and they will appear here.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func visibilityBinding(for source: CalendarSource) -> Binding<Bool> {
        Binding(
            get: { model.preferences.isVisible(calendarID: source.id) },
            set: { isVisible in
                model.preferencesController.update { preferences in
                    if isVisible {
                        preferences.hiddenCalendarIDs.remove(source.id)
                    } else {
                        preferences.hiddenCalendarIDs.insert(source.id)
                    }
                }
            }
        )
    }

    private func setColor(_ hex: String?, for source: CalendarSource) {
        model.preferencesController.update { preferences in
            if let hex {
                preferences.calendarColorOverrides[source.id] = hex
            } else {
                preferences.calendarColorOverrides.removeValue(forKey: source.id)
            }
        }
    }

    // MARK: - Todoist

    @ViewBuilder
    private var todoistSection: some View {
        Section {
            if model.todoist.isConnected {
                HStack {
                    Label("Connected", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Spacer()
                    if model.todoist.isSyncing {
                        ProgressView().controlSize(.small)
                    } else if let syncedAt = model.todoist.lastSyncedAt {
                        Text(syncedAt, style: .relative)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                HStack {
                    Text("Tasks")
                    Spacer()
                    Text("\(model.todoist.itemsByID.count)").foregroundStyle(.secondary)
                }

                Button("Sync now") {
                    Task { await model.todoist.sync(); model.reload() }
                }

                Button("Disconnect", role: .destructive) {
                    model.todoist.disconnect()
                    model.reload()
                }
            } else {
                SecureField("Todoist API token", text: $todoistToken)

                Button {
                    connectTodoist()
                } label: {
                    if isConnecting {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Connect")
                    }
                }
                .disabled(todoistToken.trimmingCharacters(in: .whitespaces).isEmpty || isConnecting)

                Link(
                    "Get your token from Todoist settings",
                    destination: URL(string: "https://app.todoist.com/app/settings/integrations/developer")!
                )
                .font(.caption)
            }

            Picker("Tasks with no time", selection: Binding(
                get: { model.preferences.dateOnlyTaskHour },
                set: { value in model.preferencesController.update { $0.dateOnlyTaskHour = value } }
            )) {
                ForEach(0..<24, id: \.self) { hour in
                    Text(HourGutter.hourLabel(for: hour)).tag(hour)
                }
            }

            if let error = connectionError ?? model.todoist.lastErrorMessage {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        } header: {
            Label("Todoist", systemImage: "checklist")
        } footer: {
            Text("A task due at a specific time appears at that time. A task due on a date with no time is placed at the hour above, drawn with a dashed edge so you can tell it apart from a real commitment.")
        }
    }

    private func connectTodoist() {
        let token = todoistToken.trimmingCharacters(in: .whitespacesAndNewlines)
        isConnecting = true
        connectionError = nil

        Task {
            do {
                try await model.todoist.connect(token: token)
                todoistToken = ""
                model.reload()
            } catch {
                connectionError = error.localizedDescription
            }
            isConnecting = false
        }
    }

    // MARK: - Alerts

    private var alertsSection: some View {
        Section {
            if model.alerts.authorizationStatus != .authorized {
                Button("Enable notifications") {
                    Task { await model.alerts.requestAuthorization() }
                }
            }

            ForEach(AlertOffset.commonChoices, id: \.self) { choice in
                Toggle(choice.shortLabel, isOn: defaultAlertBinding(choice))
            }
        } header: {
            Label("Alerts", systemImage: "bell")
        } footer: {
            Text("Applied to new events you create and to Todoist task blocks. Alerts already set on an existing event are left alone.")
        }
    }

    private func defaultAlertBinding(_ choice: AlertOffset) -> Binding<Bool> {
        Binding(
            get: { model.preferences.defaultAlerts.contains(choice) },
            set: { isOn in
                model.preferencesController.update { preferences in
                    if isOn {
                        preferences.defaultAlerts.append(choice)
                        preferences.defaultAlerts.sort { $0.minutesBefore < $1.minutesBefore }
                    } else {
                        preferences.defaultAlerts.removeAll { $0 == choice }
                    }
                }
            }
        )
    }

    // MARK: - Display

    private var displaySection: some View {
        Section {
            Toggle("Show Todoist tasks", isOn: Binding(
                get: { model.preferences.showTodoistTasks },
                set: { value in model.preferencesController.update { $0.showTodoistTasks = value } }
            ))

            Toggle("Show completed tasks", isOn: Binding(
                get: { model.preferences.showCompletedTasks },
                set: { value in model.preferencesController.update { $0.showCompletedTasks = value } }
            ))

            Picker("Week starts on", selection: Binding(
                get: { model.preferences.firstWeekday },
                set: { value in model.preferencesController.update { $0.firstWeekday = value } }
            )) {
                Text("Sunday").tag(1)
                Text("Monday").tag(2)
                Text("Saturday").tag(7)
            }

            Picker("Day starts at", selection: Binding(
                get: { model.preferences.preferredDayStartHour },
                set: { value in model.preferencesController.update { $0.preferredDayStartHour = value } }
            )) {
                ForEach(0..<13, id: \.self) { hour in
                    Text(HourGutter.hourLabel(for: hour)).tag(hour)
                }
            }
        } header: {
            Label("Display", systemImage: "slider.horizontal.3")
        }
    }

    // MARK: - Sync

    private var syncSection: some View {
        Section {
            HStack {
                Label("iCloud", systemImage: "icloud")
                Spacer()
                if let message = model.preferencesController.cloudStatusMessage {
                    Text(message).font(.caption).foregroundStyle(.orange).multilineTextAlignment(.trailing)
                } else {
                    Text("Synced").font(.caption).foregroundStyle(.secondary)
                }
            }
        } header: {
            Label("Sync", systemImage: "arrow.triangle.2.circlepath")
        } footer: {
            Text("Your settings sync between your Apple devices through iCloud. Events and tasks sync through their own accounts, so they are already up to date everywhere.")
        }
    }
}

extension AlertOffset {
    /// Offsets offered as defaults in Settings.
    static let commonChoices: [AlertOffset] = [
        .atTimeOfEvent, .fiveMinutes, .fifteenMinutes, .thirtyMinutes, .oneHour, .oneDay
    ]
}
