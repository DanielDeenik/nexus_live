import Foundation

/// Today, Slipping, A month and Assignment read one answer from the database.
extension Ledger {
    /// Loads nx_glance. It fails on its own: the other tabs keep working when it cannot load.
    func reloadGlance() async {
        do {
            let raw = try await backend.rpc("nx_glance", [:])
            glance = try JSONDecoder().decode(Glance.self, from: JSONSerialization.data(withJSONObject: raw))
            glanceError = nil
        } catch {
            glanceError = error.localizedDescription
        }
    }

    /// Stores the end date of the running assignment, or removes it with nil.
    func setAssignmentEnd(_ date: Date?) async throws {
        var end: Any = NSNull()
        if let date { end = Day.string(date) }
        _ = try await backend.rpc("nx_set_assignment_end", ["p_end": end])
        await reloadGlance()
    }

    /// The Sunday review ends by saving what you hold today (cash and what you are owed, the
    /// broker, the tax you owe), so next week shows what moved. The total is worked out by the table.
    func saveReviewSnapshot() async {
        guard let snapshot = glance?.review.snapshot else { return }
        do {
            try await addNetWorth(cash: snapshot.cash, investments: snapshot.investments, liabilities: snapshot.liabilities)
        } catch {
            glanceError = error.localizedDescription
        }
    }
}
