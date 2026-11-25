import SwiftUI
import Charts
import UniformTypeIdentifiers

/// Plan: net worth forecast as the one chart, with spending as now against on plan and the return
/// band; the sliders that move it; and one tap down the Mallorca income path, the recurring charges
/// with your cut list, and the tax year (bills, payments, reserve, structure).
struct PlanView: View {
    @EnvironmentObject private var ledger: Ledger
    @State private var invest = 0.0
    @State private var returnPct = 0.0
    @State private var withdrawal = 0.0
    @State private var loaded = false
    @State private var recordingNetWorth = false

    private var months: Int { (ledger.forecastYears ?? 0) * 12 }
    private var start: Double { max(0, ledger.netWorthParts?.total ?? 0) }

    private func dated(_ values: [Double]) -> [ChartPoint] {
        let first = Day.monthStart()
        return values.enumerated().compactMap { i, v in
            Calendar.current.date(byAdding: .month, value: i, to: first).map { ChartPoint(date: $0, value: v) }
        }
    }

    private var onPlan: [Double] { PlanMath.capitalPath(start: start, monthly: invest, yearlyPct: returnPct, months: months) }
    private var asNow: [Double] { PlanMath.capitalPath(start: start, monthly: max(0, invest - ledger.planGap), yearlyPct: returnPct, months: months) }

    private var band: [BandPoint] {
        let low = PlanMath.capitalPath(start: start, monthly: invest, yearlyPct: max(0, returnPct - ledger.returnBand), months: months)
        let high = PlanMath.capitalPath(start: start, monthly: invest, yearlyPct: returnPct + ledger.returnBand, months: months)
        return zip(dated(low), high).map { BandPoint(date: $0.date, low: $0.value, high: $1) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let last = onPlan.last, let years = ledger.forecastYears {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(Money.format(last, ledger.baseCurrency))
                                .font(.system(size: 34, weight: .bold, design: .rounded)).monospacedDigit()
                            Text("net worth in \(years) years on plan; \(Money.format(asNow.last ?? 0, ledger.baseCurrency)) if spending stays as now")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        ChartCard(title: "Net worth forecast", caption: "Band: return \(ledger.returnBand.formatted(.number.precision(.fractionLength(0...1)))) points either side. As now: your average spending above the plan comes out of the monthly invest. Starts from your accounts today.") {
                            NetWorthChart(band: band, onPlan: dated(onPlan), asNow: dated(asNow), labelled: false)
                        } large: {
                            NetWorthChart(band: band, onPlan: dated(onPlan), asNow: dated(asNow))
                        }
                    }
                }
                if loaded {
                    Section {
                        if let step = ledger.effectiveNumber("plan.invest_step_eur") {
                            SettingSlider(title: "Invest a month", value: $invest,
                                          range: SliderRange(min: 0, max: ledger.investSliderMax, step: step),
                                          format: { Money.format($0, ledger.baseCurrency) }) { v in
                                Task { await ledger.setUserSetting("invest.monthly_target_eur", v) }
                            }
                        }
                        if let range = ledger.range("plan.return_range") {
                            SettingSlider(title: "Return after inflation", value: $returnPct, range: range,
                                          format: { "\($0.formatted(.number.precision(.fractionLength(1))))% a year" }) { v in
                                Task { await ledger.setUserSetting("plan.return_real_pct", v) }
                            }
                        }
                        if let range = ledger.range("plan.withdrawal_range") {
                            SettingSlider(title: "Withdrawal rate", value: $withdrawal, range: range,
                                          format: { "\($0.formatted(.number.precision(.fractionLength(1))))% a year" }) { v in
                                Task { await ledger.setUserSetting("plan.withdrawal_rate_pct", v) }
                            }
                        }
                    } footer: {
                        Text("Every forecast shows its assumption: personal projections changed what people saved (Goda, Manchester and Sojourner 2014).")
                    }
                }
                Section {
                    NavigationLink { PurchaseReviewView() } label: { Label("Recurring charges and your cuts", systemImage: "arrow.triangle.2.circlepath") }
                    NavigationLink { TaxPlanView() } label: { Label("Tax year, payments and structure", systemImage: "building.columns") }
                    Button { recordingNetWorth = true } label: { Label("Record today's net worth", systemImage: "square.and.pencil") }
                }
            }
            .navigationTitle("Plan")
            .refreshable { await ledger.reload() }
            .sheet(isPresented: $recordingNetWorth) { NetWorthForm() }
            .onAppear(perform: load)
        }
    }

    private func load() {
        guard let r = ledger.returnPct, let w = ledger.withdrawalPct else { return }
        returnPct = r
        withdrawal = w
        invest = ledger.monthlyInvest ?? 0
        loaded = true
    }
}

/// The year ahead: days to bill, when each payment lands, the tax in it, what can be invested,
/// eenmanszaak against a BV, and what-ifs. Every number comes from the live forecast (nexus/forecast).
struct TaxPlanView: View {
    @EnvironmentObject private var ledger: Ledger
    @State private var editing = false
    @State private var importing = false
    @State private var reading = false
    @State private var importResult: String?
    @State private var error: String?

    var body: some View {
            List {
                if let forecast = ledger.forecast {
                    TaxYearSection(forecast: forecast, reserves: ledger.reserves)
                    PaymentsSection(forecast: forecast)
                    InvestSection()
                    if let next = forecast.next_year {
                        StructureSection(next: next)
                        NextYearSection(next: next)
                    }
                    WhatIfSection(forecast: forecast)
                    if !forecast.warnings.isEmpty {
                        WarningsSection(warnings: forecast.warnings)
                    }
                } else if let failure = ledger.forecastError {
                    Section { Text(failure).foregroundStyle(.secondary) }
                } else {
                    Section { ProgressView() }
                }
                invoicesSection
            }
            .navigationTitle("Tax year")
            .refreshable { await ledger.reload() }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") { editing = true }
                }
            }
            .sheet(isPresented: $editing) { PlanSettingsForm() }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.pdf, .png, .jpeg]) { result in
                readInvoice(result)
            }
            .errorAlert($error)
    }

    private var invoicesSection: some View {
        Section {
            Button(reading ? "Reading the invoice" : "Import an invoice (PDF or photo)") { importing = true }
                .disabled(reading)
            if let importResult {
                Text(importResult).font(.caption).foregroundStyle(.secondary)
            }
        } header: {
            Text("Invoices")
        } footer: {
            Text("The expense agent reads the invoice, adds it to your ledger and updates this plan. Anything unclear waits for your review.")
        }
    }

    private func readInvoice(_ result: Result<URL, Error>) {
        reading = true
        Task {
            do {
                importResult = try await ledger.importInvoice(try result.get())
            } catch {
                self.error = error.localizedDescription
            }
            reading = false
        }
    }
}

/// A label and a euro amount on one line.
struct EuroRow: View {
    let label: String
    let value: Double
    var bold = false

    var body: some View {
        HStack {
            Text(label).foregroundStyle(bold ? Color.primary : Color.secondary)
            Spacer()
            Text(Money.format(value, "EUR"))
                .monospacedDigit()
                .fontWeight(bold ? .bold : .regular)
        }
    }
}

struct TaxYearSection: View {
    let forecast: Forecast
    let reserves: [YearReserve]

    private var setAside: [YearReserve] { reserves.filter { $0.reserve_eur > 0 } }

    var body: some View {
        Section {
            ForEach(setAside) { reserve in
                EuroRow(label: "Set aside now for \(reserve.year)", value: reserve.reserve_eur, bold: true)
            }
            EuroRow(label: "Tax to pay for \(forecast.year)", value: forecast.year_end.to_pay, bold: setAside.isEmpty)
            if let hours = forecast.hours_per_day {
                Text(verbatim: "At \(hours.formatted()) hours a day until the year ends. Each payment still to come is \(Percent.format(forecast.set_aside_rate)) tax.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            EuroRow(label: "Billed through \(forecast.billed.through ?? "nothing yet")", value: forecast.billed.revenue_eur)
            if let remaining = forecast.remaining {
                EuroRow(label: "Still to bill: \(Int((remaining.working_days - remaining.days_off).rounded())) days, \(Int(remaining.hours.rounded())) h",
                        value: remaining.revenue_eur)
            }
            LabeledContent("Tax on each extra euro earned", value: Percent.format(forecast.marginal.revenue))
            LabeledContent("Tax saved per euro of business cost", value: Percent.format(forecast.marginal.cost))
            DisclosureGroup("Deductions in the year") { deductions }
            if let timeline = forecast.timeline {
                Text(verbatim: "File before \(timeline.file_before): from \(timeline.interest_from) the tax office charges \(Percent.format(timeline.interest_rate)) interest on what is still open.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } header: {
            Text(verbatim: "Tax \(forecast.year)")
        }
    }

    @ViewBuilder private var deductions: some View {
        let year = forecast.year_end
        EuroRow(label: "Zelfstandigenaftrek", value: year.zelfstandigenaftrek)
        EuroRow(label: "Startersaftrek", value: year.startersaftrek)
        EuroRow(label: "MKB-winstvrijstelling", value: year.mkb_winstvrijstelling)
        if year.kia > 0 {
            EuroRow(label: "Investment deduction (KIA)", value: year.kia)
        }
        EuroRow(label: "Depreciation and write-offs", value: year.depreciation_eur)
        EuroRow(label: "Business costs", value: year.costs_eur)
        Text(year.urencriterium_met ? "The hours criterion is met, so these deductions apply." : "The hours criterion is not met yet; the self-employed deductions depend on it.")
            .font(.caption).foregroundStyle(.secondary)
    }
}

struct PaymentsSection: View {
    let forecast: Forecast

    private struct Part: Identifiable {
        let month: String
        let part: String
        let amount: Double
        var id: String { month + "|" + part }
    }

    private var parts: [Part] {
        forecast.cash.filter { $0.payments_eur > 0 }.flatMap { cash -> [Part] in
            let label = MonthText.short(cash.month)
            return [
                Part(month: label, part: "Tax", amount: cash.tax_eur),
                Part(month: label, part: "Living", amount: cash.living_eur),
                Part(month: label, part: "Invest", amount: cash.invest_eur),
                Part(month: label, part: "Left", amount: cash.left_eur)
            ]
        }
    }

    var body: some View {
        Section {
            if !parts.isEmpty {
                Chart(parts) { part in
                    BarMark(x: .value("Month", part.month), y: .value("Euro", part.amount))
                        .foregroundStyle(by: .value("Part", part.part))
                }
                .chartForegroundStyleScale(["Tax": Color.red, "Living": Color.gray, "Invest": Theme.accent, "Left": Color.green])
                .frame(height: 220)
                .padding(.vertical, 4)
            }
            ForEach(forecast.months) { month in
                PaymentRow(month: month)
            }
        } header: {
            Text("Payments")
        } footer: {
            Text("Each bar is the money landing that month, split into tax, living costs from your budgets, investing and what is left. Payment dates follow how late the client paid before.")
        }
    }
}

struct PaymentRow: View {
    let month: WorkMonth

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title).font(.subheadline)
                Spacer()
                Text(Money.format(month.revenue_eur, "EUR")).monospacedDigit()
            }
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }
    }

    private var title: String {
        let name = MonthText.short(month.month)
        if let number = month.invoice_number { return "\(name) · \(number)" }
        return "\(name) · planned"
    }

    private var detail: String {
        let days = Int((month.working_days - month.days_off).rounded())
        let hours = Int(month.hours.rounded())
        return "\(days) days, \(hours) h · paid around \(month.payment_date) · tax in it \(Money.format(month.tax_eur, "EUR"))"
    }
}

struct InvestSection: View {
    @EnvironmentObject private var ledger: Ledger

    var body: some View {
        Section {
            if let amount = ledger.investThisMonth {
                HStack {
                    Text("Invest this month").bold()
                    Spacer()
                    Text(Money.format(amount, ledger.baseCurrency)).bold().monospacedDigit().foregroundStyle(Theme.accent)
                }
                if let target = ledger.userNumber("invest.monthly_target_eur") {
                    EuroRow(label: "Monthly target", value: target)
                }
                EuroRow(label: "Budget left unspent last month", value: ledger.underspendLastMonth)
                if let safe = ledger.summary?.safe_to_spend {
                    EuroRow(label: "Safe to spend now", value: safe)
                }
            } else {
                Text("Set a monthly investing target in Settings.").foregroundStyle(.secondary)
            }
        } header: {
            Text("Investing")
        } footer: {
            Text("The target plus the budget you did not spend last month, never more than safe to spend.")
        }
    }
}

struct StructureSection: View {
    @EnvironmentObject private var ledger: Ledger
    let next: NextYearPlan
    @State private var error: String?

    init(next: NextYearPlan) {
        self.next = next
    }

    private struct Bar: Identifiable {
        let structure: String
        let part: String
        let amount: Double
        var id: String { structure + "|" + part }
    }

    private var bars: [Bar] {
        (next.structures?.results ?? []).flatMap { result -> [Bar] in
            let name = Structure.named(result.label)?.short ?? result.label
            return [
                Bar(structure: name, part: "Tax", amount: result.tax_eur),
                Bar(structure: name, part: "To you", amount: result.net_to_you_eur),
                Bar(structure: name, part: "Kept in BV", amount: result.kept_in_bv_eur)
            ]
        }
    }

    private var choice: Binding<Structure> {
        Binding(get: { ledger.structure }, set: { choose($0) })
    }

    var body: some View {
        Section {
            Picker("Structure", selection: choice) {
                ForEach(Structure.allCases) { structure in
                    Text(structure.short).tag(structure)
                }
            }
            .pickerStyle(.segmented)
            .errorAlert($error)
            if let structures = next.structures {
                Chart(bars) { bar in
                    BarMark(x: .value("Structure", bar.structure), y: .value("Euro", bar.amount))
                        .foregroundStyle(by: .value("Part", bar.part))
                        .position(by: .value("Part", bar.part))
                }
                .chartForegroundStyleScale(["Tax": Color.red, "To you": Color.green, "Kept in BV": Theme.accent])
                .frame(height: 200)
                .padding(.vertical, 4)
                chosen(structures)
                Text(salaryNote(structures)).font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Set a director salary and the yearly BV costs in Settings to compare.").foregroundStyle(.secondary)
            }
        } header: {
            Text(verbatim: "Eenmanszaak or BV in \(next.year)")
        }
    }

    @ViewBuilder private func chosen(_ structures: StructureComparison) -> some View {
        let pick = structures.results.first { $0.label == ledger.structure.rawValue }
        let base = structures.results.first { $0.label == Structure.eenmanszaak.rawValue }
        if let pick {
            Text(ledger.structure.title).font(.subheadline.weight(.semibold))
            EuroRow(label: "Tax and levies", value: pick.tax_eur)
            EuroRow(label: "Net to you", value: pick.net_to_you_eur)
            if pick.kept_in_bv_eur > 0 {
                EuroRow(label: "Kept in the BV", value: pick.kept_in_bv_eur)
            }
            if let base, base.label != pick.label {
                EuroRow(label: "More than the eenmanszaak", value: (pick.net_to_you_eur + pick.kept_in_bv_eur) - (base.net_to_you_eur + base.kept_in_bv_eur), bold: true)
            }
        }
    }

    private func salaryNote(_ structures: StructureComparison) -> String {
        let salary = Money.format(structures.salary_eur, "EUR")
        if structures.salary_raised_to_minimum {
            return "The BV pays you \(salary), the legal minimum for a director who owns it. BV running costs from Settings are included. Your choice here is saved; nothing changes at the Chamber of Commerce."
        }
        return "The BV pays you \(salary) salary; the rest is paid out as dividend or stays in the BV. BV running costs from Settings are included. Your choice here is saved; nothing changes at the Chamber of Commerce."
    }

    private func choose(_ structure: Structure) {
        Task {
            do {
                try await ledger.setSetting("plan.structure", structure.rawValue)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

struct NextYearSection: View {
    let next: NextYearPlan

    var body: some View {
        Section {
            EuroRow(label: "Tax for the year", value: next.figures.total_due, bold: true)
            EuroRow(label: "Set aside each month", value: next.monthly_set_aside_eur)
            EuroRow(label: "Revenue at your hours", value: next.figures.revenue_eur)
            LabeledContent("Working days", value: String(Int((next.working_days - next.days_off).rounded())))
            if next.indicative {
                Text(verbatim: "Uses the \(next.params_year) tax rules until the \(next.year) rules are loaded.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } header: {
            Text(verbatim: "Next year, \(next.year)")
        }
    }
}

struct WhatIfSection: View {
    @EnvironmentObject private var ledger: Ledger
    let forecast: Forecast
    @State private var hours: Double = 0
    @State private var daysOff: Double = 0
    @State private var cost = ""
    @State private var investment = ""
    @State private var lijfrente = ""
    @State private var running = false
    @State private var loaded = false

    init(forecast: Forecast) {
        self.forecast = forecast
    }

    private struct Bar: Identifiable {
        let item: String
        let scenario: String
        let amount: Double
        var id: String { item + "|" + scenario }
    }

    var body: some View {
        Section {
            Stepper(value: $hours, in: 0...12, step: 0.5) {
                Text(verbatim: "Hours a day: \(hours.formatted())")
            }
            Stepper(value: $daysOff, in: 0...60, step: 1) {
                Text(verbatim: "Days off before the year ends: \(Int(daysOff))")
            }
            TextField("Extra business cost (EUR)", text: $cost).keyboardType(.decimalPad)
            TextField("Investment in the business (EUR)", text: $investment).keyboardType(.decimalPad)
            TextField("Lijfrente premium this year (EUR)", text: $lijfrente).keyboardType(.decimalPad)
            Button(running ? "Working it out" : "Show the effect") { run() }.disabled(running)
            if let what = ledger.whatIf {
                result(what)
            }
        } header: {
            Text("What if")
        } footer: {
            Text("A what-if is never saved. Change Settings to make it your plan.")
        }
        .onAppear {
            guard !loaded else { return }
            hours = forecast.hours_per_day ?? 0
            daysOff = forecast.remaining?.days_off ?? 0
            loaded = true
        }
    }

    @ViewBuilder private func result(_ what: Forecast) -> some View {
        compare("Revenue \(forecast.year)", forecast.year_end.revenue_eur, what.year_end.revenue_eur)
        compare("Tax to pay for \(forecast.year)", forecast.year_end.to_pay, what.year_end.to_pay)
        if let now = forecast.next_year, let then = what.next_year {
            compare("Tax for \(now.year)", now.figures.total_due, then.figures.total_due)
        }
        Chart(bars(what)) { bar in
            BarMark(x: .value("Item", bar.item), y: .value("Euro", bar.amount))
                .foregroundStyle(by: .value("Case", bar.scenario))
                .position(by: .value("Case", bar.scenario))
        }
        .chartForegroundStyleScale(["Now": Color.gray, "What if": Theme.accent])
        .frame(height: 180)
        .padding(.vertical, 4)
    }

    private func bars(_ what: Forecast) -> [Bar] {
        var out = [
            Bar(item: "Revenue", scenario: "Now", amount: forecast.year_end.revenue_eur),
            Bar(item: "Revenue", scenario: "What if", amount: what.year_end.revenue_eur),
            Bar(item: "Tax", scenario: "Now", amount: forecast.year_end.to_pay),
            Bar(item: "Tax", scenario: "What if", amount: what.year_end.to_pay)
        ]
        if let now = forecast.next_year, let then = what.next_year {
            out.append(Bar(item: "Tax \(now.year)", scenario: "Now", amount: now.figures.total_due))
            out.append(Bar(item: "Tax \(now.year)", scenario: "What if", amount: then.figures.total_due))
        }
        return out
    }

    private func compare(_ label: String, _ now: Double, _ then: Double) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            VStack(alignment: .trailing, spacing: 1) {
                Text(Money.format(then, "EUR")).monospacedDigit().bold()
                Text(verbatim: "now \(Money.format(now, "EUR"))").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private func run() {
        running = true
        var values: [String: Double] = ["hours_per_day": hours, "days_off": daysOff]
        if let x = Money.parse(cost), x > 0 { values["extra_cost_eur"] = x }
        if let x = Money.parse(investment), x > 0 { values["extra_investment_eur"] = x }
        if let x = Money.parse(lijfrente), x > 0 { values["lijfrente_eur"] = x }
        Task {
            await ledger.runWhatIf(values)
            running = false
        }
    }
}

struct WarningsSection: View {
    let warnings: [ForecastWarning]

    var body: some View {
        Section("Check") {
            ForEach(warnings) { warning in
                Label(warning.message, systemImage: warning.severity == "info" ? "info.circle" : "exclamationmark.triangle")
                    .font(.caption)
            }
        }
    }
}

/// Hours, days off, the investing target and the BV figures: the plan's own settings.
struct PlanSettingsForm: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.dismiss) private var dismiss
    @State private var hours = ""
    @State private var daysOffNow = ""
    @State private var daysOffNext = ""
    @State private var invest = ""
    @State private var salary = ""
    @State private var bvCosts = ""
    @State private var saving = false
    @State private var error: String?

    private var year: Int { Calendar.current.component(.year, from: Date()) }

    var body: some View {
        NavigationStack {
            Form {
                Section("Work") {
                    field("Hours a day", $hours)
                    field("Days off before \(year) ends", $daysOffNow)
                    field("Days off in \(year + 1)", $daysOffNext)
                }
                Section("Investing") {
                    field("Monthly target (EUR)", $invest)
                }
                Section {
                    field("Director salary a year (EUR)", $salary)
                    field("BV running costs a year (EUR)", $bvCosts)
                } header: {
                    Text("BV comparison")
                } footer: {
                    Text("Leave a field empty to keep the current value.")
                }
            }
            .navigationTitle("Plan settings")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving" : "Save") { save() }.disabled(saving)
                }
            }
            .onAppear(perform: load)
            .errorAlert($error)
        }
    }

    private func field(_ label: String, _ text: Binding<String>) -> some View {
        HStack {
            Text(label)
            Spacer()
            TextField("", text: text)
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 120)
        }
    }

    private func plain(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(value)
    }

    private func load() {
        if let current = ledger.userNumber("plan.hours_per_day") ?? ledger.forecast?.hours_per_day { hours = plain(current) }
        daysOffNow = plain(ledger.daysOff(in: year))
        daysOffNext = plain(ledger.daysOff(in: year + 1))
        invest = ledger.userNumber("invest.monthly_target_eur").map(plain) ?? ""
        salary = ledger.userNumber("bv.dga_salary_eur").map(plain) ?? ""
        bvCosts = ledger.userNumber("bv.annual_costs_eur").map(plain) ?? ""
    }

    private func save() {
        saving = true
        Task {
            do {
                try await ledger.savePlan(hoursPerDay: Money.parse(hours), daysOffThisYear: Money.parse(daysOffNow),
                                          daysOffNextYear: Money.parse(daysOffNext), investTarget: Money.parse(invest),
                                          dgaSalary: Money.parse(salary), bvCosts: Money.parse(bvCosts))
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            saving = false
        }
    }
}
