import Foundation

/// The one answer of nx_glance: what Today, Slipping, A month and Assignment show.
/// The database works the figures out and words them, and the web look-through reads the same
/// function, so the phone only draws what it is given.
struct Glance: Decodable {
    let version: Int
    let as_of: String
    let data_through: String?
    let currency: String?
    let web_url: String?
    let today: Today
    let slipping: Slipping
    let month: Month?
    let assignment: Assignment?
    let review: Review

    struct Slice: Decodable, Identifiable {
        let key: String
        let label: String
        let amount: Double
        var id: String { key }
    }

    /// A row that is off your own plan or rule. `action`, `link` and `due` are set when there is something to do.
    struct Item: Decodable, Identifiable {
        let key: String
        let title: String
        let now: String
        let short: String
        let detail: String
        let action: String?
        let link: String?
        let due: String?
        var id: String { key }
    }

    struct Better: Decodable, Identifiable {
        let key: String
        let title: String
        let detail: String
        var id: String { key }
    }

    struct Today: Decodable {
        let hold: Double
        let tax: Double
        let yours: Double
        let caption: String
        let slices: [Slice]
        let next: Item?
        let slipping_count: Int
    }

    struct Slipping: Decodable {
        let items: [Item]
        let shown: Int
        let better: [Better]
    }

    struct MonthMode: Decodable {
        let living: Double
        let left: Double
        let short: Double?
        let line: String?
    }

    struct Month: Decodable {
        let title: String
        let billed: Double
        let tax: Double
        let business: Double
        let target: Double?
        let now: MonthMode
        let budget: MonthMode
    }

    struct Tile: Decodable, Identifiable {
        let value: String?
        let label: String
        var id: String { label }
    }

    struct Assignment: Decodable {
        let question: String
        let answer: String
        let reason: String
        let tiles: [Tile]
        let end_date: String?
        let end_line: String?
    }

    /// What the Sunday review saves: cash and what you are owed, the broker, and the tax you owe.
    struct Snapshot: Decodable {
        let cash: Double
        let investments: Double
        let liabilities: Double
        let total: Double
        let currency: String?
    }

    struct Review: Decodable {
        let next: String?
        let snapshot_date: String?
        let moved: Double?
        let snapshot: Snapshot
    }
}

/// One arc of a ring: where it starts and ends as a share of the full turn, from the top.
struct RingArc: Identifiable {
    let key: String
    let label: String
    let amount: Double
    let from: Double
    let to: Double
    var id: String { key }
}

enum GlanceMath {
    /// Arcs for the amounts above zero, in the order given, together one full turn.
    static func arcs(_ slices: [Glance.Slice]) -> [RingArc] {
        let shown = slices.filter { $0.amount > 0 }
        let total = shown.reduce(0) { $0 + $1.amount }
        guard total > 0 else { return [] }
        var at = 0.0
        var out: [RingArc] = []
        for (index, slice) in shown.enumerated() {
            let start = at
            at = index == shown.count - 1 ? 1 : at + slice.amount / total
            out.append(RingArc(key: slice.key, label: slice.label, amount: slice.amount, from: start, to: at))
        }
        return out
    }

    /// An average month as the ring draws it: tax, business costs, living and what is left.
    /// Living never fills more than the month leaves, and a shortfall draws nothing.
    static func monthSlices(_ month: Glance.Month, onBudget: Bool) -> [Glance.Slice] {
        let mode = onBudget ? month.budget : month.now
        let net = max(month.billed - month.tax - month.business, 0)
        return [
            Glance.Slice(key: "tax", label: "Tax", amount: month.tax),
            Glance.Slice(key: "business", label: "Business costs", amount: month.business),
            Glance.Slice(key: "living", label: "Living", amount: min(mode.living, net)),
            Glance.Slice(key: "left", label: "Left to invest", amount: max(mode.left, 0)),
        ]
    }

    /// The same month as the rows under the ring read it: the real amounts, a shortfall included.
    static func monthLegend(_ month: Glance.Month, onBudget: Bool) -> [Glance.Slice] {
        let mode = onBudget ? month.budget : month.now
        return [
            Glance.Slice(key: "tax", label: "Tax", amount: month.tax),
            Glance.Slice(key: "business", label: "Business costs", amount: month.business),
            Glance.Slice(key: "living", label: onBudget ? "Living, on budget" : "Living, as now", amount: mode.living),
            Glance.Slice(key: "left", label: "Left to invest", amount: mode.left),
        ]
    }

    /// The first rows the phone shows, and how many are left for the web look-through.
    static func shown(_ slipping: Glance.Slipping) -> (rows: [Glance.Item], rest: Int) {
        let rows = Array(slipping.items.prefix(max(slipping.shown, 0)))
        return (rows, slipping.items.count - rows.count)
    }

    /// Where the forecasts start: what is yours on Today, with the server's sentence about an
    /// account it could not count when there is one.
    static func netWorth(_ glance: Glance) -> (total: Double, note: String?) {
        (glance.today.yours, glance.slipping.items.first { $0.key == "not_counted" }?.detail)
    }

    /// The address of a page of the web app, when the server names one.
    static func webURL(_ base: String?, path: String, topic: String? = nil) -> URL? {
        guard let base, base.hasPrefix("https://"), var parts = URLComponents(string: base) else { return nil }
        let root = parts.path.hasSuffix("/") ? String(parts.path.dropLast()) : parts.path
        parts.path = root + path
        if let topic { parts.queryItems = [URLQueryItem(name: "topic", value: topic)] }
        return parts.url
    }
}
