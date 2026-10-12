import { supabase } from './supabase'
import { callNexus, uploadDocument } from './nexus'

// Typed data access for LinkedIn insights. The li_ tables are select only for
// the owner under RLS; imports go through the nexus/linkedin Edge Function and
// the page reads one summary from the li_summary RPC (security invoker).

export type ImportKind = 'content' | 'archive' | 'screenshot'
export type ImportHint = ImportKind | 'profile_views' | 'search_appearances'

export interface Counted { label: string; count: number | null }

export interface Snapshot {
  period_label: string | null
  period_from: string | null
  period_to: string | null
  total: number | null
  captured_at: string
  details: {
    change_pct?: number | null
    titles?: Counted[]
    companies?: Counted[]
    locations?: Counted[]
    appeared_where?: Counted[]
    keywords?: Counted[]
  }
}

export interface LinkedInSummary {
  period: { from: string | null; to: string | null; first_day: string | null; last_day: string | null }
  content: { impressions: number; engagements: number; days: number; engagement_rate: number | null }
  series: { day: string; impressions: number | null; engagements: number | null; new_followers: number | null }[]
  followers: { total: number | null; as_of: string | null; growth: number }
  top_posts: { url: string; published_on: string | null; impressions: number | null; engagements: number | null; rate: number | null }[]
  audience: { as_of: string | null; dimensions: Record<string, { value: string; pct: number | null; pct_label: string | null }[]> }
  network: { connections: number; connections_in_period: number; recruiters: number; top_recruiter_companies: { company: string; recruiters: number }[] }
  messages: {
    inbound: number
    inbound_recruiter: number
    recruiter_by_month: { month: string; count: number }[]
    top_recruiter_senders_companies: { company: string; messages: number }[]
  }
  profile: { views: Snapshot | null; search: Snapshot | null }
  warm_companies: { company: string; recruiters: number; roles: number; role_list: { title: string; score: number; tier: string; status: string }[] }[]
}

export interface ImportRow {
  id: string
  kind: ImportKind
  path: string
  status: 'running' | 'succeeded' | 'partial' | 'failed'
  period_from: string | null
  period_to: string | null
  counts: Record<string, number | string | null> | null
  warnings: string[] | null
  error: string | null
  agent_run_id: string | null
  imported_at: string
}

export interface ImportResult {
  import_id?: string
  run_id?: string
  kind?: ImportKind
  status: string
  counts?: Record<string, number | string | null>
  period?: { from: string; to: string } | null
  warnings?: string[]
  error?: string
}

/** File types the import accepts, for the file input. */
export const ACCEPT = '.xlsx,.zip,.png,.jpg,.jpeg'

export async function loadSummary(from: string | null, to: string | null): Promise<LinkedInSummary> {
  const { data, error } = await supabase.rpc('li_summary', { p_from: from, p_to: to })
  if (error) throw new Error(error.message)
  return data as LinkedInSummary
}

export async function listImports(limit = 50): Promise<ImportRow[]> {
  const { data, error } = await supabase.from('li_imports').select('*').order('imported_at', { ascending: false }).limit(limit)
  if (error) throw new Error(error.message)
  return (data ?? []) as ImportRow[]
}

/** Uploads one file to the owner's folder and imports it; the kind is
 *  detected by the route when no hint is given. */
export async function importFile(file: File, kind?: ImportHint): Promise<ImportResult> {
  const path = await uploadDocument(file)
  return callNexus<ImportResult>('linkedin', { mode: 'import', path, ...(kind ? { kind } : {}) })
}

export const DIMENSION_LABELS: Record<string, string> = {
  job_title: 'Job titles',
  location: 'Locations',
  industry: 'Industries',
  seniority: 'Seniority',
  company_size: 'Company size',
  company: 'Companies',
}

export const int = (n: number | null | undefined) => (n == null ? '-' : new Intl.NumberFormat('nl-NL').format(n))
export const pct = (n: number | null | undefined, digits = 1) => (n == null ? '-' : `${(n * 100).toFixed(digits)}%`)
export const shortDay = (s: string | null | undefined) => (s ? new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '-')

/** Short plain text for an import's counts. */
export function countsText(c: Record<string, unknown> | null | undefined): string {
  if (!c) return ''
  return Object.entries(c).filter(([, v]) => v !== null && v !== '' && (typeof v === 'number' || typeof v === 'string'))
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${typeof v === 'number' ? int(v) : v}`).join(', ')
}
