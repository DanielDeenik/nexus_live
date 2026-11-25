import Charts
import SwiftUI

struct ChartPoint: Identifiable {
    let date: Date
    let value: Double
    var id: Date { date }
}

struct BandPoint: Identifiable {
    let date: Date
    let low: Double
    let high: Double
    var id: Date { date }
}

enum ChartFormat {
    /// Axis labels without the currency sign: 83k, 1.2M.
    static func short(_ value: Double) -> String {
        value.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)))
    }
}

/// A small chart that opens full size on a tap.
struct ChartCard<Small: View, Large: View>: View {
    let title: String
    let caption: String?
    @ViewBuilder let small: () -> Small
    @ViewBuilder let large: () -> Large
    @State private var open = false

    var body: some View {
        Button { open = true } label: {
            VStack(alignment: .leading, spacing: 6) {
                small().frame(height: 120)
                if let caption { Text(caption).font(.caption2).foregroundStyle(.secondary) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $open) {
            NavigationStack {
                ScrollView { large().frame(height: 360).padding() }
                    .navigationTitle(title)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { open = false } } }
            }
        }
    }
}

/// Business income on its path to the target, the income your capital could pay, and the target.
struct MallorcaChart: View {
    let business: [ChartPoint]
    let capital: [ChartPoint]
    let target: Double
    var labelled = true

    var body: some View {
        Chart {
            ForEach(business) { p in
                LineMark(x: .value("Month", p.date), y: .value("Income", p.value), series: .value("Series", "Business"))
                    .foregroundStyle(Theme.accent)
            }
            ForEach(capital) { p in
                LineMark(x: .value("Month", p.date), y: .value("Income", p.value), series: .value("Series", "Capital"))
                    .foregroundStyle(Color.teal)
            }
            RuleMark(y: .value("Target", target))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                .foregroundStyle(.secondary)
                .annotation(position: .top, alignment: .leading) {
                    if labelled { Text("Target \(ChartFormat.short(target))").font(.caption2).foregroundStyle(.secondary) }
                }
            if labelled, let last = business.last {
                PointMark(x: .value("Month", last.date), y: .value("Income", last.value))
                    .foregroundStyle(Theme.accent)
                    .annotation(position: .leading) { Text("Business").font(.caption2).foregroundStyle(Theme.accent) }
            }
            if labelled, let last = capital.last {
                PointMark(x: .value("Month", last.date), y: .value("Income", last.value))
                    .foregroundStyle(Color.teal)
                    .annotation(position: .leading) { Text("Capital").font(.caption2).foregroundStyle(Color.teal) }
            }
        }
        .chartLegend(.hidden)
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine()
                AxisValueLabel { if let v = value.as(Double.self) { Text(ChartFormat.short(v)) } }
            }
        }
    }
}

/// Net worth on plan within the return band, and spending as now.
struct NetWorthChart: View {
    let band: [BandPoint]
    let onPlan: [ChartPoint]
    let asNow: [ChartPoint]
    var labelled = true

    var body: some View {
        Chart {
            ForEach(band) { p in
                AreaMark(x: .value("Month", p.date), yStart: .value("Low", p.low), yEnd: .value("High", p.high))
                    .foregroundStyle(Theme.accent.opacity(0.18))
            }
            ForEach(onPlan) { p in
                LineMark(x: .value("Month", p.date), y: .value("Net worth", p.value), series: .value("Series", "On plan"))
                    .foregroundStyle(Theme.accent)
            }
            ForEach(asNow) { p in
                LineMark(x: .value("Month", p.date), y: .value("Net worth", p.value), series: .value("Series", "As now"))
                    .foregroundStyle(Color.secondary)
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
            }
            if labelled, let last = onPlan.last {
                PointMark(x: .value("Month", last.date), y: .value("Net worth", last.value))
                    .foregroundStyle(Theme.accent)
                    .annotation(position: .leading) { Text("On plan").font(.caption2).foregroundStyle(Theme.accent) }
            }
            if labelled, let last = asNow.last {
                PointMark(x: .value("Month", last.date), y: .value("Net worth", last.value))
                    .foregroundStyle(Color.secondary)
                    .annotation(position: .leading) { Text("As now").font(.caption2).foregroundStyle(.secondary) }
            }
        }
        .chartLegend(.hidden)
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine()
                AxisValueLabel { if let v = value.as(Double.self) { Text(ChartFormat.short(v)) } }
            }
        }
    }
}

/// Spend per month against the plan's caps then.
struct SpendCapChart: View {
    let months: [MonthSpend]
    var labelled = true

    var body: some View {
        Chart {
            ForEach(months) { m in
                BarMark(x: .value("Month", m.month, unit: .month), y: .value("Spent", m.spent))
                    .foregroundStyle(m.cap > 0 && m.spent > m.cap ? Color.red.opacity(0.8) : Theme.accent.opacity(0.8))
            }
            ForEach(months) { m in
                LineMark(x: .value("Month", m.month, unit: .month), y: .value("Cap", m.cap), series: .value("Series", "Cap"))
                    .foregroundStyle(Color.primary.opacity(0.7))
                    .interpolationMethod(.stepCenter)
            }
            if labelled, let last = months.last, last.cap > 0 {
                PointMark(x: .value("Month", last.month, unit: .month), y: .value("Cap", last.cap))
                    .foregroundStyle(Color.primary.opacity(0.7))
                    .annotation(position: .top) { Text("Cap").font(.caption2).foregroundStyle(.secondary) }
            }
        }
        .chartLegend(.hidden)
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine()
                AxisValueLabel { if let v = value.as(Double.self) { Text(ChartFormat.short(v)) } }
            }
        }
    }
}

/// Recurring charges a month now and with the cut list applied.
struct RecurringChart: View {
    let now: [ChartPoint]
    let afterCuts: [ChartPoint]
    var labelled = true

    var body: some View {
        Chart {
            ForEach(now) { p in
                LineMark(x: .value("Month", p.date), y: .value("A month", p.value), series: .value("Series", "Now"))
                    .foregroundStyle(Color.secondary)
                    .interpolationMethod(.stepEnd)
            }
            ForEach(afterCuts) { p in
                LineMark(x: .value("Month", p.date), y: .value("A month", p.value), series: .value("Series", "After cuts"))
                    .foregroundStyle(Theme.accent)
                    .interpolationMethod(.stepEnd)
            }
            if labelled, let last = afterCuts.last {
                PointMark(x: .value("Month", last.date), y: .value("A month", last.value))
                    .foregroundStyle(Theme.accent)
                    .annotation(position: .bottom) { Text("After cuts").font(.caption2).foregroundStyle(Theme.accent) }
            }
            if labelled, let last = now.last {
                PointMark(x: .value("Month", last.date), y: .value("A month", last.value))
                    .foregroundStyle(Color.secondary)
                    .annotation(position: .top) { Text("Now").font(.caption2).foregroundStyle(.secondary) }
            }
        }
        .chartLegend(.hidden)
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine()
                AxisValueLabel { if let v = value.as(Double.self) { Text(ChartFormat.short(v)) } }
            }
        }
    }
}

/// A slider with its label and value, that saves when you let go.
struct SettingSlider: View {
    let title: String
    @Binding var value: Double
    let range: SliderRange
    let format: (Double) -> String
    let onRelease: (Double) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title).font(.subheadline)
                Spacer()
                Text(format(value)).font(.subheadline.monospacedDigit()).foregroundStyle(Theme.accent)
            }
            Slider(value: $value, in: range.closed, step: max(range.step, 0.0001), onEditingChanged: { editing in
                if !editing { onRelease(value) }
            })
        }
    }
}
