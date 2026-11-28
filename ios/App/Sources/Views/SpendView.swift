import SwiftUI
import UniformTypeIdentifiers

/// Spend: this month against the plan as the one number, spend against cap over the months as the
/// one chart, the budget lines that need a look, and the purchase review. The rest is one tap down.
struct SpendView: View {
    @EnvironmentObject private var ledger: Ledger
    @State private var addingBudget = false
    @State private var importing = false
    @State private var importResult: String?
    @State private var pickPhoto = false
    @State private var takePhoto = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                hero
                lines
                more
            }
            .navigationTitle("Spend")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button { importing = true } label: { Label("Import bank file", systemImage: "square.and.arrow.down") }
                        if cameraAvailable {
                            Button { takePhoto = true } label: { Label("Photograph a receipt", systemImage: "camera") }
                        }
                        Button { pickPhoto = true } label: { Label("Receipt from Photos", systemImage: "photo") }
                        Button { addingBudget = true } label: { Label("Add a budget line", systemImage: "plus.forwardslash.minus") }
                    } label: { Image(systemName: "plus") }
                }
            }
            .refreshable { await ledger.reload() }
            .sheet(isPresented: $addingBudget) { BudgetForm() }
            .fileImporter(isPresented: $importing,
                          allowedContentTypes: [.commaSeparatedText, .tabSeparatedText, .plainText, .text, .data]) { result in
                handleImport(result)
            }
            .receiptCapture(pickPhoto: $pickPhoto, takePhoto: $takePhoto)
            .alert("Import", isPresented: Binding(get: { importResult != nil }, set: { if !$0 { importResult = nil } })) {
                Button("OK", role: .cancel) { importResult = nil }
            } message: {
                Text(importResult ?? "")
            }
            .overlay { if ledger.loading && ledger.transactions.isEmpty { ProgressView() } }
            .errorAlert($error)
        }
    }

    @ViewBuilder private var hero: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text(Money.format(ledger.spentThisMonth, ledger.baseCurrency))
                    .font(.system(size: 34, weight: .bold, design: .rounded)).monospacedDigit()
                    .foregroundStyle(ledger.spentThisMonth > ledger.planTotal && ledger.planTotal > 0 ? Color.red : Color.primary)
                Text("spent this month, of a \(Money.format(ledger.planTotal, ledger.baseCurrency)) plan").font(.subheadline).foregroundStyle(.secondary)
                if ledger.planGap > 0, let months = ledger.averageMonths {
                    Text("Your \(months)-month average runs \(Money.format(ledger.planGap, ledger.baseCurrency)) a month above the plan.")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
            let data = ledger.monthlySpend(months: ledger.chartMonths)
            if !data.isEmpty {
                ChartCard(title: "Spend against cap", caption: "Each month in the budgeted classes against the plan's caps then. Tap for full size and one line at a time.") {
                    SpendCapChart(months: data, labelled: false)
                } large: {
                    SpendChartDetail()
                }
            }
        }
    }

    /// Lines over their cap first, then the fullest; five at most.
    private var topLines: [Budget] {
        ledger.currentBudgets.filter { $0.monthly_amount > 0 || ledger.spent(in: $0.category) > 0 }
            .sorted { share($0) > share($1) }
            .prefix(5).map { $0 }
    }

    private func share(_ budget: Budget) -> Double {
        let spent = ledger.spent(in: budget.category)
        return budget.monthly_amount > 0 ? spent / budget.monthly_amount : (spent > 0 ? .infinity : 0)
    }

    @ViewBuilder private var lines: some View {
        Section("This month") {
            ForEach(topLines) { budget in
                BudgetRow(budget: budget)
            }
            NavigationLink("All budget lines") { BudgetListView() }
        }
    }

    @ViewBuilder private var more: some View {
        Section {
            NavigationLink { SubscriptionsView() } label: {
                HStack {
                    Label("Subscriptions", systemImage: "creditcard")
                    Spacer()
                    let bunq = ledger.recurring.filter { Subscriptions.group($0, today: Day.string(Date())) == .onBunq }.count
                    if bunq > 0 { Text("\(bunq) on bunq").font(.caption.bold()).foregroundStyle(.orange) }
                }
            }
            NavigationLink { PurchaseReviewView() } label: {
                HStack {
                    Label("Purchase review", systemImage: "arrow.triangle.2.circlepath")
                    Spacer()
                    let open = ledger.recurring.filter { $0.call == nil }.count
                    if open > 0 { Text(String(open)).font(.caption.bold()).foregroundStyle(.orange) }
                }
            }
            let unplanned = ledger.unplannedThisMonth
            if !unplanned.isEmpty {
                NavigationLink { UnplannedView() } label: {
                    HStack {
                        Label("No Buy check: \(unplanned.count)", systemImage: "questionmark.circle")
                        Spacer()
                        Text(Money.format(unplanned.reduce(0) { $0 + $1.outflow }, ledger.baseCurrency)).monospacedDigit().foregroundStyle(.red)
                    }
                }
            }
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

/// One budget line: spent against the cap, with your average under it.
struct BudgetRow: View {
    @EnvironmentObject private var ledger: Ledger
    let budget: Budget

    var body: some View {
        let spent = ledger.spent(in: budget.category)
        let over = spent > budget.monthly_amount
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(budget.category)
                Spacer()
                Text("\(Money.format(spent, budget.currency)) of \(Money.format(budget.monthly_amount, budget.currency))")
                    .font(.caption).monospacedDigit()
                    .foregroundStyle(over ? Color.red : Color.secondary)
            }
            ProgressView(value: min(max(spent, 0), max(budget.monthly_amount, 0.01)), total: max(budget.monthly_amount, 0.01))
                .tint(over ? .red : Theme.accent)
            if let average = ledger.average(in: budget.category), let months = ledger.averageMonths {
                Text("Your \(months)-month average: \(Money.format(average, budget.currency))")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}

/// Every budget line, with a swipe to change its cap.
struct BudgetListView: View {
    @EnvironmentObject private var ledger: Ledger
    @State private var editing: Budget?

    var body: some View {
        List {
            Section("Budget lines") {
                ForEach(ledger.currentBudgets) { budget in
                    BudgetRow(budget: budget)
                        .swipeActions { Button("Change cap") { editing = budget }.tint(Theme.accent) }
                }
            }
            if !ledger.unbudgetedThisMonth.isEmpty {
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
            if ledger.hiddenThisMonth > 0 {
                Section {
                    HStack {
                        Text("Shop not visible yet")
                        Spacer()
                        Text(Money.format(ledger.hiddenThisMonth, ledger.baseCurrency)).monospacedDigit().foregroundStyle(.orange)
                    }
                } footer: {
                    Text("Klarna, PayPal and cash hide the shop. Order emails name it once your mailbox is connected.")
                }
            }
        }
        .navigationTitle("Budget lines")
        .sheet(item: $editing) { budget in BudgetForm(category: budget.category, amount: budget.monthly_amount) }
    }
}

/// Spend against cap at full size, for all lines or one.
struct SpendChartDetail: View {
    @EnvironmentObject private var ledger: Ledger
    @State private var category = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Line", selection: $category) {
                Text("All lines").tag("")
                ForEach(ledger.currentBudgets.map(\.category), id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(.menu)
            SpendCapChart(months: ledger.monthlySpend(months: ledger.chartMonths, category: category.isEmpty ? nil : category))
        }
    }
}

/// Purchases from the small threshold in planned classes that no Buy check explains.
struct UnplannedView: View {
    @EnvironmentObject private var ledger: Ledger

    var body: some View {
        List(ledger.unplannedThisMonth) { line in
            HStack {
                VStack(alignment: .leading) {
                    Text(line.merchant ?? line.category)
                    Text("\(line.booked_on) · \(line.category)").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text(Money.format(line.outflow, line.currency)).monospacedDigit()
            }
        }
        .navigationTitle("No Buy check")
    }
}

struct BudgetForm: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.dismiss) private var dismiss
    @State private var category: String
    @State private var amountText: String
    @State private var error: String?

    init(category: String = "", amount: Double? = nil) {
        _category = State(initialValue: category)
        _amountText = State(initialValue: amount.map { String(Int($0.rounded())) } ?? "")
    }

    /// A slider from zero to twice the larger of the cap and your average, for a line that exists.
    private var sliderTop: Double? {
        guard !category.isEmpty, let cap = ledger.budget(for: category)?.monthly_amount else { return nil }
        return max(cap, ledger.average(in: category) ?? 0, 10) * 2
    }

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
                if let top = sliderTop {
                    Slider(value: Binding(get: { Money.parse(amountText) ?? 0 },
                                          set: { amountText = String(Int($0.rounded())) }),
                           in: 0...top, step: 1)
                    if let average = ledger.average(in: category), let months = ledger.averageMonths {
                        Text("Your \(months)-month average: \(Money.format(average, ledger.baseCurrency))").font(.caption).foregroundStyle(.secondary)
                    }
                }
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
