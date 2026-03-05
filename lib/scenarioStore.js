'use strict';
/**
 * lib/scenarioStore.js — Notion-backed scenario persistence
 *
 * Two Notion databases:
 *   Scenarios          — one row per named scenario (the parameters)
 *   Scenario Projections — one row per month per scenario (the time series)
 *
 * All DB IDs come from process.env / workspace.dbs at call time.
 * This module is stateless — pass the Notion client and DB IDs each call.
 */

const { prop, queryAll }           = require('./notion');
const { project }                   = require('./simulator');
const { learnFromHistory, projectMC } = require('./mlEngine');

// ── Schema helpers ────────────────────────────────────────────────────────────

/**
 * Map a Notion Scenarios page → plain JS object.
 */
function mapScenario(page) {
  return {
    // ── Core ──────────────────────────────────────────────────────────────
    id:                 page.id,
    name:               prop(page, 'Scenario Name')          || 'Unnamed',
    type:               prop(page, 'Scenario Type')          || 'Custom',
    status:             prop(page, 'Status')                 || 'Draft',
    // ── Income ────────────────────────────────────────────────────────────
    dayRateEur:         prop(page, 'Day Rate EUR')           ?? 0,
    hourlyRateEur:      prop(page, 'Hourly Rate EUR')        ?? 0,
    agencyMarginPct:    prop(page, 'Agency Margin Pct')      ?? 0,
    workDaysPerMonth:   prop(page, 'Work Days Per Month')    ?? 20,
    hoursPerDay:        prop(page, 'Hours Per Day')          ?? 8,
    paymentTermsDays:   prop(page, 'Payment Terms Days')     ?? 30,
    currency:           prop(page, 'Currency')               || 'EUR',
    // ── Timeline ──────────────────────────────────────────────────────────
    startDate:          prop(page, 'Start Date')             || null,
    endDate:            prop(page, 'End Date')               || null,
    likelyMonths:       prop(page, 'Likely Months')          ?? 6,
    renewalProbability: prop(page, 'Renewal Probability')    ?? 0.5,
    // ── Costs ─────────────────────────────────────────────────────────────
    fixedCostsEur:      prop(page, 'Fixed Costs EUR')        ?? 4000,
    variableCostsEur:   prop(page, 'Variable Costs EUR')     ?? 3000,
    monthlyBurnEur:     prop(page, 'Monthly Burn EUR')       ?? 0,   // legacy fallback
    currentBalanceEur:  prop(page, 'Current Balance EUR')    ?? 0,
    // ── ML / Monte Carlo ──────────────────────────────────────────────────
    rateVariancePct:    prop(page, 'Rate Variance Pct')      ?? 10,
    burnVariancePct:    prop(page, 'Burn Variance Pct')      ?? 15,
    payLagVarianceDays: prop(page, 'Pay Lag Variance Days')  ?? 7,
    mcRuns:             prop(page, 'MC Runs')                ?? 500,
    // ── Holiday-specific ──────────────────────────────────────────────────
    holidayExtraBurnEur:  prop(page, 'Holiday Extra Burn EUR') ?? 0,
    // ── Scale Business-specific ───────────────────────────────────────────
    revenueMultiplier:    prop(page, 'Revenue Multiplier')     ?? 1,
    subcontractorCostEur: prop(page, 'Subcontractor Cost EUR') ?? 0,
    overheadEur:          prop(page, 'Overhead EUR')           ?? 0,
    // ── BV Structure-specific ─────────────────────────────────────────────
    bvFormationCostEur:  prop(page, 'BV Formation Cost EUR')  ?? 2000,
    bvFormationMonth:    prop(page, 'BV Formation Month')     ?? 1,
    dgaAnnualSalaryEur:  prop(page, 'DGA Annual Salary EUR')  ?? 56000,
    // ── Sabbatical-specific ───────────────────────────────────────────────
    sabbaticalStartMonth:     prop(page, 'Sabbatical Start Month')      ?? 3,
    sabbaticalDurationMonths: prop(page, 'Sabbatical Duration Months')  ?? 3,
    breakMonthlyBurnEur:      prop(page, 'Break Monthly Burn EUR')      ?? 0,
    returnRampMonths:         prop(page, 'Return Ramp Months')          ?? 2,
    returnDayRate:            prop(page, 'Return Day Rate EUR')         ?? 0,
    // ── Remote Work / Digital Nomad-specific ──────────────────────────────
    nomadAccommodationEur:    prop(page, 'Nomad Accommodation EUR')     ?? 800,
    nomadHealthInsuranceEur:  prop(page, 'Nomad Health Insurance EUR')  ?? 100,
    nomadVisaCostEur:         prop(page, 'Nomad Visa Cost EUR')         ?? 300,
    nomadVisaDurationMonths:  prop(page, 'Nomad Visa Duration Months')  ?? 6,
    nomadInternetEur:         prop(page, 'Nomad Internet EUR')          ?? 50,
    fxExposurePct:            prop(page, 'FX Exposure Pct')             ?? 0,
    fxConversionCostPct:      prop(page, 'FX Conversion Cost Pct')      ?? 3,
    // ── Meta ──────────────────────────────────────────────────────────────
    notes:              prop(page, 'Notes')                  || '',
    computedAt:         prop(page, 'Computed At')            || null,
    url:                page.url,
  };
}

/**
 * Map scenario params → Notion Scenarios DB properties.
 */
function scenarioProps(d) {
  const pf = (v, def = 0) => parseFloat(v) || def;
  const pi = (v, def = 0) => parseInt(v)   || def;
  const ps = (v, def = '') => String(v || def);

  const props = {
    // ── Core ──────────────────────────────────────────────────────────────
    'Scenario Name':       { title:     [{ text: { content: ps(d.name, 'Unnamed') } }] },
    'Scenario Type':       { select:    { name: d.type || 'Custom' } },
    'Status':              { select:    { name: d.status || 'Draft' } },
    // ── Income ────────────────────────────────────────────────────────────
    'Day Rate EUR':        { number: pf(d.dayRateEur) },
    'Hourly Rate EUR':     { number: pf(d.hourlyRateEur) },
    'Agency Margin Pct':   { number: pf(d.agencyMarginPct) },
    'Work Days Per Month': { number: pi(d.workDaysPerMonth, 20) },
    'Hours Per Day':       { number: pi(d.hoursPerDay, 8) },
    'Payment Terms Days':  { number: pi(d.paymentTermsDays, 30) },
    'Currency':            { select: { name: d.currency || 'EUR' } },
    // ── Timeline ──────────────────────────────────────────────────────────
    'Likely Months':       { number: pi(d.likelyMonths, 6) },
    'Renewal Probability': { number: pf(d.renewalProbability, 0.5) },
    // ── Costs ─────────────────────────────────────────────────────────────
    'Fixed Costs EUR':     { number: pf(d.fixedCostsEur,    4000) },
    'Variable Costs EUR':  { number: pf(d.variableCostsEur, 3000) },
    'Monthly Burn EUR':    { number: pf(d.monthlyBurnEur) },       // legacy
    'Current Balance EUR': { number: pf(d.currentBalanceEur) },
    // ── ML / Monte Carlo ──────────────────────────────────────────────────
    'Rate Variance Pct':     { number: pf(d.rateVariancePct,     10) },
    'Burn Variance Pct':     { number: pf(d.burnVariancePct,     15) },
    'Pay Lag Variance Days': { number: pf(d.payLagVarianceDays,   7) },
    'MC Runs':               { number: pi(d.mcRuns,             500) },
    // ── Holiday-specific ──────────────────────────────────────────────────
    'Holiday Extra Burn EUR':  { number: pf(d.holidayExtraBurnEur) },
    // ── Scale Business-specific ───────────────────────────────────────────
    'Revenue Multiplier':      { number: pf(d.revenueMultiplier, 1) },
    'Subcontractor Cost EUR':  { number: pf(d.subcontractorCostEur) },
    'Overhead EUR':            { number: pf(d.overheadEur) },
    // ── BV Structure-specific ─────────────────────────────────────────────
    'BV Formation Cost EUR':   { number: pf(d.bvFormationCostEur,  2000) },
    'BV Formation Month':      { number: pi(d.bvFormationMonth,       1) },
    'DGA Annual Salary EUR':   { number: pf(d.dgaAnnualSalaryEur, 56000) },
    // ── Sabbatical-specific ───────────────────────────────────────────────
    'Sabbatical Start Month':      { number: pi(d.sabbaticalStartMonth,     3) },
    'Sabbatical Duration Months':  { number: pi(d.sabbaticalDurationMonths, 3) },
    'Break Monthly Burn EUR':      { number: pf(d.breakMonthlyBurnEur,      0) },
    'Return Ramp Months':          { number: pi(d.returnRampMonths,         2) },
    'Return Day Rate EUR':         { number: pf(d.returnDayRate,            0) },
    // ── Remote Work / Digital Nomad-specific ──────────────────────────────
    'Nomad Accommodation EUR':    { number: pf(d.nomadAccommodationEur,    800) },
    'Nomad Health Insurance EUR': { number: pf(d.nomadHealthInsuranceEur,  100) },
    'Nomad Visa Cost EUR':        { number: pf(d.nomadVisaCostEur,         300) },
    'Nomad Visa Duration Months': { number: pi(d.nomadVisaDurationMonths,    6) },
    'Nomad Internet EUR':         { number: pf(d.nomadInternetEur,          50) },
    'FX Exposure Pct':            { number: pf(d.fxExposurePct,             0) },
    'FX Conversion Cost Pct':     { number: pf(d.fxConversionCostPct,       3) },
    // ── Notes ─────────────────────────────────────────────────────────────
    'Notes': { rich_text: [{ text: { content: ps(d.notes).slice(0, 1999) } }] },
  };

  if (d.startDate) props['Start Date'] = { date: { start: d.startDate } };
  if (d.endDate)   props['End Date']   = { date: { start: d.endDate   } };

  return props;
}

/**
 * Map a Scenario Projections page → plain JS object.
 */
function mapProjection(page) {
  return {
    id:            page.id,
    scenarioId:    prop(page, 'Scenario ID')       || '',
    scenarioName:  prop(page, 'Scenario Name')     || '',
    label:         prop(page, 'Month Label')       || '',
    date:          prop(page, 'Date')              || '',
    phase:         prop(page, 'Phase')             || 'active',
    grossRevenue:  prop(page, 'Gross Revenue EUR') ?? 0,
    agencyMargin:  prop(page, 'Agency Margin EUR') ?? 0,
    netRevenue:    prop(page, 'Net Revenue EUR')   ?? 0,
    monthlyBurn:   prop(page, 'Monthly Burn EUR')  ?? 0,
    taxReserve:    prop(page, 'Tax Reserve EUR')   ?? 0,
    netAfterTax:   prop(page, 'Net After Tax EUR') ?? 0,
    cumulativeNet: prop(page, 'Cumulative Net EUR')?? 0,
  };
}

// ── CRUD: Scenarios ───────────────────────────────────────────────────────────

/**
 * List all scenarios (non-archived).
 */
async function listScenarios(client, dbId) {
  const pages = await queryAll(client, dbId, {
    property: 'Status',
    select: { does_not_equal: 'Archived' },
  });
  return pages.map(mapScenario);
}

/**
 * Create a new scenario in Notion. Returns the new scenario object.
 */
async function createScenario(client, dbId, data) {
  const page = await client.pages.create({
    parent: { database_id: dbId },
    properties: scenarioProps(data),
  });
  return mapScenario(page);
}

/**
 * Update scenario parameters.
 */
async function updateScenario(client, scenarioPageId, data) {
  const page = await client.pages.update({
    page_id: scenarioPageId,
    properties: scenarioProps(data),
  });
  return mapScenario(page);
}

/**
 * Archive (soft-delete) a scenario.
 */
async function archiveScenario(client, scenarioPageId) {
  await client.pages.update({ page_id: scenarioPageId, archived: true });
  return { archived: true };
}

// ── CRUD: Scenario Projections ────────────────────────────────────────────────

/**
 * Get all projection rows for a given scenario ID.
 */
async function getProjections(client, projDbId, scenarioId) {
  const pages = await queryAll(client, projDbId, {
    property: 'Scenario ID',
    rich_text: { equals: scenarioId },
  });
  return pages.map(mapProjection).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Delete all existing projection rows for a scenario (archive them).
 * Called before re-computing to avoid duplicate rows.
 */
async function clearProjections(client, projDbId, scenarioId) {
  const existing = await queryAll(client, projDbId, {
    property: 'Scenario ID',
    rich_text: { equals: scenarioId },
  });
  // Archive in parallel (Notion rate-limits to ~3 req/s, use batches)
  for (let i = 0; i < existing.length; i += 3) {
    const batch = existing.slice(i, i + 3);
    await Promise.all(batch.map(p =>
      client.pages.update({ page_id: p.id, archived: true })
    ));
    if (i + 3 < existing.length) {
      await new Promise(r => setTimeout(r, 350)); // brief pause to respect rate limit
    }
  }
  return existing.length;
}

/**
 * Build simulator input from a mapped scenario object.
 * Applies all type-specific + ML variance params.
 */
function buildSimInput(scenario) {
  return {
    name:                scenario.name,
    type:                scenario.type,
    scenarioType:        scenario.type,
    dayRate:             scenario.dayRateEur,
    hourlyRate:          scenario.hourlyRateEur,
    hoursPerDay:         scenario.hoursPerDay,
    workDaysPerMonth:    scenario.workDaysPerMonth,
    agencyMarginPct:     scenario.agencyMarginPct,
    fixedCostsEur:       scenario.fixedCostsEur    ?? 4000,
    variableCostsEur:    scenario.variableCostsEur ?? 3000,
    monthlyBurn:         scenario.monthlyBurnEur   || 0,  // legacy; simulator will derive from fixed+variable if 0
    monthlyBurnEur:      scenario.monthlyBurnEur   || 0,
    currentBalance:      scenario.currentBalanceEur,
    startDate:           scenario.startDate,
    endDate:             scenario.endDate,
    likelyMonths:        scenario.likelyMonths,
    payLagDays:          scenario.paymentTermsDays,
    paymentTermsDays:    scenario.paymentTermsDays,
    renewalProbability:  scenario.renewalProbability,
    // ML variance
    rateVariancePct:     scenario.rateVariancePct     ?? 10,
    burnVariancePct:     scenario.burnVariancePct     ?? 15,
    payLagVarianceDays:  scenario.payLagVarianceDays  ?? 7,
    mcRuns:              scenario.mcRuns              ?? 500,
    // Holiday
    holidayExtraBurnEur:  scenario.holidayExtraBurnEur  || 0,
    // Scale Business
    revenueMultiplier:    scenario.revenueMultiplier     || 1,
    subcontractorCostEur: scenario.subcontractorCostEur  || 0,
    overheadEur:          scenario.overheadEur           || 0,
    // BV Structure
    bvFormationCostEur:   scenario.bvFormationCostEur    || 2000,
    bvFormationMonth:     scenario.bvFormationMonth      || 1,
    dgaAnnualSalaryEur:   scenario.dgaAnnualSalaryEur    || 56000,
    // Sabbatical
    sabbaticalStartMonth:     scenario.sabbaticalStartMonth     || 3,
    sabbaticalDurationMonths: scenario.sabbaticalDurationMonths || 3,
    breakMonthlyBurnEur:      scenario.breakMonthlyBurnEur      || 0,
    returnRampMonths:         scenario.returnRampMonths         || 2,
    returnDayRate:            scenario.returnDayRate            || 0,
    // Remote Work / Digital Nomad
    nomadAccommodationEur:    scenario.nomadAccommodationEur    || 800,
    nomadHealthInsuranceEur:  scenario.nomadHealthInsuranceEur  || 100,
    nomadVisaCostEur:         scenario.nomadVisaCostEur         || 300,
    nomadVisaDurationMonths:  scenario.nomadVisaDurationMonths  || 6,
    nomadInternetEur:         scenario.nomadInternetEur         || 50,
    fxExposurePct:            scenario.fxExposurePct            || 0,
    fxConversionCostPct:      scenario.fxConversionCostPct      || 3,
    // ── Abundant Spending Engine — seasonal burn map ────────────────────────
    // Passed in from the API route via req.body.seasonalBurnMap.
    // Object keyed by calendar month (1–12) → total EUR spend baseline.
    // When present, overrides flat monthlyBurn per month in project().
    seasonalBurnMap:          scenario.seasonalBurnMap          || null,
  };
}

/**
 * Compute scenario projections with Monte Carlo confidence bands and
 * write the full time series to Notion.
 *
 * @param {object} client          — Notion client
 * @param {string} scenarioDbId    — Scenarios DB ID
 * @param {string} projDbId        — Scenario Projections DB ID
 * @param {string} scenarioPageId  — Notion page ID of the scenario
 * @param {object} taxOverrides    — optional { mkbPct, zvwPct }
 * @param {object} ws              — workspace object (for ML learning)
 * @returns {object} { scenario, months, summary, tax, cleared, written, mcRuns, mcEnd }
 */
async function computeAndStore(client, scenarioDbId, projDbId, scenarioPageId, taxOverrides = {}, ws = null, extraParams = {}) {
  // 1. Load scenario parameters from Notion
  const scenarioPage = await client.pages.retrieve({ page_id: scenarioPageId });
  const scenario     = mapScenario(scenarioPage);
  // Merge in runtime extras (e.g. seasonalBurnMap passed from API request body)
  if (extraParams && Object.keys(extraParams).length > 0) {
    Object.assign(scenario, extraParams);
  }
  const simInput     = buildSimInput(scenario);

  // 2. Learn distributions from Notion history (if workspace provided)
  let learnedParams = { burnRate: { mean: 4500, std: 600, n: 0 }, source: 'defaults' };
  if (ws) {
    try { learnedParams = await learnFromHistory(client, ws); }
    catch (_) { /* use defaults */ }
  }

  // 3. Run Monte Carlo simulation (N runs → P10/P50/P90 bands)
  const runs = scenario.mcRuns || 500;
  const mcResult = projectMC(simInput, learnedParams, taxOverrides, runs);
  const { months, summary, tax, mcEnd } = mcResult;

  // 4. Clear old projections then write fresh time series
  const cleared = await clearProjections(client, projDbId, scenarioPageId);

  const written = [];
  for (let i = 0; i < months.length; i++) {
    const m        = months[i];
    const rowTitle = `${scenario.name} – ${m.label}`;

    const page = await client.pages.create({
      parent: { database_id: projDbId },
      properties: {
        'Row Title':           { title:     [{ text: { content: rowTitle } }] },
        'Scenario ID':         { rich_text: [{ text: { content: scenarioPageId } }] },
        'Scenario Name':       { rich_text: [{ text: { content: scenario.name } }] },
        'Month Label':         { rich_text: [{ text: { content: m.label } }] },
        'Date':                { date:      { start: m.date + '-01' } },
        'Phase':               { select:    { name: m.phase } },
        'Gross Revenue EUR':   { number:    m.grossRevenue    || 0 },
        'Agency Margin EUR':   { number:    m.agencyMargin    || 0 },
        'Net Revenue EUR':     { number:    m.netRevenue      || 0 },
        'Monthly Burn EUR':    { number:    m.monthlyBurn     || 0 },
        'Tax Reserve EUR':     { number:    m.taxReserve      || 0 },
        'Net After Tax EUR':   { number:    m.netAfterTax     || 0 },
        'Cumulative Net EUR':  { number:    m.cumulativeNet   || 0 },
        // ── MC percentile bands ─────────────────────────────────────────
        'P10 Cumulative EUR':  { number:    m.p10 ?? m.cumulativeNet ?? 0 },
        'P50 Cumulative EUR':  { number:    m.p50 ?? m.cumulativeNet ?? 0 },
        'P90 Cumulative EUR':  { number:    m.p90 ?? m.cumulativeNet ?? 0 },
      },
    });
    written.push(page.id);

    // Rate-limit: Notion allows ~3 req/s sustained
    if (i % 3 === 2) await new Promise(r => setTimeout(r, 350));
  }

  // 5. Stamp the scenario with a computedAt timestamp
  await client.pages.update({
    page_id: scenarioPageId,
    properties: {
      'Computed At': { date: { start: new Date().toISOString() } },
    },
  });

  return {
    scenario,
    months,
    summary,
    tax,
    cleared,
    written: written.length,
    mcRuns:  runs,
    mcEnd,
    learnedFrom: learnedParams.source,
  };
}

/**
 * Get projections for multiple scenarios and return aligned comparison data.
 * Each scenario gets its cumulative net series aligned to the same 18-month grid.
 */
async function compareProjections(client, projDbId, scenarioIds) {
  const allSeries = await Promise.all(
    scenarioIds.map(id => getProjections(client, projDbId, id))
  );

  // Build a union of all labels in chronological order
  const labelSet = new Map();
  for (const series of allSeries) {
    for (const row of series) {
      if (!labelSet.has(row.date)) labelSet.set(row.date, row.label);
    }
  }
  const dates = [...labelSet.keys()].sort();

  // Build aligned month grid
  const grid = dates.map(date => {
    const entry = { date, label: labelSet.get(date) };
    for (let i = 0; i < scenarioIds.length; i++) {
      const row = allSeries[i].find(r => r.date === date);
      entry[`s${i}_cumulative`]  = row?.cumulativeNet  ?? null;
      entry[`s${i}_netRevenue`]  = row?.netRevenue     ?? null;
      entry[`s${i}_phase`]       = row?.phase          ?? 'post';
      entry[`s${i}_name`]        = row?.scenarioName   ?? scenarioIds[i];
    }
    return entry;
  });

  return {
    scenarioIds,
    seriesNames: allSeries.map(s => s[0]?.scenarioName ?? 'Unknown'),
    grid,
  };
}

module.exports = {
  listScenarios,
  createScenario,
  updateScenario,
  archiveScenario,
  getProjections,
  clearProjections,
  computeAndStore,
  compareProjections,
  mapScenario,
  buildSimInput,
};
