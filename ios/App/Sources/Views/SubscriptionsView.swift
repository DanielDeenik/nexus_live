import SwiftUI

/// Every subscription with what it costs, when it charges next and where it is paid from.
/// Manage opens the merchant's account page and Cancel its cancel page, in the browser.
/// Cancelling stays your action; the detail lives in the purchase review and on the web.
struct SubscriptionsView: View {
    @EnvironmentObject private var ledger: Ledger

    private var today: String { Day.string(Date()) }
    private func rows(_ group: Subscriptions.Group) -> [RecurringCharge] {
        ledger.recurring.filter { Subscriptions.group($0, today: today) == group }
    }
    private var perMonth: Double {
        ledger.recurring.filter { Subscriptions.group($0, today: today) != .ended }.reduce(0) { $0 + $1.perMonth }
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text(Money.format(perMonth, ledger.baseCurrency) + " a month")
                        .font(.system(size: 28, weight: .bold, design: .rounded)).monospacedDigit()
                    Text("\(ledger.recurring.count - rows(.ended).count) running").font(.subheadline).foregroundStyle(.secondary)
                }
            }
            let bunq = rows(.onBunq)
            if !bunq.isEmpty {
                Section {
                    ForEach(bunq) { SubscriptionRow(charge: $0) }
                } header: {
                    Text("On bunq: move or cancel")
                } footer: {
                    Text("bunq closes. Move each one to ABN AMRO, Wise or Amex, or cancel it.")
                }
            }
            let active = rows(.active)
            if !active.isEmpty { Section("Running") { ForEach(active) { SubscriptionRow(charge: $0) } } }
            let ended = rows(.ended)
            if !ended.isEmpty { Section("Cancelled or ended") { ForEach(ended) { SubscriptionRow(charge: $0) } } }
            if ledger.recurring.isEmpty {
                Text("Subscriptions appear after the next bank sync or import.").foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Subscriptions")
        .refreshable { await ledger.reloadSpend() }
    }
}

struct SubscriptionRow: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.openURL) private var openURL
    let charge: RecurringCharge

    private var links: Subscriptions.Links { Subscriptions.links(for: charge, routes: ledger.routes) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(charge.label).lineLimit(1)
                Spacer()
                if Subscriptions.isFailing(charge) {
                    Text("Failing").font(.caption2.bold()).foregroundStyle(.red)
                }
                Text(charge.amount.map { Money.format($0, ledger.baseCurrency) } ?? "").font(.callout.monospacedDigit())
            }
            Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            HStack(spacing: 12) {
                if let manage = links.manage {
                    Button { openURL(manage) } label: { Label("Manage", systemImage: "person.crop.circle") }
                }
                if let cancel = links.cancel {
                    Button { openURL(cancel) } label: {
                        Label(links.cancelAtBank ? "Block at bank" : "Cancel", systemImage: "xmark.circle")
                    }
                    .tint(.red)
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.vertical, 2)
    }

    private var detail: String {
        var parts = [charge.cadence.capitalized]
        if let next = charge.next_due, Subscriptions.group(charge, today: Day.string(Date())) != .ended {
            parts.append("next \(Day.date(next)?.formatted(date: .abbreviated, time: .omitted) ?? next)")
        }
        parts.append(Subscriptions.paidFrom(charge))
        return parts.joined(separator: " · ")
    }
}
