/**
 * Nexus Live — Diagnostic Script
 * Run: node diagnose.js
 * Checks each database: connection, property names, row count
 */
'use strict';
require('dotenv').config();
const { Client } = require('@notionhq/client');
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const DBS = {
  profile:       { id: process.env.DB_PROFILE,        expected: ['Parameter','Value','Category'] },
  expenses:      { id: process.env.DB_EXPENSES,        expected: ['Description','Date','Amount EUR','Category'] },
  contracts:     { id: process.env.DB_CONTRACTS,       expected: ['Document Name','Client','Hourly Rate EUR','Status','Effective Date'] },
  signals:       { id: process.env.DB_SIGNALS,         expected: ['Signal Name','Month','Year','Hiring Index'] },
  cashflow:      { id: process.env.DB_CASHFLOW,        expected: ['Month Label','Date','Gross Revenue EUR','Closing Balance EUR'] },
  companies:     { id: process.env.DB_COMPANIES,       expected: ['Name','Industry','Status'] },
  opportunities: { id: process.env.DB_OPPORTUNITIES,   expected: ['Role Title','Day Rate EUR','Status','Match Score'] },
  history:       { id: process.env.DB_HISTORY,         expected: ['Project Name','Client','Rate EUR per Hour','Start Month'] },
};

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', RESET = '\x1b[0m', DIM = '\x1b[2m';
const ok  = s => `${GREEN}✓${RESET}  ${s}`;
const err = s => `${RED}✗${RESET}  ${s}`;
const warn = s => `${YELLOW}⚠${RESET}  ${s}`;

async function checkDb(name, { id, expected }) {
  if (!id) { console.log(err(`${name.padEnd(14)} DB_${name.toUpperCase()} not set in .env`)); return; }

  let db, rows;
  try {
    db   = await notion.databases.retrieve({ database_id: id });
    rows = await notion.databases.query({ database_id: id, page_size: 3 });
  } catch (e) {
    console.log(err(`${name.padEnd(14)} ${e.message.slice(0, 80)}`));
    return;
  }

  const actualProps = Object.keys(db.properties);
  const missing = expected.filter(p => !actualProps.includes(p));
  const rowCount = rows.results.length;

  if (missing.length) {
    console.log(warn(`${name.padEnd(14)} Connected, ${rowCount} rows — MISSING properties: ${RED}${missing.join(', ')}${RESET}`));
    console.log(`${DIM}               Actual columns: ${actualProps.slice(0,8).join(', ')}${actualProps.length > 8 ? '…' : ''}${RESET}`);
  } else if (rowCount === 0) {
    console.log(warn(`${name.padEnd(14)} Connected, but ${YELLOW}EMPTY${RESET} — run: node seed.js`));
  } else {
    console.log(ok(`${name.padEnd(14)} Connected — ${rowCount}+ rows, all expected properties found`));
  }
}

(async () => {
  console.log('\n  Nexus Live — Database Diagnostic\n  ' + '─'.repeat(44));
  for (const [name, cfg] of Object.entries(DBS)) {
    await checkDb(name, cfg);
  }
  console.log('\n  Done. Fix any ✗ / ⚠ above then restart: node server.js\n');
})();
