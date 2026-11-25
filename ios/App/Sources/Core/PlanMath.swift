import Foundation

/// The arithmetic behind the Mallorca target, the forecasts and the Buy check, kept free of UI
/// so it can be checked on its own. Rates are percentages (4.0 means 4%); every input comes
/// from a setting or from your own data.
enum PlanMath {
    /// Whole months from one date to another (0 when the end is not later).
    static func months(from start: Date, to end: Date, calendar: Calendar = Calendar(identifier: .gregorian)) -> Int {
        max(0, calendar.dateComponents([.month], from: start, to: end).month ?? 0)
    }

    /// Monthly growth (percent) that takes `current` to `target` in `months`.
    static func requiredGrowth(current: Double, target: Double, months: Int) -> Double? {
        guard current > 0, target > 0, months > 0 else { return nil }
        return (pow(target / current, 1 / Double(months)) - 1) * 100
    }

    /// Income each month from now (month 0) on, growing by `growthPct` a month.
    static func incomePath(current: Double, growthPct: Double, months: Int) -> [Double] {
        (0...max(0, months)).map { current * pow(1 + growthPct / 100, Double($0)) }
    }

    /// Capital that pays `monthly` a month at the withdrawal rate.
    static func capitalNeeded(monthly: Double, withdrawalPct: Double) -> Double? {
        guard withdrawalPct > 0 else { return nil }
        return monthly * 12 / (withdrawalPct / 100)
    }

    /// What a capital pays a month at the withdrawal rate.
    static func capitalIncome(capital: Double, withdrawalPct: Double) -> Double {
        max(0, capital) * withdrawalPct / 100 / 12
    }

    /// Monthly rate equal to a yearly return (compounded).
    static func monthlyRate(yearlyPct: Double) -> Double {
        pow(1 + yearlyPct / 100, 1.0 / 12) - 1
    }

    /// Capital at the end of each month: start, plus the contribution each month, growing at the return.
    static func capitalPath(start: Double, monthly: Double, yearlyPct: Double, months: Int) -> [Double] {
        let r = monthlyRate(yearlyPct: yearlyPct)
        var value = start
        var out = [value]
        for _ in 0..<max(0, months) {
            value = value * (1 + r) + monthly
            out.append(value)
        }
        return out
    }

    /// What an amount grows to after `years` at the yearly return (after inflation).
    static func futureValue(_ amount: Double, yearlyPct: Double, years: Double) -> Double {
        amount * pow(1 + yearlyPct / 100, years)
    }

    /// Billed hours a private purchase costs: the price over what you keep of a billed hour.
    static func billedHours(price: Double, ratePerHour: Double, marginalTax: Double) -> Double? {
        let kept = ratePerHour * (1 - marginalTax)
        guard kept > 0 else { return nil }
        return price / kept
    }

    /// Days of your monthly investing that a price takes away.
    static func daysOfInvesting(price: Double, monthlyInvest: Double, daysPerMonth: Double = 365.25 / 12) -> Double? {
        guard monthlyInvest > 0 else { return nil }
        return price / (monthlyInvest / daysPerMonth)
    }

    /// How far spending runs above the plan a month: averages over caps, never below zero.
    static func planGap(averages: [Double], caps: [Double]) -> Double {
        max(0, averages.reduce(0, +) - caps.reduce(0, +))
    }

    /// Recurring charges a month for the next months, with the cancelled ones dropped from the
    /// month after their cancel date (or from next month when no date is set).
    static func recurringByMonth(items: [(perMonth: Double, cancelFrom: Date?)], months: Int, start: Date,
                                 calendar: Calendar = Calendar(identifier: .gregorian)) -> (now: [Double], afterCuts: [Double]) {
        var now: [Double] = []
        var cut: [Double] = []
        for m in 0..<max(0, months) {
            let monthStart = calendar.date(byAdding: .month, value: m, to: start) ?? start
            now.append(items.reduce(0) { $0 + $1.perMonth })
            cut.append(items.reduce(0) { total, item in
                guard let from = item.cancelFrom else { return total + item.perMonth }
                return monthStart >= from ? total : total + item.perMonth
            })
        }
        return (now, cut)
    }

    /// The first month the capital path pays the target at the withdrawal rate, or nil within the path.
    static func monthCapitalPays(target: Double, path: [Double], withdrawalPct: Double) -> Int? {
        path.firstIndex { capitalIncome(capital: $0, withdrawalPct: withdrawalPct) >= target }
    }
}
