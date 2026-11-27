// Checks for the glance on made-up figures: the answer of nx_glance decodes, the arcs of a ring
// add up to one full turn, a month never draws more living than there is money, and the phone
// shows only the first rows. Runs without Xcode: ios/scripts/check-core.sh
import Foundation

func glanceChecks() {
    let json = """
    {"version": 1, "as_of": "2026-03-15", "data_through": "2026-03-14", "currency": "EUR", "web_url": "https://app.example.test",
     "today": {"hold": 25540, "tax": 15000, "yours": 10540, "caption": "yours, after tax",
       "slices": [{"key": "tax", "label": "Tax 2026 to set aside", "amount": 15000}, {"key": "yours", "label": "Yours", "amount": 10540}],
       "next": {"key": "hours", "title": "Hours", "now": "0 logged", "short": "Invoice planned Tue 31 Mar, 160 hours.", "detail": "Nothing logged yet.", "action": "Log March's hours", "link": "time", "due": "2026-03-31"},
       "slipping_count": 4},
     "slipping": {"shown": 3, "better": [{"key": "purchases", "title": "Purchases", "detail": "10 a day since 1 Mar."}],
       "items": [
         {"key": "discretionary", "title": "Discretionary spending", "now": "225% of budget", "short": "900 a month against 400.", "detail": "d"},
         {"key": "investing", "title": "Investing", "now": "14% of target", "short": "s", "detail": "d"},
         {"key": "living", "title": "Living costs", "now": "129% of budget", "short": "s", "detail": "d"},
         {"key": "hours", "title": "Hours", "now": "0 logged", "short": "s", "detail": "d", "action": "Log March's hours", "link": "time", "due": "2026-03-31"}]},
     "month": {"title": "An average month in 2027", "billed": 8000, "tax": 3000, "business": 500, "target": 3500,
       "now": {"living": 2200, "left": 2300, "short": 1200, "line": "1,200 short of your 3,500 target."},
       "budget": {"living": 1700, "left": 2800, "short": 700, "line": "700 short of your 3,500 target."}},
     "assignment": {"question": "Renegotiate for 2027?", "answer": "Yes", "reason": "r", "end_date": null, "end_line": null,
       "tiles": [{"value": "CAD 100", "label": "now, since January"}, {"value": "CAD 115", "label": "closes the plan on budget"}, {"value": "8.0 mo", "label": "runway if it ended 31 Dec"}]},
     "review": {"weekly": {"weekday": 1, "hour": 10, "minute": 0}, "next": "2026-03-15", "snapshot_date": null, "moved": null,
       "snapshot": {"cash": 24190, "investments": 1350, "liabilities": 15000, "total": 10540, "currency": "EUR"}}}
    """
    guard let glance = try? JSONDecoder().decode(Glance.self, from: Data(json.utf8)) else {
        check("the answer of nx_glance decodes", false)
        return
    }
    check("the answer of nx_glance decodes",
          glance.today.yours == 10540 && glance.slipping.items.count == 4 && glance.today.next?.link == "time"
          && glance.assignment?.tiles.count == 3 && glance.review.snapshot.cash == 24190)

    let arcs = GlanceMath.arcs(glance.today.slices)
    check("the arcs of a ring run from the top once around",
          arcs.count == 2 && arcs[0].from == 0 && near(arcs[0].to, 15000.0 / 25540.0, 0.000001) && arcs[1].from == arcs[0].to && near(arcs[1].to, 1, 0.000001))
    let none = GlanceMath.arcs([Glance.Slice(key: "tax", label: "Tax", amount: 0), Glance.Slice(key: "yours", label: "Yours", amount: -5)])
    check("nothing above zero draws no arc", none.isEmpty)
    let lone = GlanceMath.arcs([Glance.Slice(key: "tax", label: "Tax", amount: 100), Glance.Slice(key: "yours", label: "Yours", amount: 0)])
    check("an amount of zero is left out of the ring", lone.count == 1 && lone[0].key == "tax" && lone[0].to == 1)

    guard let month = glance.month else { check("a month is in the answer", false); return }
    let now = GlanceMath.monthSlices(month, onBudget: false).map(\.amount)
    let budget = GlanceMath.monthSlices(month, onBudget: true).map(\.amount)
    check("a month adds up to what is billed, as now and on budget",
          now == [3000, 500, 2200, 2300] && budget == [3000, 500, 1700, 2800] && now.reduce(0, +) == month.billed && budget.reduce(0, +) == month.billed)
    check("the legend of a month names the mode", GlanceMath.monthLegend(month, onBudget: true).map(\.label) == ["Tax", "Business costs", "Living, on budget", "Left to invest"])

    let over = Glance.Month(title: "t", billed: 8000, tax: 3000, business: 500, target: 3500,
                            now: Glance.MonthMode(living: 6000, left: -1500, short: 5000, line: nil),
                            budget: Glance.MonthMode(living: 1700, left: 2800, short: 700, line: nil))
    check("living above what a month leaves fills the ring and no more",
          GlanceMath.monthSlices(over, onBudget: false).map(\.amount) == [3000, 500, 4500, 0])
    check("the legend still shows the real amounts", GlanceMath.monthLegend(over, onBudget: false).map(\.amount) == [3000, 500, 6000, -1500])

    let part = GlanceMath.shown(glance.slipping)
    check("the phone shows the first rows and counts the rest", part.rows.map(\.key) == ["discretionary", "investing", "living"] && part.rest == 1)
    let all = GlanceMath.shown(Glance.Slipping(items: Array(glance.slipping.items.prefix(2)), shown: 3, better: []))
    check("fewer rows than the phone shows leaves none for the web", all.rows.count == 2 && all.rest == 0)

    check("a table of the web app has its own address",
          GlanceMath.webURL("https://app.example.test", path: "/look", topic: "slipping")?.absoluteString == "https://app.example.test/look?topic=slipping"
          && GlanceMath.webURL("https://app.example.test/", path: "/time/entries")?.absoluteString == "https://app.example.test/time/entries")
    check("no web address, no link", GlanceMath.webURL(nil, path: "/look") == nil && GlanceMath.webURL("ftp://x", path: "/look") == nil)

    let bare = """
    {"version": 1, "as_of": "2026-03-15", "data_through": null, "currency": "EUR", "web_url": null,
     "today": {"hold": 100, "tax": 0, "yours": 100, "caption": "yours, after tax", "slices": [], "next": null, "slipping_count": 0},
     "slipping": {"shown": 3, "better": [], "items": []}, "month": null, "assignment": null,
     "review": {"weekly": null, "next": null, "snapshot_date": "2026-03-08", "moved": -250.5,
       "snapshot": {"cash": 100, "investments": 0, "liabilities": 0, "total": 100, "currency": "EUR"}}}
    """
    let empty = try? JSONDecoder().decode(Glance.self, from: Data(bare.utf8))
    check("an answer without a forecast still decodes", empty != nil && empty?.month == nil && empty?.assignment == nil && empty?.today.next == nil && empty?.review.moved == -250.5)

    let start = GlanceMath.netWorth(glance)
    check("the forecasts start from what is yours on Today", start.total == 10540 && start.note == nil)
    let uncounted = bare.replacingOccurrences(of: "\"items\": []",
        with: "\"items\": [{\"key\": \"not_counted\", \"title\": \"Not counted\", \"now\": \"1 account\", \"short\": \"s\", \"detail\": \"No exchange rate yet for Wise GBP.\"}]")
    if let partial = try? JSONDecoder().decode(Glance.self, from: Data(uncounted.utf8)) {
        let part = GlanceMath.netWorth(partial)
        check("an account without an exchange rate is named where the forecasts start", part.total == 100 && part.note == "No exchange rate yet for Wise GBP.")
    } else {
        check("an account without an exchange rate is named where the forecasts start", false)
    }
}
