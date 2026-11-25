import AuthenticationServices
import SwiftUI

/// Settings: every connection and key in one place, the target and the assumptions behind the
/// forecasts, food staples, the stop list, cancel routes, reminders and the Shortcuts that open
/// the Buy check. Your values override the defaults; nothing is fixed in code.
struct SettingsView: View {
    @EnvironmentObject private var backend: Backend
    @EnvironmentObject private var ledger: Ledger

    var body: some View {
        NavigationStack {
            List {
                Section("Connections") {
                    NavigationLink { AccountsView() } label: {
                        HStack {
                            Label("Banks, Wise, eToro, Moneybird", systemImage: "building.columns")
                            Spacer()
                            let warnings = ledger.overview?.needs.filter { $0.severity == "warn" }.count ?? 0
                            if warnings > 0 { Text(String(warnings)).font(.caption.bold()).foregroundStyle(.orange) }
                        }
                    }
                    NavigationLink { MailboxView() } label: {
                        HStack {
                            Label("Gmail: order emails and Apple receipts", systemImage: "envelope")
                            Spacer()
                            Text(ledger.mailbox?.connected == true ? "On" : "Off").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Section("Plan") {
                    NavigationLink { TargetSettingsView() } label: { Label("Target and assumptions", systemImage: "target") }
                    NavigationLink { FoodSettingsView() } label: { Label("Food staples", systemImage: "cart") }
                    NavigationLink { StopListView() } label: { Label("Stop list", systemImage: "hand.raised") }
                    NavigationLink { RoutesView() } label: { Label("Cancel routes", systemImage: "scissors") }
                }
                Section("Habits") {
                    NavigationLink { ShortcutsGuideView() } label: { Label("Shortcuts, Wallet and reminders", systemImage: "bolt") }
                }
                Section {
                    Button("Lock now") { backend.locked = true }
                    Button("Sign out", role: .destructive) { backend.signOut() }
                } footer: {
                    if let email = backend.email { Text("Signed in as \(email)") }
                }
            }
            .navigationTitle("Settings")
            .refreshable { await ledger.reload() }
        }
    }
}

// MARK: Mailbox

struct MailboxView: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var busy = false
    @State private var message: String?
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                LabeledContent("Status", value: status)
                if let account = ledger.mailbox?.account { LabeledContent("Mailbox", value: account) }
                if let read = ledger.mailbox?.last_read_at { LabeledContent("Last read", value: String(read.prefix(16)).replacingOccurrences(of: "T", with: " ")) }
                if let failure = ledger.mailbox?.last_error { Text(failure).font(.caption).foregroundStyle(.red) }
            }
            Section {
                Button(ledger.mailbox?.connected == true ? "Reconnect Gmail" : "Connect Gmail") { connect() }
                    .disabled(busy || ledger.mailbox?.google_ready != true)
                if ledger.mailbox?.connected == true {
                    Button("Read new mail now") { run() }.disabled(busy)
                    Button("Disconnect", role: .destructive) { disconnect() }.disabled(busy)
                }
            } footer: {
                Text(ledger.mailbox?.google_ready == true
                     ? "Read only. Nexus reads Gmail's Purchases category and Apple receipts to name the shop behind Klarna and PayPal lines, split supermarket receipts and see Apple subscriptions. Drive access covers only the archive folder Nexus creates."
                     : "Google sign-in is not set up on the server yet: create the Google client and add its ID and secret in Supabase (steps in the chat).")
            }
            if let redirect = ledger.mailbox?.redirect_url {
                Section("Authorised redirect URI for the Google client") {
                    Text(redirect).font(.caption.monospaced()).textSelection(.enabled)
                }
            }
        }
        .navigationTitle("Gmail")
        .task { await ledger.refreshMailbox() }
        .overlay { if busy { ProgressView() } }
        .alert("Gmail", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK", role: .cancel) { message = nil }
        } message: { Text(message ?? "") }
        .errorAlert($error)
    }

    private var status: String {
        guard let m = ledger.mailbox else { return "…" }
        if m.connected { return "Connected" }
        return m.status == "error" ? "Needs a reconnect" : "Not connected"
    }

    private func connect() {
        busy = true
        Task {
            do {
                let start = try await ledger.spendCall(["action": "google_start"])
                guard let link = start["url"] as? String, let url = URL(string: link) else { throw APIError.badResponse }
                let back = try await Consent.run(webAuthenticationSession, url: url, callbackScheme: AppConfig.urlScheme)
                let done = try await ledger.spendCall(["action": "google_finish", "code": back.code, "state": back.state])
                await ledger.refreshMailbox()
                message = "Connected \(done["account"] as? String ?? "Gmail"). New order emails and Apple receipts are read after each bank sync."
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    private func run() {
        busy = true
        Task {
            do {
                let json = try await ledger.spendCall(["action": "run"])
                let metrics = json["metrics"] as? [String: Any] ?? [:]
                let read = (metrics["mail_read"] as? NSNumber)?.intValue ?? 0
                let matched = (metrics["receipts_matched"] as? NSNumber)?.intValue ?? 0
                await ledger.reload()
                message = "\(read) new emails read, \(matched) matched to bank lines."
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    private func disconnect() {
        busy = true
        Task {
            do { try await ledger.spendCall(["action": "disconnect"]); await ledger.refreshMailbox() } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

// MARK: Target and assumptions

struct TargetSettingsView: View {
    @EnvironmentObject private var ledger: Ledger
    @State private var target = ""
    @State private var date = Date()
    @State private var withdrawal = 0.0
    @State private var growth = 0.0
    @State private var returnPct = 0.0
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        Form {
            Section("Target") {
                TextField("Income a month (\(ledger.baseCurrency))", text: $target).keyboardType(.decimalPad)
                DatePicker("By", selection: $date, displayedComponents: .date)
                Button("Save target") { saveTarget() }.disabled(Money.parse(target) == nil)
            }
            if loaded {
                Section {
                    if let range = ledger.range("plan.business_growth_range") {
                        SettingSlider(title: "Business growth a month", value: $growth, range: range,
                                      format: { "\($0.formatted(.number.precision(.fractionLength(1))))%" }) { v in
                            Task { await ledger.setUserSetting("plan.business_growth_pct", v) }
                        }
                    }
                    if let range = ledger.range("plan.return_range") {
                        SettingSlider(title: "Return after inflation", value: $returnPct, range: range,
                                      format: { "\($0.formatted(.number.precision(.fractionLength(1))))% a year" }) { v in
                            Task { await ledger.setUserSetting("plan.return_real_pct", v) }
                        }
                    }
                    if let range = ledger.range("plan.withdrawal_range") {
                        SettingSlider(title: "Withdrawal rate", value: $withdrawal, range: range,
                                      format: { "\($0.formatted(.number.precision(.fractionLength(1))))% a year" }) { v in
                            Task { await ledger.setUserSetting("plan.withdrawal_rate_pct", v) }
                        }
                    }
                } header: {
                    Text("Assumptions")
                } footer: {
                    Text("Return: about 7% a year after inflation for equities and housing since 1870 (Jordà et al. 2019, QJE). Withdrawal: 2.3% is what a 65-year-old couple could withdraw at a 5% chance of running out (Anarkulova, Cederburg, O'Doherty and Sias 2025). Personal projections changed what people saved, and the assumptions shown mattered (Goda, Manchester and Sojourner 2014).")
                }
            }
        }
        .navigationTitle("Target and assumptions")
        .onAppear(perform: load)
        .errorAlert($error)
    }

    private func load() {
        target = ledger.targetMonthly.map { String(Int($0)) } ?? ""
        date = ledger.targetDate ?? Date()
        growth = ledger.growthPct ?? 0
        returnPct = ledger.returnPct ?? 0
        withdrawal = ledger.withdrawalPct ?? 0
        loaded = ledger.growthPct != nil && ledger.returnPct != nil && ledger.withdrawalPct != nil
    }

    private func saveTarget() {
        guard let amount = Money.parse(target) else { return }
        Task {
            do {
                try await ledger.setSetting("target.monthly_income_eur", String(Int(amount)))
                try await ledger.setSetting("target.date", Day.string(date))
            } catch { self.error = error.localizedDescription }
        }
    }
}

// MARK: Food

struct FoodSettingsView: View {
    @EnvironmentObject private var ledger: Ledger
    @State private var staples: [String] = []
    @State private var newItem = ""
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                ForEach(staples, id: \.self) { Text($0) }
                    .onDelete { staples.remove(atOffsets: $0); save() }
                HStack {
                    TextField("Add a staple", text: $newItem).textInputAutocapitalization(.never)
                    Button("Add") {
                        let item = newItem.trimmingCharacters(in: .whitespaces).lowercased()
                        guard !item.isEmpty, !staples.contains(item) else { return }
                        staples.append(item)
                        newItem = ""
                        save()
                    }
                }
            } header: {
                Text("Staples")
            } footer: {
                Text("A supermarket receipt splits into \(ledger.staplesCategory ?? "staples") (these items) and \(ledger.luxuryCategory ?? "luxury") (the rest). A supermarket line with no receipt after \(Int(ledger.effectiveNumber("food.receipt_days") ?? 0)) days counts in full as luxury.")
            }
        }
        .navigationTitle("Food staples")
        .onAppear { staples = ledger.strings("food.staples") }
        .errorAlert($error)
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(staples), let text = String(data: data, encoding: .utf8) else { return }
        Task { do { try await ledger.setSetting("food.staples", text) } catch { self.error = error.localizedDescription } }
    }
}

// MARK: Stop list

struct StopListView: View {
    @EnvironmentObject private var ledger: Ledger

    var body: some View {
        List {
            ForEach(ledger.stopLists) { stop in
                Section {
                    LabeledContent(stop.label, value: "not allowed since \(stop.from)")
                    Text(stop.pattern.replacingOccurrences(of: "|", with: ", "))
                        .font(.caption).foregroundStyle(.secondary)
                } footer: {
                    Text("Any card, bank or Apple receipt line that matches raises an alert the same day and counts as a breach on the Sunday review.")
                }
            }
            if let appleFrom = ledger.effective("stop.apple_from"), !appleFrom.isEmpty {
                Section {
                    LabeledContent("Apple purchases stop", value: appleFrom)
                    Text("Allowed after that: " + ledger.strings("stop.apple_allowed").joined(separator: ", ")).font(.caption)
                } footer: {
                    Text("On that day set Screen Time, Apps and Websites, App Store, In-app Purchases to Blocked, behind your Screen Time passcode.")
                }
            }
            let runs = ledger.recurring.filter { $0.source == "apple" && $0.call != "keep" }
            if !runs.isEmpty {
                Section("Still runs into the stop") {
                    ForEach(runs) { charge in
                        HStack {
                            Text(charge.label)
                            Spacer()
                            Text(charge.next_due ?? charge.ends_on ?? "").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle("Stop list")
    }
}

// MARK: Cancel routes

struct RoutesView: View {
    @EnvironmentObject private var ledger: Ledger
    @State private var editing: CancelRoute?
    @State private var adding = false
    @State private var error: String?

    var body: some View {
        List {
            ForEach(ledger.routes) { route in
                Button { editing = route } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(route.label)
                        Text("\(route.route) · \(route.pattern)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .buttonStyle(.plain)
                .swipeActions {
                    Button("Delete", role: .destructive) {
                        Task { do { try await ledger.deleteRoute(route) } catch { self.error = error.localizedDescription } }
                    }
                }
            }
        }
        .navigationTitle("Cancel routes")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { adding = true } label: { Image(systemName: "plus") } } }
        .sheet(item: $editing) { RouteForm(route: $0) }
        .sheet(isPresented: $adding) { RouteForm(route: nil) }
        .errorAlert($error)
    }
}

struct RouteForm: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.dismiss) private var dismiss
    let route: CancelRoute?
    @State private var label: String
    @State private var pattern: String
    @State private var kind: String
    @State private var url: String
    @State private var steps: String
    @State private var trap: String
    @State private var noticeTo: String
    @State private var priority: String
    @State private var error: String?

    init(route: CancelRoute?) {
        self.route = route
        _label = State(initialValue: route?.label ?? "")
        _pattern = State(initialValue: route?.pattern ?? "")
        _kind = State(initialValue: route?.route ?? "web")
        _url = State(initialValue: route?.url ?? "")
        _steps = State(initialValue: route?.steps ?? "")
        _trap = State(initialValue: route?.trap ?? "")
        _noticeTo = State(initialValue: route?.notice_to ?? "")
        _priority = State(initialValue: route.map { String($0.priority) } ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $label)
                TextField("Matches (shop names, | between them)", text: $pattern).textInputAutocapitalization(.never)
                Picker("Where", selection: $kind) {
                    Text("Apple Subscriptions").tag("apple")
                    Text("Provider's page").tag("web")
                    Text("Bank direct debit").tag("bank")
                    Text("Written notice").tag("notice")
                }
                TextField("Page", text: $url).keyboardType(.URL).textInputAutocapitalization(.never)
                TextField("Steps", text: $steps, axis: .vertical)
                TextField("Trap to avoid", text: $trap, axis: .vertical)
                if kind == "notice" { TextField("Notice email address", text: $noticeTo).keyboardType(.emailAddress).textInputAutocapitalization(.never) }
                TextField("Order (lower first)", text: $priority).keyboardType(.numberPad)
            }
            .navigationTitle(route == nil ? "New route" : "Route")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }.disabled(label.isEmpty || pattern.isEmpty || Int(priority) == nil)
                }
            }
            .errorAlert($error)
        }
    }

    private func save() {
        guard let order = Int(priority) else { return }
        Task {
            do {
                try await ledger.saveRoute(id: route?.id, priority: order, pattern: pattern, label: label, route: kind,
                                           url: url, steps: steps, trap: trap, noticeTo: noticeTo)
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}

// MARK: Shortcuts, Wallet and reminders

/// The one-time steps that put the Buy check at the moment of buying. They use iOS Shortcuts,
/// so nothing extra runs on your phone.
struct ShortcutsGuideView: View {
    @State private var permission: Bool?

    var body: some View {
        List {
            Section {
                LabeledContent("Notifications", value: permission == true ? "On" : permission == false ? "Off" : "…")
                if permission != true {
                    Button("Allow notifications") { Task { permission = await NotificationService.shared.requestPermission() } }
                }
            } footer: {
                Text("Needed for the question after a card tap, the re-ask when a wait ends, the Sunday review and stop-list alerts. At most one reminder a day.")
            }
            Section("When a shopping app opens") {
                step("Shortcuts, Automation, +, App. Choose the shopping apps (for example Amazon, bol, Coolblue, Marktplaats), Is Opened, Run Immediately.")
                step("Action: Open Buy check (Nexuslive). Set Shopping app to the app's name.")
            }
            Section("When you tap a card") {
                step("Shortcuts, Automation, +, Wallet. Choose your cards, Run Immediately.")
                step("Action: Log card tap (Nexuslive). Merchant: Shortcut Input, Merchant. Amount: Shortcut Input, Amount. Card: Shortcut Input, Card or Pass.")
                step("Nexus then asks once: planned or impulse, or at a supermarket: staples only or luxury too.")
            }
            Section("From the share sheet") {
                step("Shortcuts, +, add Add receipt (Nexuslive) with Receipt set to Shortcut Input; in its details turn on Show in Share Sheet for images and PDFs. A supermarket app's digital receipt then shares straight to Nexus.")
                step("For items: a second shortcut with Open Buy check, Item set to Shortcut Input, shown in the Share Sheet for text and URLs.")
            }
            Section("Home screen and Siri") {
                step("Add the Nexuslive widget for a one-tap Buy check, or say \"Buy check in Nexuslive\".")
            }
        }
        .navigationTitle("Shortcuts and reminders")
        .task { permission = await NotificationService.shared.permissionGranted() }
    }

    private func step(_ text: String) -> some View { Text(text).font(.callout) }
}
