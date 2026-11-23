import SwiftUI

/// Record a business expense in a few taps: amount, category, save. Personal spending comes from the bank import.
struct LogView: View {
    @EnvironmentObject private var ledger: Ledger
    @State private var amountText = ""
    @State private var category = ""
    @State private var newCategory = ""
    @State private var note = ""
    @State private var date = Date()
    @State private var saving = false
    @State private var error: String?
    @State private var saved = 0
    @FocusState private var amountFocused: Bool

    private var amount: Double? { Money.parse(amountText) }
    private var chosenCategory: String {
        let typed = newCategory.trimmingCharacters(in: .whitespaces)
        return typed.isEmpty ? category : typed
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("0,00", text: $amountText)
                        .keyboardType(.decimalPad)
                        .font(.system(size: 44, weight: .semibold, design: .rounded))
                        .focused($amountFocused)
                    Text("Business expenses this month: \(Money.format(ledger.businessExpensesThisMonth, ledger.baseCurrency))")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Category") {
                    if !ledger.expenseCategories.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack {
                                ForEach(ledger.expenseCategories, id: \.self) { item in
                                    Button(item) { category = item; newCategory = "" }
                                        .buttonStyle(.bordered)
                                        .tint(item == category && newCategory.isEmpty ? Theme.accent : .secondary)
                                }
                            }
                        }
                    }
                    TextField("New category", text: $newCategory).textInputAutocapitalization(.never)
                }
                Section {
                    TextField("Note (optional)", text: $note)
                    DatePicker("Date", selection: $date, in: ...Date(), displayedComponents: .date)
                }
                Section {
                    Button {
                        save()
                    } label: {
                        HStack { Spacer(); Text(saving ? "Saving" : "Save business expense").bold(); Spacer() }
                    }
                    .disabled(saving || (amount ?? 0) <= 0 || chosenCategory.isEmpty)
                }
                Section("Recent") {
                    ForEach(ledger.expenses.prefix(15)) { expense in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(expense.vendor ?? expense.description ?? expense.category).lineLimit(1)
                                Text("\(expense.category) · \(expense.date)").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(Money.format(expense.amount, expense.currency)).monospacedDigit()
                        }
                    }
                }
            }
            .navigationTitle("Log")
            .refreshable { await ledger.reload() }
            .sensoryFeedback(.success, trigger: saved)
            .errorAlert($error)
            .onAppear { amountFocused = true }
        }
    }

    private func save() {
        guard let amount, amount > 0 else { return }
        saving = true
        Task {
            do {
                try await ledger.addExpense(amount: amount, category: chosenCategory, date: date,
                                            note: note.isEmpty ? nil : note)
                amountText = ""
                note = ""
                newCategory = ""
                date = Date()
                saved += 1
            } catch {
                self.error = error.localizedDescription
            }
            saving = false
        }
    }
}
