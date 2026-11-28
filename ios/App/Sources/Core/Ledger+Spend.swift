import Foundation

/// v2 on the ledger: your settings over the defaults, the Mallorca and forecast inputs, the spend
/// chart, the purchase review, Wallet taps, receipts, the Sunday review and the monthly close.
/// Every number comes from a setting or from your data; nothing is fixed in code.
extension Ledger {
    // MARK: Settings: yours (nx_user_settings) first, then the default (app_config)

    func effective(_ key: String) -> String? { userSettings[key] ?? settings[key] }
    func effectiveNumber(_ key: String) -> Double? { effective(key).flatMap { Double($0) } }

    func decoded<T: Decodable>(_ key: String, as type: T.Type = T.self) -> T? {
        guard let data = effective(key)?.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    func strings(_ key: String) -> [String] { decoded(key, as: [String].self) ?? [] }
    func range(_ key: String) -> SliderRange? { decoded(key, as: SliderRange.self) }
    var stopLists: [StopList] { StopList.all(in: settings.merging(userSettings) { _, yours in yours }) }

    var targetMonthly: Double? { effectiveNumber("target.monthly_income_eur") }
    var targetDate: Date? { effective("target.date").flatMap { Day.date($0) } }
    var growthPct: Double? { effectiveNumber("plan.business_growth_pct") }
    var returnPct: Double? { effectiveNumber("plan.return_real_pct") }
    var returnBand: Double { effectiveNumber("plan.return_band_pct") ?? 0 }
    var withdrawalPct: Double? { effectiveNumber("plan.withdrawal_rate_pct") }
    var forecastYears: Int? { effectiveNumber("plan.forecast_years").map { Int($0) } }
    var chartMonths: Int { Int(effectiveNumber("plan.chart_months") ?? 0) }
    var monthlyInvest: Double? { userNumber("invest.monthly_target_eur") }
    var goalName: String { settings["purchase.goal_name"] ?? "" }
    var purposeTags: [String] { strings("review.purpose_tags") }
    var urgeTags: [String] { strings("review.urge_tags") }
    var staplesCategory: String? { effective("food.staples_category") }
    var luxuryCategory: String? { effective("food.luxury_category") }

    func isSupermarket(_ shop: String) -> Bool { Amounts.matches(shop, pattern: effective("food.supermarket_pattern")) }

    /// Saves your own value for a setting; the default in app_config stays for everyone else.
    func setUserSetting(_ key: String, _ value: Double) async {
        let text = value == value.rounded() ? String(Int(value)) : String(value)
        do { try await setSetting(key, text) } catch { spendError = error.localizedDescription }
    }

    // MARK: Target and forecast inputs

    /// Business income a month: the average of this year's invoiced months.
    var businessMonthly: Double? {
        guard let months = forecast?.months else { return nil }
        let year = String(Calendar.current.component(.year, from: Date()))
        let invoiced = months.filter { $0.status == "invoiced" && $0.month.hasPrefix(year) }
        guard !invoiced.isEmpty else { return nil }
        return invoiced.reduce(0) { $0 + $1.revenue_eur } / Double(invoiced.count)
    }

    var monthsToTarget: Int? { targetDate.map { PlanMath.months(from: Date(), to: $0) } }

    var neededGrowth: Double? {
        guard let current = businessMonthly, let target = targetMonthly, let months = monthsToTarget else { return nil }
        return PlanMath.requiredGrowth(current: current, target: target, months: months)
    }

    /// Net worth now in euros: cash in your accounts less the tax you owe, plus Wise and eToro
    /// converted at today's rate. Parts that cannot be converted yet are left out and named.
    var netWorthParts: (total: Double, missing: [String])? {
        guard let summary else { return nil }
        var total = summary.cash - summary.tax_reserve
        var missing: [String] = []
        for wallet in overview?.wallets ?? [] {
            if wallet.currency == baseCurrency { total += wallet.balance }
            else if let rate = fxToEUR[wallet.currency] { total += wallet.balance * rate }
            else { missing.append(wallet.label) }
        }
        if let broker = overview?.broker {
            let usd = broker.cash_usd + broker.invested_usd + broker.unrealized_pnl_usd
            if let rate = fxToEUR["USD"] { total += usd * rate } else { missing.append("eToro") }
        }
        return (total, missing)
    }

    /// Converts the currencies of your wallets and broker to euros, from the rate provider in app_config.
    func refreshFX() async {
        guard let base = settings["integrations.fx.api_base"], !base.isEmpty else { return }
        let needed = Set((overview?.wallets ?? []).map(\.currency) + (overview?.broker == nil ? [] : ["USD"])).subtracting([baseCurrency])
        for currency in needed where fxToEUR[currency] == nil {
            guard let url = URL(string: "\(base)/latest?from=\(currency)&to=\(baseCurrency)"),
                  let (data, _) = try? await URLSession.shared.data(from: url),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let rates = json["rates"] as? [String: Any],
                  let rate = (rates[baseCurrency] as? NSNumber)?.doubleValue else { continue }
            fxToEUR[currency] = rate
        }
    }

    /// The top of the monthly invest slider: what a month leaves after the tax set-aside and the plan
    /// (or today's setting if that is higher), and never less than ten steps.
    var investSliderMax: Double {
        let set = monthlyInvest ?? 0
        let step = effectiveNumber("plan.invest_step_eur") ?? 1
        var free = 0.0
        if let business = businessMonthly, let rate = forecast?.set_aside_rate { free = business * (1 - rate) - planTotal }
        return max(set, free, step * 10)
    }

    /// How far spending runs above the plan a month (your averages over the current caps).
    var planGap: Double {
        PlanMath.planGap(averages: currentBudgets.map { average(in: $0.category) ?? 0 },
                         caps: currentBudgets.map(\.monthly_amount))
    }

    /// Skip and save: what dropped Buy checks kept, this month and in total.
    var skippedTotal: Double { purchaseChecks.filter { $0.purchase_status == "dropped" }.reduce(0) { $0 + ($1.amount ?? 0) } }

    // MARK: Spend chart

    /// The budget for a category valid on a date: the newest line with valid_from on or before it.
    func cap(for category: String, on date: String) -> Double? {
        budgets.filter { $0.category == category && $0.valid_from <= date }
            .max { $0.valid_from < $1.valid_from }?.monthly_amount
    }

    /// Spend in the budgeted classes per month (oldest first) against the caps of that month.
    /// With a category, only that line.
    func monthlySpend(months: Int, category: String? = nil) -> [MonthSpend] {
        let cal = Calendar.current
        let thisMonth = Day.monthStart()
        return (0..<max(0, months)).reversed().compactMap { back in
            guard let start = cal.date(byAdding: .month, value: -back, to: thisMonth),
                  let next = cal.date(byAdding: .month, value: 1, to: start),
                  let lastDay = cal.date(byAdding: .day, value: -1, to: next) else { return nil }
            let from = Day.string(start), to = Day.string(next), end = Day.string(lastDay)
            let lines = transactions.filter { $0.booked_on >= from && $0.booked_on < to && $0.currency == baseCurrency
                && (category == nil || $0.category == category) }
            let spent = lines.reduce(0) { $0 + $1.outflow }
            let categories = category.map { [$0] } ?? Array(Set(budgets.map(\.category)))
            let cap = categories.compactMap { self.cap(for: $0, on: end) }.reduce(0, +)
            return MonthSpend(month: start, spent: spent, cap: cap)
        }
    }

    var planTotal: Double { currentBudgets.reduce(0) { $0 + $1.monthly_amount } }

    // MARK: Loading

    /// Loads the settings when iOS started the app in the background (a Shortcut or a notification answer).
    func ensureSettings() async {
        guard settings.isEmpty else { return }
        if let config: [ConfigEntry] = try? await backend.select("app_config",
            "select=key,value&or=(key.like.food.*,key.like.notifications.*,key.like.review.*,key.like.stop.*,key.eq.storage.documents_bucket)") {
            settings = Dictionary(config.map { ($0.key, $0.value) }, uniquingKeysWith: { first, _ in first })
        }
        if let own: [ConfigEntry] = try? await backend.select("nx_user_settings", "select=key,value") {
            userSettings = Dictionary(own.map { ($0.key, $0.value) }, uniquingKeysWith: { first, _ in first })
        }
    }

    func reloadSpend() async {
        do {
            receipts = try await backend.select("nx_receipts",
                "select=id,source,kind,merchant,total,currency,order_date,received_at,txn_id,match_status&order=received_at.desc&limit=200")
            recurring = try await backend.select("nx_subscriptions", "select=*&order=per_year.desc.nullslast,label.asc")
            routes = try await backend.select("nx_cancel_routes",
                "select=id,priority,pattern,label,route,url,steps,trap,notice_to,manage_url&order=priority.asc,label.asc")
            alerts = try await backend.select("nx_alerts", "select=id,kind,title,detail,txn_id,created_at,seen_at&order=created_at.desc&limit=100")
            taps = try await backend.select("nx_wallet_taps",
                "select=id,tapped_at,merchant,amount,currency,card,planned,food,txn_id&order=tapped_at.desc&limit=200")
            closes = try await backend.select("nx_month_closes", "select=id,month,figures,archive,closed_at&order=month.desc&limit=24")
            reviewQueue = try await backend.select("nx_transactions",
                "select=id,booked_on,amount,currency,merchant,payee,category,class,review_status&or=(review_status.eq.needs_review,category.eq.Uncategorised,category.like.To%20check*)&order=booked_on.desc,id.desc&limit=200")
            let raw = try await backend.rpc("nx_measures", [:])
            measures = try JSONDecoder().decode(ServerMeasures.self, from: JSONSerialization.data(withJSONObject: raw))
            let choices = try await backend.rpc("nx_tag_choices", [:])
            tagChoices = try JSONDecoder().decode([TagChoice].self, from: JSONSerialization.data(withJSONObject: choices))
            spendError = nil
        } catch {
            spendError = error.localizedDescription
        }
        await refreshMailbox()
        await refreshFX()
        Reminders.sync(self)
    }

    func refreshMailbox() async {
        do {
            mailbox = try JSONDecoder().decode(MailboxStatus.self, from: try await backend.spend(["action": "status"]))
        } catch {
            mailbox = nil
        }
    }

    /// Runs one spend action and returns its JSON.
    @discardableResult
    func spendCall(_ body: [String: Any]) async throws -> [String: Any] {
        let data = try await backend.spend(body)
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    // MARK: Purchase review

    var unseenAlerts: [AlertItem] { alerts.filter { $0.seen_at == nil } }

    func route(for charge: RecurringCharge) -> CancelRoute? {
        routes.sorted { $0.priority < $1.priority }.first { $0.matches(charge.label) }
    }

    /// Your call on a recurring charge. Cancel starts as To cancel; any other call clears the cancel.
    func setCall(_ charge: RecurringCharge, call: String?, tag: String?, cancelBy: Date?) async throws {
        let now = ISO8601DateFormatter().string(from: Date())
        var fields: [String: Any] = ["call": call ?? NSNull(), "tag": tag ?? NSNull(), "decided_at": now, "updated_at": now]
        if call == "cancel" {
            fields["status"] = charge.status ?? "to_cancel"
            fields["cancel_by"] = cancelBy.map { Day.string($0) } ?? NSNull()
        } else {
            fields["status"] = NSNull()
            fields["cancel_by"] = NSNull()
        }
        try await backend.update("nx_recurring", id: charge.id, fields)
        await reloadSpend()
    }

    /// Requested starts the clock: a charge after this moment means the cancel did not hold.
    func setCancelStatus(_ charge: RecurringCharge, _ status: String) async throws {
        let now = ISO8601DateFormatter().string(from: Date())
        var fields: [String: Any] = ["status": status, "updated_at": now]
        if status == "requested" { fields["decided_at"] = now }
        try await backend.update("nx_recurring", id: charge.id, fields)
        await reloadSpend()
    }

    func saveRoute(id: String?, priority: Int, pattern: String, label: String, route: String,
                   url: String, manageURL: String = "", steps: String, trap: String, noticeTo: String) async throws {
        let row: [String: Any] = [
            "priority": priority, "pattern": pattern, "label": label, "route": route,
            "url": url.isEmpty ? NSNull() : url, "manage_url": manageURL.isEmpty ? NSNull() : manageURL,
            "steps": steps.isEmpty ? NSNull() : steps,
            "trap": trap.isEmpty ? NSNull() : trap, "notice_to": noticeTo.isEmpty ? NSNull() : noticeTo
        ]
        if let id { try await backend.update("nx_cancel_routes", id: id, row) } else { try await backend.insert("nx_cancel_routes", row) }
        await reloadSpend()
    }

    func deleteRoute(_ route: CancelRoute) async throws {
        try await backend.delete("nx_cancel_routes", id: route.id)
        await reloadSpend()
    }

    func markSeen(_ items: [AlertItem]) async {
        let ids = items.filter { $0.seen_at == nil }.map(\.id)
        guard !ids.isEmpty else { return }
        do {
            try await backend.updateWhere("nx_alerts", "id=in.(\(ids.joined(separator: ",")))",
                                          ["seen_at": ISO8601DateFormatter().string(from: Date())])
            await reloadSpend()
        } catch {
            spendError = error.localizedDescription
        }
    }

    // MARK: Wallet taps and receipts

    func logTap(merchant: String, amount: Double?, currency: String?, card: String?) async throws -> WalletTap {
        try await backend.insertReturning("nx_wallet_taps", [
            "merchant": merchant, "amount": amount ?? NSNull(), "currency": currency ?? baseCurrency, "card": card ?? NSNull()
        ])
    }

    func answerTap(id: String, planned: Bool? = nil, food: String? = nil) async throws {
        var fields: [String: Any] = [:]
        if let planned { fields["planned"] = planned }
        if let food { fields["food"] = food }
        guard !fields.isEmpty else { return }
        try await backend.update("nx_wallet_taps", id: id, fields)
    }

    /// Stores a receipt photo and lets the spend function read it, match it to its bank line and split it.
    func addReceipt(_ data: Data, contentType: String, fileExtension: String) async throws -> String {
        guard let uid = backend.userId else { throw APIError.notSignedIn }
        guard let bucket = settings["storage.documents_bucket"], !bucket.isEmpty else {
            throw BudgetError.missingSetting("storage.documents_bucket")
        }
        let path = "\(uid)/receipts/\(Int(Date().timeIntervalSince1970))-\(UUID().uuidString.prefix(8)).\(fileExtension)"
        try await backend.upload(bucket: bucket, path: path, data: data, contentType: contentType)
        let json = try await spendCall(["action": "receipt_photo", "path": path])
        await reload()
        let reading = json["reading"] as? [String: Any] ?? [:]
        let shop = reading["merchant"] as? String ?? "the shop"
        let total = (reading["total"] as? NSNumber)?.doubleValue
        let items = reading["items"] as? [[String: Any]] ?? []
        let staples = items.filter { $0["staple"] as? Bool == true }.count
        let metrics = json["metrics"] as? [String: Any] ?? [:]
        let split = ((metrics["food_splits"] as? NSNumber)?.intValue ?? 0) > 0
        var text = "Read \(shop)" + (total.map { ", \(Money.format($0, baseCurrency))" } ?? "") + ", \(items.count) items"
        if staples > 0 { text += ", \(staples) staples" }
        text += split ? ". The bank line is split into staples and luxury." : ". It is matched when the bank line arrives."
        return text
    }

    // MARK: Sunday review

    /// The class a category gets from its rules, from the lines already in it.
    func lineClass(for category: String) -> String? {
        let classes = transactions.filter { $0.category == category }.map(\.txClass)
        return Dictionary(classes.map { ($0, 1) }, uniquingKeysWith: +).max { $0.value < $1.value }?.key
    }

    /// Gives a line its category by hand; with "always", a rule tags the shop that way from now on.
    func confirm(_ line: ReviewLine, category: String, always: Bool) async throws {
        let lineClassName = lineClass(for: category) ?? line.txClass
        try await backend.update("nx_transactions", id: line.id,
                                 ["category": category, "class": lineClassName, "review_status": "confirmed"])
        if always, let shop = line.merchant ?? line.payee, !shop.isEmpty {
            guard let priority = effectiveNumber("review.rule_priority") else { throw BudgetError.missingSetting("review.rule_priority") }
            let escaped = NSRegularExpression.escapedPattern(for: shop.lowercased())
            try await backend.insert("nx_category_rules", [
                "priority": Int(priority), "match": ["name": "^\(escaped)"], "category": category,
                "class": lineClassName, "active": true, "origin": "review"
            ])
            _ = try await backend.rpc("nx_reclassify", [:])
        }
        await reload()
    }

    // MARK: Tags

    /// The tags on one line, by dimension.
    func lineTags(_ lineId: String) async throws -> [LineTag] {
        try await backend.select("nx_line_tags", "select=dimension,value,source&txn_id=eq.\(lineId)")
    }

    /// Tags lines by hand; nil hands the dimension back to the rules. With always, the tag also
    /// goes on the shop's rule, the same one "Always for this shop" makes for the category.
    func setTag(_ lineIds: [String], dimension: String, value: String?, always: Bool) async throws {
        _ = try await backend.rpc("nx_set_line_tags", [
            "p_txns": lineIds, "p_dimension": dimension, "p_value": value.map { $0 as Any } ?? NSNull(), "p_always": always
        ])
    }

    /// Saves what changed in a line form's tag picks, then reloads the figures that use them.
    func saveTags(_ lineIds: [String], before: [String: String], picks: [String: String], always: Bool) async throws {
        let changes = Tags.changes(from: before, to: picks)
        for change in changes {
            try await setTag(lineIds, dimension: change.dimension, value: change.value, always: always)
        }
        if !changes.isEmpty { await reloadGlance() }
    }

    // MARK: Monthly close

    func closeMonth(_ month: Date) async throws -> String {
        let json = try await spendCall(["action": "close_month", "month": Day.string(Day.monthStart(month))])
        await reloadSpend()
        let archive = json["archive"] as? [String: Any]
        let files = (archive?["files"] as? NSNumber)?.intValue
        return files.map { "Closed. \($0) files went to the Drive archive." } ?? "Closed. Connect Gmail in Settings to archive to Drive."
    }
}
