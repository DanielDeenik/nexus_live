/**
 * Nexus Live — Seed Script
 * Run ONCE to populate Notion databases with initial data.
 * Usage: node seed.js
 */
'use strict';
require('dotenv').config();
const { Client } = require('@notionhq/client');
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const DB_EXPENSES  = process.env.DB_EXPENSES  || 'fee01210-8f0c-4d09-ab7d-f7caa68d6138';
const DB_SIGNALS   = process.env.DB_SIGNALS   || '3c965e50-5833-4a95-aa73-72dd25a5ca9d';
const DB_CASHFLOW  = process.env.DB_CASHFLOW  || '3841c101-523f-4696-b622-e58c0f1618b3';
const DB_PROFILE   = process.env.DB_PROFILE   || 'b0e5a566-965b-42dd-a7a4-256957e5b196';

async function seedProfile() {
  console.log('Seeding Profile DB...');
  const entries = [
    { param:'Full Name',         val:'Dan Deenik',  cat:'Identity',      src:'Self Reported' },
    { param:'Hourly Rate EUR',   val:'115',         cat:'Rate',          src:'Self Reported' },
    { param:'Day Rate EUR',      val:'920',         cat:'Rate',          src:'Self Reported' },
    { param:'Invoice Currency',  val:'CAD',         cat:'Identity',      src:'Self Reported' },
    { param:'Monthly Burn EUR',  val:'3200',        cat:'Identity',      src:'Self Reported' },
    { param:'Wise Balance EUR',  val:'18000',       cat:'Identity',      src:'Self Reported' },
    { param:'Contract End Date', val:'2026-06-30',  cat:'Constraint',    src:'Self Reported' },
    { param:'Agency',            val:'JPSB',        cat:'Identity',      src:'Self Reported' },
    { param:'Current Client',    val:'Nicola Wealth',cat:'Identity',     src:'Self Reported' },
    { param:'MKB Pct',          val:'12.7',         cat:'Rate',          src:'Self Reported' },
    { param:'ZVW Pct',          val:'4.85',         cat:'Rate',          src:'Self Reported' },
    { param:'Tax Reserve Pct',  val:'35',           cat:'Rate',          src:'Self Reported' },
    { param:'FX Buffer Pct',    val:'3',            cat:'Rate',          src:'Self Reported' },
    { param:'Payment Lag Days', val:'21',           cat:'Constraint',    src:'Self Reported' },
    { param:'SimCorp Dimension', val:'Expert',      cat:'Skills — Tier 1',src:'CV Extracted' },
    { param:'Front Arena',       val:'Advanced',    cat:'Skills — Tier 1',src:'CV Extracted' },
    { param:'BlackRock Aladdin', val:'Proficient',  cat:'Skills — Tier 1',src:'CV Extracted' },
    { param:'MiFID II / EMIR',   val:'Strong',      cat:'Skills — Tier 1',src:'CV Extracted' },
    { param:'SFDR / ESG Reporting',val:'Strong',    cat:'Skills — Tier 2',src:'CV Extracted' },
    { param:'FIX Protocol',      val:'Advanced',    cat:'Skills — Tier 2',src:'CV Extracted' },
    { param:'Python / SQL',      val:'Intermediate',cat:'Skills — Tier 2',src:'CV Extracted' },
    { param:'Basel IV / DORA',   val:'Awareness',   cat:'Skills — Tier 3',src:'CV Extracted' },
  ];
  let count = 0;
  for (const e of entries) {
    await notion.pages.create({
      parent: { database_id: DB_PROFILE },
      properties: {
        'Parameter': { title:  [{ text: { content: e.param } }] },
        'Value':     { rich_text: [{ text: { content: e.val } }] },
        'Category':  { select: { name: e.cat } },
        'Source':    { select: { name: e.src } },
        'Confidence':{ select: { name: 'Confirmed' } },
      }
    });
    count++;
    process.stdout.write(`  Profile: ${count}/${entries.length}\r`);
  }
  console.log(`\n✓ Profile: ${count} entries`);
}

async function seedSignals() {
  console.log('Seeding Seasonality Signals...');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const hiring  = [88,90,82,70,75,65,22,18,72,85,55,20];
  const kalman  = [87,89,84,73,74,67,35,28,68,82,58,28];
  let count = 0;
  for (let i = 0; i < 12; i++) {
    await notion.pages.create({
      parent: { database_id: DB_SIGNALS },
      properties: {
        'Signal Name':    { title: [{ text: { content: `NL FO Consulting ${months[i]} 2026` } }] },
        'Month':          { select: { name: months[i] } },
        'Year':           { number: 2026 },
        'Region':         { select: { name: 'Netherlands' } },
        'Hiring Index':   { number: hiring[i] },
        'Raw Value':      { number: hiring[i] },
        'Kalman Smoothed':{ number: kalman[i] },
        'Confidence':     { select: { name: hiring[i] > 60 ? 'High' : hiring[i] > 40 ? 'Medium' : 'Low' } },
        'Data Source':    { select: { name: 'LinkedIn' } },
        'Anomaly Flag':   { checkbox: hiring[i] < 25 || hiring[i] > 90 },
      }
    });
    count++;
  }
  console.log(`✓ Signals: ${count} entries`);
}

async function seedCashflow() {
  console.log('Seeding Cashflow Months...');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const seasonScores = [88,90,82,70,75,65,22,18,72,85,55,20];
  const grossRev = 920 * 20; // €920/day × 20 days
  const burn = 3200;
  const taxRate = 0.35;
  let bal = 18000;
  let count = 0;
  for (let i = 0; i < 6; i++) {
    const mo = i; // Jan-Jun 2026
    const moNum = mo + 1;
    const isGap = false; // assume working all 6 months
    const gross = grossRev;
    const tax = gross * taxRate;
    const net = gross - tax - burn;
    bal += net;
    const zone = bal > 25000 ? 'STABLE CRUISE' : bal > 15000 ? 'TRANSITIONAL' : bal > 8000 ? 'CAUTION' : 'HIGH ALERT';
    await notion.pages.create({
      parent: { database_id: DB_CASHFLOW },
      properties: {
        'Month Label':         { title: [{ text: { content: `${months[mo]} 2026` } }] },
        'Date':                { date: { start: `2026-${String(moNum).padStart(2,'0')}-01` } },
        'Year':                { number: 2026 },
        'Month Number':        { number: moNum },
        'Gross Revenue EUR':   { number: gross },
        'Monthly Burn EUR':    { number: burn },
        'Tax Reserve EUR':     { number: Math.round(tax) },
        'Net After Tax EUR':   { number: Math.round(net) },
        'Closing Balance EUR': { number: Math.round(bal) },
        'Wise Balance Snapshot':{ number: Math.round(bal) },
        'Season Score':        { number: seasonScores[mo] },
        'Decision Score':      { number: Math.round(bal > 20000 ? 25 : bal > 10000 ? 50 : 75) },
        'Zone':                { select: { name: zone } },
        'Invoice Currency':    { select: { name: 'CAD' } },
        'Contracts Active':    { number: 1 },
        'Payment Lag Days':    { number: 21 },
      }
    });
    count++;
  }
  console.log(`✓ Cashflow: ${count} months`);
}

async function main() {
  console.log('\n⬡ Nexus Live — Seeding Notion databases\n');
  try {
    await seedProfile();
    await seedSignals();
    await seedCashflow();
    console.log('\n✅ Seed complete. Refresh your dashboard.\n');
  } catch (e) {
    console.error('\n❌ Seed failed:', e.message);
    if (e.body) console.error(JSON.stringify(e.body, null, 2));
  }
}
main();
