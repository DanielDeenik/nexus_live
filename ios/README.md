# Nexuslive for iPhone

Money, expenses and if/then/else decisions on the phone, on the Supabase project "Nexus Decision".

| Tab | What it does | Where the data goes |
| --- | --- | --- |
| Log | Record an expense: amount, category, optional note | `expenses` via `nx_add_expense`, status proposed |
| Decide | If/then/else rules; probability bets resolved as happened or did not, Brier scored | `nx_decisions` |
| Money | This month against budget, net worth snapshots, eToro positions, bank export import | `nx_budgets`, `nx_net_worth_snapshots`, `nx_positions`, `expenses` via `nx_import_expenses` |

Direct client writes to `expenses` stay blocked by the restrictive policies; the two functions pin the row to the signed in user and land it as proposed for the review pipeline. Bank layouts (ING, Rabobank, bunq, ABN AMRO) are data in `App/Resources/bank-formats.json`, so a new bank needs no code.

## Build

Same pipeline as Ladon: GitHub Actions, XcodeGen, App Store Connect API key, TestFlight. Nothing is built on a Mac.

- Start: Actions, Nexuslive iOS, Run workflow, or a commit to `ios/` whose message contains `[ios]`.
- Secret: `ASC_KEY_P8_BASE64` in this repo, same value as in Ladon.
- Once: an App Store Connect app record for `nl.danieldeenik.nexuslive` (Apple does not allow creating it by API). The first job checks both on Linux before any Mac minutes are used.
