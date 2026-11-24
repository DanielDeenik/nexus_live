import Foundation

/// One tax year as the fiscal engine computes it (nexus/forecast). Amounts in euro.
struct TaxFigures: Decodable {
    let revenue_eur: Double
    let costs_eur: Double
    let depreciation_eur: Double
    let hours: Double
    let profit: Double
    let zelfstandigenaftrek: Double
    let startersaftrek: Double
    let kia: Double
    let mkb_winstvrijstelling: Double
    let taxable_profit: Double
    let wage: Double
    let tariefsaanpassing: Double
    let algemene_heffingskorting: Double
    let arbeidskorting: Double
    let income_tax: Double
    let zvw: Double
    let total_due: Double
    let withheld: Double
    let prepaid: Double
    let to_pay: Double
    let effective_rate: Double
    let urencriterium_met: Bool
}

struct ForecastRate: Decodable {
    let eur_per_hour: Double
    let unit_rate: Double
    let currency: String
    let fx_eur: Double
    let invoice_number: String?
}

struct BilledSoFar: Decodable {
    let through: String?
    let hours: Double
    let revenue_eur: Double
    let invoices: Int
}

struct StillToBill: Decodable {
    let from: String
    let to: String
    let working_days: Double
    let days_off: Double
    let hours: Double
    let revenue_eur: Double
}

struct MarginalRates: Decodable {
    let revenue: Double
    let cost: Double
}

struct FilingTimeline: Decodable {
    let file_before: String
    let interest_from: String
    let interest_rate: Double
}

/// One invoice: billed already, or projected from the hours you plan to work.
struct WorkMonth: Decodable, Identifiable {
    let month: String
    let working_days: Double
    let days_off: Double
    let hours: Double
    let revenue_eur: Double
    let invoice_date: String
    let payment_date: String
    let invoice_number: String?
    let status: String
    let tax_eur: Double
    var id: String { month + "|" + (invoice_number ?? status) }
}

/// Money in and out by month: payments, the tax share, living costs and investing.
struct CashMonth: Decodable, Identifiable {
    let month: String
    let payments_eur: Double
    let tax_eur: Double
    let living_eur: Double
    let invest_eur: Double
    let left_eur: Double
    var id: String { month }
}

struct StructureResult: Decodable, Identifiable {
    let label: String
    let tax_eur: Double
    let net_to_you_eur: Double
    let kept_in_bv_eur: Double
    var id: String { label }
}

struct StructureComparison: Decodable {
    let salary_eur: Double
    let salary_raised_to_minimum: Bool
    let minimum_salary_eur: Double
    let results: [StructureResult]
}

struct NextYearPlan: Decodable {
    let year: Int
    let params_year: Int
    let indicative: Bool
    let working_days: Double
    let days_off: Double
    let figures: TaxFigures
    let monthly_set_aside_eur: Double
    let structures: StructureComparison?
}

struct ForecastWarning: Decodable, Identifiable {
    let code: String
    let severity: String
    let message: String
    var id: String { code + message }
}

struct Forecast: Decodable {
    let year: Int
    let today: String
    let params_year: Int
    let params_indicative: Bool
    let rate: ForecastRate?
    let hours_per_day: Double?
    let payment_lag_days: Double?
    let billed: BilledSoFar
    let to_date: TaxFigures
    let year_end: TaxFigures
    let remaining: StillToBill?
    let reserve_eur: Double
    let set_aside_rate: Double
    let marginal: MarginalRates
    let timeline: FilingTimeline?
    let months: [WorkMonth]
    let cash: [CashMonth]
    let next_year: NextYearPlan?
    let warnings: [ForecastWarning]
}

struct YearReserve: Decodable, Identifiable {
    let year: Int
    let reserve_eur: Double
    var id: Int { year }
}

struct ForecastResponse: Decodable {
    let forecast: Forecast
    let reserves: [YearReserve]
    let what_if: Forecast?
}

/// What the books cannot know for a year: days off and wage figures (nx_tax_year_inputs).
struct YearInput: Codable {
    let year: Int
    let days_off: Double
}

// MARK: Accounts screen (nexus/accounts)

struct ServiceInfo: Decodable, Identifiable {
    let id: String
    let name: String
    let kind: String
    let via: String
    let status: String
    let detail: String?
    let valid_until: String?
    let open_url: String?
    let help_url: String?
    let help: String?
    let optional: Bool

    var isConnected: Bool { status == "connected" }
}

struct AccountInfo: Decodable, Identifiable {
    let label: String
    let source: String
    let account: String
    let kind: String
    let balance: Double
    let last_booked: String?
    let bank_balance: Double?
    let bank_balance_date: String?
    let feed: String
    var id: String { source + "|" + account }
}

struct WalletInfo: Decodable {
    let label: String
    let currency: String
    let balance: Double
}

struct BrokerInfo: Decodable {
    let as_of: String?
    let cash_usd: Double
    let invested_usd: Double
    let unrealized_pnl_usd: Double
    let positions: Int
}

struct NeedDecision: Decodable {
    let approve: String
    let reject: String
}

struct NeedInfo: Decodable, Identifiable {
    let code: String
    let severity: String
    let title: String
    let detail: String
    let action: String
    let service_id: String?
    let review_item_id: String?
    let decide: NeedDecision?
    let dismissible: Bool
    var id: String { code }
}

struct AccountsOverview: Decodable {
    let as_of: String
    let redirect_url: String
    let callback_url: String
    let services: [ServiceInfo]
    let accounts: [AccountInfo]
    let wallets: [WalletInfo]
    let broker: BrokerInfo?
    let needs: [NeedInfo]

    func service(_ id: String?) -> ServiceInfo? {
        guard let id else { return nil }
        return services.first { $0.id == id }
    }
}

/// The three ways to run the business, as the forecast labels them.
enum Structure: String, CaseIterable, Identifiable {
    case eenmanszaak
    case bvPayout = "bv_payout"
    case bvRetain = "bv_retain"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .eenmanszaak: return "Eenmanszaak"
        case .bvPayout: return "BV, pay it out"
        case .bvRetain: return "BV, keep it in"
        }
    }

    var short: String {
        switch self {
        case .eenmanszaak: return "ZZP"
        case .bvPayout: return "BV out"
        case .bvRetain: return "BV keep"
        }
    }

    static func named(_ label: String) -> Structure? { Structure(rawValue: label) }
}

enum MonthText {
    private static let parser: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM"
        return f
    }()

    private static let output: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM yy"
        return f
    }()

    /// "2026-12" as "Dec 26".
    static func short(_ month: String) -> String {
        guard let date = parser.date(from: String(month.prefix(7))) else { return month }
        return output.string(from: date)
    }
}

enum Percent {
    static func format(_ value: Double) -> String {
        value.formatted(.percent.precision(.fractionLength(0...1)))
    }
}
