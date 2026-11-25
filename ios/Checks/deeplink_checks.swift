// Checks for the app links and amount reading.
import Foundation

func deeplinkChecks() {
    let s = "nexuslive"
    let shop = Deeplink.parse(URL(string: "nexuslive://buy?app=Shopmart")!, scheme: s)
    check("a shopping app opens the Buy check with its name", shop == .buy(BuyDraft(item: "", amount: nil, appName: "Shopmart", entry: "shopping_app")))
    let widget = Deeplink.parse(URL(string: "nexuslive://buy?entry=widget")!, scheme: s)
    check("the widget opens an empty Buy check", widget == .buy(BuyDraft(item: "", amount: nil, appName: nil, entry: "widget")))
    let shared = Deeplink.parse(URL(string: "nexuslive://buy?item=Running%20shoes&amount=%E2%82%AC%20129,95&entry=share")!, scheme: s)
    check("a shared item keeps its name and reads a euro amount", shared == .buy(BuyDraft(item: "Running shoes", amount: 129.95, appName: nil, entry: "share")))
    let odd = Deeplink.parse(URL(string: "nexuslive://buy?entry=hack&amount=-5")!, scheme: s)
    check("an unknown entry falls back and a negative amount is dropped", odd == .buy(BuyDraft(item: "", amount: nil, appName: nil, entry: "app")))
    check("review, close and purchases links", Deeplink.parse(URL(string: "nexuslive://review")!, scheme: s) == .review
          && Deeplink.parse(URL(string: "nexuslive://close")!, scheme: s) == .close
          && Deeplink.parse(URL(string: "nexuslive://purchases")!, scheme: s) == .purchases)
    check("another scheme or route is ignored", Deeplink.parse(URL(string: "https://buy")!, scheme: s) == nil
          && Deeplink.parse(URL(string: "nexuslive://connect?code=1")!, scheme: s) == nil)
    check("amounts as Shortcuts writes them", Amounts.parse("€ 12,50") == 12.5 && Amounts.parse("EUR 1.234,56") == 1234.56
          && Amounts.parse("$19.99") == 19.99 && Amounts.parse("free") == nil)
    check("shop names against a setting pattern", Amounts.matches("FRESHMART 1234", pattern: "freshmart|grocerly")
          && !Amounts.matches("Gadgetshop", pattern: "freshmart|grocerly") && !Amounts.matches("Grocerly", pattern: nil))
}
