// Runs the core checks: ios/scripts/check-core.sh
import Foundation

var failures = 0
func check(_ label: String, _ ok: Bool) {
    print(ok ? "ok   \(label)" : "FAIL \(label)")
    if !ok { failures += 1 }
}
func near(_ a: Double?, _ b: Double, _ tol: Double) -> Bool { a.map { abs($0 - b) <= tol } ?? false }

planMathChecks()
deeplinkChecks()
spendModelChecks()
glanceChecks()
subscriptionChecks()
tagChecks()
if failures > 0 { print("\(failures) failed"); exit(1) }
print("all core checks passed")
