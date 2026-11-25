import AuthenticationServices
import SwiftUI

/// A consent in the browser (Google, a bank) that hands a code and state back to the app,
/// which then finishes the connection signed in.
enum Consent {
    @MainActor
    static func run(_ session: WebAuthenticationSession, url: URL, callbackScheme: String) async throws -> (code: String, state: String) {
        let returned = try await session.authenticate(using: url, callbackURLScheme: callbackScheme, preferredBrowserSession: .ephemeral)
        let items = URLComponents(url: returned, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let values = Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
        if let refused = values["error"] {
            throw ConnectError.refused(values["error_description"] ?? refused)
        }
        guard let code = values["code"], !code.isEmpty, let state = values["state"], !state.isEmpty else {
            throw APIError.badResponse
        }
        return (code, state)
    }
}
