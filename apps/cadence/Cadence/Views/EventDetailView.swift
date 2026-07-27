import SwiftUI

struct EventDetailView: View {
    let item: CalendarItem

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var title: String
    @State private var start: Date
    @State private var end: Date
    @State private var isAllDay: Bool
    @State private var location: String
    @State private var notes: String
    @State private var alerts: [AlertOffset]
    @State private var isConfirmingDelete = false
    @State private var isSaving = false

    init(item: CalendarItem) {
        self.item = item
        _title = State(initialValue: item.title)
        _start = State(initialValue: item.start)
        _end = State(initialValue: item.end)
        _isAllDay = State(initialValue: item.isAllDay)
        _location = State(initialValue: item.location ?? "")
        _notes = State(initialValue: item.notes ?? "")
        _alerts = State(initialValue: item.alerts)
    }

    private var isTask: Bool { item.origin.isTask }
    private var accent: Color { Color(hex: item.colorHex) }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()

            Form {
                Section {
                    TextField("Title", text: $title)
                        .font(.system(size: 17, weight: .medium))

                    HStack(spacing: 8) {
                        Circle().fill(accent).frame(width: 9, height: 9)
                        Text(item.containerTitle).foregroundStyle(.secondary)
                        if item.isRecurring {
                            Image(systemName: "repeat").font(.caption).foregroundStyle(.tertiary)
                        }
                        Spacer()
                        if isTask, let priority = item.priority, priority < 4 {
                            Text("p\(priority)")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.red)
                        }
                    }
                }

                Section("When") {
                    if !isTask {
                        Toggle("All day", isOn: $isAllDay)
                    }

                    DatePicker(
                        isTask ? "Due" : "Starts",
                        selection: $start,
                        displayedComponents: isAllDay ? [.date] : [.date, .hourAndMinute]
                    )

                    if !isTask && !isAllDay {
                        DatePicker("Ends", selection: $end, in: start..., displayedComponents: [.date, .hourAndMinute])
                    }
                }

                if !isTask {
                    Section("Details") {
                        TextField("Location", text: $location)
                        TextField("Notes", text: $notes, axis: .vertical).lineLimit(2...6)
                    }

                    Section("Alerts") {
                        ForEach(alerts, id: \.self) { alert in
                            HStack {
                                Image(systemName: "bell").foregroundStyle(.secondary)
                                Text(alert.shortLabel)
                                Spacer()
                                Button {
                                    alerts.removeAll { $0 == alert }
                                } label: {
                                    Image(systemName: "minus.circle.fill").foregroundStyle(.red.opacity(0.7))
                                }
                                .buttonStyle(.plain)
                            }
                        }

                        Menu("Add alert") {
                            ForEach(Self.alertChoices, id: \.self) { choice in
                                Button(choice.shortLabel) {
                                    guard !alerts.contains(choice) else { return }
                                    alerts.append(choice)
                                    alerts.sort { $0.minutesBefore < $1.minutesBefore }
                                }
                            }
                        }
                    }
                }

                if isTask {
                    Section {
                        Button {
                            Task {
                                await model.toggleCompletion(for: item)
                                dismiss()
                            }
                        } label: {
                            Label(
                                item.isCompleted ? "Mark as not done" : "Complete task",
                                systemImage: item.isCompleted ? "arrow.uturn.backward" : "checkmark.circle"
                            )
                        }
                    } footer: {
                        Text("Completing here updates Todoist on the next sync.")
                    }
                }

                Section {
                    Button(role: .destructive) {
                        isConfirmingDelete = true
                    } label: {
                        Label(isTask ? "Complete and remove" : "Delete event", systemImage: "trash")
                    }
                }
            }
            .formStyle(.grouped)
        }
        .frame(minWidth: 420, minHeight: 520)
        .confirmationDialog(
            isTask ? "Complete this task?" : "Delete this event?",
            isPresented: $isConfirmingDelete,
            titleVisibility: .visible
        ) {
            Button(isTask ? "Complete" : "Delete", role: .destructive) {
                model.delete(item)
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if item.isRecurring && !isTask {
                Text("This is a repeating event. Only this occurrence will be removed.")
            }
        }
    }

    private var header: some View {
        HStack {
            Button("Close") { dismiss() }
                .buttonStyle(.plain)

            Spacer()

            Text(isTask ? "Task" : "Event")
                .font(.headline)

            Spacer()

            Button(action: save) {
                if isSaving {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Save").fontWeight(.semibold)
                }
            }
            .buttonStyle(.plain)
            .disabled(isSaving || title.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal, Theme.Metrics.horizontalPadding)
        .padding(.vertical, 12)
    }

    private static let alertChoices: [AlertOffset] = [
        .atTimeOfEvent, .fiveMinutes, .fifteenMinutes, .thirtyMinutes, .oneHour,
        AlertOffset(minutesBefore: 120), .oneDay
    ]

    private func save() {
        isSaving = true

        Task {
            switch item.origin {
            case .event(let identifier, _):
                do {
                    try model.eventStore.updateEvent(
                        identifier: identifier,
                        title: title,
                        start: start,
                        end: isAllDay ? start.addingTimeInterval(86_400) : max(end, start),
                        isAllDay: isAllDay,
                        location: location.isEmpty ? nil : location,
                        notes: notes.isEmpty ? nil : notes,
                        alerts: alerts
                    )
                } catch {
                    model.errorMessage = error.localizedDescription
                }

            case .task(let todoistID):
                // Only the due date is editable from here; renaming or
                // reprojecting a task belongs in Todoist itself.
                if start != item.start {
                    await model.todoist.reschedule(taskID: todoistID, to: start)
                }
            }

            model.reload()
            isSaving = false
            dismiss()
        }
    }
}
