import SwiftUI

private let callLabels: [String: String] = ["keep": "Keep", "cancel": "Cancel", "move_business": "Business"]
private let tagLabels: [String: String] = ["social_arb": "Social Arb", "net_worth": "Net worth", "life": "Life", "cut": "Cut"]
private let statusLabels: [String: String] = [
    "to_cancel": "To cancel", "requested": "Requested", "confirmed": "Confirmed", "charged_after_cancel": "Charged after cancel"
]

// MARK: Purchase review

/// Every recurring charge with your call: keep, cancel by a date, or move to business, and a tag.
/// Cancel opens the exact place to do it; cancelling stays your action.
struct PurchaseReviewView: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?

    private var cutsPerYear: Double { ledger.recurring.filter(\.isCut).reduce(0) { $0 + ($1.per_year ?? 0) } }

    private var chart: (now: [ChartPoint], cut: [ChartPoint]) {
        let start = Day.monthStart()
        let items = ledger.recurring.filter { $0.status != "confirmed" || $0.call != "cancel" }.map { c in
            (perMonth: c.perMonth, cancelFrom: c.isCut ? (c.cancel_by.flatMap { Day.date($0) } ?? Calendar.current.date(byAdding: .month, value: 1, to: start)) : nil)
        }
        let series = PlanMath.recurringByMonth(items: items, months: ledger.chartMonths, start: start)
        let dates = (0..<series.now.count).compactMap { Calendar.current.date(byAdding: .month, value: $0, to: start) }
        return (zip(dates, series.now).map { ChartPoint(date: $0, value: $1) }, zip(dates, series.afterCuts).map { ChartPoint(date: $0, value: $1) })
    }

    private func section(_ title: String, _ rows: [RecurringCharge]) -> some View {
        Section(title) {
            ForEach(rows) { charge in
                NavigationLink { RecurringDetail(charge: charge) } label: { RecurringRow(charge: charge) }
                    .swipeActions(edge: .trailing) {
                        Button("Cancel") { set(charge, "cancel") }.tint(.red)
                        Button("Business") { set(charge, "move_business") }.tint(.blue)
                    }
                    .swipeActions(edge: .leading) {
                        Button("Keep") { set(charge, "keep") }.tint(.green)
                    }
            }
        }
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text(Money.format(cutsPerYear, ledger.baseCurrency) + " a year cut")
                        .font(.system(size: 28, weight: .bold, design: .rounded)).monospacedDigit()
                    if let r = ledger.returnPct, let years = ledger.forecastYears {
                        let worth = PlanMath.capitalPath(start: 0, monthly: cutsPerYear / 12, yearlyPct: r, months: years * 12).last ?? 0
                        Text("About \(Money.format(worth, ledger.baseCurrency)) after \(years) years at \(r.formatted(.number.precision(.fractionLength(1))))% after inflation.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                if !ledger.recurring.isEmpty {
                    let c = chart
                    ChartCard(title: "Recurring charges", caption: "A month now and with your cut list. Tap for full size.") {
                        RecurringChart(now: c.now, afterCuts: c.cut, labelled: false)
                    } large: {
                        RecurringChart(now: c.now, afterCuts: c.cut)
                    }
                }
            } footer: {
                Text("People overestimate how soon they will cancel a contract that renews by itself, and keep paying meanwhile (DellaVigna and Malmendier 2006). Swipe right to keep, left to cancel or move to business.")
            }
            if ledger.recurring.isEmpty {
                Text("Recurring charges appear after the next bank sync or import.").foregroundStyle(.secondary)
            }
            let open = ledger.recurring.filter { $0.call == nil }
            if !open.isEmpty { section("To decide", open) }
            let cuts = ledger.recurring.filter(\.isCut)
            if !cuts.isEmpty { section("Cancel", cuts) }
            let business = ledger.recurring.filter { $0.call == "move_business" }
            if !business.isEmpty { section("Move to business", business) }
            let keep = ledger.recurring.filter { $0.call == "keep" }
            if !keep.isEmpty { section("Keep", keep) }
        }
        .navigationTitle("Purchase review")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        .refreshable { await ledger.reloadSpend() }
        .errorAlert($error)
    }

    private func set(_ charge: RecurringCharge, _ call: String) {
        Task {
            do { try await ledger.setCall(charge, call: call, tag: call == "cancel" ? "cut" : charge.tag, cancelBy: nil) }
            catch { self.error = error.localizedDescription }
        }
    }
}

struct RecurringRow: View {
    @EnvironmentObject private var ledger: Ledger
    let charge: RecurringCharge

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(charge.label).lineLimit(1)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(charge.per_year.map { Money.format($0, ledger.baseCurrency) + " a year" } ?? "").font(.caption.monospacedDigit())
                if let call = charge.shownCall {
                    Text((charge.call == nil ? "Suggested: " : "") + (callLabels[call] ?? call))
                        .font(.caption2.bold())
                        .foregroundStyle(call == "cancel" ? Color.red : call == "keep" ? Color.green : Color.blue)
                }
            }
        }
    }

    private var detail: String {
        var parts = [charge.cadence.capitalized]
        if let amount = charge.amount { parts.append(Money.format(amount, ledger.baseCurrency)) }
        if let status = charge.status { parts.append(statusLabels[status] ?? status) }
        else if let next = charge.next_due { parts.append("next \(next)") }
        return parts.joined(separator: " · ")
    }
}

/// One recurring charge: your call and tag, and for a cancel the exact place, the steps, the trap,
/// a drafted notice where a provider wants one, the status and the way back after a wrong charge.
struct RecurringDetail: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss
    let charge: RecurringCharge
    @State private var call: String
    @State private var tag: String
    @State private var cancelBy: Date
    @State private var error: String?

    init(charge: RecurringCharge) {
        self.charge = charge
        _call = State(initialValue: charge.call ?? charge.proposed_call ?? "")
        _tag = State(initialValue: charge.tag ?? "")
        _cancelBy = State(initialValue: charge.cancel_by.flatMap { Day.date($0) } ?? charge.next_due.flatMap { Day.date($0) } ?? Date())
    }

    var body: some View {
        Form {
            Section {
                LabeledContent("How often", value: charge.cadence.capitalized)
                if let amount = charge.amount { LabeledContent("Each charge", value: Money.format(amount, ledger.baseCurrency)) }
                if let year = charge.per_year { LabeledContent("A year", value: Money.format(year, ledger.baseCurrency)) }
                LabeledContent("Paid this year", value: Money.format(charge.paid_this_year, ledger.baseCurrency))
                if let last = charge.last_charge { LabeledContent("Last charge", value: last) }
                if let next = charge.next_due { LabeledContent("Next charge", value: next) }
                if let note = charge.note { Text(note).font(.caption).foregroundStyle(.secondary) }
            }
            Section("Your call") {
                Picker("Call", selection: $call) {
                    Text("Not decided").tag("")
                    ForEach(["keep", "cancel", "move_business"], id: \.self) { Text(callLabels[$0] ?? $0).tag($0) }
                }
                Picker("Serves", selection: $tag) {
                    Text("Not tagged").tag("")
                    ForEach(["social_arb", "net_worth", "life", "cut"], id: \.self) { Text(tagLabels[$0] ?? $0).tag($0) }
                }
                if call == "cancel" {
                    DatePicker("Cancel by", selection: $cancelBy, displayedComponents: .date)
                }
                if call == "move_business" {
                    Text("Business only by your rule: paid from the business account, with the invoice in your business name and your VAT number.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if charge.call == "cancel" { assist }
        }
        .navigationTitle(charge.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { save() }.disabled(call == (charge.call ?? "") && tag == (charge.tag ?? "") && call != "cancel")
            }
        }
        .errorAlert($error)
    }

    @ViewBuilder private var assist: some View {
        if let route = ledger.route(for: charge) {
            Section("Cancel it: \(route.label)") {
                if let steps = route.steps { Text(steps) }
                if let trap = route.trap { Label(trap, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange) }
                if let link = route.url, let url = URL(string: link) {
                    Button { openURL(url) } label: { Label(route.route == "bank" ? "Open the bank" : "Open the cancel page", systemImage: "arrow.up.right.square") }
                }
                if route.route == "notice" || route.notice_to != nil, let mail = noticeURL(route) {
                    Button { openURL(mail) } label: { Label("Draft the notice email", systemImage: "envelope") }
                }
            }
        }
        Section("Status") {
            ForEach(["to_cancel", "requested", "confirmed", "charged_after_cancel"], id: \.self) { status in
                Button {
                    Task {
                        do { try await ledger.setCancelStatus(charge, status) } catch { self.error = error.localizedDescription }
                    }
                } label: {
                    HStack {
                        Text(statusLabels[status] ?? status)
                        Spacer()
                        if charge.status == status { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
                    }
                }
            }
            if charge.status == "charged_after_cancel" {
                Text("A SEPA direct debit can be reversed at your bank within 8 weeks. Apple refunds go through Report a Problem; an Amex charge through a dispute in the Amex app.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func noticeURL(_ route: CancelRoute) -> URL? {
        let subject = "Cancellation: \(charge.label)"
        let body = "Hello,\n\nPlease cancel my \(charge.label) at the end of the current term and confirm the end date by email.\n\nKind regards,"
        var parts = URLComponents()
        parts.scheme = "mailto"
        parts.path = route.notice_to ?? ""
        parts.queryItems = [URLQueryItem(name: "subject", value: subject), URLQueryItem(name: "body", value: body)]
        return parts.url
    }

    private func save() {
        Task {
            do {
                try await ledger.setCall(charge, call: call.isEmpty ? nil : call, tag: tag.isEmpty ? nil : tag,
                                         cancelBy: call == "cancel" ? cancelBy : nil)
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}

// MARK: Alerts

struct AlertsView: View {
    @EnvironmentObject private var ledger: Ledger

    var body: some View {
        List {
            if ledger.alerts.isEmpty { Text("No alerts.").foregroundStyle(.secondary) }
            ForEach(ledger.alerts) { alert in
                VStack(alignment: .leading, spacing: 4) {
                    Text(alert.title).bold().foregroundStyle(alert.seen_at == nil ? Color.primary : Color.secondary)
                    if let detail = alert.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
                    Text(String(alert.created_at.prefix(10))).font(.caption2).foregroundStyle(.secondary)
                }
                .swipeActions { if alert.seen_at == nil { Button("Seen") { Task { await ledger.markSeen([alert]) } }.tint(.gray) } }
            }
        }
        .navigationTitle("Alerts")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("All seen") { Task { await ledger.markSeen(ledger.alerts) } }.disabled(ledger.unseenAlerts.isEmpty)
            }
        }
    }
}

// MARK: Sunday review

/// Ten minutes on Sunday: clear the review queue (each answer can become a rule), last week's
/// decisions and impulses, stop-list breaches, and the plan gap.
struct SundayReviewView: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.dismiss) private var dismiss
    @State private var confirming: ReviewLine?

    private var weekAgo: String { Day.string(Calendar.current.date(byAdding: .day, value: -7, to: Date()) ?? Date()) }
    private var checks: [Decision] { ledger.purchaseChecks.filter { $0.created_at >= weekAgo } }
    private var impulses: [WalletTap] { ledger.taps.filter { $0.planned == false && $0.tapped_at >= weekAgo } }
    private var breaches: [AlertItem] { ledger.alerts.filter { $0.created_at >= weekAgo } }
    private var firstSundayOfMonth: Bool { Calendar.current.component(.day, from: Date()) <= 7 }

    var body: some View {
        List {
            Section {
                if ledger.reviewQueue.isEmpty { Text("Nothing waits for a category.").foregroundStyle(.secondary) }
                ForEach(ledger.reviewQueue.prefix(25)) { line in
                    Button { confirming = line } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(line.shop).lineLimit(1)
                                Text("\(line.booked_on) · \(line.category)").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(Money.format(-line.amount, line.currency)).monospacedDigit()
                        }
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                Text("Review queue: \(ledger.reviewQueue.count)")
            } footer: {
                Text("Tap a line to give it a category; Always for this shop makes it a rule, so the queue gets shorter every week.")
            }
            Section("Last 7 days") {
                LabeledContent("Buy checks", value: String(checks.count))
                LabeledContent("Skipped and saved", value: Money.format(checks.filter { $0.purchase_status == "dropped" }.reduce(0) { $0 + ($1.amount ?? 0) }, ledger.baseCurrency))
                LabeledContent("Impulse taps", value: String(impulses.count))
                ForEach(impulses.prefix(5)) { tap in
                    HStack {
                        Text(tap.merchant).font(.caption)
                        Spacer()
                        Text(tap.amount.map { Money.format($0, tap.currency) } ?? "").font(.caption.monospacedDigit())
                    }
                }
                LabeledContent("Stop-list breaches", value: String(breaches.count))
                    .foregroundStyle(breaches.isEmpty ? Color.primary : Color.red)
            }
            Section("Plan") {
                LabeledContent("Spent this month", value: Money.format(ledger.spentThisMonth, ledger.baseCurrency))
                LabeledContent("Plan for the month", value: Money.format(ledger.planTotal, ledger.baseCurrency))
                let over = ledger.currentBudgets.filter { $0.monthly_amount >= 0 && ledger.spent(in: $0.category) > $0.monthly_amount }
                if !over.isEmpty {
                    Text("Over the cap: " + over.map(\.category).joined(separator: ", ")).font(.caption).foregroundStyle(.orange)
                }
                if firstSundayOfMonth {
                    NavigationLink("Monthly purchase review") { PurchaseReviewView() }
                }
            }
        }
        .navigationTitle("Sunday review")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") {
                    Task { await ledger.markSeen(breaches) }
                    dismiss()
                }
            }
        }
        .sheet(item: $confirming) { line in ConfirmLineForm(line: line) }
        .refreshable { await ledger.reload() }
    }
}

struct ConfirmLineForm: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.dismiss) private var dismiss
    let line: ReviewLine
    @State private var category = ""
    @State private var always = true
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Shop", value: line.shop)
                    LabeledContent("Amount", value: Money.format(-line.amount, line.currency))
                    LabeledContent("Date", value: line.booked_on)
                }
                Section {
                    Picker("Category", selection: $category) {
                        Text("Pick one").tag("")
                        ForEach(ledger.categories, id: \.self) { Text($0).tag($0) }
                    }
                    Toggle("Always for this shop", isOn: $always)
                }
            }
            .navigationTitle("Category")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            do {
                                try await ledger.confirm(line, category: category, always: always)
                                dismiss()
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                    .disabled(category.isEmpty)
                }
            }
            .errorAlert($error)
        }
    }
}

// MARK: Monthly close

/// The 1st working day: receipt coverage, open lines and the VAT draft for the month; you approve,
/// the month is recorded and its receipts go to the Drive archive.
struct CloseView: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.dismiss) private var dismiss
    @State private var month: Date = Calendar.current.date(byAdding: .month, value: -1, to: Day.monthStart()) ?? Date()
    @State private var busy = false
    @State private var message: String?
    @State private var error: String?

    private var choices: [Date] {
        (1...6).compactMap { Calendar.current.date(byAdding: .month, value: -$0, to: Day.monthStart()) }
    }

    private var closed: MonthClose? { ledger.closes.first { $0.month == Day.string(month) } }

    var body: some View {
        Form {
            Picker("Month", selection: $month) {
                ForEach(choices, id: \.self) { Text($0.formatted(.dateTime.month(.wide).year())).tag($0) }
            }
            if let closed {
                Section("Closed \(String(closed.closed_at.prefix(10)))") { figures(closed.figures) }
            }
            Section {
                Button(busy ? "Closing…" : (closed == nil ? "Approve and close" : "Close again")) { close() }.disabled(busy)
            } footer: {
                Text("Closing records the figures and copies the month's lines and receipt photos to the Drive archive. Business receipts stay in Moneybird.")
            }
        }
        .navigationTitle("Monthly close")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        .alert("Monthly close", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK", role: .cancel) { message = nil }
        } message: { Text(message ?? "") }
        .errorAlert($error)
    }

    @ViewBuilder private func figures(_ f: CloseFigures) -> some View {
        LabeledContent("Business costs with invoice", value: f.invoice_coverage_pct.map { "\($0.formatted(.number.precision(.fractionLength(0...1))))%" } ?? "none")
        LabeledContent("Business costs", value: Money.format(f.business_costs_eur, ledger.baseCurrency))
        LabeledContent("Lines still open", value: "\(f.lines_open) of \(f.lines)")
        LabeledContent("Food lines with a receipt", value: "\(f.food_lines_with_receipt) of \(f.food_lines)")
        if let vat = f.vat {
            LabeledContent("VAT \(vat.period)", value: vat.payable.map { Money.format($0, ledger.baseCurrency) } ?? "draft")
        }
    }

    private func close() {
        busy = true
        Task {
            do { message = try await ledger.closeMonth(month) } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

// MARK: Seven numbers

/// Seven numbers that say whether the process and the habit work; targets for the first 90 days.
struct MeasuresView: View {
    @EnvironmentObject private var ledger: Ledger

    private var targets: MeasureTargets? { ledger.decoded("measures.targets", as: MeasureTargets.self) }

    private var buyCheckPct: Double? {
        guard let small = ledger.number("purchase.small_below") else { return nil }
        let planned = ledger.thisMonth.filter { ledger.plannedClasses.contains($0.txClass) && $0.outflow >= small }
        guard !planned.isEmpty else { return nil }
        return Double(planned.count - ledger.unplannedThisMonth.count) / Double(planned.count) * 100
    }

    /// Full months since the plan started in which spending stayed inside the caps.
    private var monthsInside: (inside: Int, of: Int) {
        let months = ledger.monthlySpend(months: ledger.chartMonths).dropLast()
        let start = ledger.budgets.map(\.valid_from).min() ?? ""
        let counted = months.filter { $0.cap > 0 && Day.string($0.month) >= String(start.prefix(7)) + "-01" }
        return (counted.filter { $0.spent <= $0.cap }.count, counted.count)
    }

    var body: some View {
        List {
            Section {
                measure("Business cost value with its invoice", ledger.measures?.invoice_coverage_pct.map { pct($0) } ?? "…",
                        target: targets.map { pct($0.invoice_coverage_pct) })
                measure("Lines untagged after \(ledger.measures?.untagged_days ?? 0) days", ledger.measures.map { String($0.untagged_older) } ?? "…",
                        target: targets.map { String(Int($0.untagged_older)) })
                measure("Planned purchases with a Buy check", buyCheckPct.map { pct($0) } ?? "none yet",
                        target: targets.map { pct($0.buy_check_pct) })
                measure("Skip and save this month", Money.format(ledger.keptThisMonth, ledger.baseCurrency), target: nil)
                measure("Months inside the plan", "\(monthsInside.inside) of \(monthsInside.of)", target: nil)
                measure("Hidden shops this month", Money.format(ledger.hiddenThisMonth, ledger.baseCurrency),
                        target: targets.map { Money.format($0.hidden_eur_month, ledger.baseCurrency) })
                measure("Minutes in Nexus this week", String(Int(UsageClock.shared.minutesThisWeek.rounded())),
                        target: targets.map { "under \(Int($0.minutes_week))" })
            } footer: {
                Text("Success is fewer minutes in the app, not more. Monitoring progress raised goal attainment across 138 experiments (Harkin et al. 2016).")
            }
        }
        .navigationTitle("Seven numbers")
        .refreshable { await ledger.reloadSpend() }
    }

    private func pct(_ v: Double) -> String { "\(v.formatted(.number.precision(.fractionLength(0...1))))%" }

    private func measure(_ title: String, _ value: String, target: String?) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let target { Text("Target \(target)").font(.caption2).foregroundStyle(.secondary) }
            }
            Spacer()
            Text(value).font(.headline.monospacedDigit()).foregroundStyle(Theme.accent)
        }
    }
}
