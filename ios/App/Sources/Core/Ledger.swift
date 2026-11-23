import Foundation

/// Everything the three tabs show, loaded from Supabase "Nexus Decision".
/// Thresholds, classes and windows come from app_config (keys purchase.* and budget.*), never from code.
@MainActor
final class Ledger: ObservableObject {
    @Published var expenses: [Expense] = []
    @Published var transactions: [Transaction] = []
    @Published var decisions: [Decision] = []
    @Published var budgets: [Budget] = []
    @Published var positions: [Position] = []
    @Published var netWorth: [NetWorth] = []
    @Published var settings: [String: String] = [:]
    @Published var summary: MoneySummary?
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
            let config: [ConfigEntry] = try await backend.select("app_config",
                "select=key,value&or=(key.like.purchase.*,key.like.budget.*)")
            settings = Dictionary(config.map { ($0.key, $0.value) }, uniquingKeysWith: { first, _ in first })

            let months = averageMonths ?? 0
            let since = Day.string(Calendar.current.date(byAdding: .month, value: -months, to: Day.monthStart()) ?? Date())
            let classes = spendClasses.sorted().joined(separator: ",")
            if classes.isEmpty {
                transactions = []
            } else {
                transactions = try await selectAll("nx_transactions",
                    "select=id,booked_on,amount,currency,merchant,category,class,rail,review_status,decision_id&booked_on=gte.\(since)&class=in.(\(classes))&order=booked_on.desc,created_at.desc,id.desc")
            }
            expenses = try await backend.select("expenses",
                "select=id,amount,currency,category,date,description,vendor,status,source&date=gte.\(since)&status=neq.rejected&order=date.desc,created_at.desc")
            decisions = try await backend.select("nx_decisions", "select=*&order=created_at.desc")
            budgets = try await backend.select("nx_budgets", "select=id,category,monthly_amount,currency,valid_from&order=category.asc,valid_from.desc")
            positions = try await backend.select("nx_positions", "select=id,source,symbol,units,value,currency,pnl,as_of&order=value.desc.nullslast")
            netWorth = try await backend.select("nx_net_worth_snapshots", "select=id,as_of,cash,investments,liabilities,total,currency&order=as_of.desc&limit=12")
            let raw = try await backend.rpc("nx_money_summary", [:])
            summary = try JSONDecoder().decode(MoneySummary.self, from: JSONSerialization.data(withJSONObject: raw))
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// PostgREST caps one response at the project's max rows, so this keeps reading with an offset
    /// until a page comes back empty. The query needs a complete order for the pages to line up.
    private func selectAll<T: Decodable>(_ table: String, _ query: String) async throws -> [T] {
        var all: [T] = []
        while true {
            let page: [T] = try await backend.select(table, query + "&offset=\(all.count)")
            if page.isEmpty { return all }
            all += page
        }
    }

    // MARK: Settings

    func number(_ key: String) -> Double? { settings[key].flatMap { Double($0) } }

    func list(_ key: String) -> [String] {
        guard let data = settings[key]?.data(using: .utf8),
              let values = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return values
    }

    var averageMonths: Int? { number("budget.average_months").map { Int($0) } }
    var spendClasses: Set<String> { Set(list("budget.spend_classes")) }
    var hiddenClasses: Set<String> { Set(list("budget.hidden_classes")) }
    var plannedClasses: Set<String> { Set(list("budget.planned_classes")) }

    // MARK: Budgets

    /// The newest budget per category.
    var currentBudgets: [Budget] {
        var seen = Set<String>()
        return budgets.filter { seen.insert($0.category).inserted }
    }

    /// Categories to budget: current budgets first, then anything spent on.
    var categories: [String] {
        var seen = Set<String>()
        let ordered = currentBudgets.map(\.category) + transactions.map(\.category)
        return ordered.filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    /// Categories used for business expenses in the Log tab.
    var expenseCategories: [String] {
        var seen = Set<String>()
        return expenses.map(\.category).filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    private var monthStartString: String { Day.string(Day.monthStart()) }

    var thisMonth: [Transaction] {
        transactions.filter { $0.booked_on >= monthStartString && $0.currency == baseCurrency }
    }

    func spent(in category: String) -> Double {
        thisMonth.filter { $0.category == category }.reduce(0) { $0 + $1.outflow }
    }

    var spentThisMonth: Double { thisMonth.reduce(0) { $0 + $1.outflow } }

    var hiddenThisMonth: Double {
        thisMonth.filter { hiddenClasses.contains($0.txClass) }.reduce(0) { $0 + $1.outflow }
    }

    /// Monthly average over the last full months, for the comparison next to each budget.
    func average(in category: String) -> Double? {
        guard let months = averageMonths, months > 0,
              let start = Calendar.current.date(byAdding: .month, value: -months, to: Day.monthStart()) else { return nil }
        let from = Day.string(start)
        let total = transactions
            .filter { $0.category == category && $0.booked_on >= from && $0.booked_on < monthStartString && $0.currency == baseCurrency }
            .reduce(0) { $0 + $1.outflow }
        return total / Double(months)
    }

    func budget(for category: String) -> Budget? { currentBudgets.first { $0.category == category } }

    func budgetLeft(in category: String) -> Double? {
        budget(for: category).map { $0.monthly_amount - spent(in: category) }
    }

    /// Categories with spending this month and no budget yet, largest first.
    var unbudgetedThisMonth: [CategorySpend] {
        let budgeted = Set(currentBudgets.map(\.category))
        var totals: [String: Double] = [:]
        for line in thisMonth where !budgeted.contains(line.category) {
            totals[line.category, default: 0] += line.outflow
        }
        return totals.map { CategorySpend(category: $0.key, spent: $0.value) }.sorted { $0.spent > $1.spent }
    }

    /// Business expenses logged this month in the Log tab.
    var businessExpensesThisMonth: Double {
        expenses.filter { $0.date >= monthStartString && $0.currency == baseCurrency }.reduce(0) { $0 + $1.amount }
    }

    /// Purchases from the small threshold that no Buy check explains.
    var unplannedThisMonth: [Transaction] {
        guard let small = number("purchase.small_below"), let tolerance = number("purchase.match_tolerance_pct") else { return [] }
        var bought = purchaseChecks.filter { $0.purchase_status == "bought" && ($0.created_at >= monthStartString) }
        return thisMonth.filter { line in
            guard plannedClasses.contains(line.txClass), line.outflow >= small, line.decision_id == nil else { return false }
            if let index = bought.firstIndex(where: { check in
                guard let amount = check.amount, amount > 0 else { return false }
                return abs(line.outflow - amount) / amount * 100 <= tolerance
            }) {
                bought.remove(at: index)
                return false
            }
            return true
        }
    }

    // MARK: Decisions

    var rules: [Decision] { decisions.filter(\.isRule) }
    var openBets: [Decision] {
        decisions.filter(\.isOpenBet).sorted { ($0.resolve_by ?? "9999") < ($1.resolve_by ?? "9999") }
    }
    var resolvedBets: [Decision] { decisions.filter(\.isResolvedBet) }
    var meanBrier: Double? {
        let scores = resolvedBets.compactMap(\.brier)
        return scores.isEmpty ? nil : scores.reduce(0, +) / Double(scores.count)
    }

    var purchaseChecks: [Decision] { decisions.filter(\.isPurchase) }
    var waitingPurchases: [Decision] { purchaseChecks.filter { $0.purchase_status == "waiting" } }
    var decidedPurchases: [Decision] { purchaseChecks.filter { $0.purchase_status == "bought" || $0.purchase_status == "dropped" } }
    var keptThisMonth: Double {
        purchaseChecks.filter { $0.purchase_status == "dropped" && $0.created_at >= monthStartString }
            .reduce(0) { $0 + ($1.amount ?? 0) }
    }

    /// small, considered or major, from purchase.small_below and purchase.major_from.
    func tier(for amount: Double) -> String? {
        guard let small = number("purchase.small_below"), let major = number("purchase.major_from") else { return nil }
        if amount < small { return "small" }
        return amount < major ? "considered" : "major"
    }

    func waitUntil(for tier: String, from start: Date = Date()) -> Date? {
        switch tier {
        case "considered":
            return number("purchase.considered_wait_hours").map { start.addingTimeInterval($0 * 3600) }
        case "major":
            return number("purchase.major_wait_days").flatMap { Calendar.current.date(byAdding: .day, value: Int($0), to: start) }
        default:
            return start
        }
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

    /// Sends raw bank lines to nx_import_transactions in batches that never split a day,
    /// so identical lines on one day keep their numbering and re-imports add nothing twice.
    func importTransactions(_ rows: [[String: Any]]) async throws -> ImportSummary {
        guard let limit = number("budget.import_batch_rows").map({ Int($0) }), limit > 0 else {
            throw BudgetError.missingSetting("budget.import_batch_rows")
        }
        let sorted = rows.sorted { ($0["date"] as? String ?? "") < ($1["date"] as? String ?? "") }
        var batches: [[[String: Any]]] = []
        var batch: [[String: Any]] = []
        var lastDate = ""
        for row in sorted {
            let date = row["date"] as? String ?? ""
            if batch.count >= limit && date != lastDate {
                batches.append(batch)
                batch = []
            }
            batch.append(row)
            lastDate = date
        }
        if !batch.isEmpty { batches.append(batch) }

        var summary = ImportSummary()
        for part in batches {
            let result = try await backend.rpc("nx_import_transactions", ["p_rows": part])
            guard let json = result as? [String: Any] else { throw APIError.badResponse }
            summary.add(json)
        }
        await reload()
        return summary
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

    /// Logs a Buy check: the tier and the end of the wait come from app_config; a usage bet is added
    /// when `useProbability` is given (Major purchases and new subscriptions).
    func addPurchaseCheck(item: String, amount: Double, category: String, business: Bool,
                          alternative: String?, useProbability: Double?) async throws {
        guard let tier = tier(for: amount) else { throw BudgetError.missingSetting("purchase.small_below or purchase.major_from") }
        guard let wait = waitUntil(for: tier) else { throw BudgetError.missingSetting("purchase wait for \(tier)") }
        var row: [String: Any] = [
            "kind": "purchase",
            "area": "Purchases",
            "statement": item,
            "amount": amount,
            "currency": baseCurrency,
            "category": category,
            "scope": business ? "business" : "personal",
            "tier": tier,
            "wait_until": ISO8601DateFormatter().string(from: wait),
            "purchase_status": "waiting",
            "else_action": orNull(alternative)
        ]
        if let useProbability {
            guard let days = number("purchase.use_bet_days"),
                  let due = Calendar.current.date(byAdding: .day, value: Int(days), to: Date()) else {
                throw BudgetError.missingSetting("purchase.use_bet_days")
            }
            row["probability"] = useProbability
            row["resolve_by"] = Day.string(due)
        }
        try await backend.insert("nx_decisions", row)
        await reload()
    }

    func setPurchase(_ check: Decision, status: String) async throws {
        try await backend.update("nx_decisions", id: check.id,
                                 ["purchase_status": status, "updated_at": ISO8601DateFormatter().string(from: Date())])
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
