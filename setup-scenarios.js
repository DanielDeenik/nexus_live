#!/usr/bin/env node
'use strict';
/**
 * setup-scenarios.js — One-time setup for the Scenario Planner
 *
 * What this does:
 *   1. Creates "Scenarios" database in Notion (under a parent page you specify)
 *   2. Creates "Scenario Projections" database in Notion
 *   3. Appends the two new DB IDs to .env
 *   4. Seeds 5 real-world scenarios based on Dan's contracts
 *
 * Usage:
 *   NOTION_PARENT_PAGE_ID=<page-id> node setup-scenarios.js
 *
 *   Or set NOTION_PARENT_PAGE_ID in .env first, then run:
 *   node setup-scenarios.js
 *
 * The parent page can be any Notion page your integration has access to.
 * Get it from the page URL: notion.so/workspace/<PageTitle>-<PAGE_ID>
 *
 * Run only once. Re-running is safe — it will skip if DB_SCENARIOS already set.
 */

require('dotenv').config();
const { Client }  = require('@notionhq/client');
const fs          = require('fs');
const path        = require('path');

const TOKEN       = process.env.NOTION_TOKEN;
const PARENT_ID   = process.env.NOTION_PARENT_PAGE_ID;
const ENV_PATH    = path.join(__dirname, '.env');

if (!TOKEN) {
  console.error('✗ NOTION_TOKEN not set');
  process.exit(1);
}
if (!PARENT_ID) {
  console.error('✗ NOTION_PARENT_PAGE_ID not set.');
  console.error('  Usage: NOTION_PARENT_PAGE_ID=<page-id> node setup-scenarios.js');
  console.error('  Get the page ID from the last part of the page URL in Notion.');
  process.exit(1);
}
if (process.env.DB_SCENARIOS) {
  console.log('⚠  DB_SCENARIOS already set in .env — skipping DB creation.');
  console.log('   DB_SCENARIOS =', process.env.DB_SCENARIOS);
  console.log('   DB_SCENARIO_PROJECTIONS =', process.env.DB_SCENARIO_PROJECTIONS);
  console.log('   To re-run, remove these lines from .env first.');
  process.exit(0);
}

const notion = new Client({ auth: TOKEN });

// ── Scenario schema ───────────────────────────────────────────────────────────

const SCENARIOS_SCHEMA = {
  'Scenario Name':       { title: {} },
  'Scenario Type':       { select: { options: [
    { name: 'Baseline',     color: 'blue'   },
    { name: 'Extension',    color: 'green'  },
    { name: 'New Contract', color: 'purple' },
    { name: 'Gap Period',   color: 'red'    },
    { name: 'Custom',       color: 'gray'   },
  ]}},
  'Status':              { select: { options: [
    { name: 'Active',   color: 'green'  },
    { name: 'Draft',    color: 'yellow' },
    { name: 'Archived', color: 'gray'   },
  ]}},
  'Day Rate EUR':        { number: { format: 'euro' } },
  'Hourly Rate EUR':     { number: { format: 'euro' } },
  'Start Date':          { date: {} },
  'End Date':            { date: {} },
  'Likely Months':       { number: { format: 'number' } },
  'Agency Margin Pct':   { number: { format: 'percent' } },
  'Payment Terms Days':  { number: { format: 'number' } },
  'Work Days Per Month': { number: { format: 'number' } },
  'Hours Per Day':       { number: { format: 'number' } },
  'Monthly Burn EUR':    { number: { format: 'euro' } },
  'Current Balance EUR': { number: { format: 'euro' } },
  'Renewal Probability': { number: { format: 'percent' } },
  'Currency':            { select: { options: [
    { name: 'EUR', color: 'blue'  },
    { name: 'CHF', color: 'red'   },
    { name: 'CAD', color: 'brown' },
    { name: 'USD', color: 'green' },
  ]}},
  'Computed At':         { date: {} },
  'Notes':               { rich_text: {} },
};

const PROJECTIONS_SCHEMA = {
  'Row Title':          { title: {} },
  'Scenario ID':        { rich_text: {} },
  'Scenario Name':      { rich_text: {} },
  'Month Label':        { rich_text: {} },
  'Date':               { date: {} },
  'Phase':              { select: { options: [
    { name: 'gap',    color: 'yellow' },
    { name: 'active', color: 'green'  },
    { name: 'post',   color: 'gray'   },
  ]}},
  'Gross Revenue EUR':  { number: { format: 'euro' } },
  'Agency Margin EUR':  { number: { format: 'euro' } },
  'Net Revenue EUR':    { number: { format: 'euro' } },
  'Monthly Burn EUR':   { number: { format: 'euro' } },
  'Tax Reserve EUR':    { number: { format: 'euro' } },
  'Net After Tax EUR':  { number: { format: 'euro' } },
  'Cumulative Net EUR': { number: { format: 'euro' } },
};

// ── Dan's 5 real-world scenarios ──────────────────────────────────────────────
// Sources: SOW JPSBCL-DANDEE-2026-001 (Jan 12 – Jun 30 2026), Swisslinx/ZKB RoR

const SEED_SCENARIOS = [
  {
    name:             'JPSB CL — Current SOW',
    type:             'Baseline',
    status:           'Active',
    dayRateEur:       900,       // ~€112.50/hr × 8h — adjust to actual from CSA
    hourlyRateEur:    0,
    startDate:        '2026-01-12',
    endDate:          '2026-06-30',
    likelyMonths:     6,
    agencyMarginPct:  12,        // JPSB intermediary margin — adjust from CSA
    paymentTermsDays: 30,
    workDaysPerMonth: 20,
    hoursPerDay:      8,
    monthlyBurnEur:   4500,      // Dan's personal burn — adjust to actual
    currentBalanceEur:25000,     // Starting balance — adjust to actual Wise balance
    renewalProbability: 0.65,
    currency:         'EUR',
    notes:            'SOW DANDEE-2026-001. Effective Jan 12 to Jun 30 2026. Via JPSB Consulting Ltd. Adjust day rate and agency margin from the CSA.',
  },
  {
    name:             'JPSB CL — Renewal H2 2026 (same rate)',
    type:             'Extension',
    status:           'Draft',
    dayRateEur:       900,
    hourlyRateEur:    0,
    startDate:        '2026-07-01',
    endDate:          '2026-12-31',
    likelyMonths:     6,
    agencyMarginPct:  12,
    paymentTermsDays: 30,
    workDaysPerMonth: 20,
    hoursPerDay:      8,
    monthlyBurnEur:   4500,
    currentBalanceEur:0,         // Starts from whatever Jul balance will be
    renewalProbability: 0.55,
    currency:         'EUR',
    notes:            'Renewal at same rate from Jul 1 2026. Probability reflects client budget cycle uncertainty.',
  },
  {
    name:             'JPSB CL — Renewal H2 2026 (+10% rate uplift)',
    type:             'Extension',
    status:           'Draft',
    dayRateEur:       990,       // +10% uplift on renewal
    hourlyRateEur:    0,
    startDate:        '2026-07-01',
    endDate:          '2026-12-31',
    likelyMonths:     6,
    agencyMarginPct:  12,
    paymentTermsDays: 30,
    workDaysPerMonth: 20,
    hoursPerDay:      8,
    monthlyBurnEur:   4500,
    currentBalanceEur:0,
    renewalProbability: 0.35,
    currency:         'EUR',
    notes:            'Rate renegotiation scenario. +10% uplift on renewal. Lower probability than flat renewal.',
  },
  {
    name:             'Swisslinx / ZKB — New Engagement',
    type:             'New Contract',
    status:           'Draft',
    dayRateEur:       1050,      // ZKB via Swisslinx — Swiss bank, higher rate; in CHF converted to EUR
    hourlyRateEur:    0,
    startDate:        '2026-08-01',  // Estimated start after right-of-representation converts
    endDate:          null,
    likelyMonths:     6,
    agencyMarginPct:  18,        // Swisslinx margin — typical 15-20% for Swiss placements
    paymentTermsDays: 45,        // Swiss bank payment terms tend to be longer
    workDaysPerMonth: 20,
    hoursPerDay:      8,
    monthlyBurnEur:   4500,
    currentBalanceEur:0,
    renewalProbability: 0.50,
    currency:         'EUR',
    notes:            'Swisslinx right-of-representation ref zkb15412. ZKB (Zürcher Kantonalbank) engagement. Rate shown in EUR equivalent — actual billing in CHF. Adjust agency margin from RoR document.',
  },
  {
    name:             'Gap Period — No Renewal Jul 2026',
    type:             'Gap Period',
    status:           'Draft',
    dayRateEur:       0,
    hourlyRateEur:    0,
    startDate:        '2026-07-01',
    endDate:          '2026-09-30',  // 3-month gap
    likelyMonths:     3,
    agencyMarginPct:  0,
    paymentTermsDays: 0,
    workDaysPerMonth: 0,
    hoursPerDay:      8,
    monthlyBurnEur:   4500,
    currentBalanceEur:0,
    renewalProbability: 0,
    currency:         'EUR',
    notes:            'Worst-case: JPSB contract ends Jun 30 with no renewal and no Swisslinx conversion. 3-month gap model showing pure burn.',
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🚀  Nexus Live — Scenario Planner Setup\n');

  // 1. Create Scenarios DB
  console.log('  Creating Scenarios database...');
  const scenariosDb = await notion.databases.create({
    parent:     { type: 'page_id', page_id: PARENT_ID },
    title:      [{ type: 'text', text: { content: 'Nexus — Scenarios' } }],
    properties: SCENARIOS_SCHEMA,
  });
  const scenariosDbId = scenariosDb.id;
  console.log(`  ✓ Scenarios DB:             ${scenariosDbId}`);

  // 2. Create Scenario Projections DB
  console.log('  Creating Scenario Projections database...');
  const projectionsDb = await notion.databases.create({
    parent:     { type: 'page_id', page_id: PARENT_ID },
    title:      [{ type: 'text', text: { content: 'Nexus — Scenario Projections' } }],
    properties: PROJECTIONS_SCHEMA,
  });
  const projectionsDbId = projectionsDb.id;
  console.log(`  ✓ Scenario Projections DB:  ${projectionsDbId}`);

  // 3. Append DB IDs to .env
  const envAddition = [
    '',
    '# ─── Scenario Planner (added by setup-scenarios.js) ─────────────────────────',
    `DB_SCENARIOS=${scenariosDbId}`,
    `DB_SCENARIO_PROJECTIONS=${projectionsDbId}`,
    '',
  ].join('\n');
  fs.appendFileSync(ENV_PATH, envAddition);
  console.log('\n  ✓ .env updated with DB_SCENARIOS and DB_SCENARIO_PROJECTIONS');

  // 4. Seed scenarios
  console.log('\n  Seeding scenarios...');
  const seededIds = [];
  for (const s of SEED_SCENARIOS) {
    const page = await notion.pages.create({
      parent: { database_id: scenariosDbId },
      properties: {
        'Scenario Name':       { title:     [{ text: { content: s.name } }] },
        'Scenario Type':       { select:    { name: s.type } },
        'Status':              { select:    { name: s.status } },
        'Day Rate EUR':        { number:    s.dayRateEur },
        'Hourly Rate EUR':     { number:    s.hourlyRateEur },
        'Likely Months':       { number:    s.likelyMonths },
        'Agency Margin Pct':   { number:    s.agencyMarginPct },
        'Payment Terms Days':  { number:    s.paymentTermsDays },
        'Work Days Per Month': { number:    s.workDaysPerMonth },
        'Hours Per Day':       { number:    s.hoursPerDay },
        'Monthly Burn EUR':    { number:    s.monthlyBurnEur },
        'Current Balance EUR': { number:    s.currentBalanceEur },
        'Renewal Probability': { number:    s.renewalProbability },
        'Currency':            { select:    { name: s.currency } },
        'Notes':               { rich_text: [{ text: { content: s.notes } }] },
        ...(s.startDate ? { 'Start Date': { date: { start: s.startDate } } } : {}),
        ...(s.endDate   ? { 'End Date':   { date: { start: s.endDate   } } } : {}),
      },
    });
    console.log(`  ✓ Seeded: ${s.name}`);
    seededIds.push({ name: s.name, id: page.id });
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('  ✅  Setup complete!\n');
  console.log('  Next steps:');
  console.log('  1. Restart the server:  npm start');
  console.log('  2. Open the dashboard and go to Scenario Planner');
  console.log('  3. Adjust the day rates and burn rate in Notion to match your actual CSA');
  console.log('  4. Click "Compute" to generate 18-month time series for each scenario\n');
  console.log('  Seeded scenario IDs (keep for reference):');
  seededIds.forEach(s => console.log(`    ${s.name}: ${s.id}`));
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(e => {
  console.error('\n✗ Setup failed:', e.message);
  if (e.code === 'unauthorized') {
    console.error('  Check that your integration has access to the parent page.');
    console.error('  Go to Notion → Share → Add connections → select your integration.');
  }
  process.exit(1);
});
