import SwiftUI

@main
struct NexusliveApp: App {
    @StateObject private var backend: Backend
    @StateObject private var ledger: Ledger

    init() {
        let backend = Backend()
        _backend = StateObject(wrappedValue: backend)
        _ledger = StateObject(wrappedValue: Ledger(backend: backend))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(backend)
                .environmentObject(ledger)
                .tint(Theme.accent)
                .preferredColorScheme(.dark)
        }
    }
}

enum Theme {
    static let accent = Color(red: 201 / 255, green: 168 / 255, blue: 92 / 255)
}

struct RootView: View {
    @EnvironmentObject private var backend: Backend
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        if !backend.isConfigured {
            ContentUnavailableView("Backend not connected", systemImage: "exclamationmark.triangle",
                                   description: Text("This build has no Supabase address."))
        } else if backend.session == nil {
            SignInView()
        } else if backend.locked {
            LockView()
        } else {
            TabView {
                LogView().tabItem { Label("Log", systemImage: "plus.circle") }
                DecideView().tabItem { Label("Decide", systemImage: "arrow.triangle.branch") }
                PlanView().tabItem { Label("Plan", systemImage: "calendar") }
                MoneyView().tabItem { Label("Money", systemImage: "chart.bar") }
            }
            .task { await ledger.reload() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .background { backend.locked = true }
            }
        }
    }
}

/// Covers the app until Face ID (or the device passcode) unlocks it.
struct LockView: View {
    @EnvironmentObject private var backend: Backend
    @Environment(\.scenePhase) private var scenePhase
    @State private var asking = false
    @State private var autoTried = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "faceid").font(.system(size: 64)).foregroundStyle(Theme.accent)
            Text("Nexuslive is locked").font(.title3.bold())
            Button("Unlock with Face ID") { unlock() }
                .buttonStyle(.borderedProminent)
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .onAppear { if scenePhase == .active { autoUnlock() } }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { autoUnlock() }
        }
    }

    /// Asks once by itself each time the lock screen appears; a cancelled prompt does not reopen in a loop.
    private func autoUnlock() {
        guard !autoTried else { return }
        autoTried = true
        unlock()
    }

    private func unlock() {
        guard !asking else { return }
        asking = true
        Task {
            await backend.unlock()
            asking = false
        }
    }
}

/// Shows an error from any write in a standard alert.
struct ErrorAlert: ViewModifier {
    @Binding var message: String?

    func body(content: Content) -> some View {
        content.alert("Something went wrong", isPresented: Binding(
            get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK", role: .cancel) { message = nil }
        } message: {
            Text(message ?? "")
        }
    }
}

extension View {
    func errorAlert(_ message: Binding<String?>) -> some View { modifier(ErrorAlert(message: message)) }
}
