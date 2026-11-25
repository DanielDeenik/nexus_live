import AuthenticationServices
import SwiftUI

/// A consent in the browser (Google, a bank) that hands a code and state back to the app,
/// which then finishes the connection signed in. Most consents come back to the sign-in sheet.
/// A bank that approves in its own app hands back through Safari instead, which opens the app's
/// link (nexuslive://connect); the consent takes whichever arrives first and closes the sheet.
enum Consent {
    @MainActor
    static func run(_ session: WebAuthenticationSession, url: URL, callbackScheme: String) async throws -> (code: String, state: String) {
        let returned: URL = try await withCheckedThrowingContinuation { continuation in
            let once = ConsentOnce(continuation)
            let sheet = Task { @MainActor in
                do {
                    once.resume(.success(try await session.authenticate(using: url, callbackURLScheme: callbackScheme, preferredBrowserSession: .ephemeral)))
                } catch {
                    once.resume(.failure(error))
                }
            }
            ConsentRelay.shared.wait { link in
                once.resume(.success(link))
                sheet.cancel()
            }
        }
        ConsentRelay.shared.stopWaiting()
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

/// Resumes the consent once: the first return wins, a later one (the closed sheet) is dropped.
@MainActor
private final class ConsentOnce {
    private var continuation: CheckedContinuation<URL, Error>?

    init(_ continuation: CheckedContinuation<URL, Error>) {
        self.continuation = continuation
    }

    func resume(_ result: Result<URL, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
    }
}

/// Hands a consent return that arrives through the app's link to the consent that is open.
@MainActor
final class ConsentRelay {
    static let shared = ConsentRelay()

    private var waiter: (@MainActor (URL) -> Void)?

    func wait(_ deliver: @escaping @MainActor (URL) -> Void) {
        waiter = deliver
    }

    func stopWaiting() {
        waiter = nil
    }

    /// False when no consent is open; the return is then dropped and Connect can be tapped again.
    @discardableResult
    func deliver(_ url: URL) -> Bool {
        guard let waiter else { return false }
        self.waiter = nil
        waiter(url)
        return true
    }
}
