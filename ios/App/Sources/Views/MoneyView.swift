import SwiftUI
import UniformTypeIdentifiers

/// Safe to spend, this month against budget and your own average, net worth, eToro positions and bank import.
struct MoneyView: View {
    @EnvironmentObject private var ledger: Ledger
    @State private var addingBudget = false
    @State private var addingNetWorth = false
    @State private var importing = false
    @State private var importResult: String?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                safeToSpend
                thisMonth
                if !ledger.unbudgetedThisMonth.isEmpty { noBudget }
                netWorthSection
                positionsSection
                bankSection
            }
            .navigationTitle("Money")
            .refreshable { await ledger.reload() }
            .sheet(isPresented: $addingBudget) { BudgetForm() }
            .sheet(isPresented: $addingNetWorth) { NetWorthForm() }
            .fileImporter(isPresented: $importing,
                          allowedContentTypes: [.commaSeparatedText, .tabSeparatedText, .plainText, .text, .data]) { result in
                handleImport(result)
            }
            .overlay { if ledger.loading { ProgressView() } }
            .errorAlert($error)
        }
    }

    @ViewBuilder private var safeToSpend: some View {
        Section {
            if let summary = ledger.summary {
                HStack {
                    Text("Safe to spend").bold()
                    Spacer()
                    Text(Money.format(summary.safe_to_spend, ledger.baseCurrency)).bold().monospacedDigit()
                        .foregroundStyle(summary.safe_to_spend < 0 ? Color.red : Theme.accent)
                }
                amountRow("Cash in your accounts", summary.cash)
                amountRow(summary.tax_reserve_label, -summary.tax_reserve)
                amountRow("Fixed costs still due this month", -summary.fixed_left)
                DisclosureGroup("Accounts") {
                    ForEach(summary.accounts) { account in
                        HStack {
                            Text(account.label)
                            Spacer()
                            Text(Money.format(account.balance, ledger.baseCurrency)).monospacedDigit().foregroundStyle(.secondary)
                        }
                    }
                }
                if let asOf = summary.as_of {
                    Text("Bank lines up to \(asOf). Import new exports to keep this current.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Text("Import your bank exports to see safe to spend.").foregroundStyle(.secondary)
            }
        }
    }

    private func amountRow(_ label: String, _ value: Double) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(Money.format(value, ledger.baseCurrency)).monospacedDigit().foregroundStyle(.secondary)
        }
        .font(.callout)
    }

    @ViewBuilder private var thisMonth: some View {
        Section("This month") {
            HStack {
                Text("Spent")
                Spacer()
                Text(Money.format(ledger.spentThisMonth, ledger.baseCurrency)).bold().monospacedDigit()
            }
            if ledger.hiddenThisMonth > 0 {
                HStack {
                    Text("Shop not visible yet")
                    Spacer()
                    Text(Money.format(ledger.hiddenThisMonth, ledger.baseCurrency)).monospacedDigit().foregroundStyle(.orange)
                }
            }
            let unplanned = ledger.unplannedThisMonth
            if !unplanned.isEmpty {
                HStack {
                    Text("Unplanned purchases: \(unplanned.count)")
                    Spacer()
                    Text(Money.format(unplanned.reduce(0) { $0 + $1.outflow }, ledger.baseCurrency))
                        .monospacedDigit().foregroundStyle(.red)
                }
            }
            ForEach(ledger.currentBudgets) { budget in
                budgetRow(budget)
            }
            Button("Set a budget") { addingBudget = true }
        }
    }

    private func budgetRow(_ budget: Budget) -> some View {
        let spent = ledger.spent(in: budget.category)
        let over = spent > budget.monthly_amount
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(budget.category)
                Spacer()
                Text("\(Money.format(spent, budget.currency)) of \(Money.format(budget.monthly_amount, budget.currency))")
                    .font(.caption).monospacedDigit()
                    .foregroundStyle(over ? Color.red : Color.secondary)
            }
            ProgressView(value: min(max(spent, 0), budget.monthly_amount), total: max(budget.monthly_amount, 0.01))
                .tint(over ? .red : Theme.accent)
            if let average = ledger.average(in: budget.category), let months = ledger.averageMonths {
                Text("Your \(months)-month average: \(Money.format(average, budget.currency))")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private var noBudget: some View {
        Section("No budget yet") {
            ForEach(ledger.unbudgetedThisMonth) { item in
                HStack {
                    Text(item.category)
                    Spacer()
                    Text(Money.format(item.spent, ledger.baseCurrency)).monospacedDigit().foregroundStyle(.secondary)
                }
            }
        }
    }

    private var netWorthSection: some View {
        Section("Net worth") {
            if let latest = ledger.netWorth.first {
                HStack {
                    Text(latest.as_of)
                    Spacer()
                    Text(Money.format(latest.total ?? 0, latest.currency)).bold().monospacedDigit()
                }
                ForEach(ledger.netWorth.dropFirst().prefix(5)) { snapshot in
                    HStack {
                        Text(snapshot.as_of).foregroundStyle(.secondary)
                        Spacer()
                        Text(Money.format(snapshot.total ?? 0, snapshot.currency)).monospacedDigit().foregroundStyle(.secondary)
                    }
                }
            } else {
                Text("No snapshot yet.").foregroundStyle(.secondary)
            }
            Button("Record today's net worth") { addingNetWorth = true }
        }
    }

    private var positionsSection: some View {
        Section("eToro positions") {
            if ledger.positions.isEmpty {
                Text("eToro sync is not connected yet.").foregroundStyle(.secondary)
            }
            ForEach(ledger.positions) { position in
                HStack {
                    Text(position.symbol ?? position.source)
                    Spacer()
                    VStack(alignment: .trailing) {
                        Text(Money.format(position.value ?? 0, position.currency ?? ledger.baseCurrency)).monospacedDigit()
                        if let pnl = position.pnl {
                            Text(Money.format(pnl, position.currency ?? ledger.baseCurrency))
                                .font(.caption).monospacedDigit()
                                .foregroundStyle(pnl >= 0 ? Color.green : Color.red)
                        }
                    }
                }
            }
        }
    }

    private var bankSection: some View {
        Section("Bank") {
            Button("Import bank export") { importing = true }
            if let importResult { Text(importResult).font(.caption).foregroundStyle(.secondary) }
            Text("Every line comes in, money in and money out. Transfers between your own accounts stay out of spending, your rules pick the category, and importing the same lines again adds nothing.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func handleImport(_ result: Result<URL, Error>) {
        Task {
            do {
                let url = try result.get()
                let preview = try BankImport.read(url, fallbackCurrency: ledger.baseCurrency)
                let summary = try await ledger.importTransactions(preview.rows)
                importResult = "\(preview.bank): \(summary.received) lines read, \(summary.inserted) new, \(summary.duplicates) already in, \(summary.needsReview) to review, \(preview.skipped) unreadable."
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

struct BudgetForm: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.dismiss) private var dismiss
    @State private var category = ""
    @State private var amountText = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("Category", text: $category).textInputAutocapitalization(.never)
                if !ledger.categories.isEmpty {
                    Picker("Pick existing", selection: $category) {
                        Text("").tag("")
                        ForEach(ledger.categories, id: \.self) { Text($0).tag($0) }
                    }
                }
                TextField("Monthly amount (\(ledger.baseCurrency))", text: $amountText).keyboardType(.decimalPad)
            }
            .navigationTitle("Budget")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        guard let amount = Money.parse(amountText) else { return }
                        Task {
                            do {
                                try await ledger.setBudget(category: category.trimmingCharacters(in: .whitespaces), amount: amount)
                                dismiss()
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                    .disabled(category.trimmingCharacters(in: .whitespaces).isEmpty || Money.parse(amountText) == nil)
                }
            }
            .errorAlert($error)
        }
    }
}

struct NetWorthForm: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.dismiss) private var dismiss
    @State private var cash = ""
    @State private var investments = ""
    @State private var liabilities = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Today, in \(ledger.baseCurrency)") {
                    TextField("Cash and bank", text: $cash).keyboardType(.decimalPad)
                    TextField("Investments", text: $investments).keyboardType(.decimalPad)
                    TextField("Debts", text: $liabilities).keyboardType(.decimalPad)
                }
            }
            .navigationTitle("Net worth")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            do {
                                try await ledger.addNetWorth(cash: Money.parse(cash) ?? 0,
                                                             investments: Money.parse(investments) ?? 0,
                                                             liabilities: Money.parse(liabilities) ?? 0)
                                dismiss()
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                    .disabled(cash.isEmpty && investments.isEmpty)
                }
            }
            .errorAlert($error)
        }
    }
}
