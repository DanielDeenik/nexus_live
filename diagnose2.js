/**
 * Nexus Live — Deep Diagnostic v2
 * Fetches actual rows and shows REAL property names + values from Notion
 * Run: node diagnose2.js
 */
'use strict';
require('dotenv').config();
const { Client } = require('@notionhq/client');
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m', RESET = '\x1b[0m', DIM = '\x1b[2m';

function extractVal(p) {
  if (!p) return null;
  switch (p.type) {
    case 'title':        return p.title.map(t => t.plain_text).join('') || null;
    case 'rich_text':    return p.rich_text.map(t => t.plain_text).join('') || null;
    case 'number':       return p.number;
    case 'select':       return p.select?.name;
    case 'multi_select': return p.multi_select.map(s => s.name).join(', ');
    case 'date':         return p.date?.start;
    case 'checkbox':     return p.checkbox;
    case 'url':          return p.url;
    default:             return `[${p.type}]`;
  }
}

async function inspect(label, dbId, codeExpects) {
  console.log(`\n${CYAN}── ${label} ${'─'.repeat(44 - label.length)}${RESET}`);
  if (!dbId) { console.log(`  ${RED}✗ Not configured in .env${RESET}`); return; }

  let db, rows;
  try {
    db   = await notion.databases.retrieve({ database_id: dbId });
    rows = await notion.databases.query({ database_id: dbId, page_size: 2 });
  } catch (e) {
    console.log(`  ${RED}✗ ${e.message.slice(0, 100)}${RESET}`);
    return;
  }

  const actualProps = Object.keys(db.properties);
  console.log(`  ${GREEN}✓ Connected — ${rows.results.length > 0 ? rows.results.length + '+ rows' : 'EMPTY'}${RESET}`);
  console.log(`  ${DIM}Actual columns (${actualProps.length}): ${actualProps.join(', ')}${RESET}`);

  // Check each expected property
  const missing = codeExpects.filter(p => !actualProps.includes(p));
  const present = codeExpects.filter(p => actualProps.includes(p));

  if (missing.length) {
    console.log(`  ${RED}✗ MISSING: ${missing.join(', ')}${RESET}`);
    // Suggest fuzzy matches
    missing.forEach(m => {
      const lower = m.toLowerCase();
      const fuzzy = actualProps.filter(a => a.toLowerCase().includes(lower.split(' ')[0].toLowerCase()));
      if (fuzzy.length) console.log(`    ${YELLOW}→ "${m}" — did you mean: ${fuzzy.join(', ')}?${RESET}`);
    });
  } else {
    console.log(`  ${GREEN}✓ All expected properties present${RESET}`);
  }

  // Show sample values from first row
  if (rows.results.length > 0) {
    const page = rows.results[0];
    console.log(`  ${DIM}Sample row values:${RESET}`);
    present.slice(0, 6).forEach(p => {
      const val = extractVal(page.properties[p]);
      console.log(`    ${DIM}${p.padEnd(28)} → ${val ?? '(null)'}${RESET}`);
    });
  }
}

(async () => {
  console.log('\n  Nexus Live — Deep Diagnostic\n  ' + '─'.repeat(44));

  await inspect('Profile', process.env.DB_PROFILE, [
    'Parameter', 'Value', 'Category', 'Source', 'Confidence'
  ]);
  await inspect('Expenses', process.env.DB_EXPENSES, [
    'Description', 'Date', 'Amount EUR', 'Category', 'Currency', 'Year', 'Notes'
  ]);
  await inspect('Contracts', process.env.DB_CONTRACTS, [
    'Document Name', 'Client', 'Counterparty', 'Hourly Rate EUR', 'Day Rate CAD',
    'Effective Date', 'End Date', 'Status', 'Payment Terms Days', 'Governing Law',
    'Notice Period', 'Key Obligations', 'Key Risks', 'Contact JPSB', 'Insurance Required CAD'
  ]);
  await inspect('Signals', process.env.DB_SIGNALS, [
    'Signal Name', 'Month', 'Year', 'Region', 'Hiring Index', 'Raw Value',
    'Kalman Smoothed', 'Anomaly Flag', 'Data Source', 'Confidence'
  ]);
  await inspect('Cashflow', process.env.DB_CASHFLOW, [
    'Month Label', 'Date', 'Year', 'Month Number', 'Gross Revenue EUR',
    'Monthly Burn EUR', 'Tax Reserve EUR', 'Net After Tax EUR',
    'Closing Balance EUR', 'Wise Balance Snapshot', 'Zone', 'Invoice Currency',
    'Contracts Active', 'Payment Lag Days', 'Season Score', 'Decision Score'
  ]);
  await inspect('Companies', process.env.DB_COMPANIES, [
    'Name', 'Industry', 'Status', 'Tags', 'Budget Score', 'Contract Length',
    'Approach Month', 'LinkedIn URL'
  ]);
  await inspect('Opportunities', process.env.DB_OPPORTUNITIES, [
    'Role Title', 'Company', 'Day Rate EUR', 'Status', 'Action',
    'Match Score', 'Contract Length', 'Remote', 'Posted Date', 'Skills Required', 'Source URL'
  ]);
  await inspect('History', process.env.DB_HISTORY, [
    'Project Name', 'Client', 'Client Sector', 'Role Title', 'Start Month', 'End Month',
    'Duration Months', 'Rate EUR per Hour', 'Rate EUR per Day', 'Contract Type',
    'Platform', 'How Won', 'Why Ended', 'Regulatory Driver'
  ]);

  console.log('\n  Done.\n');
})();
