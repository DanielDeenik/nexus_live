import SwiftUI

/// If/then/else rules, probability bets scored with the Brier score, and Buy checks for purchases.
struct DecideView: View {
    @EnvironmentObject private var ledger: Ledger
    @State private var mode = 0
    @State private var addingRule = false
    @State private var addingBet = false
    @State private var addingPurchase = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Picker("View", selection: $mode) {
                    Text("Rules").tag(0)
                    Text("Bets").tag(1)
                    Text("Buy").tag(2)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)

                if mode == 0 {
                    rules
                } else if mode == 1 {
                    bets
                } else {
                    purchases
                }
            }
            .navigationTitle("Decide")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        if mode == 0 { addingRule = true } else if mode == 1 { addingBet = true } else { addingPurchase = true }
                    } label: { Image(systemName: "plus") }
                }
            }
            .refreshable { await ledger.reload() }
            .sheet(isPresented: $addingRule) { RuleForm() }
            .sheet(isPresented: $addingBet) { BetForm() }
            .sheet(isPresented: $addingPurchase) { PurchaseForm() }
            .errorAlert($error)
        }
    }

    @ViewBuilder private var rules: some View {
        if ledger.rules.isEmpty {
            Text("No rules yet. Add your first if/then rule with +.").foregroundStyle(.secondary)
        }
        ForEach(ledger.rules) { rule in
            VStack(alignment: .leading, spacing: 4) {
                if let area = rule.area { Text(area.uppercased()).font(.caption2).foregroundStyle(Theme.accent) }
                Text("If \(rule.if_condition ?? "")").bold()
                Text("Then \(rule.then_action ?? "")")
                if let otherwise = rule.else_action { Text("Else \(otherwise)").foregroundStyle(.secondary) }
            }
            .opacity(rule.active ? 1 : 0.45)
            .swipeActions {
                Button(rule.active ? "Pause" : "Activate") { act { try await ledger.setRuleActive(rule, !rule.active) } }
                    .tint(.orange)
                Button("Delete", role: .destructive) { act { try await ledger.delete(rule) } }
            }
        }
    }

    @ViewBuilder private var bets: some View {
        Section {
            HStack {
                Text("Mean Brier score")
                Spacer()
                Text(ledger.meanBrier.map { String(format: "%.3f", $0) } ?? "no resolved bets").monospacedDigit()
            }
            Text("Lower is better: 0 is perfect, 0.25 is a coin flip.").font(.caption).foregroundStyle(.secondary)
        }
        Section("Open") {
            if ledger.openBets.isEmpty { Text("No open bets. Add one with +.").foregroundStyle(.secondary) }
            ForEach(ledger.openBets) { bet in
                betRow(bet)
                    .swipeActions(edge: .leading) {
                        Button("Happened") { act { try await ledger.resolve(bet, outcome: true) } }.tint(.green)
                    }
                    .swipeActions(edge: .trailing) {
                        Button("Did not") { act { try await ledger.resolve(bet, outcome: false) } }.tint(.red)
                        Button("Delete", role: .destructive) { act { try await ledger.delete(bet) } }
                    }
            }
        }
        Section("Resolved") {
            ForEach(ledger.resolvedBets) { bet in
                betRow(bet)
            }
        }
    }

    @ViewBuilder private var purchases: some View {
        Section {
            Button("New Buy check") { addingPurchase = true }
            if let tiers = tierSummary {
                Text(tiers).font(.caption).foregroundStyle(.secondary)
            }
        }
        Section("Waiting") {
            if ledger.waitingPurchases.isEmpty { Text("Nothing waiting.").foregroundStyle(.secondary) }
            ForEach(ledger.waitingPurchases) { check in
                purchaseRow(check)
                    .swipeActions(edge: .leading) {
                        Button("Bought") { act { try await ledger.setPurchase(check, status: "bought") } }.tint(.green)
                    }
                    .swipeActions(edge: .trailing) {
                        Button("Dropped") { act { try await ledger.setPurchase(check, status: "dropped") } }.tint(.orange)
                        Button("Delete", role: .destructive) { act { try await ledger.delete(check) } }
                    }
            }
        }
        Section("Kept this month") {
            HStack {
                Text("Dropped after the wait")
                Spacer()
                Text(Money.format(ledger.keptThisMonth, ledger.baseCurrency)).monospacedDigit().foregroundStyle(Theme.accent)
            }
            Text(keptCaption).font(.caption).foregroundStyle(.secondary)
        }
        Section("Decided") {
            if ledger.decidedPurchases.isEmpty { Text("No decided purchases yet.").foregroundStyle(.secondary) }
            ForEach(ledger.decidedPurchases.prefix(20)) { check in
                purchaseRow(check)
            }
        }
    }

    /// Where kept money goes, named by purchase.goal_name in app_config.
    private var keptCaption: String {
        if let goal = ledger.settings["purchase.goal_name"], !goal.isEmpty { return "Move it to the \(goal) goal the same day." }
        return "Move it to your savings goal the same day."
    }

    /// The tiers as configured in app_config, in one line.
    private var tierSummary: String? {
        guard let small = ledger.number("purchase.small_below"), let major = ledger.number("purchase.major_from"),
              let hours = ledger.number("purchase.considered_wait_hours"), let days = ledger.number("purchase.major_wait_days") else { return nil }
        let currency = ledger.baseCurrency
        return "Small under \(Money.format(small, currency)). Considered from \(Money.format(small, currency)): wait \(Int(hours)) hours. Major from \(Money.format(major, currency)): wait \(Int(days)) days and bet on use."
    }

    private func purchaseRow(_ check: Decision) -> some View {
        let waitEnd = Day.timestamp(check.wait_until)
        let waiting = check.purchase_status == "waiting"
        let waitOver = waitEnd.map { $0 <= Date() } ?? true
        let state: String
        if waiting, let waitEnd {
            state = waitOver ? "Wait over: decide" : "Wait until " + waitEnd.formatted(date: .abbreviated, time: .shortened)
        } else {
            state = (check.purchase_status ?? "").capitalized
        }
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(check.statement ?? "").bold()
                Spacer()
                Text(Money.format(check.amount ?? 0, check.currency ?? ledger.baseCurrency)).monospacedDigit()
            }
            HStack(spacing: 8) {
                Text((check.tier ?? "").capitalized)
                if let category = check.category { Text(category) }
                if check.scope == "business" { Text("Business") }
                Spacer()
                Text(state).foregroundStyle(waiting && waitOver ? Theme.accent : Color.secondary)
            }
            .font(.caption).foregroundStyle(.secondary)
            if let alternative = check.else_action {
                Text("Instead: \(alternative)").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func betRow(_ bet: Decision) -> some View {
        let statement = bet.isPurchase ? "I use \(bet.statement ?? "") at least weekly" : (bet.statement ?? "")
        return VStack(alignment: .leading, spacing: 4) {
            if let area = bet.area { Text(area.uppercased()).font(.caption2).foregroundStyle(Theme.accent) }
            Text(statement)
            HStack {
                Text(verbatim: "\(Int(((bet.probability ?? 0) * 100).rounded()))%").bold().monospacedDigit()
                if let due = bet.resolve_by { Text("by \(due)").foregroundStyle(.secondary) }
                Spacer()
                if let outcome = bet.outcome {
                    Text(outcome ? "Happened" : "Did not").foregroundStyle(outcome ? Color.green : Color.red)
                    if let brier = bet.brier { Text(String(format: "%.3f", brier)).monospacedDigit() }
                }
            }
            .font(.caption)
        }
    }

    private func act(_ work: @escaping () async throws -> Void) {
        Task {
            do { try await work() } catch { self.error = error.localizedDescription }
        }
    }
}

struct RuleForm: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.dismiss) private var dismiss
    @State private var area = ""
    @State private var condition = ""
    @State private var then = ""
    @State private var otherwise = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("Area (money, health, trading)", text: $area).textInputAutocapitalization(.never)
                TextField("If", text: $condition, axis: .vertical)
                TextField("Then", text: $then, axis: .vertical)
                TextField("Else (optional)", text: $otherwise, axis: .vertical)
            }
            .navigationTitle("New rule")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            do {
                                try await ledger.addRule(area: area, condition: condition, then: then, otherwise: otherwise)
                                dismiss()
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                    .disabled(condition.isEmpty || then.isEmpty)
                }
            }
            .errorAlert($error)
        }
    }
}

struct BetForm: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.dismiss) private var dismiss
    @State private var area = ""
    @State private var statement = ""
    @State private var probability = 0.6
    @State private var resolveBy = Calendar.current.date(byAdding: .day, value: 7, to: Date()) ?? Date()
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("Area (money, health, trading)", text: $area).textInputAutocapitalization(.never)
                TextField("What will happen?", text: $statement, axis: .vertical)
                Section(header: Text(verbatim: "Confidence \(Int((probability * 100).rounded()))%")) {
                    Slider(value: $probability, in: 0.01...0.99, step: 0.01)
                }
                DatePicker("Check on", selection: $resolveBy, in: Date()..., displayedComponents: .date)
            }
            .navigationTitle("New bet")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            do {
                                try await ledger.addBet(area: area, statement: statement,
                                                        probability: probability, resolveBy: resolveBy)
                                dismiss()
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                    .disabled(statement.isEmpty)
                }
            }
            .errorAlert($error)
        }
    }
}

/// A Buy check before paying: tier, budget left, your own average, safe to spend after, and the wait.
struct PurchaseForm: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.dismiss) private var dismiss
    @State private var item = ""
    @State private var amountText = ""
    @State private var category = ""
    @State private var business = false
    @State private var subscription = false
    @State private var alternative = ""
    @State private var useProbability = 0.6
    @State private var error: String?

    private var amount: Double? {
        guard let value = Money.parse(amountText), value > 0 else { return nil }
        return value
    }
    private var tier: String? { amount.flatMap { ledger.tier(for: $0) } }
    private var needsBet: Bool { tier == "major" || subscription }
    private var needsAlternative: Bool { tier == "considered" || tier == "major" }
    private var alternativePrompt: String {
        if let goal = ledger.settings["purchase.goal_name"], !goal.isEmpty { return "For example: the \(goal) transfer it delays" }
        return "For example: the savings transfer it delays"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What do you want to buy?", text: $item)
                    TextField("Amount (\(ledger.baseCurrency))", text: $amountText).keyboardType(.decimalPad)
                    Picker("Category", selection: $category) {
                        Text("Pick one").tag("")
                        ForEach(ledger.categories, id: \.self) { Text($0).tag($0) }
                    }
                    Toggle("For the business", isOn: $business)
                    Toggle("It's a subscription", isOn: $subscription)
                }
                if let amount, let tier {
                    Section("Check") {
                        LabeledContent("Tier", value: tier.capitalized)
                        if !category.isEmpty, let left = ledger.budgetLeft(in: category) {
                            LabeledContent("Budget left after this", value: Money.format(left - amount, ledger.baseCurrency))
                        }
                        if !category.isEmpty, let average = ledger.average(in: category), let months = ledger.averageMonths {
                            LabeledContent("Your \(months)-month average", value: Money.format(average, ledger.baseCurrency))
                        }
                        if let summary = ledger.summary {
                            LabeledContent("Safe to spend after", value: Money.format(summary.safe_to_spend - amount, ledger.baseCurrency))
                                .foregroundStyle(summary.safe_to_spend - amount < 0 ? Color.red : Color.primary)
                        }
                        if tier != "small", let until = ledger.waitUntil(for: tier) {
                            LabeledContent("Wait until", value: until.formatted(date: .abbreviated, time: .shortened))
                        }
                        taxLines(amount)
                    }
                }
                if needsAlternative {
                    Section("What else would this money do?") {
                        TextField(alternativePrompt, text: $alternative, axis: .vertical)
                    }
                }
                if business {
                    Section {
                        Text("Pay from the business account and get the invoice in your business name with your VAT number, so it can be booked.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if needsBet {
                    Section(header: Text(verbatim: "Chance you use it at least weekly: \(Int((useProbability * 100).rounded()))%")) {
                        Slider(value: $useProbability, in: 0.01...0.99, step: 0.01)
                    }
                }
            }
            .navigationTitle("Buy check")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Log") { save() }
                        .disabled(item.isEmpty || amount == nil || category.isEmpty || (needsAlternative && alternative.isEmpty))
                }
            }
            .errorAlert($error)
        }
    }

    /// What the purchase means after tax: a business cost lowers income tax at the marginal rate;
    /// a private purchase is paid from income that was taxed first, so it costs billable hours.
    @ViewBuilder private func taxLines(_ amount: Double) -> some View {
        if let forecast = ledger.forecast {
            if business {
                LabeledContent("Income tax it saves", value: Money.format(amount * forecast.marginal.cost, ledger.baseCurrency))
                LabeledContent("Cost after tax", value: Money.format(amount * (1 - forecast.marginal.cost), ledger.baseCurrency))
                Text("Before any VAT you reclaim.").font(.caption).foregroundStyle(.secondary)
            } else if let rate = forecast.rate, rate.eur_per_hour * (1 - forecast.marginal.revenue) > 0 {
                let perHour = rate.eur_per_hour * (1 - forecast.marginal.revenue)
                LabeledContent("Billable hours it costs", value: (amount / perHour).formatted(.number.precision(.fractionLength(1))))
                LabeledContent("You keep per billed hour", value: Money.format(perHour, ledger.baseCurrency))
            }
        }
    }

    private func save() {
        guard let value = amount else { return }
        let note = alternative.trimmingCharacters(in: .whitespacesAndNewlines)
        let probability: Double? = needsBet ? useProbability : nil
        Task {
            do {
                try await ledger.addPurchaseCheck(item: item, amount: value, category: category, business: business,
                                                  alternative: note.isEmpty ? nil : note, useProbability: probability)
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
