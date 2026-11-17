import Foundation
import CryptoKit

/// One bank export layout, read from bank-formats.json so new banks need no code change.
struct BankFormat: Decodable {
    let name: String
    let requires: [String]?
    let date: String?
    let date_formats: [String]
    let amount: String?
    let direction: String?
    let outgoing: [String]?
    let currency: String?
    let currency_fixed: String?
    let counterparty: String?
    let description: String?
    let headerless_columns: Int?
    let date_index: Int?
    let amount_index: Int?
    let currency_index: Int?
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

    /// Turns a bank export into expense rows (money going out only) for nx_import_expenses.
    static func read(_ url: URL, fallbackCurrency: String) throws -> ImportPreview {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        guard let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else {
            throw BankImportError.unreadable
        }
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        guard let first = lines.first else { throw BankImportError.unreadable }
        let delimiter = detectDelimiter(first)
        let table = lines.map { split($0, delimiter) }
        let header = table[0].map { $0.trimmingCharacters(in: .whitespaces) }

        for format in try formats() {
            if let required = format.requires {
                guard required.allSatisfy({ header.contains($0) }) else { continue }
                return build(format, rows: Array(table.dropFirst()), lines: Array(lines.dropFirst()),
                             column: { name in name.flatMap { header.firstIndex(of: $0) } },
                             fallbackCurrency: fallbackCurrency)
            }
            if let count = format.headerless_columns, header.count == count,
               let dateIndex = format.date_index, parseDate(table[0][safe: dateIndex] ?? "", format.date_formats) != nil {
                return build(format, rows: table, lines: lines, column: { _ in nil },
                             fallbackCurrency: fallbackCurrency)
            }
        }
        throw BankImportError.unknownLayout(first)
    }

    private static func build(_ format: BankFormat, rows: [[String]], lines: [String],
                              column: (String?) -> Int?, fallbackCurrency: String) -> ImportPreview {
        let dateCol = column(format.date) ?? format.date_index
        let amountCol = column(format.amount) ?? format.amount_index
        let directionCol = column(format.direction)
        let currencyCol = column(format.currency) ?? format.currency_index
        let counterpartyCol = column(format.counterparty)
        let descriptionCol = column(format.description) ?? format.description_index
        let outgoing = Set(format.outgoing ?? [])

        var out: [[String: Any]] = []
        var skipped = 0
        for (index, row) in rows.enumerated() {
            guard let dateCol, let amountCol,
                  let date = parseDate(row[safe: dateCol] ?? "", format.date_formats),
                  var amount = Money.parse(row[safe: amountCol] ?? "") else { skipped += 1; continue }
            if let directionCol {
                let direction = (row[safe: directionCol] ?? "").trimmingCharacters(in: .whitespaces)
                amount = outgoing.contains(direction) ? -abs(amount) : abs(amount)
            }
            guard amount < 0 else { skipped += 1; continue }
            let currency = format.currency_fixed
                ?? currencyCol.flatMap { row[safe: $0] }.flatMap { $0.isEmpty ? nil : $0 }
                ?? fallbackCurrency
            let line = index < lines.count ? lines[index] : row.joined(separator: "|")
            let digest = SHA256.hash(data: Data((format.name + "|" + line).utf8))
            let hex = digest.map { String(format: "%02x", $0) }.joined()
            let id = "\(format.name.lowercased()):\(hex.prefix(32))"
            var entry: [String: Any] = [
                "external_txn_id": id,
                "amount": abs(amount),
                "currency": currency,
                "category": "uncategorised",
                "date": Day.string(date)
            ]
            if let counterpartyCol, let vendor = row[safe: counterpartyCol], !vendor.isEmpty { entry["vendor"] = vendor }
            if let descriptionCol, let note = row[safe: descriptionCol], !note.isEmpty { entry["description"] = String(note.prefix(500)) }
            out.append(entry)
        }
        return ImportPreview(bank: format.name, rows: out, skipped: skipped)
    }

    static func detectDelimiter(_ line: String) -> Character {
        let candidates: [Character] = [";", ",", "\t"]
        return candidates.max { a, b in line.filter { $0 == a }.count < line.filter { $0 == b }.count } ?? ","
    }

    /// Splits one CSV line, honouring double quotes and doubled quotes inside them.
    static func split(_ line: String, _ delimiter: Character) -> [String] {
        var fields: [String] = []
        var current = ""
        var quoted = false
        let iterator = Array(line)
        var i = 0
        while i < iterator.count {
            let c = iterator[i]
            if c == "\"" {
                if quoted && i + 1 < iterator.count && iterator[i + 1] == "\"" {
                    current.append("\"")
                    i += 1
                } else {
                    quoted.toggle()
                }
            } else if c == delimiter && !quoted {
                fields.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(c)
            }
            i += 1
        }
        fields.append(current.trimmingCharacters(in: .whitespaces))
        return fields
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
