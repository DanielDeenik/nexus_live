import AppIntents
import Foundation
import UIKit
import UniformTypeIdentifiers

/// Opens a Buy check. A Shortcuts automation runs it when a shopping app you name opens
/// ("When Amazon is opened"), with the app's name filled in; Siri and Spotlight run it too.
struct OpenBuyCheckIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Buy check"
    static var description = IntentDescription("Opens a Buy check in Nexuslive before you buy.")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Shopping app") var appName: String?
    @Parameter(title: "Item") var item: String?
    @Parameter(title: "Amount") var amount: Double?

    @MainActor
    func perform() async throws -> some IntentResult {
        let entry = appName == nil ? (item == nil ? "siri" : "share") : "shopping_app"
        AppRouter.shared.openBuy(BuyDraft(item: item ?? "", amount: amount.flatMap { $0 > 0 ? $0 : nil }, appName: appName, entry: entry))
        return .result()
    }
}

/// Logs an Apple Pay tap. A Shortcuts Wallet automation ("When I tap any of my cards") passes the
/// merchant, amount and card; a notification then asks planned or impulse, or at a supermarket,
/// staples only or luxury too.
struct LogTapIntent: AppIntent {
    static var title: LocalizedStringResource = "Log card tap"
    static var description = IntentDescription("Logs a Wallet tap in Nexuslive and asks one question about it.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Merchant") var merchant: String
    @Parameter(title: "Amount") var amount: Double?
    @Parameter(title: "Card") var card: String?

    @MainActor
    func perform() async throws -> some IntentResult {
        let ledger = AppServices.ledgerForBackground()
        await ledger.ensureSettings()
        let tap = try await ledger.logTap(merchant: merchant, amount: amount, currency: nil, card: card)
        await NotificationService.shared.askAboutTap(tap, supermarket: ledger.isSupermarket(merchant))
        return .result()
    }
}

/// Reads a receipt image: a photo, or a supermarket app's digital receipt shared through a
/// Shortcut that shows in the share sheet.
struct AddReceiptIntent: AppIntent {
    static var title: LocalizedStringResource = "Add receipt"
    static var description = IntentDescription("Reads a receipt image into Nexuslive and splits staples from luxury.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Receipt") var file: IntentFile

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard file.type.map({ $0.conforms(to: .image) }) ?? true,
              let image = UIImage(data: file.data), let jpeg = ReceiptImage.jpeg(image) else {
            throw ReceiptError.notAnImage
        }
        let ledger = AppServices.ledgerForBackground()
        await ledger.ensureSettings()
        let message = try await ledger.addReceipt(jpeg, contentType: "image/jpeg", fileExtension: "jpg")
        return .result(dialog: IntentDialog(stringLiteral: message))
    }
}

enum ReceiptError: LocalizedError {
    case notAnImage

    var errorDescription: String? { "Share the receipt as an image (a photo or a screenshot)." }
}

/// The Siri and Spotlight phrase for the Buy check. Log card tap and Add receipt need input, so
/// they live as actions in the Shortcuts app, where the Wallet automation and the share sheet use them.
struct NexusShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: OpenBuyCheckIntent(),
                    phrases: ["Buy check in \(.applicationName)", "Open a \(.applicationName) Buy check"],
                    shortTitle: "Buy check", systemImageName: "cart.badge.questionmark")
    }
}
