import SwiftUI
import UIKit

/// Registers what iOS needs before the first screen: notification answers and the background alert check.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        NotificationService.shared.configure()
        BackgroundRefresh.register()
        return true
    }
}

@main
struct NexusliveApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var backend: Backend
    @StateObject private var ledger: Ledger
    @StateObject private var router = AppRouter.shared

    init() {
        let backend = Backend()
        let ledger = Ledger(backend: backend)
        _backend = StateObject(wrappedValue: backend)
        _ledger = StateObject(wrappedValue: ledger)
        AppServices.ledger = ledger
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(backend)
                .environmentObject(ledger)
                .environmentObject(router)
                .tint(Theme.accent)
                .preferredColorScheme(.dark)
                .onOpenURL { router.handle($0) }
        }
    }
}

enum Theme {
    static let accent = Color(red: 201 / 255, green: 168 / 255, blue: 92 / 255)
}

struct RootView: View {
    @EnvironmentObject private var backend: Backend
    @EnvironmentObject private var ledger: Ledger
    @EnvironmentObject private var router: AppRouter
    @Environment(\.scenePhase) private var scenePhase
    /// True once the tabs have opened. From then on the lock covers the app instead of replacing it,
    /// so the page you were on, an open sheet and what you typed are still there after Face ID.
    @State private var opened = false

    private var covered: Bool { opened && backend.locked && backend.session != nil }

    var body: some View {
        content
            .onChange(of: covered) { _, covered in
                if covered {
                    LockCover.shared.show(backend)
                } else {
                    LockCover.shared.hide()
                    // The tabs used to reload when Face ID rebuilt them; they now stay, so reload here.
                    if backend.session != nil { Task { await ledger.reload() } }
                }
            }
    }

    @ViewBuilder private var content: some View {
        if !backend.isConfigured {
            ContentUnavailableView("Backend not connected", systemImage: "exclamationmark.triangle",
                                   description: Text("This build has no Supabase address."))
        } else if backend.session == nil {
            SignInView()
        } else if backend.locked && !opened {
            LockView()
        } else {
            TabView(selection: $router.tab) {
                HomeView().tabItem { Label("Home", systemImage: "house") }.tag(AppRouter.Tab.home)
                SpendView().tabItem { Label("Spend", systemImage: "creditcard") }.tag(AppRouter.Tab.spend)
                DecideView().tabItem { Label("Decide", systemImage: "arrow.triangle.branch") }.tag(AppRouter.Tab.decide)
                PlanView().tabItem { Label("Plan", systemImage: "chart.line.uptrend.xyaxis") }.tag(AppRouter.Tab.plan)
                SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }.tag(AppRouter.Tab.settings)
            }
            .sheet(item: $router.buyDraft) { draft in PurchaseForm(draft: draft) }
            .sheet(isPresented: $router.showReview) { NavigationStack { SundayReviewView() } }
            .sheet(isPresented: $router.showClose) { NavigationStack { CloseView() } }
            .sheet(isPresented: $router.showPurchases) { NavigationStack { PurchaseReviewView() } }
            .onAppear { opened = true }
            .task {
                UsageClock.shared.start()
                await ledger.reload()
            }
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active: UsageClock.shared.start()
                case .background:
                    UsageClock.shared.stop()
                    BackgroundRefresh.schedule()
                    backend.locked = true
                default: break
                }
            }
        }
    }
}

/// Covers the app until Face ID (or the device passcode) unlocks it.
/// Reads the app state from UIApplication, so it works inline and inside the cover window alike.
struct LockView: View {
    @EnvironmentObject private var backend: Backend
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
        .onAppear { if UIApplication.shared.applicationState == .active { autoUnlock() } }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            autoUnlock()
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

/// Shows the lock screen in its own window above every page, sheet and alert of the app.
/// The app underneath is left as it was, so Face ID brings you back to the same place.
@MainActor
final class LockCover {
    static let shared = LockCover()
    private var window: UIWindow?
    private weak var previousKey: UIWindow?

    func show(_ backend: Backend) {
        guard window == nil,
              let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
        // Closes the keyboard so it cannot sit above the lock; the text in the field stays.
        _ = UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        let host = UIHostingController(rootView: LockView().environmentObject(backend).tint(Theme.accent))
        host.view.backgroundColor = .systemBackground
        let cover = UIWindow(windowScene: scene)
        cover.overrideUserInterfaceStyle = .dark
        cover.windowLevel = .alert + 1
        cover.rootViewController = host
        previousKey = scene.keyWindow
        cover.makeKeyAndVisible()
        window = cover
    }

    func hide() {
        guard let cover = window else { return }
        cover.isHidden = true
        window = nil
        previousKey?.makeKey()
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
