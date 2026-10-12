import { supabase } from './supabase'
import {
  type AssetRow, type ExpenseRow, type FiscalParams, type InvoiceRow, type ParamRow, type TimeEntryRow,
  deductibleEur, depreciationForYear, estimateIncomeTax, kiaForYear, paramsFromRows, summarizeIncome, workingCapacity,
} from '@fiscal'

// Data access for the income, expense and tax workflow. Reads go straight to
// Postgres under RLS; anything that changes agent output goes through the
// nexus Edge Function so every decision is validated and traced.

export async function callNexus<T = unknown>(route: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(`nexus/${route}`, { body })
  if (error) {
    // Surface the function's own error message rather than a generic one.
    const ctx = (error as { context?: Response }).context
    const detail = ctx ? await ctx.json().catch(() => null) : null
    throw new Error(detail?.error ?? error.message)
  }
  return data as T
}

export interface Profile {
  id: string
  name: string
  work_calendar_region: string | null
  standard_hours_per_day: number | null
  startersaftrek_eligible: boolean
}

export interface InvoiceRecord extends InvoiceRow {
  client_country: string | null
  client_region: string | null
  vat_treatment: string | null
  vat_amount: number
  fx_rate_eur: number | null
  description: string | null
  void_reason: string | null
  document_path: string | null
}

export interface ExpenseRecord extends ExpenseRow {
  vendor: string | null
  vendor_country: string | null
  description: string | null
  source: string | null
  amount_eur: number | null
  confidence: number | null
  rationale: string | null
  evidence_path: string | null
  asset_id: string | null
  created_at: string
}

export interface ReviewItem {
  id: string
  item_type: 'expense' | 'asset' | 'filing' | 'invoice_anomaly'
  item_id: string | null
  reason_codes: string[]
  summary: string
  proposed: Record<string, unknown>
  status: string
  created_at: string
}

export interface TaxFiling {
  id: string
  kind: 'vat_quarter' | 'income_tax_year'
  period_label: string
  period_start: string
  period_end: string
  status: 'needs_review' | 'approved' | 'filed' | 'superseded'
  figures: Record<string, unknown>
  warnings: { code: string; severity: 'info' | 'warn' | 'block'; message: string }[]
  approved_at: string | null
  filed_at: string | null
  filed_reference: string | null
  created_at: string
}

const num = (v: unknown) => (v == null ? null : Number(v))

export async function loadProfile(): Promise<Profile | null> {
  const { data: u } = await supabase.auth.getUser()
  if (!u.user) return null
  const { data, error } = await supabase.from('profiles')
    .select('id, name, work_calendar_region, standard_hours_per_day, startersaftrek_eligible').eq('id', u.user.id).single()
  if (error) throw error
  return { ...data, standard_hours_per_day: num(data.standard_hours_per_day) } as Profile
}

export async function loadParams(): Promise<Map<number, FiscalParams>> {
  const { data, error } = await supabase.from('tax_parameters').select('year, key, value, verified')
  if (error) throw error
  const out = new Map<number, FiscalParams>()
  for (const y of new Set((data ?? []).map((r) => r.year as number))) out.set(y, paramsFromRows(data as ParamRow[], y))
  return out
}

export async function loadInvoices(): Promise<InvoiceRecord[]> {
  const { data, error } = await supabase.from('invoices').select('*').order('issued_date', { ascending: true })
  if (error) throw error
  return (data ?? []).map((r) => ({
    ...r, amount: Number(r.amount), amount_eur: num(r.amount_eur), hours: num(r.hours), unit_rate: num(r.unit_rate),
    vat_amount: Number(r.vat_amount ?? 0), fx_rate_eur: num(r.fx_rate_eur),
  })) as InvoiceRecord[]
}

export async function loadTimeEntries(): Promise<(TimeEntryRow & { id: string; description: string | null })[]> {
  const { data, error } = await supabase.from('time_entries').select('id, entry_date, hours, category, description').order('entry_date', { ascending: false })
  if (error) throw error
  return (data ?? []).map((r) => ({ ...r, hours: Number(r.hours) }))
}

export async function loadExpenses(): Promise<ExpenseRecord[]> {
  const { data, error } = await supabase.from('expenses').select('*').order('date', { ascending: false })
  if (error) throw error
  return (data ?? []).map((r) => ({
    ...r, amount: Number(r.amount), amount_excl_vat: num(r.amount_excl_vat), vat_amount: num(r.vat_amount),
    business_use_pct: Number(r.business_use_pct), fx_rate_eur: num(r.fx_rate_eur), amount_eur: num(r.amount_eur), confidence: num(r.confidence),
  })) as ExpenseRecord[]
}

export async function loadAssets(): Promise<AssetRow[]> {
  const { data, error } = await supabase.from('fixed_assets').select('*').order('acquired_date', { ascending: false })
  if (error) throw error
  return (data ?? []).map((r) => ({ ...r, cost_excl_vat: Number(r.cost_excl_vat), residual_value: Number(r.residual_value), useful_life_years: Number(r.useful_life_years) })) as AssetRow[]
}

export async function loadHolidays(region: string, from: string, to: string) {
  const { data, error } = await supabase.from('public_holidays').select('holiday_date, name').eq('region_code', region).gte('holiday_date', from).lte('holiday_date', to)
  if (error) throw error
  return data ?? []
}

export async function loadRegions(): Promise<string[]> {
  const { data, error } = await supabase.from('public_holidays').select('region_code')
  if (error) throw error
  return [...new Set((data ?? []).map((r) => r.region_code as string))].sort()
}

export async function loadOpenReviews(): Promise<ReviewItem[]> {
  const { data, error } = await supabase.from('review_items').select('*').eq('status', 'open').order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as ReviewItem[]
}

export async function loadFilings(): Promise<TaxFiling[]> {
  const { data, error } = await supabase.from('tax_filings').select('*').neq('status', 'superseded').order('period_start', { ascending: false })
  if (error) throw error
  return (data ?? []) as TaxFiling[]
}

export async function evidenceUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from('receipts').createSignedUrl(path, 300)
  return data?.signedUrl ?? null
}

/** Uploads into the caller's own folder (enforced by storage RLS too). */
export async function uploadDocument(file: File): Promise<string> {
  const { data: u } = await supabase.auth.getUser()
  if (!u.user) throw new Error('not signed in')
  const safe = file.name.replace(/[^A-Za-z0-9._-]/g, '_')
  const path = `${u.user.id}/uploads/${Date.now()}_${safe}`
  const { error } = await supabase.storage.from('receipts').upload(path, file, { contentType: file.type || undefined })
  if (error) throw error
  return path
}

/** Region for the remaining-days calendar: the owner's setting, or derived
 *  from the client on the most recent invoice. */
export function calendarRegion(profile: Profile | null, invoices: InvoiceRecord[]): string | null {
  if (profile?.work_calendar_region) return profile.work_calendar_region
  const latest = [...invoices].filter((i) => !i.voided_at && i.client_country && i.client_region).sort((a, b) => b.issued_date.localeCompare(a.issued_date))[0]
  return latest ? `${latest.client_country}-${latest.client_region}` : null
}

export interface YearView {
  year: number
  ledger: ReturnType<typeof summarizeIncome>
  params: FiscalParams | null
  totalHours: number
  costsEur: number
  depreciationEur: number
  kia: { qualifying: number; kia: number }
  ytd: ReturnType<typeof estimateIncomeTax> | null
  capacity: ReturnType<typeof workingCapacity> | null
  projection: { revenue_eur: number; estimate: ReturnType<typeof estimateIncomeTax>; eur_per_hour: number } | null
  region: string | null
}

export async function buildYearView(year: number, today: string): Promise<YearView & { invoices: InvoiceRecord[]; profile: Profile | null }> {
  const [profile, params, invoices, time, expenses, assets] = await Promise.all([
    loadProfile(), loadParams(), loadInvoices(), loadTimeEntries(), loadExpenses(), loadAssets(),
  ])
  const p = params.get(year) ?? null
  const ledger = summarizeIncome(invoices, time, year)
  const totalHours = ledger.billed_hours + ledger.non_billable_hours
  const yearExp = expenses.filter((e) => e.date.startsWith(String(year)))
  const costsEur = p ? Math.round(yearExp.reduce((s, e) => s + deductibleEur(e, p), 0) * 100) / 100 : 0
  const depreciationEur = Math.round(assets.reduce((s, a) => s + depreciationForYear(a, year), 0) * 100) / 100
  const kia = p ? kiaForYear(assets, year, p) : { qualifying: 0, kia: 0 }
  const starters = profile?.startersaftrek_eligible === true
  const ytd = p ? estimateIncomeTax({ revenue_eur: ledger.revenue_eur, deductible_costs_eur: costsEur, depreciation_eur: depreciationEur, kia_eur: kia.kia, total_hours: totalHours, starters_eligible: starters }, p) : null

  const region = calendarRegion(profile, invoices)
  const perDay = profile?.standard_hours_per_day ?? null
  const end = `${year}-12-31`
  let capacity = null
  let projection = null
  if (region && perDay && today <= end) {
    const from = today >= `${year}-01-01` ? today : `${year}-01-01`
    capacity = workingCapacity(from, end, await loadHolidays(region, from, end), perDay)
    const latest = [...invoices].filter((i) => !i.voided_at && i.unit_rate && i.amount_eur).sort((a, b) => b.issued_date.localeCompare(a.issued_date))[0]
    // Capacity counts from today; months already billed are excluded so they
    // are not counted twice.
    const lastBilled = ledger.months.at(-1)?.month
    if (p && latest && lastBilled) {
      const nextUnbilled = new Date(Date.UTC(Number(lastBilled.slice(0, 4)), Number(lastBilled.slice(5, 7)), 1)).toISOString().slice(0, 10)
      const projFrom = nextUnbilled > from ? nextUnbilled : from
      const cap = projFrom === from ? capacity : workingCapacity(projFrom, end, await loadHolidays(region, projFrom, end), perDay)
      const eurPerHour = (Number(latest.amount_eur) / Number(latest.amount)) * Number(latest.unit_rate)
      const revenue = ledger.revenue_eur + cap.hours * eurPerHour
      projection = {
        revenue_eur: Math.round(revenue * 100) / 100,
        eur_per_hour: Math.round(eurPerHour * 100) / 100,
        estimate: estimateIncomeTax({ revenue_eur: revenue, deductible_costs_eur: costsEur, depreciation_eur: depreciationEur, kia_eur: kia.kia, total_hours: totalHours + cap.hours, starters_eligible: starters }, p),
      }
    }
  }
  return { year, ledger, params: p, totalHours, costsEur, depreciationEur, kia, ytd, capacity, projection, region, invoices, profile }
}

export const eur = (n: number) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)
export const money = (n: number, c: string) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: c, maximumFractionDigits: 2 }).format(n)
export const hrs = (n: number) => new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 1 }).format(n)
