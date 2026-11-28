// Checks for the Subscriptions list: which page Manage and Cancel open, and which group a
// subscription sits in, on made-up charges and routes.
import Foundation

func subscriptionChecks() {
    func route(_ id: String, _ priority: Int, _ pattern: String, route: String = "web", url: String?, manage: String?) -> CancelRoute {
        CancelRoute(id: id, priority: priority, pattern: pattern, label: id, route: route, url: url, steps: nil, trap: nil,
                    notice_to: nil, manage_url: manage)
    }
    func charge(_ label: String, paidFrom: String? = nil, onBunq: Bool? = nil, billing: String? = nil,
                endsOn: String? = nil, call: String? = nil, status: String? = nil) -> RecurringCharge {
        RecurringCharge(id: label, key: label.lowercased(), label: label, category: nil, source: "manual", cadence: "monthly",
                        amount: 9.99, per_year: 119.88, charges: 3, paid_this_year: 29.97, last_charge: "2026-11-01",
                        next_due: "2026-12-01", ends_on: endsOn, proposed_call: nil, call: call, tag: nil, cancel_by: nil,
                        status: status, note: nil, paying_account: nil, billing_status: billing, evidence: nil,
                        paid_from: paidFrom, on_bunq: onBunq)
    }
    let routes = [
        route("any", 900, ".", route: "bank", url: "https://bank.example", manage: nil),
        route("board", 20, "boardly", url: "https://help.boardly.example/cancel", manage: "https://boardly.example/billing"),
        route("store", 10, "appstore", route: "apple", url: "https://store.example/subscriptions", manage: nil),
        route("broken", 30, "notes", url: "not a url", manage: ""),
    ]

    let board = Subscriptions.links(for: charge("Boardly Business"), routes: routes)
    check("Manage opens the account page of the first route that matches", board.manage?.absoluteString == "https://boardly.example/billing")
    check("Cancel opens the cancel page of that route", board.cancel?.absoluteString == "https://help.boardly.example/cancel" && !board.cancelAtBank)

    let store = Subscriptions.links(for: charge("APPSTORE.COM/BILL"), routes: routes)
    check("a store route without an account page manages where it cancels", store.manage?.absoluteString == "https://store.example/subscriptions")

    let other = Subscriptions.links(for: charge("Some gym"), routes: routes)
    check("with only the catch-all bank route there is no account page", other.manage == nil)
    check("with only the catch-all bank route Cancel means blocking it at the bank", other.cancelAtBank && other.cancel?.absoluteString == "https://bank.example")

    let broken = Subscriptions.links(for: charge("Notes app"), routes: routes)
    check("a route with a text that is no web address opens nothing", broken.manage == nil && broken.cancel == nil)

    let none = Subscriptions.links(for: charge("Anything"), routes: [])
    check("no routes, no buttons", none.manage == nil && none.cancel == nil && !none.cancelAtBank)

    let today = "2026-11-28"
    check("a subscription paid from bunq goes to the bunq group", Subscriptions.group(charge("A", onBunq: true), today: today) == .onBunq)
    check("a subscription paid elsewhere is active", Subscriptions.group(charge("B", paidFrom: "ABN AMRO 0338", onBunq: false), today: today) == .active)
    check("a cancelled subscription has ended, even on bunq", Subscriptions.group(charge("C", onBunq: true, billing: "cancelled"), today: today) == .ended)
    check("an end date in the past means it has ended", Subscriptions.group(charge("D", endsOn: "2026-11-19"), today: today) == .ended)
    check("an end date ahead still runs", Subscriptions.group(charge("E", endsOn: "2027-01-31"), today: today) == .active)
    check("a cancel you confirmed has ended", Subscriptions.group(charge("F", call: "cancel", status: "confirmed"), today: today) == .ended)
    check("a failing payment is flagged", Subscriptions.isFailing(charge("G", billing: "failing")) && !Subscriptions.isFailing(charge("H")))
    check("the paying account shows, or says it is not known", Subscriptions.paidFrom(charge("I", paidFrom: "Amex")) == "Amex"
          && Subscriptions.paidFrom(charge("J")) == "Account not known")
}
