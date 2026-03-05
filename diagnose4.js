/**
 * diagnose4.js — Live API data check
 * Tests exactly what config/cashflow/contracts return after processing
 */
'use strict';
require('dotenv').config();
const { getWorkspace } = require('./lib/workspace');
const { prop, queryAll } = require('./lib/notion');

(async () => {
  const ws = getWorkspace('primary');
  console.log('\n  Nexus Live — Live API Data Check\n  ' + '─'.repeat(44));

  // ── Config
  try {
    const pages = await queryAll(ws.client, ws.dbs.profile);
    const cfg = { name:null, hourlyRate:null, dayRate:null, currency:null, burn:null,
                  wiseBalance:null, contractEnd:null, agency:null, client:null,
                  mkbPct:null, zvwPct:null, fxBuffer:null, payLagDays:null,
                  taxReservePct:null, skills:[] };
    for (const page of pages) {
      const parameter = prop(page,'Parameter');
      const value     = prop(page,'Value');
      const category  = prop(page,'Category');
      if (!parameter || value === null || value === '') continue;
      const v = String(value).trim();
      switch(parameter) {
        case 'Full Name':          cfg.name         = v; break;
        case 'Hourly Rate EUR':    cfg.hourlyRate    = parseFloat(v); break;
        case 'Day Rate EUR':       cfg.dayRate       = parseFloat(v); break;
        case 'Invoice Currency':   cfg.currency      = v; break;
        case 'Monthly Burn EUR':   cfg.burn          = parseFloat(v); break;
        case 'Wise Balance EUR':   cfg.wiseBalance   = parseFloat(v); break;
        case 'Contract End Date':  cfg.contractEnd   = v; break;
        case 'Agency':             cfg.agency        = v; break;
        case 'Current Client':     cfg.client        = v; break;
        case 'MKB Pct':            cfg.mkbPct        = parseFloat(v); break;
        case 'ZVW Pct':            cfg.zvwPct        = parseFloat(v); break;
        case 'FX Buffer Pct':      cfg.fxBuffer      = parseFloat(v); break;
        case 'Payment Lag Days':   cfg.payLagDays    = parseInt(v); break;
        case 'Tax Reserve Pct':    cfg.taxReservePct = parseFloat(v); break;
        default:
          if (category === 'Skills — Tier 1') cfg.skills.push({ label: parameter, tier: 1 });
          else if (category === 'Skills — Tier 2') cfg.skills.push({ label: parameter, tier: 2 });
          else if (category === 'Skills — Tier 3') cfg.skills.push({ label: parameter, tier: 3 });
      }
    }
    console.log('\n✓ Config resolved:');
    const { skills, ...rest } = cfg;
    console.log(JSON.stringify(rest, null, 2));
    console.log(`  Skills (${skills.length}): ${skills.map(s=>s.label).join(', ')}`);
    const nullFields = Object.entries(rest).filter(([,v]) => v === null).map(([k]) => k);
    if (nullFields.length) console.log(`  ⚠ Still null: ${nullFields.join(', ')}`);
  } catch(e) { console.error('✗ Config error:', e.message); }

  // ── Cashflow
  try {
    const pages = await queryAll(ws.client, ws.dbs.cashflow, undefined,
      [{ property: 'Date', direction: 'ascending' }]);
    const rows = pages.map(p => ({
      label:          prop(p,'Month Label'),
      date:           prop(p,'Date'),
      grossRevenue:   prop(p,'Gross Revenue EUR'),
      closingBalance: prop(p,'Closing Balance EUR'),
      monthlyBurn:    prop(p,'Monthly Burn EUR'),
      zone:           prop(p,'Zone'),
      seasonScore:    prop(p,'Season Score'),
    }));
    console.log(`\n✓ Cashflow: ${rows.length} rows`);
    rows.forEach(r => console.log(`    ${r.date}  ${r.label}  Rev=${r.grossRevenue}  Bal=${r.closingBalance}  Zone=${r.zone}`));
  } catch(e) { console.error('✗ Cashflow error:', e.message); }

  // ── Contracts
  try {
    const pages = await queryAll(ws.client, ws.dbs.contracts);
    const rows = pages.map(p => ({
      name:     prop(p,'Document Name'),
      status:   prop(p,'Status'),
      client:   prop(p,'Client'),
      rate:     prop(p,'Hourly Rate EUR'),
      endDate:  prop(p,'End Date'),
      insType:  p.properties['Insurance Required CAD']?.type,
    }));
    console.log(`\n✓ Contracts: ${rows.length} rows`);
    rows.forEach(r => console.log(`    [${r.status}] ${r.name}  €${r.rate}/hr  ends ${r.endDate}  insField=${r.insType}`));
    const nonActive = rows.filter(r => r.status !== 'Active');
    if (nonActive.length) console.log(`  ⚠  ${nonActive.length} contract(s) not Active — won't show in Command Center active panel`);
  } catch(e) { console.error('✗ Contracts error:', e.message); }

  // ── Expenses
  try {
    const pages = await queryAll(ws.client, ws.dbs.expenses);
    console.log(`\n✓ Expenses: ${pages.length} rows`);
    pages.slice(0,3).forEach(p => console.log(`    ${prop(p,'Date')}  ${prop(p,'Description')}  €${prop(p,'Amount EUR')}`));
  } catch(e) { console.error('✗ Expenses error:', e.message); }

  // ── Signals
  try {
    const pages = await queryAll(ws.client, ws.dbs.signals);
    console.log(`\n✓ Signals: ${pages.length} rows`);
    pages.slice(0,3).forEach(p => console.log(`    ${prop(p,'Month')} ${prop(p,'Year')}  HiringIndex=${prop(p,'Hiring Index')}  ContractorRatio=${prop(p,'Contractor Ratio')}`));
  } catch(e) { console.error('✗ Signals error:', e.message); }

  console.log('\n  Done.\n');
})();
