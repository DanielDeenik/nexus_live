import Foundation

struct Profile: Codable {
    let id: String
    let base_currency: String?
}

struct Expense: Codable, Identifiable {
    let id: String
    let amount: Double
    let currency: String
    let category: String
    let date: String
    let description: String?
    let vendor: String?
    let status: String
    let source: String?
}

/// One bank line from nx_transactions. Money out is negative; `outflow` flips it for budgets.
struct Transaction: Codable, Identifiable {
    let id: String
    let booked_on: String
    let amount: Double
    let currency: String
    let merchant: String?
    let category: String
    let txClass: String
    let rail: String?
    let review_status: String
    let decision_id: String?

    enum CodingKeys: String, CodingKey {
        case id, booked_on, amount, currency, merchant, category, rail, review_status, decision_id
        case txClass = "class"
    }

    var outflow: Double { -amount }
}

struct Decision: Codable, Identifiable {
    let id: String
    let kind: String
    let area: String?
    let if_condition: String?
    let then_action: String?
    let else_action: String?
    let statement: String?
    let probability: Double?
    let resolve_by: String?
    let outcome: Bool?
    let resolved_at: String?
    let brier: Double?
    let active: Bool
    let created_at: String
    let amount: Double?
    let currency: String?
    let category: String?
    let scope: String?
    let tier: String?
    let wait_until: String?
    let purchase_status: String?

    var isRule: Bool { kind == "rule" }
    var isPurchase: Bool { kind == "purchase" }
    /// A bet, or a bought purchase whose "I use it weekly" bet is still open.
    var isOpenBet: Bool {
        guard outcome == nil else { return false }
        return kind == "bet" || (isPurchase && probability != nil && purchase_status == "bought")
    }
    var isResolvedBet: Bool { (kind == "bet" || isPurchase) && outcome != nil && probability != nil }
}

struct Budget: Codable, Identifiable {
    let id: String
    let category: String
    let monthly_amount: Double
    let currency: String
    let valid_from: String
}

struct Position: Codable, Identifiable {
    let id: String
    let source: String
    let symbol: String?
    let units: Double?
    let value: Double?
    let currency: String?
    let pnl: Double?
    let as_of: String
}

struct NetWorth: Codable, Identifiable {
    let id: String
    let as_of: String
    let cash: Double?
    let investments: Double?
    let liabilities: Double?
    let total: Double?
    let currency: String
}

struct CategorySpend: Identifiable {
    let category: String
    let spent: Double
    var id: String { category }
}

struct ConfigEntry: Codable {
    let key: String
    let value: String
}

struct AccountBalance: Codable, Identifiable {
    let label: String
    let source: String
    let account: String
    let kind: String
    let balance: Double
    let last_booked: String?
    var id: String { source + account }
}

/// Cash across accounts, the tax reserve and fixed costs still due, from nx_money_summary.
struct MoneySummary: Codable {
    let as_of: String?
    let cash: Double
    let accounts: [AccountBalance]
    let tax_reserve: Double
    let tax_reserve_label: String
    let fixed_left: Double
    let safe_to_spend: Double
}

struct ImportSummary {
    var received = 0
    var inserted = 0
    var duplicates = 0
    var needsReview = 0

    mutating func add(_ json: [String: Any]) {
        received += (json["received"] as? NSNumber)?.intValue ?? 0
        inserted += (json["inserted"] as? NSNumber)?.intValue ?? 0
        duplicates += (json["duplicates"] as? NSNumber)?.intValue ?? 0
        needsReview += (json["needs_review"] as? NSNumber)?.intValue ?? 0
    }
}

enum BudgetError: LocalizedError {
    case missingSetting(String)

    var errorDescription: String? {
        switch self {
        case .missingSetting(let key): return "The setting \(key) is missing in app_config."
        }
    }
}

enum Day {
    static let isoDate: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func string(_ date: Date) -> String { isoDate.string(from: date) }
    static func date(_ string: String) -> Date? { isoDate.date(from: String(string.prefix(10))) }

    static func monthStart(_ date: Date = Date()) -> Date {
        Calendar.current.date(from: Calendar.current.dateComponents([.year, .month], from: date)) ?? date
    }

    static func timestamp(_ text: String?) -> Date? {
        guard let text else { return nil }
        let full = ISO8601DateFormatter()
        full.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = full.date(from: text) { return date }
        return ISO8601DateFormatter().date(from: text)
    }
}

enum Money {
    static func format(_ value: Double, _ currency: String) -> String {
        value.formatted(.currency(code: currency).precision(.fractionLength(0...2)))
    }

    /// Reads "12,50", "12.50", "1.234,56" or "1,234.56": the last separator is the decimal one.
    static func parse(_ raw: String) -> Double? {
        var text = raw.trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "\u{00A0}", with: "")
        var negative = false
        if text.hasPrefix("-") { negative = true; text.removeFirst() }
        else if text.hasPrefix("+") { text.removeFirst() }
        let lastComma = text.lastIndex(of: ",")
        let lastDot = text.lastIndex(of: ".")
        switch (lastComma, lastDot) {
        case let (comma?, dot?):
            if comma > dot {
                text = text.replacingOccurrences(of: ".", with: "").replacingOccurrences(of: ",", with: ".")
            } else {
                text = text.replacingOccurrences(of: ",", with: "")
            }
        case (_?, nil):
            text = text.replacingOccurrences(of: ",", with: ".")
        default:
            break
        }
        guard let value = Double(text) else { return nil }
        return negative ? -value : value
    }
}
