import SwiftUI

@main
struct CadenceApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .task { await model.bootstrap() }
                .onChange(of: scenePhase) { _, phase in
                    // EventKit posts changes while the app is backgrounded, but
                    // Todoist has to be polled, so returning to the foreground
                    // is the moment to catch up.
                    guard phase == .active else { return }
                    Task { await model.refresh() }
                }
        }
        #if os(macOS)
        .defaultSize(width: 1180, height: 780)
        .commands { CadenceCommands(model: model) }
        #endif

        #if os(macOS)
        Settings {
            SettingsView()
                .environmentObject(model)
                .frame(width: 560, height: 520)
        }
        #endif
    }
}

#if os(macOS)
/// Menu-bar commands and their keyboard shortcuts. On macOS these are what make
/// the app feel native rather than like an iPad build in a window.
struct CadenceCommands: Commands {
    @ObservedObject var model: AppModel

    var body: some Commands {
        CommandGroup(after: .newItem) {
            Button("Quick Add…") { model.isPresentingQuickAdd = true }
                .keyboardShortcut("n", modifiers: .command)
        }

        CommandMenu("View") {
            ForEach(CalendarViewMode.allCases) { mode in
                Button(mode.title) { model.setViewMode(mode) }
                    .keyboardShortcut(shortcut(for: mode), modifiers: .command)
            }
            Divider()
            Button("Today") { model.goToToday() }
                .keyboardShortcut("t", modifiers: .command)
            Button("Previous") { model.step(months: -1) }
                .keyboardShortcut(.leftArrow, modifiers: [.command, .option])
            Button("Next") { model.step(months: 1) }
                .keyboardShortcut(.rightArrow, modifiers: [.command, .option])
        }
    }

    private func shortcut(for mode: CalendarViewMode) -> KeyEquivalent {
        switch mode {
        case .day: return "1"
        case .week: return "2"
        case .month: return "3"
        case .agenda: return "4"
        }
    }
}
#endif
