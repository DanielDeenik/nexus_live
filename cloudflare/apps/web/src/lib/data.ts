import { supabase } from './supabase'

// Direct, RLS-scoped data access. Replaces the REST endpoints the old Hono API
// exposed — every query below is automatically limited to the signed-in user by
// Row-Level Security, so no user_id filter is needed here.
//
// Pages migrate off useApi(path) onto these helpers during the restyle phase.

export async function listInvoices() {
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .order('due_date', { ascending: true })
  if (error) throw error
  return data
}

export async function listExpenses() {
  const { data, error } = await supabase
    .from('expenses')
    .select('*')
    .order('date', { ascending: false })
  if (error) throw error
  return data
}

export async function listMarketSignals() {
  const { data, error } = await supabase
    .from('market_signals')
    .select('*')
    .order('score', { ascending: false })
  if (error) throw error
  return data
}

export async function listCommitments() {
  const { data, error } = await supabase
    .from('commitment_stages')
    .select('*')
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data
}

// Client-side dashboard summary built from base tables, replacing the old
// /v1/finance/summary endpoint. The daily recalc keeps cashflow/burn current.
export async function getDashboardSummary() {
  const [invoices, cashflow, burn] = await Promise.all([
    supabase.from('invoices').select('amount, currency, status, due_date'),
    supabase.from('cashflow_history').select('month, revenue, costs, profit, currency').order('month'),
    supabase.from('burn_history').select('month, amount, currency').order('month'),
  ])
  if (invoices.error) throw invoices.error
  if (cashflow.error) throw cashflow.error
  if (burn.error) throw burn.error

  const paid = (invoices.data ?? []).filter((i) => i.status === 'paid')
  const pending = (invoices.data ?? []).filter((i) => i.status !== 'paid')
  const sum = (rows: { amount: number }[]) => rows.reduce((a, r) => a + Number(r.amount), 0)

  return {
    cashPaid: sum(paid),
    cashPending: sum(pending),
    burnHistory: burn.data ?? [],
    cashflowHistory: cashflow.data ?? [],
  }
}

export { callFunction } from './supabase'
