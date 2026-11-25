# Nexuslive for iPhone

Money, spending control and if/then/else decisions on the phone, on the Supabase project "Nexus Decision".

| Tab | What it does | Where the data goes |
| --- | --- | --- |
| Home | The Mallorca target (`target.*`) with business income and what your capital pays, three sliders (business growth, monthly invest, return), safe to spend, Skip and save, and at most three rows that need you (alerts, Sunday review, monthly close or the seven numbers). + opens a Buy check, a business cost or a receipt | `nx_money_summary`, the live forecast, `nx_user_settings` |
| Spend | This month against the plan, spend against cap over `plan.chart_months` months, the five fullest budget lines, the purchase review with the cancel assist. + imports a bank file or a receipt | `nx_spend_lines` (a split line counts per part), `nx_budgets`, `nx_recurring`, `nx_cancel_routes` |
| Decide | If/then/else rules, Brier-scored bets, Buy checks with purpose, urge, billed hours after tax, the ten-year value and the re-ask when the wait ends | `nx_decisions` |
| Plan | Net worth forecast (on plan, as now, return band) with sliders; one tap down the Mallorca path, recurring charges and the tax year | live forecast, `nx_net_worth_snapshots` |
| Settings | Every connection and key (banks through Enable Banking, Wise, eToro, Moneybird, Gmail), the target and assumptions, food staples, the stop list, cancel routes, Shortcuts and reminders | `nexus/accounts`, `spend`, `nx_user_settings` |

The Buy check also opens from outside the app: a Shortcuts automation when a named shopping app opens (Open Buy check), the home-screen widget (`Widget/`, a deep link `nexuslive://buy?entry=widget`), Siri and the share sheet. Log card tap is the action for the Shortcuts Wallet automation; a notification then asks planned or impulse, or at a supermarket staples only or luxury too. Add receipt reads a receipt image shared from another app. Stop-list alerts arrive through a background refresh, at most `notifications.max_per_day` a day.

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

## Checks without Xcode

`scripts/check-core.sh` compiles the UI-free core (`PlanMath`, `Deeplink`, `Models`, `SpendModels`) with plain `swiftc` on Linux or macOS and runs `Checks/`: the target and forecast arithmetic, the app links and the stop lists read from settings, on made-up figures.

## Build

Same pipeline as Ladon: GitHub Actions, XcodeGen, App Store Connect API key, TestFlight. Nothing is built on a Mac.

- Start: Actions, Nexuslive iOS, Run workflow, or a commit to `ios/` whose message contains `[ios]`.
- Secret: `ASC_KEY_P8_BASE64` in this repo, the NexusLive Admin key file.
- Once: an App Store Connect app record for `nl.danieldeenik.nexuslive` (Apple does not allow creating it by API). The first job checks both on Linux before any Mac minutes are used.
