// Checks for the stop lists read from settings, on made-up settings.
import Foundation

func spendModelChecks() {
    let settings = [
        "stop.gaming_pattern": "pixelcoins|gemstore", "stop.gaming_from": "2026-11-25",
        "stop.late_night_pattern": "nightbites",
        "stop.apple_line_pattern": "apple\\.com/bill", "stop.apple_from": "2027-01-01",
        "stop.food_delivery_pattern": "quickbite", "stop.food_delivery_from": "2027-02-01",
        "stop.empty_pattern": "", "stop.empty_from": "2027-01-01",
    ]
    let lists = StopList.all(in: settings)
    check("a stop list is a pattern with a start date; a pattern alone is not one", lists.map(\.name) == ["food_delivery", "gaming"])
    check("a stop list label reads as words", lists.map(\.label) == ["Food delivery", "Gaming"])
    check("a stop list keeps its pattern and start date", lists.last?.pattern == "pixelcoins|gemstore" && lists.last?.from == "2026-11-25")
}
