import SwiftUI

/// If/then/else rules and probability bets, scored with the Brier score once resolved.
struct DecideView: View {
    @EnvironmentObject private var ledger: Ledger
    @State private var mode = 0
    @State private var addingRule = false
    @State private var addingBet = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Picker("View", selection: $mode) {
                    Text("Rules").tag(0)
                    Text("Bets").tag(1)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)

                if mode == 0 { rules } else { bets }
            }
            .navigationTitle("Decide")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        if mode == 0 { addingRule = true } else { addingBet = true }
                    } label: { Image(systemName: "plus") }
                }
            }
            .refreshable { await ledger.reload() }
            .sheet(isPresented: $addingRule) { RuleForm() }
            .sheet(isPresented: $addingBet) { BetForm() }
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

    private func betRow(_ bet: Decision) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let area = bet.area { Text(area.uppercased()).font(.caption2).foregroundStyle(Theme.accent) }
            Text(bet.statement ?? "")
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
