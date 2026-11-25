import Foundation

/// An order email, Apple receipt or receipt photo the spend function read.
struct Receipt: Codable, Identifiable {
    let id: String
    let source: String
    let kind: String
    let merchant: String?
    let total: Double?
    let currency: String?
    let order_date: String?
    let received_at: String
    let txn_id: String?
    let match_status: String
}

/// A recurring charge with the review call you made (or the suggestion while you have not).
struct RecurringCharge: Codable, Identifiable {
    let id: String
    let key: String
    let label: String
    let category: String?
    let source: String
    let cadence: String
    let amount: Double?
    let per_year: Double?
    let charges: Int
    let paid_this_year: Double
    let last_charge: String?
    let next_due: String?
    let ends_on: String?
    let proposed_call: String?
    let call: String?
    let tag: String?
    let cancel_by: String?
    let status: String?
    let note: String?

    var perMonth: Double { (per_year ?? 0) / 12 }
    var isCut: Bool { call == "cancel" }
    var shownCall: String? { call ?? proposed_call }
}

/// Where a recurring charge is cancelled; the first route by priority whose pattern matches wins.
struct CancelRoute: Codable, Identifiable {
    let id: String
    let priority: Int
    let pattern: String
    let label: String
    let route: String
    let url: String?
    let steps: String?
    let trap: String?
    let notice_to: String?

    func matches(_ text: String) -> Bool { Amounts.matches(text, pattern: pattern) }
}

/// A stop list: shops that are not allowed from a date, set as stop.<name>_pattern and
/// stop.<name>_from. Its alerts carry the name as their kind.
struct StopList: Identifiable, Equatable {
    let name: String
    let pattern: String
    let from: String
    var id: String { name }
    var label: String {
        let words = name.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// Every stop.<name>_pattern with a stop.<name>_from beside it. A pattern without a start
    /// date (stop.apple_line_pattern) is not a stop list.
    static func all(in settings: [String: String]) -> [StopList] {
        settings.compactMap { key, pattern -> StopList? in
            guard key.hasPrefix("stop."), key.hasSuffix("_pattern"), !pattern.isEmpty else { return nil }
            let name = String(key.dropFirst("stop.".count).dropLast("_pattern".count))
            guard !name.isEmpty, name.allSatisfy({ $0.isLowercase || $0.isNumber || $0 == "_" }),
                  let from = settings["stop.\(name)_from"], !from.isEmpty else { return nil }
            return StopList(name: name, pattern: pattern, from: from)
        }
        .sorted { $0.name < $1.name }
    }
}

/// A same-day alert: a charge on a stop list, an Apple charge outside the allowed list, a charge after a cancel.
struct AlertItem: Codable, Identifiable {
    let id: String
    let kind: String
    let title: String
    let detail: String?
    let txn_id: String?
    let created_at: String
    let seen_at: String?
}

/// An Apple Pay tap logged by the Shortcuts Wallet automation.
struct WalletTap: Codable, Identifiable {
    let id: String
    let tapped_at: String
    let merchant: String
    let amount: Double?
    let currency: String
    let card: String?
    let planned: Bool?
    let food: String?
    let txn_id: String?
}

struct CloseVat: Codable {
    let period: String
    let payable: Double?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        period = try c.decode(String.self, forKey: .period)
        if let n = try? c.decode(Double.self, forKey: .payable) { payable = n }
        else { payable = (try? c.decode(String.self, forKey: .payable)).flatMap(Double.init) }
    }
}

struct CloseFigures: Codable {
    let month: String
    let business_costs_eur: Double
    let business_costs_with_invoice_eur: Double
    let invoice_coverage_pct: Double?
    let lines: Int
    let lines_open: Int
    let food_lines: Int
    let food_lines_with_receipt: Int
    let vat: CloseVat?
}

struct CloseArchive: Codable {
    let folder_id: String?
    let files: Int?
}

struct MonthClose: Codable, Identifiable {
    let id: String
    let month: String
    let figures: CloseFigures
    let archive: CloseArchive?
    let closed_at: String
}

/// The two numbers of the seven-number card that need the books (nx_measures).
struct ServerMeasures: Codable {
    let invoice_value_with: Double
    let invoice_value_all: Double
    let invoice_coverage_pct: Double?
    let untagged_older: Int
    let untagged_days: Int
}

/// The v2 mailbox (order emails and Apple receipts) as the spend function reports it.
struct MailboxStatus: Codable {
    let google_ready: Bool
    let connected: Bool
    let status: String
    let account: String?
    let last_error: String?
    let last_read_at: String?
    let redirect_url: String?
}

/// A bank line waiting for a category in the Sunday review.
struct ReviewLine: Codable, Identifiable {
    let id: String
    let booked_on: String
    let amount: Double
    let currency: String
    let merchant: String?
    let payee: String?
    let category: String
    let txClass: String
    let review_status: String

    enum CodingKeys: String, CodingKey {
        case id, booked_on, amount, currency, merchant, payee, category, review_status
        case txClass = "class"
    }

    var shop: String { merchant ?? payee ?? "Unknown shop" }
}

/// A slider's range from a setting such as {"min": 0, "max": 6, "step": 0.1}.
struct SliderRange: Codable, Equatable {
    let min: Double
    let max: Double
    let step: Double

    var closed: ClosedRange<Double> { min...Swift.max(min, max) }
    func clamp(_ value: Double) -> Double { Swift.min(Swift.max(value, min), max) }
}

/// The targets on the seven-number card (measures.targets).
struct MeasureTargets: Codable {
    let invoice_coverage_pct: Double
    let untagged_older: Double
    let buy_check_pct: Double
    let hidden_eur_month: Double
    let minutes_week: Double
}

/// The Sunday reminder time (review.weekly); weekday 1 is Sunday.
struct WeeklyTime: Codable {
    let weekday: Int
    let hour: Int
    let minute: Int
}

/// One month on the spend chart: what was spent in the budgeted classes and the plan's caps then.
struct MonthSpend: Identifiable, Equatable {
    let month: Date
    let spent: Double
    let cap: Double
    var id: Date { month }
}
