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

    var isRule: Bool { kind == "rule" }
    var isOpenBet: Bool { kind == "bet" && outcome == nil }
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
