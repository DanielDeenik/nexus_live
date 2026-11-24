import SwiftUI
import AuthenticationServices
import UniformTypeIdentifiers
import UIKit

/// Every account and service Nexus reads, how fresh it is, what Nexus still needs from you,
/// and the connections that keep it current. Keys go to the vault; Nexus only reads.
struct AccountsView: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @Environment(\.openURL) private var openURL
    @State private var busy: String?
    @State private var message: String?
    @State private var error: String?
    @State private var sheet: ConnectKind?

    var body: some View {
        List {
            if let overview = ledger.overview {
                needsSection(overview)
                accountsSection(overview)
                if !overview.wallets.isEmpty { walletsSection(overview) }
                if let broker = overview.broker { brokerSection(broker) }
                servicesSection(overview)
            } else if let failure = ledger.accountsError {
                Section { Text(failure).foregroundStyle(.secondary) }
            } else {
                Section { ProgressView() }
            }
        }
        .navigationTitle("Accounts")
        .refreshable { await ledger.refreshOverview() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Sync now") { syncNow() }.disabled(busy != nil)
            }
        }
        .sheet(item: $sheet) { kind in
            ConnectForm(kind: kind, redirectURL: ledger.overview?.redirect_url ?? "", help: catalogHelp(for: kind)) { done in
                message = done
            }
        }
        .overlay { busyOverlay }
        .alert("Done", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK", role: .cancel) { message = nil }
        } message: {
            Text(message ?? "")
        }
        .errorAlert($error)
        .task { if ledger.overview == nil { await ledger.refreshOverview() } }
    }

    @ViewBuilder private var busyOverlay: some View {
        if let busy {
            VStack(spacing: 8) {
                ProgressView()
                Text(busy).font(.caption)
            }
            .padding(16)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    // MARK: Sections

    private func needsSection(_ overview: AccountsOverview) -> some View {
        Section {
            if overview.needs.isEmpty {
                Label("Nothing missing", systemImage: "checkmark.circle").foregroundStyle(.secondary)
            }
            ForEach(overview.needs) { need in
                NeedRow(need: need, service: overview.service(need.service_id),
                        connect: { connect($0) }, decide: { decide($0, $1) }, dismiss: { dismissNeed($0) })
            }
        } header: {
            Text("Nexus needs")
        } footer: {
            Text("Swipe left on a tip to dismiss it.")
        }
    }

    private func accountsSection(_ overview: AccountsOverview) -> some View {
        Section("Accounts") {
            ForEach(overview.accounts) { account in
                AccountRow(account: account, currency: ledger.baseCurrency)
            }
        }
    }

    private func walletsSection(_ overview: AccountsOverview) -> some View {
        Section {
            ForEach(Array(overview.wallets.enumerated()), id: \.offset) { _, wallet in
                HStack {
                    Text(wallet.label)
                    Spacer()
                    Text(Money.format(wallet.balance, wallet.currency)).monospacedDigit()
                }
            }
        } header: {
            Text("Wise")
        } footer: {
            Text("Wise balances are shown here and are not part of safe to spend.")
        }
    }

    private func brokerSection(_ broker: BrokerInfo) -> some View {
        Section {
            LabeledContent("Invested", value: Money.format(broker.invested_usd, "USD"))
            LabeledContent("Cash", value: Money.format(broker.cash_usd, "USD"))
            LabeledContent("Open profit", value: Money.format(broker.unrealized_pnl_usd, "USD"))
            LabeledContent("Positions", value: String(broker.positions))
        } header: {
            Text("eToro")
        } footer: {
            Text(broker.as_of.map { "Updated \(String($0.prefix(16)).replacingOccurrences(of: "T", with: " "))" } ?? "")
        }
    }

    private func servicesSection(_ overview: AccountsOverview) -> some View {
        Section {
            ForEach(overview.services) { service in
                ServiceRow(service: service,
                           connect: { connect($0) }, disconnect: { disconnect($0) }, open: { openURL($0) })
            }
        } header: {
            Text("Connections")
        } footer: {
            Text("Keys and tokens are stored in the vault in Supabase, never on this phone. Every connection is read only.")
        }
    }

    // MARK: Actions

    private func catalogHelp(for kind: ConnectKind) -> String? {
        ledger.overview?.services.first { $0.via == kind.via }?.help
    }

    private func connect(_ service: ServiceInfo) {
        switch service.via {
        case ConnectKind.wise.via: sheet = .wise
        case ConnectKind.etoro.via: sheet = .etoro
        case ConnectKind.enableBanking.via: sheet = .enableBanking
        case "enable_banking": bankConsent(service)
        case "google_oauth": googleConsent()
        default: break
        }
    }

    private func bankConsent(_ service: ServiceInfo) {
        run("Opening \(service.name)") {
            let start = try await ledger.call("accounts", ["action": "eb_start", "service_id": service.id])
            guard let link = start["url"] as? String, let url = URL(string: link) else { throw APIError.badResponse }
            let back = try await consent(url)
            let finish = try await ledger.call("accounts", ["action": "eb_finish", "code": back.code, "state": back.state])
            await ledger.reload()
            let sync = finish["sync"] as? [String: Any]
            let lines = (sync?["inserted"] as? NSNumber)?.intValue ?? 0
            let accounts = (finish["accounts"] as? NSNumber)?.intValue ?? 0
            return "\(service.name) is connected: \(accounts) accounts, \(lines) new lines. It syncs every morning."
        }
    }

    private func googleConsent() {
        run("Opening Google") {
            let start = try await ledger.call("integrations", ["action": "google_start", "return_to": "app"])
            guard let link = start["url"] as? String, let url = URL(string: link) else { throw APIError.badResponse }
            let back = try await consent(url)
            try await ledger.call("integrations", ["action": "google_finish", "code": back.code, "state": back.state])
            await ledger.refreshOverview()
            return "Gmail is connected. The expense agent reads new invoices and receipts every morning."
        }
    }

    /// Opens the consent page and returns the code and state it hands back to the app.
    private func consent(_ url: URL) async throws -> (code: String, state: String) {
        guard let callback = ledger.overview.flatMap({ URL(string: $0.callback_url) }), let scheme = callback.scheme else {
            throw APIError.badResponse
        }
        let returned = try await webAuthenticationSession.authenticate(using: url, callbackURLScheme: scheme,
                                                                       preferredBrowserSession: .ephemeral)
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

    private func syncNow() {
        run("Syncing") {
            try await ledger.call("accounts", ["action": "sync"])
            await ledger.reload()
            return "Your connected accounts are up to date."
        }
    }

    private func disconnect(_ service: ServiceInfo) {
        run("Disconnecting") {
            try await ledger.call("accounts", ["action": "disconnect", "service_id": service.id])
            await ledger.refreshOverview()
            return "\(service.name) is disconnected."
        }
    }

    private func decide(_ need: NeedInfo, _ approve: Bool) {
        guard let id = need.review_item_id else { return }
        run("Saving") {
            try await ledger.decide(reviewItem: id, approve: approve)
            return nil
        }
    }

    private func dismissNeed(_ need: NeedInfo) {
        run("Saving") {
            try await ledger.call("accounts", ["action": "dismiss_need", "code": need.code])
            await ledger.refreshOverview()
            return nil
        }
    }

    private func run(_ label: String, _ work: @escaping () async throws -> String?) {
        guard busy == nil else { return }
        busy = label
        Task {
            do {
                if let done = try await work() { message = done }
            } catch let failure as ASWebAuthenticationSessionError where failure.code == .canceledLogin {
                // You closed the page: nothing to report.
            } catch {
                self.error = error.localizedDescription
            }
            busy = nil
        }
    }
}

enum ConnectError: LocalizedError {
    case refused(String)

    var errorDescription: String? {
        switch self {
        case .refused(let why): return "The connection was not approved: \(why)"
        }
    }
}

/// The connections that need a key typed or a file chosen, rather than a sign in.
enum ConnectKind: String, Identifiable {
    case wise, etoro, enableBanking

    var id: String { rawValue }

    /// How the catalog in app_config names this way of connecting.
    var via: String {
        switch self {
        case .wise: return "wise_token"
        case .etoro: return "etoro_keys"
        case .enableBanking: return "enable_banking_app"
        }
    }

    var title: String {
        switch self {
        case .wise: return "Connect Wise"
        case .etoro: return "Connect eToro"
        case .enableBanking: return "Set up Enable Banking"
        }
    }
}

struct NeedRow: View {
    let need: NeedInfo
    let service: ServiceInfo?
    let connect: (ServiceInfo) -> Void
    let decide: (NeedInfo, Bool) -> Void
    let dismiss: (NeedInfo) -> Void

    private var warn: Bool { need.severity == "warn" }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: warn ? "exclamationmark.triangle.fill" : "info.circle")
                    .foregroundStyle(warn ? Color.orange : Color.secondary)
                Text(need.title).font(.subheadline.weight(.semibold))
            }
            Text(need.detail).font(.caption).foregroundStyle(.secondary)
            actions
        }
        .padding(.vertical, 2)
        .swipeActions {
            if need.dismissible {
                Button("Dismiss") { dismiss(need) }.tint(.gray)
            }
        }
    }

    @ViewBuilder private var actions: some View {
        if let decision = need.decide {
            HStack {
                Button(decision.approve) { decide(need, true) }.buttonStyle(.borderedProminent)
                Button(decision.reject) { decide(need, false) }.buttonStyle(.bordered)
            }
            .font(.caption)
        } else if need.action == "connect", let service, service.status != "unavailable" {
            Button(service.isConnected ? "Reconnect \(service.name)" : "Connect \(service.name)") { connect(service) }
                .buttonStyle(.bordered)
                .font(.caption)
        }
    }
}

struct AccountRow: View {
    let account: AccountInfo
    let currency: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(account.label)
                Spacer()
                Text(Money.format(account.balance, currency)).monospacedDigit()
            }
            HStack(spacing: 6) {
                Text(account.feed == "bank" ? "Bank sync" : "Export")
                    .font(.caption2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Color.secondary.opacity(0.15), in: Capsule())
                Text(account.last_booked.map { "Newest line \($0)" } ?? "No lines yet")
                    .font(.caption).foregroundStyle(.secondary)
                if let bank = account.bank_balance, abs(bank - account.balance) >= 0.01 {
                    Text("Bank says \(Money.format(bank, currency))").font(.caption).foregroundStyle(.orange)
                }
            }
        }
    }
}

struct ServiceRow: View {
    let service: ServiceInfo
    let connect: (ServiceInfo) -> Void
    let disconnect: (ServiceInfo) -> Void
    let open: (URL) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(service.name)
                Spacer()
                Text(statusText).font(.caption).foregroundStyle(statusColor)
            }
            if let detail = service.detail, !detail.isEmpty {
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            if let until = service.valid_until {
                Text("Consent until \(String(until.prefix(10)))").font(.caption2).foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                if service.status != "unavailable" {
                    Button(service.isConnected ? "Reconnect" : "Connect") { connect(service) }.buttonStyle(.bordered)
                }
                if service.isConnected || service.status == "error" {
                    Button("Disconnect", role: .destructive) { disconnect(service) }.buttonStyle(.bordered)
                }
                if let link = service.open_url, let url = URL(string: link) {
                    Button("Open") { open(url) }.buttonStyle(.bordered)
                }
                if let link = service.help_url, let url = URL(string: link) {
                    Button("How") { open(url) }.buttonStyle(.bordered)
                }
            }
            .font(.caption)
        }
        .padding(.vertical, 2)
    }

    private var statusText: String {
        switch service.status {
        case "connected": return "Connected"
        case "error": return "Needs attention"
        case "unavailable": return "Not available yet"
        default: return "Not connected"
        }
    }

    private var statusColor: Color {
        switch service.status {
        case "connected": return .green
        case "error": return .orange
        default: return .secondary
        }
    }
}

/// Typing a token, two keys, or choosing the Enable Banking key file. What you enter is sent once
/// to the server, stored in the vault and never shown again.
struct ConnectForm: View {
    let kind: ConnectKind
    let redirectURL: String
    let helpText: String?
    let onSaved: (String) -> Void
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.dismiss) private var dismiss
    @State private var first = ""
    @State private var second = ""
    @State private var pem: String?
    @State private var pemName = ""
    @State private var choosing = false
    @State private var saving = false
    @State private var error: String?

    init(kind: ConnectKind, redirectURL: String, help: String?, onSaved: @escaping (String) -> Void) {
        self.kind = kind
        self.redirectURL = redirectURL
        self.helpText = help
        self.onSaved = onSaved
    }

    var body: some View {
        NavigationStack {
            Form {
                switch kind {
                case .wise: wiseFields
                case .etoro: etoroFields
                case .enableBanking: bankingFields
                }
            }
            .navigationTitle(kind.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Checking" : "Save") { save() }.disabled(!ready || saving)
                }
            }
            .fileImporter(isPresented: $choosing, allowedContentTypes: [.item]) { result in readKeyFile(result) }
            .errorAlert($error)
        }
    }

    @ViewBuilder private var wiseFields: some View {
        Section {
            SecureField("Wise API token", text: $first)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        } footer: {
            Text(helpText ?? "")
        }
    }

    @ViewBuilder private var etoroFields: some View {
        Section {
            SecureField("Public API key", text: $first)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            SecureField("User key", text: $second)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        } footer: {
            Text(helpText ?? "")
        }
    }

    @ViewBuilder private var bankingFields: some View {
        Section {
            Text(redirectURL).font(.caption.monospaced()).textSelection(.enabled)
            Button("Copy the redirect URL") { UIPasteboard.general.string = redirectURL }
        } header: {
            Text("Redirect URL for the application")
        }
        Section {
            TextField("Application ID", text: $first)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.callout.monospaced())
            Button(pem == nil ? "Choose the .pem key file" : "Key file: \(pemName)") { choosing = true }
        } header: {
            Text("Application")
        } footer: {
            Text(helpText ?? "")
        }
    }

    private var ready: Bool {
        switch kind {
        case .wise: return !first.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .etoro: return !first.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !second.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .enableBanking: return !first.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && pem != nil
        }
    }

    private func readKeyFile(_ result: Result<URL, Error>) {
        do {
            let url = try result.get()
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let text = try String(contentsOf: url, encoding: .utf8)
            guard text.contains("PRIVATE KEY") else {
                error = "That file is not a private key. Choose the .pem file Enable Banking downloaded."
                return
            }
            pem = text
            pemName = url.lastPathComponent
            // Enable Banking names the key file after the application ID.
            if first.isEmpty { first = url.deletingPathExtension().lastPathComponent }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save() {
        saving = true
        let one = first.trimmingCharacters(in: .whitespacesAndNewlines)
        let two = second.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            do {
                let done: String
                switch kind {
                case .wise:
                    try await ledger.call("integrations", ["action": "wise_connect", "token": one])
                    try await ledger.call("accounts", ["action": "sync"])
                    done = "Wise is connected. Balances refresh every morning."
                case .etoro:
                    try await ledger.call("accounts", ["action": "etoro_connect", "api_key": one, "user_key": two])
                    done = "eToro is connected. Positions refresh every morning."
                case .enableBanking:
                    try await ledger.call("accounts", ["action": "eb_setup", "app_id": one, "private_key": pem ?? ""])
                    done = "Enable Banking is set up. Now connect each bank."
                }
                first = ""
                second = ""
                pem = nil
                await ledger.reload()
                onSaved(done)
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            saving = false
        }
    }
}
