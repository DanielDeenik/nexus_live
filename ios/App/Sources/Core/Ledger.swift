import Foundation

/// Everything the three tabs show, loaded from Supabase "Nexus Decision".
@MainActor
final class Ledger: ObservableObject {
    @Published var expenses: [Expense] = []
    @Published var decisions: [Decision] = []
    @Published var budgets: [Budget] = []
    @Published var positions: [Position] = []
    @Published var netWorth: [NetWorth] = []
    @Published var baseCurrency: String = Locale.current.currency?.identifier ?? "EUR"
    @Published var error: String?
    @Published var loading = false

    let backend: Backend

    init(backend: Backend) {
        self.backend = backend
    }

    func reload() async {
        guard let uid = backend.userId else { return }
        loading = true
        defer { loading = false }
        do {
            let profiles: [Profile] = try await backend.select("profiles", "select=id,base_currency&id=eq.\(uid)")
            if let currency = profiles.first?.base_currency, !currency.isEmpty { baseCurrency = currency }
            let since = Day.string(Calendar.current.date(byAdding: .month, value: -3, to: Day.monthStart()) ?? Date())
            expenses = try await backend.select("expenses",
                "select=id,amount,currency,category,date,description,vendor,status,source&date=gte.\(since)&status=neq.rejected&order=date.desc,created_at.desc")
            decisions = try await backend.select("nx_decisions", "select=*&order=created_at.desc")
            budgets = try await backend.select("nx_budgets", "select=id,category,monthly_amount,currency,valid_from&order=category.asc,valid_from.desc")
            positions = try await backend.select("nx_positions", "select=id,source,symbol,units,value,currency,pnl,as_of&order=value.desc.nullslast")
            netWorth = try await backend.select("nx_net_worth_snapshots", "select=id,as_of,cash,investments,liabilities,total,currency&order=as_of.desc&limit=12")
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: Derived

    /// The newest budget per category.
    var currentBudgets: [Budget] {
        var seen = Set<String>()
        return budgets.filter { seen.insert($0.category).inserted }
    }

    var categories: [String] {
        var seen = Set<String>()
        let ordered = currentBudgets.map(\.category) + expenses.map(\.category)
        return ordered.filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    var thisMonth: [Expense] {
        let start = Day.string(Day.monthStart())
        return expenses.filter { $0.date >= start }
    }

    func spent(in category: String) -> Double {
        thisMonth.filter { $0.category == category && $0.currency == baseCurrency }.reduce(0) { $0 + $1.amount }
    }

    var spentThisMonth: Double {
        thisMonth.filter { $0.currency == baseCurrency }.reduce(0) { $0 + $1.amount }
    }

    var rules: [Decision] { decisions.filter(\.isRule) }
    var openBets: [Decision] {
        decisions.filter(\.isOpenBet).sorted { ($0.resolve_by ?? "9999") < ($1.resolve_by ?? "9999") }
    }
    var resolvedBets: [Decision] { decisions.filter { $0.kind == "bet" && $0.outcome != nil } }
    var meanBrier: Double? {
        let scores = resolvedBets.compactMap(\.brier)
        return scores.isEmpty ? nil : scores.reduce(0, +) / Double(scores.count)
    }

    // MARK: Writes

    func addExpense(amount: Double, category: String, date: Date, note: String?) async throws {
        _ = try await backend.rpc("nx_add_expense", [
            "p_amount": amount,
            "p_currency": baseCurrency,
            "p_category": category,
            "p_date": Day.string(date),
            "p_description": orNull(note)
        ])
        await reload()
    }

    func importExpenses(_ rows: [[String: Any]]) async throws -> Int {
        var added = 0
        var start = 0
        let chunk = 200
        while start < rows.count {
            let slice = Array(rows[start..<min(start + chunk, rows.count)])
            let result = try await backend.rpc("nx_import_expenses", ["p_rows": slice])
            added += (result as? NSNumber)?.intValue ?? 0
            start += chunk
        }
        await reload()
        return added
    }

    func addRule(area: String?, condition: String, then: String, otherwise: String?) async throws {
        try await backend.insert("nx_decisions", [
            "kind": "rule",
            "area": orNull(area),
            "if_condition": condition,
            "then_action": then,
            "else_action": orNull(otherwise)
        ])
        await reload()
    }

    func setRuleActive(_ rule: Decision, _ active: Bool) async throws {
        try await backend.update("nx_decisions", id: rule.id, ["active": active, "updated_at": ISO8601DateFormatter().string(from: Date())])
        await reload()
    }

    func addBet(area: String?, statement: String, probability: Double, resolveBy: Date) async throws {
        try await backend.insert("nx_decisions", [
            "kind": "bet",
            "area": orNull(area),
            "statement": statement,
            "probability": probability,
            "resolve_by": Day.string(resolveBy)
        ])
        await reload()
    }

    func resolve(_ bet: Decision, outcome: Bool) async throws {
        let now = ISO8601DateFormatter().string(from: Date())
        try await backend.update("nx_decisions", id: bet.id, ["outcome": outcome, "resolved_at": now, "updated_at": now])
        await reload()
    }

    func delete(_ decision: Decision) async throws {
        try await backend.delete("nx_decisions", id: decision.id)
        await reload()
    }

    func setBudget(category: String, amount: Double) async throws {
        try await backend.upsert("nx_budgets", [
            "category": category,
            "monthly_amount": amount,
            "currency": baseCurrency,
            "valid_from": Day.string(Day.monthStart())
        ], onConflict: "user_id,category,valid_from")
        await reload()
    }

    func addNetWorth(cash: Double, investments: Double, liabilities: Double) async throws {
        try await backend.upsert("nx_net_worth_snapshots", [
            "as_of": Day.string(Date()),
            "cash": cash,
            "investments": investments,
            "liabilities": liabilities,
            "currency": baseCurrency
        ], onConflict: "user_id,as_of")
        await reload()
    }
}

/// JSON null for a missing optional text, so PostgREST stores NULL.
private func orNull(_ text: String?) -> Any {
    guard let text, !text.isEmpty else { return NSNull() }
    return text
}
