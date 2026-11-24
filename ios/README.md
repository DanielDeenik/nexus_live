# Nexuslive for iPhone

Money, spending control and if/then/else decisions on the phone, on the Supabase project "Nexus Decision".

| Tab | What it does | Where the data goes |
| --- | --- | --- |
| Log | Record a business expense: amount, category, optional note | `expenses` via `nx_add_expense`, status proposed |
| Decide | If/then/else rules; probability bets resolved as happened or did not, Brier scored; Buy checks that put a wait and, for major purchases and subscriptions, a usage bet in front of a purchase | `nx_decisions` |
| Money | Safe to spend after the tax reserve and fixed costs, this month against budget next to your own average, unplanned purchases, net worth snapshots, eToro positions, bank export import | `nx_money_summary`, `nx_transactions` via `nx_import_transactions`, `nx_budgets`, `nx_net_worth_snapshots`, `nx_positions` |

Direct client writes to `expenses` stay blocked by the restrictive policies; `nx_add_expense` pins the row to the signed in user and lands it as proposed for the review pipeline. `nx_import_transactions` pins bank lines to the signed in user the same way. Bank layouts (the Nexus ledger CSV, ING, Rabobank, bunq, ABN AMRO) are data in `App/Resources/bank-formats.json`, so a new bank needs no code.

## Budgeting

- Import: export an account from the bank, then Money, Import. The app reads the layout, keeps every line (money in and out) and sends the raw lines in batches of `budget.import_batch_rows` that never split a day.
- The server does the rest in `nx_ingest_transactions`: `nx_parse_bank_line` reads the bank's description layout, transfers between your own accounts are marked from `budget.own_name_pattern` and `budget.own_bank_iban_pattern`, payment rails (`budget.rails`) resolve to the shop when the description names it, and the first active rule in `nx_category_rules` by priority sets the category and class. A line no rule matches lands as Uncategorised for review.
- Each line gets a stable id from source, account, date, amount, payee and description, numbered among identical lines on the same day, so importing an overlapping export again adds nothing twice.
- `nx_reclassify()` re-applies the rules to every line not confirmed by hand, after a rule changes.
- Safe to spend is cash in the accounts listed in `nx_accounts` (opening balance plus every line since the opening date), minus the tax reserve from the latest approved income tax filing for the year, minus fixed budgets not yet spent this month.

Every threshold lives in `app_config`, never in code:

| Setting | Meaning |
| --- | --- |
| `purchase.small_below` | Below this a purchase is small: buy it if the category has budget left |
| `purchase.considered_wait_hours` | Wait for a considered purchase |
| `purchase.major_from` | From this amount a purchase is major |
| `purchase.major_wait_days` | Wait for a major purchase |
| `purchase.use_bet_days` | When the "I use it at least weekly" bet is checked |
| `purchase.match_tolerance_pct` | How close a bank line must be to a bought Buy check to count as planned |
| `purchase.goal_name` | The goal that money kept by a dropped purchase moves to, named in the Buy view |
| `budget.average_months` | Months in the average shown next to each budget |
| `budget.spend_classes` | Rule classes that count as spending |
| `budget.hidden_classes` | Classes where the bank line hides the shop |
| `budget.planned_classes` | Classes where a purchase from the small threshold needs a Buy check |
| `budget.import_batch_rows` | Bank lines per import call |

## Build

Same pipeline as Ladon: GitHub Actions, XcodeGen, App Store Connect API key, TestFlight. Nothing is built on a Mac.

- Start: Actions, Nexuslive iOS, Run workflow, or a commit to `ios/` whose message contains `[ios]`.
- Secret: `ASC_KEY_P8_BASE64` in this repo, the NexusLive Admin key file.
- Once: an App Store Connect app record for `nl.danieldeenik.nexuslive` (Apple does not allow creating it by API). The first job checks both on Linux before any Mac minutes are used.
