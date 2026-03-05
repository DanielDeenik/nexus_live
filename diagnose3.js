/**
 * Nexus Live — Parameter Dump
 * Dumps every row from Profile + first row of all other DBs
 * to show exact values the code will receive.
 * Run: node diagnose3.js
 */
'use strict';
require('dotenv').config();
const { Client } = require('@notionhq/client');
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const CYAN = '\x1b[36m', DIM = '\x1b[2m', YELLOW = '\x1b[33m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

function val(p) {
  if (!p) return null;
  switch (p.type) {
    case 'title':        return p.title.map(t => t.plain_text).join('') || null;
    case 'rich_text':    return p.rich_text.map(t => t.plain_text).join('') || null;
    case 'number':       return p.number;
    case 'select':       return p.select?.name;
    case 'multi_select': return p.multi_select.map(s => s.name);
    case 'date':         return p.date?.start;
    case 'checkbox':     return p.checkbox;
    case 'url':          return p.url;
    default:             return `[${p.type}]`;
  }
}

async function dumpAll(label, dbId, keyProp, valProp) {
  console.log(`\n${CYAN}── ${label}${RESET}`);
  if (!dbId) { console.log('  (not configured)'); return; }
  try {
    const rows = await notion.databases.query({ database_id: dbId, page_size: 100 });
    console.log(`  ${rows.results.length} rows:`);
    for (const page of rows.results) {
      const k = val(page.properties[keyProp]);
      const v = valProp ? val(page.properties[valProp]) : null;
      const cat = val(page.properties['Category']);
      const extra = [v, cat].filter(Boolean).join(' | ');
      console.log(`  ${DIM}  "${k}"${extra ? '  →  ' + extra : ''}${RESET}`);
    }
  } catch(e) { console.log(`  ${YELLOW}✗ ${e.message.slice(0,80)}${RESET}`); }
}

async function dumpFirstRow(label, dbId, titleProp) {
  console.log(`\n${CYAN}── ${label} (first row)${RESET}`);
  if (!dbId) { console.log('  (not configured)'); return; }
  try {
    const rows = await notion.databases.query({ database_id: dbId, page_size: 1 });
    if (!rows.results.length) { console.log('  (empty)'); return; }
    const page = rows.results[0];
    for (const [name, prop] of Object.entries(page.properties)) {
      const v = val(prop);
      if (v !== null && v !== '' && (!Array.isArray(v) || v.length))
        console.log(`  ${DIM}  "${name}"  →  ${JSON.stringify(v)}${RESET}`);
    }
  } catch(e) { console.log(`  ${YELLOW}✗ ${e.message.slice(0,80)}${RESET}`); }
}

(async () => {
  console.log('\n  Nexus Live — Full Parameter Dump\n  ' + '─'.repeat(44));

  // Profile: dump ALL rows (key-value store)
  await dumpAll('Profile — ALL rows', process.env.DB_PROFILE, 'Parameter', 'Value');

  // All others: just first row to show actual property names/values
  await dumpFirstRow('Cashflow — first row', process.env.DB_CASHFLOW, 'Month Label');
  await dumpFirstRow('Expenses — first row', process.env.DB_EXPENSES, 'Description');
  await dumpFirstRow('Contracts — first row', process.env.DB_CONTRACTS, 'Document Name');
  await dumpFirstRow('Signals — first row', process.env.DB_SIGNALS, 'Signal Name');
  await dumpFirstRow('Companies — first row', process.env.DB_COMPANIES, 'Name');
  await dumpFirstRow('Opportunities — first row', process.env.DB_OPPORTUNITIES, 'Role Title');
  await dumpFirstRow('History — first row', process.env.DB_HISTORY, 'Project Name');

  console.log('\n  Done.\n');
})();
