// Tags on bank lines, on the made-up household of glance_test.ts with the real tags migration:
// a rule tags lines, a hand tag beats it, "Always for this shop" joins the shop's own rule, a
// value above its own average joins Slipping with a proposed rule, and the web shows By tag.
// Run: deno test --allow-read supabase/tests/tags_web_test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.6.0";
import { household, iso, M, OTHER, read, today, U } from "./fixtures/glance/household.ts";
import { type Look, topics } from "../../apps/web/src/lib/look.ts";

// What the tags migration reads beyond the glance cut: the columns it joins on, the projects,
// the bank line parser and the settings it takes its values from.
async function withTags(): Promise<PGlite> {
  const db = await household();
  await db.exec(`
    create table if not exists auth.users (id uuid primary key);
    insert into auth.users (id) values ('${U}'), ('${OTHER}');
    alter table nx_transactions add column if not exists description text, add column if not exists payee text,
      add column if not exists counterparty_iban text, add column if not exists is_own_transfer boolean default false;
    alter table nx_category_rules add column if not exists match jsonb not null default '{}', add column if not exists origin text,
      add column if not exists created_at timestamptz default now(), add primary key (id);
    alter table nx_recurring add column if not exists tag text, add column if not exists updated_at timestamptz default now();
    alter table nx_decisions add column if not exists purpose text, add column if not exists urge text;
    create table dt_projects (id uuid default gen_random_uuid(), user_id uuid, name text, archived_at timestamptz);
    insert into dt_projects (user_id, name) values ('${U}', 'Nexus'), ('${U}', 'Old thing'), ('${OTHER}', 'Not mine');
    update dt_projects set archived_at = now() where name = 'Old thing';
    create function nx_parse_bank_line(p_source text, p_description text, p_payee text, p_iban text)
      returns table(details text, tx_type text) language sql as $$ select coalesce(p_description, ''), ''::text $$;
    insert into app_config (key, value) values
      ('review.purpose_tags', '["Social Arb", "net worth", "life"]'), ('review.rule_priority', '245'),
      ('purchase.considered_wait_hours', '48'), ('purchase.goal_name', 'the goal');`);
  await db.exec(read("../migrations/20261128000003_tags.sql"));
  return db;
}
const look = async (db: PGlite) => (await db.query<{ j: Look }>("select nx_look() as j")).rows[0].j;
const tagOf = async (db: PGlite, merchant: string, dimension: string) =>
  (await db.query<{ value: string; source: string }>(
    "select lt.value, lt.source from nx_line_tags lt join nx_transactions t on t.id = lt.txn_id where t.merchant = $1 and lt.dimension = $2 and t.user_id = $3",
    [merchant, dimension, U])).rows;

Deno.test("the choices come from where they live: Serves, your open projects, Worth it", async () => {
  const db = await withTags();
  const c = (await db.query<{ j: { key: string; values: { value: string; label: string }[] }[] }>("select nx_tag_choices() as j")).rows[0].j;
  assertEquals(c.map((d) => d.key), ["serves", "project", "worth"]);
  assertEquals(c[0].values.map((v) => v.value), ["social_arb", "net_worth", "life"]);
  assertEquals(c[1].values.map((v) => v.label), ["Nexus"]);
  assertEquals(c[2].values.map((v) => v.label), ["Need", "Want", "Regret"]);
  await db.close();
});

Deno.test("a tag rule tags every line of the shop and leaves the category alone", async () => {
  const db = await withTags();
  const before = (await db.query<{ n: number }>("select count(*)::int n from nx_transactions where category = 'Shopping'")).rows[0].n;
  await db.query(`insert into nx_category_rules (user_id, priority, match, tags, origin) values ($1, 245, '{"name": "^gadgetshop"}', '{"serves": "life"}', 'review')`, [U]);
  await db.query("select nx_retag()");
  const tags = await tagOf(db, "Gadgetshop", "serves");
  assertEquals(tags.length, 7); // three months of a purchase and a refund, and this month's purchase
  assert(tags.every((t) => t.value === "life" && t.source === "rule"));
  assertEquals((await tagOf(db, "Bookworld", "serves")).length, 0);
  // nx_classify never picks a rule that only tags.
  const c = (await db.query<{ category: string }>(`select category from nx_classify($1, '{"name": "Gadgetshop"}')`, [U])).rows[0];
  assertEquals(c.category, "Rent");
  assertEquals((await db.query<{ n: number }>("select count(*)::int n from nx_transactions where category = 'Shopping'")).rows[0].n, before);
  // A rule that sets nothing is refused, and so is a value no dimension has.
  await assertRejects(() => db.query(`insert into nx_category_rules (user_id, priority, match) values ($1, 1, '{"name": "x"}')`, [U]));
  await assertRejects(() => db.query("select nx_set_line_tags(array(select id from nx_transactions where merchant = 'Bookworld'), 'serves', 'nonsense')"));
  await db.close();
});

Deno.test("a hand tag beats the rule, and Always joins the shop's own rule", async () => {
  const db = await withTags();
  await db.query(`insert into nx_category_rules (user_id, priority, match, category, class, origin) values ($1, 245, '{"name": "^bookworld"}', 'Shopping', 'discretionary', 'review')`, [U]);
  await db.query(`insert into nx_category_rules (user_id, priority, match, tags, origin) values ($1, 245, '{"name": "^gadgetshop"}', '{"serves": "life"}', 'review')`, [U]);
  await db.query("select nx_retag()");
  const one = (await db.query<{ id: string }>("select id from nx_transactions where merchant = 'Gadgetshop' and user_id = $1 order by booked_on desc limit 1", [U])).rows[0].id;
  await db.query("select nx_set_line_tags(array[$1::uuid], 'serves', 'net_worth')", [one]);
  await db.query("select nx_retag()");
  const tags = await tagOf(db, "Gadgetshop", "serves");
  assertEquals(tags.filter((t) => t.source === "hand").map((t) => t.value), ["net_worth"]);
  assertEquals(tags.filter((t) => t.source === "rule").length, 6);
  // Back to the rules.
  await db.query("select nx_set_line_tags(array[$1::uuid], 'serves', null)", [one]);
  assertEquals((await tagOf(db, "Gadgetshop", "serves")).filter((t) => t.value === "life").length, 7);

  const book = (await db.query<{ id: string }>("select id from nx_transactions where merchant = 'Bookworld'")).rows[0].id;
  await db.query("select nx_set_line_tags(array[$1::uuid], 'worth', 'want', true)", [book]);
  const rules = (await db.query<{ category: string | null; tags: Record<string, string> | null }>(
    "select category, tags from nx_category_rules where match ->> 'name' = '^bookworld'")).rows;
  assertEquals(rules, [{ category: "Shopping", tags: { worth: "want" } }]);
  await db.close();
});

Deno.test("a value above its own average slips with a proposed rule, and the web shows By tag", async () => {
  const db = await withTags();
  await db.query(`insert into nx_category_rules (user_id, priority, match, tags, origin) values ($1, 245, '{"name": "^gadgetshop"}', '{"serves": "life"}', 'review')`, [U]);
  await db.query("select nx_retag()");
  await db.query("insert into nx_transactions (user_id, source, account, booked_on, amount, merchant, category, class) values ($1, 'bank', 'CUR', $2, -2000, 'Gadgetshop', 'Shopping', 'discretionary')", [U, iso(M)]);
  const l = await look(db);
  const life = l.facts.tags!.dimensions[0].rows.find((r) => r.value === "life")!;
  assertEquals(life.avg, 900); // after refunds, as living costs count it
  assertEquals(life.mtd, 2200); // the new line was tagged as it came in
  assertEquals(life.lines, 2);
  assert(life.slipping, JSON.stringify(life));
  const item = l.glance.slipping.items.find((i) => i.key === "tag:serves:life")!;
  assertEquals([item.title, item.link, item.action], ["Serves: life", "rule", "Make it a rule"]);
  assert(item.rule!.if.startsWith("I am about to spend on life at Gadgetshop on a "), item.rule!.if);
  assertEquals(item.rule!.then, "I log a Buy check and wait 48 hours first");
  assertEquals(item.rule!.goal, "the goal");
  assertEquals(l.glance.today.slipping_count, l.glance.slipping.items.length);
  assertEquals(l.facts.tags!.without_tag.serves, 1); // Bookworld, this month, no tag

  const t = Object.fromEntries(topics(l).map((x) => [x.key, x]));
  assertEquals(Object.keys(t), ["hold", "tax", "living", "tags", "levers", "slipping", "assignment", "calendar", "recurring"]);
  assertEquals(t.tags.rows[0][0], "Serves: life");
  assert(t.tags.rows[0][1].startsWith("Average €900. ") && t.tags.rows[0][1].endsWith(". Slipping"), t.tags.rows[0][1]);
  assert(t.tags.note.endsWith("without a tag: Serves 1, Project 3, Worth it 3. Tag them on the Review page."), t.tags.note);
  assert(t.slipping.rows.some((r) => r[0] === "Serves: life" && r[1].includes("Proposed rule: if I am about to spend on life")));

  // The rule you take shows its effect once spend drops below the month before.
  await db.query(`insert into nx_decisions (user_id, kind, if_condition, then_action, tag_dimension, tag_value, created_at)
    values ($1, 'rule', 'Before a gadget, a Buy check', 'wait 48 hours', 'serves', 'life', $2)`, [U, iso(today) + "T00:00:00Z"]);
  const after = await look(db);
  assertEquals(after.facts.tags!.effects.length, 1);
  await db.close();
});

Deno.test("someone else's lines and rules never reach your tags", async () => {
  const db = await withTags();
  await db.query(`insert into nx_category_rules (user_id, priority, match, tags, origin) values ($1, 245, '{"name": ".*"}', '{"serves": "life"}', 'review')`, [OTHER]);
  await db.query("select nx_retag()");
  assertEquals((await db.query<{ n: number }>("select count(*)::int n from nx_line_tags")).rows[0].n, 0);
  const other = (await db.query<{ id: string }>("select id from nx_transactions where user_id = $1", [OTHER])).rows[0].id;
  assertEquals((await db.query<{ n: number }>("select nx_tag_line($1) n", [other])).rows[0].n, 0);
  assertEquals((await db.query<{ n: number }>("select nx_set_line_tags(array[$1::uuid], 'serves', 'life') n", [other])).rows[0].n, 0);
  await db.close();
});
