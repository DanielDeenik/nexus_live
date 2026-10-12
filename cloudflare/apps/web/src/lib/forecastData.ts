import { supabase } from './supabase'
import { loadInvoices, loadParams } from './nexus'
import { billableVsInvoiced } from './time'
import { CONFIG_KEYS, type ForecastConfig, type ForecastInvoice, configFromRows } from './forecast'

// Supabase reads for the Forecast page. The maths lives in forecast.ts.

export async function loadForecastConfig(): Promise<ForecastConfig> {
  const { data, error } = await supabase.from('app_config').select('key, value').in('key', Object.values(CONFIG_KEYS))
  if (error) throw new Error(error.message)
  return configFromRows(data ?? [])
}

export async function loadForecastInvoices(): Promise<ForecastInvoice[]> {
  return (await loadInvoices()).map((i) => ({
    id: i.id, client: i.client, amount_eur: i.amount_eur, hours: i.hours, issued_date: i.issued_date,
    period_start: i.period_start, period_end: i.period_end, voided_at: i.voided_at, duplicate_of: i.duplicate_of,
  }))
}

/** Urencriterium hours for the year from tax_parameters, or null with the
 *  reason when the year's parameters are not loaded. */
export async function loadUrencriterium(year: number): Promise<{ hours: number | null; note: string }> {
  try {
    const p = (await loadParams()).get(year)
    return p ? { hours: p.urencriteriumHours, note: '' } : { hours: null, note: `No tax parameters for ${year}.` }
  } catch (e) {
    return { hours: null, note: (e as Error).message }
  }
}

/** Billable hours logged in DTrack in [from, toExclusive). */
export async function loggedBillableHours(from: string, toExclusive: string): Promise<number> {
  if (from >= toExclusive) return 0
  const rows = await billableVsInvoiced(from, toExclusive)
  return rows.reduce((s, r) => s + r.logged_hours, 0)
}
