import BackgroundTasks
import Foundation

/// A background check for new stop-list alerts, so a charge on a stop list or an Apple charge outside
/// the allowed list reaches you the same day without a server push. iOS decides the exact time.
enum BackgroundRefresh {
    static var identifier: String { (Bundle.main.bundleIdentifier ?? "nexuslive") + ".refresh" }

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else { task.setTaskCompleted(success: false); return }
            handle(refresh)
        }
    }

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 3 * 3600)
        try? BGTaskScheduler.shared.submit(request)
    }

    private static func handle(_ task: BGAppRefreshTask) {
        schedule()
        let work = Task { @MainActor in
            let ledger = AppServices.ledgerForBackground()
            await ledger.ensureSettings()
            if let alerts: [AlertItem] = try? await ledger.backend.select("nx_alerts",
                "select=id,kind,title,detail,txn_id,created_at,seen_at&seen_at=is.null&order=created_at.desc&limit=20") {
                await Reminders.notifyAlerts(alerts, maxPerDay: Int(ledger.effectiveNumber("notifications.max_per_day") ?? 0))
            }
            task.setTaskCompleted(success: true)
        }
        task.expirationHandler = { work.cancel() }
    }
}
