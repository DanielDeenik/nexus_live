// Checks for tags on made-up figures: a slipping tag decodes with its proposed rule, its key names
// the tag, the rule form starts from the proposal, and a line form saves only what changed.
// Runs without Xcode: ios/scripts/check-core.sh
import Foundation

func tagChecks() {
    let json = """
    {"key": "tag:serves:life", "title": "Serves: life", "now": "620 by month end", "short": "Your average is 410 a month.",
     "detail": "d", "action": "Make it a rule", "link": "rule",
     "rule": {"if": "I am about to spend on life at a bar on a Friday feeling bored", "then": "I log a Buy check and wait 48 hours first",
              "cue": "a bar, Friday, bored", "eur_month": 210, "goal": "the goal"}}
    """
    guard let item = try? JSONDecoder().decode(Glance.Item.self, from: Data(json.utf8)) else {
        check("a slipping tag decodes with its proposed rule", false)
        return
    }
    check("a slipping tag decodes with its proposed rule",
          item.link == "rule" && item.rule?.condition.hasPrefix("I am about to spend") == true && item.rule?.eur_month == 210)

    let plain = try? JSONDecoder().decode(Glance.Item.self, from: Data(#"{"key": "living", "title": "t", "now": "n", "short": "s", "detail": "d"}"#.utf8))
    check("a row without a rule still decodes", plain != nil && plain?.rule == nil)

    let tag = GlanceMath.tag(of: item.key)
    check("the key names the tag", tag?.dimension == "serves" && tag?.value == "life")
    check("a key that is not a tag names none", GlanceMath.tag(of: "living") == nil && GlanceMath.tag(of: "tag::x") == nil)
    check("a project slug with a colon stays whole", GlanceMath.tag(of: "tag:project:a:b")?.value == "a:b")

    let draft = Tags.draft(from: item)
    check("the rule form starts from the proposal and knows its tag",
          draft?.condition == item.rule?.condition && draft?.then == item.rule?.then
          && draft?.cue == "a bar, Friday, bored" && draft?.tagDimension == "serves" && draft?.tagValue == "life")
    check("a row without a rule opens no form", plain.map { Tags.draft(from: $0) } ?? nil == nil)

    let before = ["serves": "life", "worth": "want"]
    let changes = Tags.changes(from: before, to: ["serves": "life", "worth": "", "project": "nexus"])
    check("a line form saves only what changed, and an empty pick hands back to the rules",
          changes.count == 2 && changes[0].dimension == "project" && changes[0].value == "nexus"
          && changes[1].dimension == "worth" && changes[1].value == nil)
    check("nothing changed saves nothing", Tags.changes(from: before, to: before).isEmpty)

    let tags = [LineTag(dimension: "serves", value: "life", source: "rule"), LineTag(dimension: "worth", value: "need", source: "hand")]
    check("picks start from the line's tags", Tags.picks(tags) == ["serves": "life", "worth": "need"])

    let choices = try? JSONDecoder().decode([TagChoice].self, from: Data(#"[{"key": "worth", "label": "Worth it", "values": [{"value": "need", "label": "Need"}]}]"#.utf8))
    check("the choices decode", choices?.first?.values.first?.label == "Need")
}
