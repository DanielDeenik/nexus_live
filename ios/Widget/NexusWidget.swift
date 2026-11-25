import SwiftUI
import WidgetKit

/// One tap from the home or lock screen to a Buy check, before you pay. It shows no figures, so it
/// needs no data from the app.
struct BuyCheckEntry: TimelineEntry {
    let date: Date
}

struct BuyCheckProvider: TimelineProvider {
    func placeholder(in context: Context) -> BuyCheckEntry { BuyCheckEntry(date: Date()) }

    func getSnapshot(in context: Context, completion: @escaping (BuyCheckEntry) -> Void) {
        completion(BuyCheckEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BuyCheckEntry>) -> Void) {
        completion(Timeline(entries: [BuyCheckEntry(date: Date())], policy: .never))
    }
}

/// The app's URL scheme, from this extension's Info.plist (set in project.yml).
private var urlScheme: String { (Bundle.main.object(forInfoDictionaryKey: "NXURLScheme") as? String) ?? "" }

struct BuyCheckView: View {
    @Environment(\.widgetFamily) private var family
    let entry: BuyCheckEntry

    var body: some View {
        content
            .widgetURL(URL(string: "\(urlScheme)://buy?entry=widget"))
            .containerBackground(for: .widget) { Color(.systemBackground) }
    }

    @ViewBuilder private var content: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "cart.badge.questionmark").font(.title3)
            }
        case .accessoryRectangular:
            VStack(alignment: .leading) {
                Text("Buy check").font(.headline)
                Text("Before you pay").font(.caption)
            }
        default:
            VStack(alignment: .leading, spacing: 4) {
                Image(systemName: "cart.badge.questionmark").font(.title).foregroundStyle(Color.accentColor)
                Spacer()
                Text("Buy check").font(.headline)
                Text("Before you pay").font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }
}

struct BuyCheckWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BuyCheck", provider: BuyCheckProvider()) { entry in
            BuyCheckView(entry: entry)
        }
        .configurationDisplayName("Buy check")
        .description("Opens a Buy check in Nexuslive before you pay.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular])
    }
}

@main
struct NexusWidgets: WidgetBundle {
    var body: some Widget {
        BuyCheckWidget()
    }
}
