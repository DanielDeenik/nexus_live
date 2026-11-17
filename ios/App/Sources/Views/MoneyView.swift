import SwiftUI
import UniformTypeIdentifiers

/// This month against budget, net worth, eToro positions and bank file import.
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
                Section("This month") {
                    HStack {
                        Text("Spent")
                        Spacer()
                        Text(Money.format(ledger.spentThisMonth, ledger.baseCurrency)).bold().monospacedDigit()
                    }
                    ForEach(ledger.currentBudgets) { budget in
                        let spent = ledger.spent(in: budget.category)
                        VStack(alignment: .leading) {
                            HStack {
                                Text(budget.category)
                                Spacer()
                                Text("\(Money.format(spent, budget.currency)) of \(Money.format(budget.monthly_amount, budget.currency))")
                                    .font(.caption).monospacedDigit()
                                    .foregroundStyle(spent > budget.monthly_amount ? Color.red : Color.secondary)
                            }
                            ProgressView(value: min(spent, budget.monthly_amount), total: max(budget.monthly_amount, 0.01))
                                .tint(spent > budget.monthly_amount ? .red : Theme.accent)
                        }
                    }
                    Button("Set a budget") { addingBudget = true }
                }

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

                Section("Bank") {
                    Button("Import bank export (CSV or TAB)") { importing = true }
                    if let importResult { Text(importResult).font(.caption).foregroundStyle(.secondary) }
                    Text("Imported payments land as proposed expenses for review. Re-importing the same file adds nothing twice.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Money")
            .refreshable { await ledger.reload() }
            .sheet(isPresented: $addingBudget) { BudgetForm() }
            .sheet(isPresented: $addingNetWorth) { NetWorthForm() }
            .fileImporter(isPresented: $importing,
                          allowedContentTypes: [.commaSeparatedText, .tabSeparatedText, .plainText, .text]) { result in
                handleImport(result)
            }
            .overlay { if ledger.loading { ProgressView() } }
            .errorAlert($error)
        }
    }

    private func handleImport(_ result: Result<URL, Error>) {
        Task {
            do {
                let url = try result.get()
                let preview = try BankImport.read(url, fallbackCurrency: ledger.baseCurrency)
                let added = try await ledger.importExpenses(preview.rows)
                importResult = "\(preview.bank): \(preview.rows.count) payments read, \(added) new, \(preview.skipped) lines skipped (income or unreadable)."
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
