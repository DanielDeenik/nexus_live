// Look-through: turns the one answer of nx_look() into the three rings and the
// tables of the page (eight, and By tag once lines carry tags). Pure, so it is checked in supabase/tests/look_web_test.ts.
// The figures and the wording of the phone come from the database; this file only
// lays the same facts out as rows. Money reads as the database words it (€1,234),
// so a sentence from the server and a cell from here never differ in style.

export interface LookSlice { key: string; label: string; amount: number }
export interface LookProposal { if: string; then: string; cue: string | null; eur_month: number | null; goal: string | null }
export interface LookItem { key: string; title: string; now: string; short: string; detail: string; action?: string; link?: string; due?: string; rule?: LookProposal | null }
export interface LookAccount { label: string; kind: string; balance: number; last_booked: string | null }
export interface LookReceivable { number: string | null; period: string | null; hours: number | null; amount: number; currency: string; amount_eur: number | null; due: string | null }
export interface LookInvestment { label: string; currency: string; amount: number; amount_eur: number | null; rate: number | null; rate_date: string | null; as_of: string | null; positions: number | null }
export interface LookCategory { category: string; class: string | null; budget: number | null; avg: number; mtd: number }
export interface LookInvoice { number: string | null; period: string | null; issued: string | null; paid: string | null; due: string | null; hours: number | null; amount_eur: number | null; status: string; lag_days: number | null }
export interface LookRecurring { key: string; label: string; cadence: string; amount: number | null; per_year: number | null; next_due: string | null; call: string | null; proposed_call: string | null; overdue: boolean }
export interface LookDayItem { label: string; amount: number; call?: string | null; proposed_call?: string | null; payment?: boolean }
export interface LookDay { date: string; items: LookDayItem[]; balance: number }
export interface LookTagRow { value: string | null; label: string | null; mtd: number; avg: number | null; landing: number; slip: number; slipping: boolean; lines: number; proposal: LookProposal | null }
export interface LookTagDimension { key: string; label: string; rows: LookTagRow[] }
export interface LookTagEffect { id: string; dimension: string; value: string; if_condition: string | null; since: string; before_month: number | null; since_month: number | null }
export interface LookTags { average_months: number; tolerance_pct: number; dimensions: LookTagDimension[]; without_tag: Record<string, number>; effects: LookTagEffect[] }
type Figures = Record<string, number | boolean | null | undefined | { rate: number }[]>

export interface Look {
  version: number
  glance: {
    as_of: string
    today: { hold: number; tax: number; yours: number; caption: string; slices: LookSlice[]; slipping_count: number }
    slipping: { items: LookItem[]; better: { key: string; title: string; detail: string }[] }
  }
  facts: {
    as_of: string
    data_through: string | null
    settings: { window_from: string; window_to: string; average_months: number }
    hold: {
      cash: number; receivable: number; investments: number; hold: number; tax: number; yours: number
      tax_label: string | null; tax_computed_at: string | null; invest_year: number
      accounts: LookAccount[]; receivables: LookReceivable[]; investment_rows: LookInvestment[]; investments_missing: string[]
    }
    month: null | {
      year: number; billed: number; tax: number; business: number; net: number; hours: number; target: number | null
      living_now: number; living_budget: number; left_now: number; left_budget: number; short_now: number | null; short_budget: number | null
    }
    spend: {
      living_avg: number; living_budget: number; month_to_date: number
      classes: Record<string, number>; categories: LookCategory[]
    }
    assignment: null | {
      forecast_year: number; year_end: string; rate: number | null; currency: string | null; fx: number | null; eur_per_hour: number | null
      rate_since: string | null; eur_per_hour_min: number | null; eur_per_hour_max: number | null; keep: number | null
      hours_per_day: number | null; per_unit: number | null; rate_budget: number | null; rate_now: number | null
      lever_spend: number; lever_day: number | null; lever_bv: number | null
      runway_now: number | null; runway_budget: number | null
      contract: null | { client: string; end_date: string | null }
      income_target: number | null; income_date: string | null
      roles: number; roles_hot: number; applications_sent: number
      invoices: LookInvoice[]
    }
    tax: null | {
      year: number; computed_at: string | null; reserve: number; invoice_count: number | null
      to_date: Figures | null; year_end: Figures | null
      billed: { hours?: number; through?: string; revenue_eur?: number } | null
      timeline: { file_before?: string; interest_from?: string; interest_rate?: number } | null
    }
    recurring: { rows: LookRecurring[]; per_year: number; count: number }
    calendar: null | { start: number; until: string; days: LookDay[]; first_negative: string | null; low: number | null; low_date: string | null }
    tags?: LookTags
  }
}

export interface Topic { key: string; label: string; title: string; note: string; cols: [string, string, string]; rows: [string, string, string][] }
export interface Ring { key: string; title: string; centre: string; caption: string; slices: (LookSlice & { color: string })[] }

// Colours checked with the dataviz validator on the card surface (#101829): three hues that stay
// apart for colour-blind readers, a neutral for tax, and one blue stepped light to dark.
export const COLOR = { tax: '#94a3b8', business: '#12a594', living: '#338ced', yours: '#d28e05' }
const LIVING_RAMP = ['#cce3fd', '#6aabf1', '#2370cd', '#1757ac']

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const nf0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })
const nf2 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const nfx = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 })

const signed = (n: number, body: string) => (n < 0 ? '−' : '') + '€' + body
// Halves round away from zero, as Postgres rounds them: −1,342.50 is −€1,343 here and in the database.
const away = (n: number, digits: number) => { const f = 10 ** digits; return Math.sign(n) * Math.round(Math.abs(n) * f) / f }
/** €1,234 and −€1,234: whole euros. */
export const eur0 = (n: number) => { const r = away(n, 0); return signed(r, nf0.format(Math.abs(r))) }
/** €1,234.50: to the cent. */
export const eur2 = (n: number) => { const r = away(n, 2); return signed(r, nf2.format(Math.abs(r))) }
export const num = (n: number) => nfx.format(n)

const parse = (iso: string) => new Date(iso.slice(0, 10) + 'T00:00:00Z')
export const monthName = (iso: string) => MONTHS[parse(iso).getUTCMonth()]
/** 15 Dec, with the year only when it is not the year of `today`. */
export function dayShort(iso: string, today: string): string {
  const d = parse(iso)
  const year = d.getUTCFullYear() === parse(today).getUTCFullYear() ? '' : ` ${d.getUTCFullYear()}`
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}${year}`
}
/** Tue 15 Dec. */
export const day = (iso: string, today: string) => `${DAYS[parse(iso).getUTCDay()]} ${dayShort(iso, today)}`
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const pct = (n: number) => `${Math.round(n * 100)}%`
const n = (v: unknown): number => (typeof v === 'number' ? v : 0)

export function windowLabel(look: Look): string {
  const s = look.facts.settings
  return s.average_months > 1 ? `${monthName(s.window_from)} to ${monthName(s.window_to)}` : monthName(s.window_from)
}

/** The rings at the top: what is yours, an average month, and inside living costs. */
export function rings(look: Look, mode: 'now' | 'budget'): Ring[] {
  const { glance, facts } = look
  const out: Ring[] = [{
    key: 'yours', title: 'What is yours', centre: eur0(glance.today.yours), caption: glance.today.caption,
    slices: glance.today.slices.map((s) => ({ ...s, color: s.key === 'tax' ? COLOR.tax : COLOR.yours })),
  }]
  const m = facts.month
  if (m) {
    const living = mode === 'now' ? m.living_now : m.living_budget
    const left = mode === 'now' ? m.left_now : m.left_budget
    out.push({
      key: 'month', title: `An average month in ${m.year}`, centre: eur0(left), caption: left < 0 ? 'short of living costs' : 'left to invest',
      slices: [
        { key: 'tax', label: 'Tax', amount: m.tax, color: COLOR.tax },
        { key: 'business', label: 'Business costs', amount: m.business, color: COLOR.business },
        { key: 'living', label: mode === 'now' ? 'Living, as now' : 'Living, on budget', amount: Math.min(living, Math.max(m.net, 0)), color: COLOR.living },
        { key: 'left', label: 'Left to invest', amount: Math.max(left, 0), color: COLOR.yours },
      ],
    })
  }
  const c = facts.spend.classes
  const named = ['discretionary', 'fixed', 'variable']
  const other = Object.entries(c).filter(([k]) => !named.includes(k)).reduce((s, [, v]) => s + v, 0)
  const parts: [string, string, number][] = [
    ['discretionary', 'Discretionary', n(c.discretionary)], ['fixed', 'Fixed', n(c.fixed)],
    ['variable', 'Day to day', n(c.variable)], ['other', 'Not visible and other', other],
  ]
  out.push({
    key: 'living', title: 'Inside living costs', centre: eur0(facts.spend.living_avg), caption: `a month, ${windowLabel(look)}`,
    slices: parts.map(([key, label, amount], i) => ({ key, label, amount: Math.max(amount, 0), color: LIVING_RAMP[i] })),
  })
  return out
}

function holdTopic(look: Look): Topic {
  const { hold, as_of } = look.facts
  const rows: Topic['rows'] = [...hold.accounts].sort((a, b) => b.balance - a.balance).map((a) => [
    a.label, `${cap(a.kind)}, ${a.last_booked ? `booked to ${dayShort(a.last_booked, as_of)}` : 'no lines yet'}`, eur2(a.balance)])
  for (const r of hold.receivables) {
    rows.push([[r.number ?? 'Invoice', r.period ? monthName(r.period) : null].filter(Boolean).join(', '),
      [r.hours != null ? `${num(r.hours)} hours` : null, `${r.currency} ${num(r.amount)}`, r.due ? `due ${day(r.due, as_of)}` : null].filter(Boolean).join(', '),
      r.amount_eur != null ? eur2(r.amount_eur) : 'not counted'])
  }
  for (const i of hold.investment_rows) {
    const held = i.positions === 0 ? 'all in cash' : i.positions != null ? `${i.positions} ${i.positions === 1 ? 'position' : 'positions'}` : null
    const rate = i.rate != null && i.currency !== 'EUR' ? `at ${i.rate}${i.rate_date ? `, ECB rate of ${dayShort(i.rate_date, as_of)}` : ''}` : null
    rows.push([i.label, [`${i.currency} ${nf2.format(i.amount)}`, held, rate].filter(Boolean).join(', '), i.amount_eur != null ? eur2(i.amount_eur) : 'not counted'])
  }
  rows.push([hold.tax_label ?? 'Tax to set aside', hold.tax_computed_at ? `Nexus estimate of ${dayShort(hold.tax_computed_at, as_of)}` : '', eur2(-hold.tax)])
  rows.push(['Yours', '', eur2(hold.yours)])
  return {
    key: 'hold', label: 'Hold and owe', title: 'What you hold and owe',
    note: `Cash of ${eur0(hold.cash)} plus ${eur0(hold.receivable)} owed to you and ${eur0(hold.investments)} at the broker, less ${eur0(hold.tax)} of tax. That leaves ${eur0(hold.yours)}.`,
    cols: ['Account or item', 'Detail', 'Amount'], rows,
  }
}

function taxTopic(look: Look): Topic | null {
  const t = look.facts.tax
  if (!t || !t.to_date) return null
  const d = t.to_date
  const today = look.facts.as_of
  const rows: Topic['rows'] = []
  const add = (label: string, detail: string, value: number, when = true) => { if (when) rows.push([label, detail, eur2(value)]) }
  add(t.billed?.through ? `Billed to ${dayShort(t.billed.through, today)}` : 'Billed',
    [t.invoice_count != null ? `${t.invoice_count} invoices` : null, t.billed?.hours != null ? `${num(t.billed.hours)} hours` : null].filter(Boolean).join(', '),
    n(t.billed?.revenue_eur ?? d.revenue_eur))
  add('Business costs', '', -n(d.costs_eur), n(d.costs_eur) !== 0)
  add('Depreciation', '', -n(d.depreciation_eur), n(d.depreciation_eur) !== 0)
  add('Profit', '', n(d.profit))
  add('Zelfstandigenaftrek', '', -n(d.zelfstandigenaftrek), n(d.zelfstandigenaftrek) !== 0)
  add('Startersaftrek', '', -n(d.startersaftrek), n(d.startersaftrek) !== 0)
  add('MKB winstvrijstelling', '', -n(d.mkb_winstvrijstelling), n(d.mkb_winstvrijstelling) !== 0)
  add('Taxable profit', '', n(d.taxable_profit))
  add('Wage', '', n(d.wage), n(d.wage) !== 0)
  add('Box 1 income', '', n(d.box1_income))
  const brackets = Array.isArray(d.bracket_tax) ? d.bracket_tax.map((b) => `${Math.round(b.rate * 10000) / 100}%`) : []
  add('Income tax', brackets.length ? `Brackets of ${brackets.join(', ')}` : '', n(d.income_tax))
  add('Zvw', '', n(d.zvw))
  add('Total due', '', n(d.total_due))
  add('Withheld on the wage', '', -n(d.withheld), n(d.withheld) !== 0)
  add('Prepaid', '', -n(d.prepaid), n(d.prepaid) !== 0)
  add('To pay, to date', '', n(d.to_pay))
  add('Reserve Nexus sets aside', 'The figure used in safe to spend', t.reserve)
  if (t.year_end) add('Year end, to pay', `With the rest of ${t.year} billed${t.year_end.hours != null ? `, ${num(n(t.year_end.hours))} hours` : ''}`, n(t.year_end.to_pay))
  const tl = t.timeline
  const note = ["Nexus's own estimate, not a filing."]
  if (tl?.file_before) note.push(`File before ${day(tl.file_before, today)}.`)
  if (tl?.interest_from) note.push(`Interest runs from ${day(tl.interest_from, today)}${tl.interest_rate != null ? ` at ${Math.round(tl.interest_rate * 1000) / 10}%` : ''}.`)
  return { key: 'tax', label: `Tax ${t.year}`, title: `Tax ${t.year}`, note: note.join(' '), cols: ['Line', 'Detail', 'Amount'], rows }
}

function livingTopic(look: Look): Topic {
  const { spend, as_of } = look.facts
  const month = monthName(as_of)
  const rows: Topic['rows'] = spend.categories.map((c) => [
    c.category, `${c.budget != null ? `Budget ${eur0(c.budget)}` : 'No budget'}. ${month} so far ${eur0(c.mtd)}`, eur0(c.avg)])
  rows.push(['Total', `Budget ${eur0(spend.living_budget)}. ${month} so far ${eur0(spend.month_to_date)}`, eur0(spend.living_avg)])
  return {
    key: 'living', label: 'Living by category', title: 'Living costs by category',
    note: `Average of ${windowLabel(look)} after refunds, against budget. In total ${eur0(spend.living_avg)} against ${eur0(spend.living_budget)}.`,
    cols: ['Category', `Budget and ${month}`, 'Average a month'], rows,
  }
}

/** Spend per tag value against its own average, the same figures Slipping uses, and the rules you took. */
function tagsTopic(look: Look): Topic | null {
  const t = look.facts.tags
  if (!t) return null
  const month = monthName(look.facts.as_of)
  const rows: Topic['rows'] = []
  for (const d of t.dimensions) {
    for (const r of d.rows) {
      if (r.value == null) continue
      rows.push([`${d.label}: ${r.label ?? r.value}`,
        `${r.avg != null && r.avg > 0 ? `Average ${eur0(r.avg)}` : 'No average yet'}. ${month} so far ${eur0(r.mtd)}, ${r.lines} ${r.lines === 1 ? 'line' : 'lines'}${r.slipping ? '. Slipping' : ''}`,
        eur0(r.landing)])
    }
  }
  for (const e of t.effects) {
    const dim = t.dimensions.find((d) => d.key === e.dimension)
    const value = dim?.rows.find((r) => r.value === e.value)?.label ?? e.value
    rows.push([e.if_condition ?? `${dim?.label ?? e.dimension}: ${value}`,
      `Rule since ${dayShort(e.since, look.facts.as_of)}. ${e.before_month != null ? `${eur0(e.before_month)} a month before` : 'No month before'}`,
      e.since_month != null ? `${eur0(e.since_month)} a month` : ''])
  }
  if (rows.length === 0) return null
  const open = t.dimensions.map((d) => [d.label, t.without_tag?.[d.key] ?? 0] as const).filter(([, c]) => c > 0)
  const without = open.length ? ` Lines of ${month} without a tag: ${open.map(([l, c]) => `${l} ${c}`).join(', ')}. Tag them on the Review page.` : ''
  return {
    key: 'tags', label: 'By tag', title: 'Spend by tag',
    note: `Each value against its own average of ${t.average_months} ${t.average_months === 1 ? 'month' : 'months'}, after refunds; slipping when the month lands more than ${t.tolerance_pct}% above it.${without}`,
    cols: ['Tag', `Average and ${month}`, 'By month end'], rows,
  }
}

function leversTopic(look: Look): Topic | null {
  const { month: m, assignment: a, hold, as_of } = look.facts
  if (!m || !a) return null
  const rows: Topic['rows'] = []
  const plus = (v: number) => (v < 0 ? eur0(v) : `+${eur0(v)}`)
  if (a.lever_spend > 0) rows.push(['Spend on your budget', `${eur0(m.living_budget)} instead of ${eur0(m.living_now)}`, plus(a.lever_spend)])
  if (a.per_unit != null && a.currency) rows.push([`Each ${a.currency} 1 more an hour`, `${num(m.hours)} hours a month${a.fx != null ? ` at ${a.fx}` : ''}, after tax`, plus(a.per_unit)])
  if (a.lever_day != null && a.hours_per_day != null && a.eur_per_hour != null) rows.push(['One more billed day a month', `${num(a.hours_per_day)} hours at ${eur2(a.eur_per_hour)}, after tax`, plus(a.lever_day)])
  if (a.lever_bv != null) rows.push(['BV, profit paid out', `Nexus's ${m.year} comparison, indicative`, plus(a.lever_bv)])
  if (m.target != null) {
    rows.push(['Investing target', `${eur0(m.target)} a month. As now ${eur0(m.left_now)} is free, on budget ${eur0(m.left_budget)}`,
      n(m.short_budget) > 0 ? `${eur0(n(m.short_budget))} short` : 'covered on budget'])
  }
  if (a.income_target != null) {
    rows.push(['Income target', `${eur0(a.income_target)} a month${a.income_date ? ` by ${day(a.income_date, as_of)}` : ''}. The assignment bills ${eur0(m.billed)}, which is ${pct(m.billed / a.income_target)}`,
      `${eur0(Math.max(a.income_target - m.billed, 0))} open`])
  }
  rows.push(['A year on these terms', `Before market returns: ${eur0(hold.yours + 12 * m.left_budget)} on budget`, `${eur0(hold.yours + 12 * m.left_now)} as now`])
  return {
    key: 'levers', label: 'Levers', title: 'What has to change',
    note: `What each lever frees a month${a.keep != null ? `, after tax at your ${Math.round((1 - a.keep) * 1000) / 10}% marginal rate where tax applies` : ''}.`,
    cols: ['Lever or target', 'Detail', 'A month'], rows,
  }
}

function slippingTopic(look: Look): Topic {
  const s = look.glance.slipping
  const rows: Topic['rows'] = s.items.map((i) => [i.title, i.rule ? `${i.detail} Proposed rule: if ${i.rule.if}, then ${i.rule.then}.` : i.detail, i.now])
  for (const b of s.better) rows.push([b.title, b.detail, 'better'])
  return {
    key: 'slipping', label: 'Slipping', title: 'Slipping',
    note: `${s.items.length} open ${s.items.length === 1 ? 'item' : 'items'}, each against your own plan or rule.`,
    cols: ['Item', 'Detail', 'Now'], rows,
  }
}

function assignmentTopic(look: Look): Topic | null {
  const { assignment: a, month: m, tax, as_of } = look.facts
  if (!a) return null
  const rows: Topic['rows'] = []
  const cur = a.currency ?? ''
  if (a.rate != null) rows.push(['Rate', a.rate_since ? `Unchanged since ${monthName(a.rate_since)}` : '', `${cur} ${num(a.rate)} an hour`])
  if (a.eur_per_hour != null) {
    rows.push(['In euro', a.eur_per_hour_min != null && a.eur_per_hour_max != null ? `${eur2(a.eur_per_hour_min)} to ${eur2(a.eur_per_hour_max)} this year on the exchange rate` : '', eur2(a.eur_per_hour)])
  }
  if (m) {
    rows.push([`${m.year} billed`, `${num(m.hours * 12)} hours, if it runs on`, eur0(m.billed * 12)])
    rows.push([`${m.year} tax`, 'Indicative', eur0(-m.tax * 12)])
    rows.push([`${m.year} business costs`, 'As this year', eur0(-m.business * 12)])
    rows.push([`${m.year} to you`, `${eur0(m.net)} a month`, eur0(m.net * 12)])
    const up = (r: number) => (a.rate ? `Rate up ${pct(Math.ceil(r) / a.rate - 1)}` : '')
    if (n(m.short_budget) > 0 && a.rate_budget != null) rows.push(['Plan closes, living on budget', up(a.rate_budget), `${cur} ${num(Math.ceil(a.rate_budget))}`])
    if (n(m.short_now) > 0 && a.rate_now != null) rows.push(['Plan closes, living as now', up(a.rate_now), `${cur} ${num(Math.ceil(a.rate_now))}`])
  }
  if (a.runway_now != null) {
    const after = tax?.year_end ? ` After ${eur0(n(tax.year_end.to_pay))} of ${a.forecast_year} tax.` : ''
    rows.push([`Runway if it ended ${dayShort(a.year_end, as_of)}`, `${a.runway_budget != null ? `${a.runway_budget} months on budget.` : ''}${after}`.trim(), `${a.runway_now} months`])
  }
  rows.push(['Next assignment', `${a.roles} roles tracked, ${a.roles_hot} hot`, `${a.applications_sent} applications sent`])
  rows.push(['End date', a.contract ? a.contract.client : 'No contract on file', a.contract?.end_date ? day(a.contract.end_date, as_of) : 'not set'])
  for (const i of a.invoices) {
    rows.push([[i.number ?? 'Invoice', i.period ? monthName(i.period) : null].filter(Boolean).join(', '),
      [i.hours != null ? `${num(i.hours)} hours` : null, i.paid ? (i.lag_days != null ? `paid after ${i.lag_days} days` : 'paid') : i.due ? `due ${day(i.due, as_of)}` : i.status].filter(Boolean).join(', '),
      i.amount_eur != null ? eur2(i.amount_eur) : ''])
  }
  return {
    key: 'assignment', label: 'Assignment', title: 'Assignment',
    note: `${m ? `The ${m.year} figures are Nexus's own estimate at today's rate and hours.` : 'No forecast for next year yet.'}${a.contract ? '' : ' No contract on file, so no end date.'}`,
    cols: ['Line', 'Detail', 'Figure'], rows,
  }
}

function calendarTopic(look: Look): Topic | null {
  const c = look.facts.calendar
  if (!c) return null
  const today = look.facts.as_of
  const rows: Topic['rows'] = c.days.map((d) => [day(d.date, today), d.items.map((i) => i.payment
    ? `${i.label} lands, ${eur2(i.amount)}`
    : `${i.label} ${eur2(-i.amount)}${i.call ? ` (your call: ${i.call})` : i.proposed_call ? ` (Nexus proposes: ${i.proposed_call})` : ''}`).join(', '), eur0(d.balance)])
  const late = look.facts.recurring.rows.filter((r) => r.overdue && r.amount != null)
  if (late.length) rows.push(['Not in this line', `Day to day spending. Due and not seen yet: ${late.map((r) => `${r.label} ${eur2(n(r.amount))}`).join(', ')}`, ''])
  const below = c.first_negative
    ? ` On fixed debits alone they are below zero from ${day(c.first_negative, today)}${c.low != null && c.low_date ? `, lowest ${eur0(c.low)} on ${day(c.low_date, today)}` : ''}.`
    : ' On fixed debits alone they stay above zero.'
  return {
    key: 'calendar', label: 'Until the next payment', title: `Until the next payment, ${day(c.until, today)}`,
    note: `The day to day accounts hold ${eur0(c.start)} today.${below}`,
    cols: ['Day', 'What leaves or lands', 'Balance after'], rows,
  }
}

function recurringTopic(look: Look): Topic {
  const r = look.facts.recurring
  const today = look.facts.as_of
  const rows: Topic['rows'] = r.rows.map((x) => [x.label,
    `${cap(x.cadence)}${x.next_due ? `, ${x.overdue ? 'was due' : 'next'} ${dayShort(x.next_due, today)}` : ''}${x.call ? `. Your call: ${x.call}` : x.proposed_call ? `. Nexus proposes: ${x.proposed_call}` : ''}`,
    x.amount != null ? eur2(x.amount) : ''])
  return {
    key: 'recurring', label: 'Recurring', title: 'Recurring charges',
    note: `${r.count} charges, ${eur0(r.per_year)} a year. Your call, or Nexus's proposal, where there is one.`,
    cols: ['Charge', 'Rhythm and call', 'Each time'], rows,
  }
}

/** The tables under the rings, in the order of the menu. A table with nothing behind it is left out. */
export function topics(look: Look): Topic[] {
  return [holdTopic(look), taxTopic(look), livingTopic(look), tagsTopic(look), leversTopic(look), slippingTopic(look), assignmentTopic(look), calendarTopic(look), recurringTopic(look)]
    .filter((t): t is Topic => t !== null)
}

/** Which table a slice of a ring opens. */
export const SLICE_TOPIC: Record<string, string> = {
  'yours:tax': 'tax', 'yours:yours': 'hold', 'month:tax': 'tax', 'month:business': 'assignment', 'month:living': 'living', 'month:left': 'levers',
  'living:discretionary': 'living', 'living:fixed': 'living', 'living:variable': 'living', 'living:other': 'living',
}
