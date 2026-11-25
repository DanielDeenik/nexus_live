import Foundation
import SwiftUI

/// Which tab is showing and what was asked from outside: a Buy check from Shortcuts, the widget or
/// a notification, the Sunday review, the monthly close or the purchase review.
@MainActor
final class AppRouter: ObservableObject {
    static let shared = AppRouter()

    enum Tab: Hashable { case home, spend, decide, plan, settings }

    @Published var tab: Tab = .home
    @Published var buyDraft: BuyDraft?
    @Published var showReview = false
    @Published var showClose = false
    @Published var showPurchases = false

    /// Opens the Buy check over whatever is showing.
    func openBuy(_ draft: BuyDraft) {
        buyDraft = draft
    }

    /// The app's own links (nexuslive://buy, review, close, purchases).
    func handle(_ url: URL) {
        switch Deeplink.parse(url, scheme: AppConfig.urlScheme) {
        case .buy(let draft): openBuy(draft)
        case .review: showReview = true
        case .close: showClose = true
        case .purchases: showPurchases = true
        case nil: break
        }
    }

    /// A link name from a notification.
    func handle(link: String) {
        switch link {
        case "review": showReview = true
        case "purchases": showPurchases = true
        case "close": showClose = true
        default: tab = .home
        }
    }
}

extension AppConfig {
    /// The app's URL scheme (Info.plist NXURLScheme, set in project.yml).
    static var urlScheme: String { value("NXURLScheme") }
}
