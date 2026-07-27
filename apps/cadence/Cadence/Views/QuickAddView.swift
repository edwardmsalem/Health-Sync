import SwiftUI

/// The natural-language entry field.
///
/// The preview row underneath the field is the important part: it shows what the
/// parser understood *before* you commit. Without it natural-language input is a
/// guessing game, and one wrong guess teaches people to stop trusting it.
struct QuickAddView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var text = ""
    @State private var forceTask = false
    @State private var isSaving = false
    @FocusState private var isFieldFocused: Bool

    /// Reparsed on every keystroke. It is a handful of regular expressions over
    /// a short string, which is far cheaper than the debounce would be worth.
    private var parsed: ParsedInput {
        NaturalLanguageParser(calendar: model.calendar).parse(text)
    }

    private var willCreateTask: Bool {
        (forceTask || parsed.looksLikeTask) && model.todoist.isConnected
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()

            VStack(alignment: .leading, spacing: 14) {
                TextField("Lunch with Sam tomorrow 1–2pm", text: $text, axis: .vertical)
                    .font(.system(size: 18))
                    .textFieldStyle(.plain)
                    .lineLimit(1...3)
                    .focused($isFieldFocused)
                    .onSubmit(save)
                    #if os(iOS)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.sentences)
                    #endif

                if !text.isEmpty {
                    previewChips
                }

                if model.todoist.isConnected {
                    Toggle(isOn: $forceTask) {
                        Label("Create as a Todoist task", systemImage: "checkmark.circle")
                            .font(.subheadline)
                    }
                    .toggleStyle(.switch)
                    .disabled(parsed.looksLikeTask)
                    .help(parsed.looksLikeTask ? "A #project, @label, or priority already makes this a task." : "")
                }

                hints
            }
            .padding(Theme.Metrics.horizontalPadding)

            Spacer(minLength: 0)
        }
        .frame(minWidth: 420, minHeight: 300)
        .onAppear { isFieldFocused = true }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        #endif
    }

    // MARK: - Pieces

    private var header: some View {
        HStack {
            Button("Cancel") {
                model.pendingStart = nil
                dismiss()
            }
            .buttonStyle(.plain)

            Spacer()

            Text(willCreateTask ? "New Task" : "New Event")
                .font(.headline)

            Spacer()

            Button(action: save) {
                if isSaving {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Add").fontWeight(.semibold)
                }
            }
            .buttonStyle(.plain)
            .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || isSaving)
        }
        .padding(.horizontal, Theme.Metrics.horizontalPadding)
        .padding(.vertical, 12)
    }

    private var previewChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                if let start = parsed.start {
                    chip(
                        systemImage: parsed.isAllDay ? "calendar" : "clock",
                        text: scheduleLabel(start: start, end: parsed.end, isAllDay: parsed.isAllDay),
                        tint: .accentColor
                    )
                } else if let pending = model.pendingStart {
                    chip(systemImage: "clock", text: DateFormat.time.string(from: pending), tint: .secondary)
                }

                if let recurrence = parsed.recurrence {
                    chip(systemImage: "repeat", text: recurrence.displayLabel, tint: .purple)
                }

                ForEach(parsed.alerts, id: \.self) { alert in
                    chip(systemImage: "bell", text: alert.shortLabel, tint: .orange)
                }

                if let project = parsed.projectName {
                    chip(systemImage: "number", text: project, tint: .teal)
                }

                ForEach(parsed.labels, id: \.self) { label in
                    chip(systemImage: "tag", text: label, tint: .teal)
                }

                if let priority = parsed.priority {
                    chip(systemImage: "flag.fill", text: "p\(priority)", tint: .red)
                }
            }
        }
        .frame(height: 30)
    }

    private func chip(systemImage: String, text: String, tint: Color) -> some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage).font(.system(size: 10, weight: .semibold))
            Text(text).font(.system(size: 12, weight: .medium))
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(tint.opacity(0.13), in: Capsule())
    }

    private var hints: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Try:").font(.caption).foregroundStyle(.tertiary)
            ForEach([
                "Standup every weekday at 9:15",
                "Dentist next Tuesday 3–4:30 remind me 1 hour before",
                "Submit report friday 5pm #Work p1"
            ], id: \.self) { example in
                Button {
                    text = example
                } label: {
                    Text(example)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 4)
    }

    private func scheduleLabel(start: Date, end: Date?, isAllDay: Bool) -> String {
        let day = DateFormat.weekdayShort.string(from: start)
        guard !isAllDay else { return "\(day) · all day" }

        let startTime = DateFormat.time.string(from: start)
        guard let end else { return "\(day) · \(startTime)" }
        return "\(day) · \(startTime) – \(DateFormat.time.string(from: end))"
    }

    private func save() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isSaving else { return }

        isSaving = true
        Task {
            await model.createFromQuickAdd(text: trimmed, forceTask: forceTask)
            isSaving = false
            dismiss()
        }
    }
}
