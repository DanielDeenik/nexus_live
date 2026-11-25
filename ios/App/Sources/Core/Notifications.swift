import Foundation
import UserNotifications

/// Shared handles for code that runs outside a view: notification answers and Shortcuts.
@MainActor
enum AppServices {
    static var ledger: Ledger?

    /// The running app's ledger, or a fresh one when iOS started the app in the background.
    static func ledgerForBackground() -> Ledger {
        if let ledger { return ledger }
        let fresh = Ledger(backend: Backend())
        ledger = fresh
        return fresh
    }
}

/// Local notifications: the question after a Wallet tap, the re-ask when a Buy check's wait ends,
/// the Sunday review, renewals and stop-list alerts. Answers from the buttons are saved without
/// opening the app. Reminders stay within notifications.max_per_day (Karlan et al. 2016).
final class NotificationService: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationService()

    enum Category {
        static let tap = "nx.tap"
        static let tapFood = "nx.tap.food"
        static let reask = "nx.reask"
    }
    enum Action {
        static let planned = "nx.tap.planned"
        static let impulse = "nx.tap.impulse"
        static let staples = "nx.tap.staples"
        static let luxury = "nx.tap.luxury"
        static let buy = "nx.reask.buy"
        static let skip = "nx.reask.skip"
    }

    private var center: UNUserNotificationCenter { .current() }

    func configure() {
        center.delegate = self
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Category.tap, actions: [
                UNNotificationAction(identifier: Action.planned, title: "Planned"),
                UNNotificationAction(identifier: Action.impulse, title: "Impulse")
            ], intentIdentifiers: []),
            UNNotificationCategory(identifier: Category.tapFood, actions: [
                UNNotificationAction(identifier: Action.staples, title: "Staples only"),
                UNNotificationAction(identifier: Action.luxury, title: "Luxury too")
            ], intentIdentifiers: []),
            UNNotificationCategory(identifier: Category.reask, actions: [
                UNNotificationAction(identifier: Action.buy, title: "Buy it"),
                UNNotificationAction(identifier: Action.skip, title: "Skip and save", options: [.destructive])
            ], intentIdentifiers: [])
        ])
    }

    @discardableResult
    func requestPermission() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    func permissionGranted() async -> Bool {
        await center.notificationSettings().authorizationStatus == .authorized
    }

    // MARK: Asking

    /// Right after a Wallet tap: planned or impulse; at a supermarket: staples only or luxury too.
    func askAboutTap(_ tap: WalletTap, supermarket: Bool) async {
        let content = UNMutableNotificationContent()
        let amount = tap.amount.map { Money.format($0, tap.currency) } ?? ""
        content.title = "\(tap.merchant) \(amount)".trimmingCharacters(in: .whitespaces)
        content.body = supermarket ? "Staples only, or luxury too?" : "Planned, or an impulse?"
        content.categoryIdentifier = supermarket ? Category.tapFood : Category.tap
        content.userInfo = ["tap": tap.id]
        try? await center.add(UNNotificationRequest(identifier: "tap-\(tap.id)", content: content, trigger: nil))
    }

    /// When a Buy check's wait ends: still want it? The answer is the next loop's trigger.
    func scheduleReask(checkId: String, item: String, amount: Double, currency: String, at date: Date) async {
        guard date > Date() else { return }
        let content = UNMutableNotificationContent()
        content.title = "Still want \(item)?"
        content.body = "\(Money.format(amount, currency)). The wait is over: buy it, or skip and save."
        content.categoryIdentifier = Category.reask
        content.userInfo = ["check": checkId]
        let parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        try? await center.add(UNNotificationRequest(identifier: "reask-\(checkId)", content: content,
                                                    trigger: UNCalendarNotificationTrigger(dateMatching: parts, repeats: false)))
    }

    // MARK: Answers

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions { [.banner, .sound] }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        await MainActor.run { UsageClock.shared.touch() }
        if let tap = info["tap"] as? String {
            let planned: Bool? = action == Action.planned ? true : action == Action.impulse ? false : nil
            let food: String? = action == Action.staples ? "staples" : action == Action.luxury ? "luxury" : nil
            guard planned != nil || food != nil else { return }
            let ledger = await AppServices.ledgerForBackground()
            try? await ledger.answerTap(id: tap, planned: planned, food: food)
        } else if let check = info["check"] as? String, action == Action.buy || action == Action.skip {
            let status = action == Action.buy ? "bought" : "dropped"
            let ledger = await AppServices.ledgerForBackground()
            try? await ledger.backend.update("nx_decisions", id: check,
                                             ["purchase_status": status, "updated_at": ISO8601DateFormatter().string(from: Date())])
            await ledger.reload()
        } else if let link = info["link"] as? String {
            await MainActor.run { AppRouter.shared.handle(link: link) }
        } else if info["check"] != nil || info["tap"] != nil {
            await MainActor.run { AppRouter.shared.tab = .decide }
        }
    }
}

/// Reminders that repeat or follow your data: the Sunday review and renewals of recurring charges.
@MainActor
enum Reminders {
    /// Re-plans the Sunday review and the renewal reminders from the current settings and charges.
    static func sync(_ ledger: Ledger) {
        Task {
            guard await NotificationService.shared.permissionGranted() else { return }
            let center = UNUserNotificationCenter.current()
            let pending = await center.pendingNotificationRequests().map(\.identifier)
            center.removePendingNotificationRequests(withIdentifiers: pending.filter { $0.hasPrefix("renewal-") || $0 == "weekly-review" })

            if let weekly = ledger.decoded("review.weekly", as: WeeklyTime.self) {
                let content = UNMutableNotificationContent()
                content.title = "Sunday review, 10 minutes"
                content.body = "Clear the review queue, look at last week's decisions and add one rule."
                content.userInfo = ["link": "review"]
                var when = DateComponents()
                when.weekday = weekly.weekday
                when.hour = weekly.hour
                when.minute = weekly.minute
                try? await center.add(UNNotificationRequest(identifier: "weekly-review", content: content,
                                                            trigger: UNCalendarNotificationTrigger(dateMatching: when, repeats: true)))
            }

            // One renewal reminder a day at most, naming every charge that renews then; none on the review day.
            guard let lead = ledger.effectiveNumber("review.renewal_reminder_days"),
                  let perDay = ledger.effectiveNumber("notifications.max_per_day"), perDay >= 1 else { return }
            let weeklyDay = ledger.decoded("review.weekly", as: WeeklyTime.self)?.weekday
            var byDay: [String: [RecurringCharge]] = [:]
            for charge in ledger.recurring where charge.call != "cancel" || charge.status != "confirmed" {
                guard let due = charge.next_due.flatMap({ Day.date($0) }),
                      let remind = Calendar.current.date(byAdding: .day, value: -Int(lead), to: due), remind > Date() else { continue }
                byDay[Day.string(remind), default: []].append(charge)
            }
            for (day, charges) in byDay.sorted(by: { $0.key < $1.key }).prefix(30) {
                guard let date = Day.date(day), Calendar.current.component(.weekday, from: date) != weeklyDay else { continue }
                let content = UNMutableNotificationContent()
                content.title = charges.count == 1 ? "\(charges[0].label) renews in \(Int(lead)) days" : "\(charges.count) charges renew in \(Int(lead)) days"
                content.body = charges.map { c in c.amount.map { "\(c.label) \(Money.format($0, ledger.baseCurrency))" } ?? c.label }
                    .joined(separator: ", ")
                content.userInfo = ["link": "purchases"]
                var when = Calendar.current.dateComponents([.year, .month, .day], from: date)
                when.hour = ledger.decoded("review.weekly", as: WeeklyTime.self)?.hour
                try? await center.add(UNNotificationRequest(identifier: "renewal-\(day)", content: content,
                                                            trigger: UNCalendarNotificationTrigger(dateMatching: when, repeats: false)))
            }
        }
    }

    /// New stop-list alerts as one notification, at most notifications.max_per_day a day.
    static func notifyAlerts(_ alerts: [AlertItem], maxPerDay: Int) async {
        let defaults = UserDefaults.standard
        let today = Day.string(Date())
        let sentKey = "nx.alerts.sent.\(today)"
        let seenKey = "nx.alerts.notified"
        var notified = Set(defaults.stringArray(forKey: seenKey) ?? [])
        let fresh = alerts.filter { $0.seen_at == nil && !notified.contains($0.id) }
        guard !fresh.isEmpty, defaults.integer(forKey: sentKey) < maxPerDay,
              await NotificationService.shared.permissionGranted() else { return }
        let content = UNMutableNotificationContent()
        content.title = fresh.count == 1 ? fresh[0].title : "\(fresh.count) stop-list alerts"
        content.body = fresh.count == 1 ? (fresh[0].detail ?? "") : fresh.map(\.title).joined(separator: "; ")
        content.userInfo = ["link": "home"]
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "alerts-\(today)", content: content, trigger: nil))
        defaults.set(defaults.integer(forKey: sentKey) + 1, forKey: sentKey)
        notified.formUnion(fresh.map(\.id))
        defaults.set(Array(notified), forKey: seenKey)
    }
}

/// Minutes spent in Nexuslive per week, kept on this phone, for the seven-number card
/// (the guardrail: success is fewer minutes, not more).
@MainActor
final class UsageClock {
    static let shared = UsageClock()
    private var started: Date?
    private let defaults = UserDefaults.standard

    private func weekKey(_ date: Date = Date()) -> String {
        let c = Calendar(identifier: .iso8601).dateComponents([.yearForWeekOfYear, .weekOfYear], from: date)
        return "nx.usage.\(c.yearForWeekOfYear ?? 0)-\(c.weekOfYear ?? 0)"
    }

    func start() { started = started ?? Date() }
    func touch() { start() }

    func stop() {
        guard let started else { return }
        let key = weekKey()
        defaults.set(defaults.double(forKey: key) + Date().timeIntervalSince(started), forKey: key)
        self.started = nil
    }

    var minutesThisWeek: Double {
        (defaults.double(forKey: weekKey()) + (started.map { Date().timeIntervalSince($0) } ?? 0)) / 60
    }
}
