import SwiftUI

/// The target, one tap down from Today: the Mallorca target as one number, business and capital
/// income under it, three sliders that redraw the path, safe to spend and what Skip and save has
/// kept, and at most three rows that need you. The + menu lives on Today.
struct TargetView: View {
    @EnvironmentObject private var ledger: Ledger
    @State private var growth = 0.0
    @State private var invest = 0.0
    @State private var returnPct = 0.0
    @State private var loaded = false

    var body: some View {
        List {
            hero
            sliders
            pills
            needsYou
        }
        .navigationTitle(ledger.goalName.isEmpty ? "Target" : ledger.goalName)
        .refreshable { await ledger.reload() }
        .onAppear(perform: load)
        .onChange(of: ledger.userSettings) { _, _ in if !loaded { load() } }
        .overlay { if ledger.loading && ledger.summary == nil { ProgressView() } }
    }

    private func load() {
        guard let g = ledger.growthPct, let r = ledger.returnPct else { return }
        growth = g
        returnPct = r
        invest = ledger.monthlyInvest ?? 0
        loaded = true
    }

    // MARK: Hero

    private var months: Int { ledger.monthsToTarget ?? 0 }

    private var businessPath: [ChartPoint] {
        guard let current = ledger.businessMonthly else { return [] }
        return dated(PlanMath.incomePath(current: current, growthPct: growth, months: months))
    }

    private var capitalPath: [ChartPoint] {
        guard let withdrawal = ledger.withdrawalPct else { return [] }
        let start = ledger.netWorthParts?.total ?? 0
        let path = PlanMath.capitalPath(start: max(0, start), monthly: invest, yearlyPct: returnPct, months: months)
        return dated(path.map { PlanMath.capitalIncome(capital: $0, withdrawalPct: withdrawal) })
    }

    private func dated(_ values: [Double]) -> [ChartPoint] {
        let start = Day.monthStart()
        return values.enumerated().compactMap { i, v in
            Calendar.current.date(byAdding: .month, value: i, to: start).map { ChartPoint(date: $0, value: v) }
        }
    }

    @ViewBuilder private var hero: some View {
        Section {
            if let target = ledger.targetMonthly, let date = ledger.targetDate {
                VStack(alignment: .leading, spacing: 4) {
                    Text(Money.format(target, ledger.baseCurrency) + " a month")
                        .font(.system(size: 34, weight: .bold, design: .rounded)).monospacedDigit()
                    Text("by \(date.formatted(date: .long, time: .omitted)), \(months) months from now")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                businessLine(target: target)
                capitalLine(target: target)
                if !businessPath.isEmpty {
                    ChartCard(title: "Mallorca income", caption: "Business on its path at your growth, and what your capital pays at the withdrawal rate. Tap for full size.") {
                        MallorcaChart(business: businessPath, capital: capitalPath, target: target, labelled: false)
                    } large: {
                        MallorcaChart(business: businessPath, capital: capitalPath, target: target)
                    }
                }
            } else {
                Text("Set your target in Settings, Target and assumptions.").foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private func businessLine(target: Double) -> some View {
        if let current = ledger.businessMonthly {
            let reach = businessPath.last?.value ?? current
            HStack(alignment: .firstTextBaseline) {
                Label("Business", systemImage: "briefcase").font(.subheadline.bold()).foregroundStyle(Theme.accent)
                Spacer()
                Text("\(Money.format(current, ledger.baseCurrency)) now").font(.subheadline.monospacedDigit())
            }
            Text(businessText(current: current, reach: reach, target: target)).font(.caption).foregroundStyle(.secondary)
        } else {
            Text("Business income shows once this year's invoices are in the plan.").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func businessText(current: Double, reach: Double, target: Double) -> String {
        var text = "At \(growth.formatted(.number.precision(.fractionLength(1))))% a month it reaches \(Money.format(reach, ledger.baseCurrency)) a month by the date"
        if let needed = ledger.neededGrowth {
            text += "; the target needs \(needed.formatted(.number.precision(.fractionLength(1))))% a month"
        }
        text += reach >= target ? ". On track." : "."
        return text
    }

    @ViewBuilder private func capitalLine(target: Double) -> some View {
        if let withdrawal = ledger.withdrawalPct {
            let pays = capitalPath.last?.value ?? 0
            HStack(alignment: .firstTextBaseline) {
                Label("Capital", systemImage: "building.columns").font(.subheadline.bold()).foregroundStyle(.teal)
                Spacer()
                Text("\(Money.format(capitalPath.first?.value ?? 0, ledger.baseCurrency)) a month now").font(.subheadline.monospacedDigit())
            }
            let needed = PlanMath.capitalNeeded(monthly: target, withdrawalPct: withdrawal)
            Text("Investing \(Money.format(invest, ledger.baseCurrency)) a month at \(returnPct.formatted(.number.precision(.fractionLength(1))))% it pays \(Money.format(pays, ledger.baseCurrency)) a month by the date, at a \(withdrawal.formatted(.number.precision(.fractionLength(1))))% withdrawal rate. Capital alone needs \(needed.map { Money.format($0, ledger.baseCurrency) } ?? "?").")
                .font(.caption).foregroundStyle(.secondary)
            if let note = ledger.netWorthParts?.note {
                Text(note).font(.caption2).foregroundStyle(.orange)
            }
        }
    }

    // MARK: Sliders

    @ViewBuilder private var sliders: some View {
        if loaded {
            Section {
                if let range = ledger.range("plan.business_growth_range") {
                    SettingSlider(title: "Business growth a month", value: $growth, range: range,
                                  format: { "\($0.formatted(.number.precision(.fractionLength(1))))%" }) { v in
                        Task { await ledger.setUserSetting("plan.business_growth_pct", v) }
                    }
                }
                if let step = ledger.effectiveNumber("plan.invest_step_eur") {
                    SettingSlider(title: "Invest a month", value: $invest, range: SliderRange(min: 0, max: ledger.investSliderMax, step: step),
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
            } footer: {
                Text("Return: long-run equities and housing returned about 7% a year after inflation (Jordà et al. 2019). Your settings, not a promise.")
            }
        }
    }

    // MARK: Pills

    private var pills: some View {
        Section {
            HStack(spacing: 10) {
                pill(title: "Safe to spend", value: ledger.summary.map { Money.format($0.safe_to_spend, ledger.baseCurrency) } ?? "…",
                     color: (ledger.summary?.safe_to_spend ?? 0) < 0 ? .red : Theme.accent)
                pill(title: "Skip and save", value: Money.format(ledger.skippedTotal, ledger.baseCurrency), color: .teal)
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        }
    }

    private func pill(title: String, value: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.headline.monospacedDigit()).foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    // MARK: Needs you (three rows at most)

    @ViewBuilder private var needsYou: some View {
        Section("Needs you") {
            if !ledger.unseenAlerts.isEmpty {
                NavigationLink { AlertsView() } label: {
                    row("Stop list and alerts", count: ledger.unseenAlerts.count, color: .red, icon: "exclamationmark.octagon")
                }
            }
            NavigationLink { SundayReviewView() } label: {
                row("Sunday review", count: ledger.reviewQueue.count, color: .orange, icon: "checklist")
            }
            if let month = closeDue {
                NavigationLink { CloseView() } label: {
                    row("Close \(month.formatted(.dateTime.month(.wide)))", count: nil, color: Theme.accent, icon: "lock.doc")
                }
            } else {
                NavigationLink { MeasuresView() } label: {
                    row("Seven numbers", count: nil, color: Theme.accent, icon: "gauge.with.dots.needle.33percent")
                }
            }
        }
    }

    /// Last month, while it is not closed yet.
    private var closeDue: Date? {
        guard let last = Calendar.current.date(byAdding: .month, value: -1, to: Day.monthStart()) else { return nil }
        return ledger.closes.contains { $0.month == Day.string(last) } ? nil : last
    }

    private func row(_ title: String, count: Int?, color: Color, icon: String) -> some View {
        HStack {
            Label(title, systemImage: icon)
            Spacer()
            if let count, count > 0 { Text(String(count)).font(.caption.bold()).foregroundStyle(color) }
        }
    }
}
