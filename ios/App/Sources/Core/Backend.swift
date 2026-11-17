import Foundation
import Security
import LocalAuthentication

/// Values baked into Info.plist at build time from Config/release.env.
enum AppConfig {
    static func value(_ key: String) -> String {
        (Bundle.main.object(forInfoDictionaryKey: key) as? String) ?? ""
    }
    static var supabaseURL: URL? {
        let raw = value("NXSupabaseURL")
        guard raw.hasPrefix("https://"), raw.count > "https://".count else { return nil }
        return URL(string: raw)
    }
    static var supabaseKey: String { value("NXSupabaseAnonKey") }
}

enum Keychain {
    private static let service = "nexuslive.session"

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func save(_ data: Data, account: String) {
        SecItemDelete(query(account) as CFDictionary)
        var add = query(account)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    static func load(account: String) -> Data? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func delete(account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }

    static let credentialsAccount = "credentials"

    /// Stores an item that can only be read after Face ID (or Touch ID) on this device.
    @discardableResult
    static func saveBiometric(_ data: Data, account: String) -> Bool {
        SecItemDelete(query(account) as CFDictionary)
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
                                                           .biometryCurrentSet, &error) else { return false }
        var add = query(account)
        add[kSecValueData as String] = data
        add[kSecAttrAccessControl as String] = access
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    /// Shows the Face ID prompt and returns the item. Blocks while the prompt is up: call off the main thread.
    static func loadBiometric(account: String, prompt: String) -> Data? {
        let context = LAContext()
        context.localizedReason = prompt
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        q[kSecUseAuthenticationContext as String] = context
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    /// True when a Face ID protected item exists, without showing a prompt.
    static func biometricItemExists(account: String) -> Bool {
        let context = LAContext()
        context.interactionNotAllowed = true
        var q = query(account)
        q[kSecUseAuthenticationContext as String] = context
        let status = SecItemCopyMatching(q as CFDictionary, nil)
        return status == errSecSuccess || status == errSecInteractionNotAllowed
    }
}

struct AuthUser: Codable {
    let id: String
    let email: String?
}

struct AuthSession: Codable {
    let access_token: String
    let refresh_token: String
    let expires_at: Double?
    let user: AuthUser
}

enum APIError: LocalizedError {
    case notConfigured
    case notSignedIn
    case http(Int, String)
    case badResponse
    case faceIDFailed
    case badLink

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "The backend address is missing from this build."
        case .notSignedIn: return "Please sign in again."
        case .http(let code, let body):
            if let data = body.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let message = json["msg"] ?? json["message"] ?? json["error_description"] ?? json["error"]
                if let message { return "\(message) (\(code))" }
            }
            return "Server answered \(code)"
        case .badResponse: return "The server sent something unexpected."
        case .badLink: return "That is not a sign in link. In the email, press and hold Sign in, tap Copy Link, then try again."
        case .faceIDFailed: return "Face ID could not renew your sign in. Sign in once with your password or the email link."
        }
    }
}

/// Thin client for Supabase Auth and PostgREST, no third party packages.
@MainActor
final class Backend: ObservableObject {
    @Published private(set) var session: AuthSession?
    /// The app opens locked whenever a session exists; Face ID or the device passcode unlocks it.
    @Published var locked: Bool
    @Published private(set) var hasFaceIDSignIn: Bool

    private let base: URL?
    private let key: String
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private static let sessionAccount = "session"

    init() {
        base = AppConfig.supabaseURL
        key = AppConfig.supabaseKey
        var stored: AuthSession?
        if let data = Keychain.load(account: Self.sessionAccount) {
            stored = try? JSONDecoder().decode(AuthSession.self, from: data)
        }
        session = stored
        locked = stored != nil
        hasFaceIDSignIn = Keychain.biometricItemExists(account: Keychain.credentialsAccount)
    }

    var isConfigured: Bool { base != nil && !key.isEmpty }
    var userId: String? { session?.user.id }
    var email: String? { session?.user.email }

    // MARK: Auth

    func signIn(email: String, password: String) async throws {
        let data = try await send("POST", "auth/v1/token?grant_type=password",
                                  body: ["email": email, "password": password], authenticated: false)
        try store(data)
        locked = false
    }

    /// Signs in with the "Sign in" link from the Supabase email, copied instead of tapped.
    /// Reads a token_hash (or token) link, or a redirect link that already carries a refresh token.
    func signInWithLink(_ text: String) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed) else { throw APIError.badLink }
        var values: [String: String] = [:]
        for item in components.queryItems ?? [] { values[item.name] = item.value }
        if let fragment = components.fragment, let parsed = URLComponents(string: "?" + fragment) {
            for item in parsed.queryItems ?? [] { values[item.name] = item.value }
        }
        let data: Data
        if let refresh = values["refresh_token"] {
            data = try await send("POST", "auth/v1/token?grant_type=refresh_token",
                                  body: ["refresh_token": refresh], authenticated: false)
        } else if let hash = values["token_hash"] ?? values["token"] {
            data = try await send("POST", "auth/v1/verify",
                                  body: ["type": values["type"] ?? "magiclink", "token_hash": hash], authenticated: false)
        } else {
            throw APIError.badLink
        }
        try store(data)
        locked = false
    }

    /// Reads the last session behind Face ID and renews it. No password is ever stored.
    func signInWithFaceID() async throws {
        let data = await Task.detached {
            Keychain.loadBiometric(account: Keychain.credentialsAccount, prompt: "Sign in to Nexuslive")
        }.value
        guard let data, let saved = try? decoder.decode(AuthSession.self, from: data) else { throw APIError.faceIDFailed }
        do {
            let fresh = try await send("POST", "auth/v1/token?grant_type=refresh_token",
                                       body: ["refresh_token": saved.refresh_token], authenticated: false)
            try store(fresh)
            locked = false
        } catch {
            throw APIError.faceIDFailed
        }
    }

    /// Face ID, falling back to the device passcode. A device without a passcode cannot be locked.
    func unlock() async {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            locked = false
            return
        }
        if (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Nexuslive")) == true {
            locked = false
        }
    }

    func sendCode(email: String) async throws {
        _ = try await send("POST", "auth/v1/otp",
                           body: ["email": email, "create_user": false], authenticated: false)
    }

    func verifyCode(email: String, code: String) async throws {
        let data = try await send("POST", "auth/v1/verify",
                                  body: ["type": "email", "email": email, "token": code], authenticated: false)
        try store(data)
        locked = false
    }

    func signOut() {
        session = nil
        Keychain.delete(account: Self.sessionAccount)
    }

    private func store(_ data: Data) throws {
        let fresh = try decoder.decode(AuthSession.self, from: data)
        session = fresh
        let encoded = try encoder.encode(fresh)
        Keychain.save(encoded, account: Self.sessionAccount)
        // A copy behind Face ID, so Face ID can sign back in after a sign out or an expired session.
        if Keychain.saveBiometric(encoded, account: Keychain.credentialsAccount) { hasFaceIDSignIn = true }
    }

    private func refreshIfNeeded() async throws {
        guard let current = session else { throw APIError.notSignedIn }
        let expiresAt = current.expires_at ?? 0
        guard expiresAt - Date().timeIntervalSince1970 < 60 else { return }
        do {
            let data = try await send("POST", "auth/v1/token?grant_type=refresh_token",
                                      body: ["refresh_token": current.refresh_token], authenticated: false)
            try store(data)
        } catch {
            signOut()
            throw APIError.notSignedIn
        }
    }

    // MARK: Data

    func select<T: Decodable>(_ table: String, _ query: String) async throws -> [T] {
        let data = try await send("GET", "rest/v1/\(table)?\(query)")
        return try decoder.decode([T].self, from: data)
    }

    func insert(_ table: String, _ row: [String: Any]) async throws {
        _ = try await send("POST", "rest/v1/\(table)", body: row, prefer: "return=minimal")
    }

    func upsert(_ table: String, _ row: [String: Any], onConflict: String) async throws {
        _ = try await send("POST", "rest/v1/\(table)?on_conflict=\(onConflict)", body: row,
                           prefer: "resolution=merge-duplicates,return=minimal")
    }

    func update(_ table: String, id: String, _ fields: [String: Any]) async throws {
        _ = try await send("PATCH", "rest/v1/\(table)?id=eq.\(id)", body: fields, prefer: "return=minimal")
    }

    func delete(_ table: String, id: String) async throws {
        _ = try await send("DELETE", "rest/v1/\(table)?id=eq.\(id)", prefer: "return=minimal")
    }

    /// Calls a Postgres function and returns its JSON result (a scalar or an object).
    func rpc(_ function: String, _ args: [String: Any]) async throws -> Any {
        let data = try await send("POST", "rest/v1/rpc/\(function)", body: args)
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    // MARK: Transport

    private func send(_ method: String, _ path: String, body: Any? = nil,
                      prefer: String? = nil, authenticated: Bool = true) async throws -> Data {
        guard let base, !key.isEmpty, let url = URL(string: base.absoluteString + "/" + path) else {
            throw APIError.notConfigured
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(key, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let prefer { request.setValue(prefer, forHTTPHeaderField: "Prefer") }
        if authenticated {
            try await refreshIfNeeded()
            guard let token = session?.access_token else { throw APIError.notSignedIn }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        } else {
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 && authenticated { signOut() }
            throw APIError.http(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }
}
