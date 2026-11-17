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

    var body: some View {
        if !backend.isConfigured {
            ContentUnavailableView("Backend not connected", systemImage: "exclamationmark.triangle",
                                   description: Text("This build has no Supabase address."))
        } else if backend.session == nil {
            SignInView()
        } else {
            TabView {
                LogView().tabItem { Label("Log", systemImage: "plus.circle") }
                DecideView().tabItem { Label("Decide", systemImage: "arrow.triangle.branch") }
                MoneyView().tabItem { Label("Money", systemImage: "chart.bar") }
            }
            .task { await ledger.reload() }
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
