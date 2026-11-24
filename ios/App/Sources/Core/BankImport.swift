import Foundation

/// One bank export layout, read from bank-formats.json so new banks need no code change.
struct BankFormat: Decodable {
    let name: String
    /// Source id the server parses by (abn, bunq, ing, rabobank); `source_column` reads it per line instead.
    let source: String?
    let source_column: String?
    let requires: [String]?
    let date: String?
    let date_formats: [String]
    let amount: String?
    let direction: String?
    let outgoing: [String]?
    let currency: String?
    let currency_fixed: String?
    let account: String?
    let counterparty: String?
    let counterparty_iban: String?
    let description: String?
    let headerless_columns: Int?
    let date_index: Int?
    let amount_index: Int?
    let currency_index: Int?
    let account_index: Int?
    let description_index: Int?
}

private struct BankFormatFile: Decodable {
    let formats: [BankFormat]
}

struct ImportPreview {
    let bank: String
    let rows: [[String: Any]]
    let skipped: Int
}

enum BankImportError: LocalizedError {
    case unreadable
    case unknownLayout(String)
    case noFormats

    var errorDescription: String? {
        switch self {
        case .unreadable: return "The file could not be read as text."
        case .unknownLayout(let header): return "This export layout is not known yet. First line: \(header.prefix(120))"
        case .noFormats: return "bank-formats.json is missing from the app."
        }
    }
}

enum BankImport {
    static func formats() throws -> [BankFormat] {
        guard let url = Bundle.main.url(forResource: "bank-formats", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { throw BankImportError.noFormats }
        return try JSONDecoder().decode(BankFormatFile.self, from: data).formats
    }

    /// Reads a bank export into raw lines, money in and money out. The server parses each line,
    /// recognises transfers between your own accounts, applies your category rules and skips lines it already has.
    static func read(_ url: URL, fallbackCurrency: String) throws -> ImportPreview {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        guard var text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else {
            throw BankImportError.unreadable
        }
        if text.hasPrefix("\u{FEFF}") { text.removeFirst() }
        let firstLine = String(text.prefix { $0 != "\n" && $0 != "\r" && $0 != "\r\n" })
        let table = records(text, detectDelimiter(firstLine))
        guard let headerRow = table.first else { throw BankImportError.unreadable }
        let header = headerRow.map { $0.trimmingCharacters(in: .whitespaces) }

        for format in try formats() {
            if let required = format.requires {
                guard required.allSatisfy({ header.contains($0) }) else { continue }
                return build(format, rows: Array(table.dropFirst()),
                             column: { name in name.flatMap { header.firstIndex(of: $0) } },
                             fallbackCurrency: fallbackCurrency)
            }
            if let count = format.headerless_columns, headerRow.count == count,
               let dateIndex = format.date_index, parseDate(headerRow[safe: dateIndex] ?? "", format.date_formats) != nil {
                return build(format, rows: table, column: { _ in nil }, fallbackCurrency: fallbackCurrency)
            }
        }
        throw BankImportError.unknownLayout(firstLine)
    }

    private static func build(_ format: BankFormat, rows: [[String]],
                              column: (String?) -> Int?, fallbackCurrency: String) -> ImportPreview {
        let dateCol = column(format.date) ?? format.date_index
        let amountCol = column(format.amount) ?? format.amount_index
        let directionCol = column(format.direction)
        let currencyCol = column(format.currency) ?? format.currency_index
        let accountCol = column(format.account) ?? format.account_index
        let payeeCol = column(format.counterparty)
        let ibanCol = column(format.counterparty_iban)
        let descriptionCol = column(format.description) ?? format.description_index
        let sourceCol = column(format.source_column)
        let outgoing = Set(format.outgoing ?? [])

        var out: [[String: Any]] = []
        var skipped = 0
        for row in rows {
            guard let dateCol, let amountCol,
                  let date = parseDate(row[safe: dateCol] ?? "", format.date_formats),
                  var amount = Money.parse(row[safe: amountCol] ?? "") else { skipped += 1; continue }
            if let directionCol {
                let direction = (row[safe: directionCol] ?? "").trimmingCharacters(in: .whitespaces)
                amount = outgoing.contains(direction) ? -abs(amount) : abs(amount)
            }
            let lineSource = sourceCol.flatMap { row[safe: $0] }.flatMap { $0.isEmpty ? nil : $0.lowercased() }
            let currency = format.currency_fixed
                ?? currencyCol.flatMap { row[safe: $0] }.flatMap { $0.isEmpty ? nil : $0 }
                ?? fallbackCurrency
            var entry: [String: Any] = [
                "source": lineSource ?? format.source ?? format.name.lowercased(),
                "account": accountCol.flatMap { row[safe: $0] } ?? "",
                "date": Day.string(date),
                "amount": amount,
                "currency": currency,
                "description": descriptionCol.flatMap { row[safe: $0] } ?? ""
            ]
            if let payeeCol, let payee = row[safe: payeeCol], !payee.isEmpty { entry["payee"] = payee }
            if let ibanCol, let iban = row[safe: ibanCol], !iban.isEmpty { entry["counterparty"] = iban }
            out.append(entry)
        }
        return ImportPreview(bank: format.name, rows: out, skipped: skipped)
    }

    static func detectDelimiter(_ line: String) -> Character {
        let candidates: [Character] = [";", ",", "\t"]
        return candidates.max { a, b in line.filter { $0 == a }.count < line.filter { $0 == b }.count } ?? ","
    }

    /// Splits the whole file into records. A field that starts with a quote may hold the delimiter,
    /// doubled quotes and line breaks; quotes elsewhere are kept as text.
    static func records(_ text: String, _ delimiter: Character) -> [[String]] {
        var rows: [[String]] = []
        var row: [String] = []
        var field = ""
        var quoted = false
        let chars = Array(text)
        var i = 0

        func endField() {
            row.append(field.trimmingCharacters(in: .whitespaces))
            field = ""
        }
        func endRow() {
            endField()
            if row.contains(where: { !$0.isEmpty }) { rows.append(row) }
            row = []
        }

        while i < chars.count {
            let c = chars[i]
            if quoted {
                if c == "\"" {
                    if i + 1 < chars.count && chars[i + 1] == "\"" {
                        field.append("\"")
                        i += 1
                    } else {
                        quoted = false
                    }
                } else {
                    field.append(c)
                }
            } else if c == "\"" && field.trimmingCharacters(in: .whitespaces).isEmpty {
                field = ""
                quoted = true
            } else if c == delimiter {
                endField()
            } else if c == "\n" || c == "\r\n" || c == "\r" {
                endRow()
            } else {
                field.append(c)
            }
            i += 1
        }
        if !field.isEmpty || !row.isEmpty { endRow() }
        return rows
    }

    static func parseDate(_ raw: String, _ patterns: [String]) -> Date? {
        let text = raw.trimmingCharacters(in: .whitespaces)
        for pattern in patterns {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.calendar = Calendar(identifier: .gregorian)
            f.dateFormat = pattern
            if let date = f.date(from: text) { return date }
        }
        return nil
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
