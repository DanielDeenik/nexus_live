// Checks for PlanMath on made-up figures. Runs on any machine with a Swift toolchain, without
// Xcode: ios/scripts/check-core.sh
import Foundation

func planMathChecks() {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withFullDate]
    let today = f.date(from: "2026-03-15")!
    let target = f.date(from: "2029-03-15")!
    let months = PlanMath.months(from: today, to: target)
    check("36 months from 15 Mar 2026 to 15 Mar 2029", months == 36)
    check("10,000 to 40,000 in 36 months needs about 3.9% a month", near(PlanMath.requiredGrowth(current: 10_000, target: 40_000, months: months), 3.93, 0.01))
    let path = PlanMath.incomePath(current: 10_000, growthPct: 4.0, months: months)
    check("4.0% a month reaches the target by the date", path.last! >= 40_000 && path.count == 37)
    check("capital for 40k a month at 2.3% is about 20.9M", near(PlanMath.capitalNeeded(monthly: 40_000, withdrawalPct: 2.3), 20_869_565, 1))
    check("capital for 40k a month at 4% is 12M", near(PlanMath.capitalNeeded(monthly: 40_000, withdrawalPct: 4), 12_000_000, 1))
    check("a capital of 1M pays 1,917 a month at 2.3%", near(PlanMath.capitalIncome(capital: 1_000_000, withdrawalPct: 2.3), 1_916.67, 0.01))
    check("7% a year is 0.565% a month", near(PlanMath.monthlyRate(yearlyPct: 7), 0.005654, 0.000001))
    let cap = PlanMath.capitalPath(start: 0, monthly: 1_500, yearlyPct: 7, months: 120)
    check("1,500 a month for ten years at 7% is about 257k", near(cap.last, 256_578, 2) && cap.count == 121)
    check("100 now is about 197 after ten years at 7%", near(PlanMath.futureValue(100, yearlyPct: 7, years: 10), 196.72, 0.01))
    check("300 at 120 an hour, 40% marginal tax, is 4.2 billed hours", near(PlanMath.billedHours(price: 300, ratePerHour: 120, marginalTax: 0.40), 4.17, 0.01))
    check("no rate, no billed hours", PlanMath.billedHours(price: 300, ratePerHour: 0, marginalTax: 0.4) == nil)
    check("300 is 6.1 days of 1,500 a month investing", near(PlanMath.daysOfInvesting(price: 300, monthlyInvest: 1_500), 6.09, 0.01))
    check("the plan gap never goes below zero", PlanMath.planGap(averages: [100, 50], caps: [200, 100]) == 0 && PlanMath.planGap(averages: [500, 300], caps: [200, 100]) == 500)
    let cancelFrom = Calendar(identifier: .gregorian).date(byAdding: .month, value: 2, to: today)!
    let rec = PlanMath.recurringByMonth(items: [(30, cancelFrom), (10, nil)], months: 4, start: today)
    check("a cancelled charge drops out from its date", rec.now == [40, 40, 40, 40] && rec.afterCuts == [40, 40, 10, 10])
    check("the capital path pays a target from the first month it is large enough",
          PlanMath.monthCapitalPays(target: 1_000, path: [0, 400_000, 600_000], withdrawalPct: 2.3) == 2)
}
