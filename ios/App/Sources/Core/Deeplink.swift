import Foundation

/// A Buy check started outside the app: from a Shortcuts automation when a shopping app opens,
/// the share sheet, the home-screen widget or Siri. Fields the source did not give stay empty.
struct BuyDraft: Equatable, Identifiable {
    var item: String = ""
    var amount: Double?
    var appName: String?
    /// Where it was opened: app, shopping_app, share, widget, siri.
    var entry: String = "app"

    var id: String { [entry, appName ?? "", item, amount.map { String($0) } ?? ""].joined(separator: "|") }
}

/// The app's own links (scheme from Info.plist): nexuslive://buy?item=&amount=&app=&entry=,
/// nexuslive://review, nexuslive://close, nexuslive://purchases, and nexuslive://connect, where a
/// consent (a bank, Google) comes back when it returns through Safari instead of the sign-in sheet.
enum Deeplink: Equatable {
    case buy(BuyDraft)
    case review
    case close
    case purchases
    case connect

    static func parse(_ url: URL, scheme: String) -> Deeplink? {
        guard url.scheme?.lowercased() == scheme.lowercased(),
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var q: [String: String] = [:]
        for item in parts.queryItems ?? [] { q[item.name] = item.value }
        switch (parts.host ?? "").lowercased() {
        case "buy":
            let entries: Set<String> = ["app", "shopping_app", "share", "widget", "siri"]
            var draft = BuyDraft()
            draft.item = (q["item"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            draft.amount = q["amount"].flatMap(Amounts.parse).flatMap { $0 > 0 ? $0 : nil }
            draft.appName = q["app"].flatMap { $0.isEmpty ? nil : $0 }
            draft.entry = q["entry"].flatMap { entries.contains($0) ? $0 : nil } ?? (draft.appName == nil ? "app" : "shopping_app")
            return .buy(draft)
        case "review": return .review
        case "close": return .close
        case "purchases": return .purchases
        case "connect": return .connect
        default: return nil
        }
    }
}

enum Amounts {
    /// Reads an amount as Shortcuts or a shop writes it: "€ 12,50", "EUR 1.234,56", "$19.99".
    static func parse(_ raw: String) -> Double? {
        let kept = raw.filter { $0.isNumber || $0 == "," || $0 == "." || $0 == "-" }
        guard kept.contains(where: \.isNumber) else { return nil }
        return Money.parse(kept)
    }

    /// True when the shop name matches the pattern from a setting (case-insensitive regex).
    static func matches(_ text: String, pattern: String?) -> Bool {
        guard let pattern, !pattern.isEmpty else { return false }
        return text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }
}
