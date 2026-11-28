import SwiftUI

// Today, Slipping, A month and Assignment: one number, one answer and one action a screen.
// Every figure and sentence comes from nx_glance; the web look-through shows what is behind them.

/// Ring colours: a neutral for tax and three hues that stay apart for colour-blind eyes.
enum RingColor {
    static let tax = Color(red: 142 / 255, green: 142 / 255, blue: 147 / 255)
    static let business = Color(red: 18 / 255, green: 165 / 255, blue: 148 / 255)
    static let living = Color(red: 51 / 255, green: 140 / 255, blue: 237 / 255)
    static let yours = Color(red: 210 / 255, green: 142 / 255, blue: 5 / 255)

    static func of(_ key: String) -> Color {
        switch key {
        case "tax": return tax
        case "business": return business
        case "living": return living
        default: return yours
        }
    }
}

/// A ring of arcs with a small gap between neighbours, and whatever belongs in the middle.
struct Ring<Centre: View>: View {
    let arcs: [RingArc]
    let lineWidth: CGFloat
    private let centre: Centre

    init(arcs: [RingArc], lineWidth: CGFloat = 14, @ViewBuilder centre: () -> Centre) {
        self.arcs = arcs
        self.lineWidth = lineWidth
        self.centre = centre()
    }

    /// Half the gap between two arcs as a share of the turn; a lone arc closes the ring.
    private var gap: Double { arcs.count > 1 ? 0.004 : 0 }

    var body: some View {
        ZStack {
            Circle().stroke(Color(.tertiarySystemFill), lineWidth: lineWidth)
            ForEach(arcs) { arc in
                Circle()
                    .trim(from: arc.from + gap, to: max(arc.to - gap, arc.from + gap))
                    .stroke(RingColor.of(arc.key), style: StrokeStyle(lineWidth: lineWidth, lineCap: .butt))
                    .rotationEffect(.degrees(-90))
            }
            centre
        }
        .padding(lineWidth / 2)
    }
}

/// The number in the middle of a ring and the few words under it.
struct RingCentre: View {
    let amount: Double
    let caption: String
    let currency: String

    var body: some View {
        VStack(spacing: 2) {
            Text(Money.format(amount.rounded(), currency))
                .font(.system(size: 34, weight: .bold, design: .rounded)).monospacedDigit()
                .foregroundStyle(amount < 0 ? Color.red : Color.primary)
                .minimumScaleFactor(0.5)
                .lineLimit(1)
            Text(caption).font(.footnote).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 30)
    }
}

/// The rows under a ring: a colour, a name and an amount.
struct LegendCard: View {
    let slices: [Glance.Slice]
    let currency: String

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(slices.enumerated()), id: \.element.id) { index, slice in
                if index > 0 { Divider() }
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 3).fill(RingColor.of(slice.key)).frame(width: 12, height: 12)
                    Text(slice.label)
                    Spacer()
                    Text(Money.format(slice.amount.rounded(), currency))
                        .monospacedDigit()
                        .fontWeight(.semibold)
                        .foregroundStyle(slice.amount < 0 ? Color.red : Color.primary)
                }
                .frame(minHeight: 44)
            }
        }
        .padding(.horizontal, 16)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }
}

/// Opens what a row points at: a sheet of the app, or a page of the web app.
@MainActor
func follow(_ item: Glance.Item, in glance: Glance, router: AppRouter, openURL: OpenURLAction) {
    switch item.link ?? "" {
    case "review": router.showReview = true
    case "close": router.showClose = true
    case "purchases": router.showPurchases = true
    case "rule": router.ruleDraft = Tags.draft(from: item)
    case "time":
        if let url = GlanceMath.webURL(glance.web_url, path: "/time/entries") { openURL(url) }
    default: break
    }
}

// MARK: Today

/// Today: what is yours after tax as one ring, the next thing to do, and how much is slipping.
/// The target, the sliders and the reviews are one tap down.
struct TodayView: View {
    @EnvironmentObject private var ledger: Ledger
    @EnvironmentObject private var router: AppRouter
    @Environment(\.openURL) private var openURL
    @State private var loggingCost = false
    @State private var pickPhoto = false
    @State private var takePhoto = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    if let glance = ledger.glance {
                        Ring(arcs: GlanceMath.arcs(glance.today.slices)) {
                            RingCentre(amount: glance.today.yours, caption: glance.today.caption, currency: ledger.baseCurrency)
                        }
                        .frame(width: 232, height: 232)
                        .padding(.top, 4)
                        LegendCard(slices: glance.today.slices, currency: ledger.baseCurrency)
                        if let next = glance.today.next { nextCard(next, glance) }
                        links(glance)
                    } else if let problem = ledger.glanceError {
                        ContentUnavailableView("Today could not load", systemImage: "exclamationmark.triangle",
                                               description: Text(problem))
                    } else {
                        ProgressView().padding(.top, 120)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .navigationTitle("Today")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if let count = ledger.glance?.today.slipping_count, count > 0 {
                        NavigationLink { SlippingView() } label: {
                            HStack(spacing: 6) {
                                Circle().fill(Color.red).frame(width: 8, height: 8)
                                Text("\(count) slipping").font(.subheadline.weight(.semibold))
                            }
                        }
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button { router.openBuy(BuyDraft()) } label: { Label("Buy check", systemImage: "cart.badge.questionmark") }
                        Button { loggingCost = true } label: { Label("Log business cost", systemImage: "briefcase") }
                        if cameraAvailable {
                            Button { takePhoto = true } label: { Label("Photograph a receipt", systemImage: "camera") }
                        }
                        Button { pickPhoto = true } label: { Label("Receipt from Photos", systemImage: "photo") }
                    } label: { Image(systemName: "plus") }
                }
            }
            .refreshable { await ledger.reload() }
            .sheet(isPresented: $loggingCost) { LogView() }
            .receiptCapture(pickPhoto: $pickPhoto, takePhoto: $takePhoto)
        }
    }

    private func nextCard(_ next: Glance.Item, _ glance: Glance) -> some View {
        Button { follow(next, in: glance, router: router, openURL: openURL) } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Next").font(.caption).foregroundStyle(.secondary)
                    Text(next.action ?? next.title).font(.headline).foregroundStyle(Color.primary)
                    Text("\(next.title): \(next.now)").font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.leading)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
    }

    private func links(_ glance: Glance) -> some View {
        VStack(spacing: 0) {
            if glance.month != nil {
                NavigationLink { MonthView() } label: { linkRow("A month", icon: "chart.pie") }
                Divider().padding(.leading, 52)
            }
            if glance.assignment != nil {
                NavigationLink { AssignmentView() } label: { linkRow("Assignment", icon: "briefcase") }
                Divider().padding(.leading, 52)
            }
            NavigationLink { TargetView() } label: { linkRow(ledger.goalName.isEmpty ? "Target" : ledger.goalName, icon: "flag") }
        }
        .buttonStyle(.plain)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    private func linkRow(_ title: String, icon: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon).frame(width: 24).foregroundStyle(Theme.accent)
            Text(title).foregroundStyle(Color.primary)
            Spacer()
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 48)
        .contentShape(Rectangle())
    }
}

// MARK: Slipping

/// Slipping: the first rows that are off your own plan or rule, and what got better.
/// The rest is in the web look-through.
struct SlippingView: View {
    @EnvironmentObject private var ledger: Ledger
    @EnvironmentObject private var router: AppRouter
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            if let glance = ledger.glance {
                let part = GlanceMath.shown(glance.slipping)
                VStack(alignment: .leading, spacing: 28) {
                    if part.rows.isEmpty {
                        Text("Nothing is off your plan today.").foregroundStyle(.secondary)
                    }
                    ForEach(part.rows) { item in
                        if item.link != nil {
                            Button { follow(item, in: glance, router: router, openURL: openURL) } label: { row(item) }
                                .buttonStyle(.plain)
                        } else {
                            row(item)
                        }
                    }
                    ForEach(glance.slipping.better) { better in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.green)
                            Text("\(better.title): \(better.detail)").font(.subheadline)
                        }
                    }
                    if part.rest > 0 { rest(part.rest, glance) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }
        }
        .navigationTitle("Slipping")
        .refreshable { await ledger.reloadGlance() }
    }

    private func row(_ item: Glance.Item) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.title).font(.subheadline).foregroundStyle(.secondary)
            Text(item.now)
                .font(.system(size: 34, weight: .bold, design: .rounded)).monospacedDigit()
                .foregroundStyle(Color.red)
                .minimumScaleFactor(0.5)
                .lineLimit(1)
            Text(item.short).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder private func rest(_ count: Int, _ glance: Glance) -> some View {
        let text = count == 1 ? "The other one is in the web app." : "The other \(count) are in the web app."
        if let url = GlanceMath.webURL(glance.web_url, path: "/look", topic: "slipping") {
            Button { openURL(url) } label: {
                HStack {
                    Text(text)
                    Spacer()
                    Image(systemName: "arrow.up.right")
                }
                .font(.subheadline)
                .frame(minHeight: 44)
            }
        } else {
            Text(text).font(.subheadline).foregroundStyle(.secondary)
        }
    }
}

// MARK: A month

/// A month: where an average month of next year goes, as you live now and on your budget.
struct MonthView: View {
    @EnvironmentObject private var ledger: Ledger
    @State private var onBudget = false

    var body: some View {
        ScrollView {
            if let month = ledger.glance?.month {
                let mode = onBudget ? month.budget : month.now
                VStack(spacing: 20) {
                    Text(month.title).font(.subheadline).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Picker("Living costs", selection: $onBudget) {
                        Text("As now").tag(false)
                        Text("On budget").tag(true)
                    }
                    .pickerStyle(.segmented)
                    Ring(arcs: GlanceMath.arcs(GlanceMath.monthSlices(month, onBudget: onBudget))) {
                        RingCentre(amount: mode.left, caption: mode.left < 0 ? "short of living costs" : "left to invest",
                                   currency: ledger.baseCurrency)
                    }
                    .frame(width: 220, height: 220)
                    LegendCard(slices: GlanceMath.monthLegend(month, onBudget: onBudget), currency: ledger.baseCurrency)
                    if let line = mode.line {
                        Text(line).font(.subheadline).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(20)
            }
        }
        .navigationTitle("A month")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if ledger.glance?.assignment != nil {
                    NavigationLink("Assignment") { AssignmentView() }
                }
            }
        }
        .refreshable { await ledger.reloadGlance() }
    }
}

// MARK: Assignment

/// Assignment: does the plan close at the rate you bill, which rate would close it, and how long
/// the money lasts if the work stopped.
struct AssignmentView: View {
    @EnvironmentObject private var ledger: Ledger
    @State private var settingEnd = false

    var body: some View {
        ScrollView {
            if let assignment = ledger.glance?.assignment {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(assignment.question).font(.subheadline).foregroundStyle(.secondary)
                        Text(assignment.answer).font(.system(size: 64, weight: .bold, design: .rounded))
                        Text(assignment.reason).foregroundStyle(.secondary)
                    }
                    HStack(alignment: .top, spacing: 10) {
                        ForEach(assignment.tiles) { tile in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(tile.value ?? "").font(.title3.bold()).monospacedDigit()
                                    .minimumScaleFactor(0.6)
                                    .lineLimit(1)
                                Text(tile.label).font(.caption).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
                        }
                    }
                    if let line = assignment.end_line {
                        Text(line).font(.subheadline)
                    }
                    Button { settingEnd = true } label: {
                        Text(assignment.end_date == nil ? "Set the end date" : "Change the end date").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }
        }
        .navigationTitle("Assignment")
        .refreshable { await ledger.reloadGlance() }
        .sheet(isPresented: $settingEnd) {
            EndDateForm(current: ledger.glance?.assignment?.end_date.flatMap { Day.date($0) })
        }
    }
}

/// The last day of the running assignment. Nexus counts down to it; nothing else changes.
struct EndDateForm: View {
    @EnvironmentObject private var ledger: Ledger
    @Environment(\.dismiss) private var dismiss
    @State private var date: Date
    @State private var saving = false
    @State private var problem: String?
    private let hadDate: Bool

    init(current: Date?) {
        _date = State(initialValue: current ?? Date())
        hadDate = current != nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("Ends on", selection: $date, displayedComponents: .date)
                } footer: {
                    Text("The last day of the running assignment. Nexus counts down to it; nothing else changes.")
                }
                if hadDate {
                    Section {
                        Button("Remove the end date", role: .destructive) { save(nil) }
                    }
                }
            }
            .navigationTitle("End date")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save(date) }.disabled(saving) }
            }
            .errorAlert($problem)
        }
    }

    private func save(_ value: Date?) {
        saving = true
        Task {
            do {
                try await ledger.setAssignmentEnd(value)
                dismiss()
            } catch {
                problem = error.localizedDescription
            }
            saving = false
        }
    }
}
