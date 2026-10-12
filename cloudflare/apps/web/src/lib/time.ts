import { supabase } from './supabase'
import { hrs, loadProfile } from './nexus'

// Typed data access for time tracking (the DTrack tables). Reads and writes go
// straight to Postgres under owner-only RLS. Rows that came from Relay
// (external_id set) are read only; the database refuses changes to them.

export type Category = 'execution' | 'junk' | 'off' | 'flow'
export type Axis = 'area' | 'project' | 'activity' | 'category' | 'billable' | 'source' | 'month' | 'week' | 'day'

export const CATEGORIES: { id: Category; name: string }[] = [
  { id: 'flow', name: 'Flow' },
  { id: 'execution', name: 'Execution' },
  { id: 'junk', name: 'Junk' },
  { id: 'off', name: 'Off' },
]

export const SOURCES: { id: string; name: string }[] = [
  { id: 'dtrack', name: 'Typed in Nexus' },
  { id: 'flow', name: 'Relay flow block' },
  { id: 'call', name: 'Relay call' },
  { id: 'calendar', name: 'Relay calendar' },
  { id: 'app', name: 'Relay app in front' },
  { id: 'git', name: 'Relay git' },
  { id: 'manual', name: 'Relay typed' },
  { id: 'relay', name: 'Relay activity' },
]

export const AXES: { value: Axis; label: string }[] = [
  { value: 'area', label: 'Area of work' },
  { value: 'project', label: 'Project' },
  { value: 'activity', label: 'Activity' },
  { value: 'category', label: 'Category' },
  { value: 'billable', label: 'Billable' },
  { value: 'source', label: 'Source' },
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
]
export const MAX_AXES = 5

export interface NamedRow { id: string; name: string; description: string | null }
export type Area = NamedRow
export type Activity = NamedRow

export interface Project {
  id: string
  aow_id: string | null
  name: string
  client: string | null
  billable: boolean
  relay_key: string | null
  needs_mapping: boolean
  start_date: string | null
  end_date: string | null
  description: string | null
  archived_at: string | null
}

export interface TimeEntry {
  id: string
  project_id: string
  activity_id: string | null
  entry_date: string
  started_at: string | null
  ended_at: string | null
  minutes: number
  description: string | null
  category: Category | null
  source: string
  external_id: string | null
}

export interface FlowBlock {
  id: string
  project_id: string | null
  external_id: string | null
  started_at: string
  ended_at: string | null
  minutes: number
  planned_min: number | null
  goal: string | null
  depth: number | null
  challenge: string | null
  triggers: unknown
  interrupted: boolean | null
  recovery_min: number | null
  note: string | null
}

export interface DeviceToken {
  id: string
  name: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export interface SummaryRow { path: string[]; hours: number }
export interface ReconRow { month: string; logged_hours: number; invoiced_hours: number }

export const hoursLabel = (h: number) => `${hrs(h)} h`
export const fromRelay = (r: { external_id: string | null }) => r.external_id != null

/** Address Relay pushes confirmed time to; read from the same env as the client. */
export const ingestUrl = () => `${import.meta.env.VITE_SUPABASE_URL ?? ''}/functions/v1/nexus/dtrack-ingest`

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data as T
}

// ---- bootstrap -----------------------------------------------------------

const booted = new Map<string, Promise<void>>()

/** Runs dt_bootstrap once per signed-in user per page session. */
export function ensureBootstrap(userId: string): Promise<void> {
  let p = booted.get(userId)
  if (!p) {
    p = (async () => { check(await supabase.rpc('dt_bootstrap')) })()
    p.catch(() => booted.delete(userId))
    booted.set(userId, p)
  }
  return p
}

// ---- lookups ---------------------------------------------------------------

type NamedTable = 'dt_areas_of_work' | 'dt_activities'

export async function listNamed(table: NamedTable): Promise<NamedRow[]> {
  return check(await supabase.from(table).select('id, name, description').order('name'))
}

export async function saveNamed(table: NamedTable, row: { id?: string; name: string; description: string | null }) {
  const body = { name: row.name.trim(), description: row.description?.trim() || null }
  if (row.id) check(await supabase.from(table).update(body).eq('id', row.id))
  else check(await supabase.from(table).insert(body))
}

export async function deleteNamed(table: NamedTable, id: string) {
  check(await supabase.from(table).delete().eq('id', id))
}

// ---- projects --------------------------------------------------------------

const PROJECT_COLS = 'id, aow_id, name, client, billable, relay_key, needs_mapping, start_date, end_date, description, archived_at'

export async function listProjects(opts: { needsMapping?: boolean } = {}): Promise<Project[]> {
  let q = supabase.from('dt_projects').select(PROJECT_COLS).order('name')
  if (opts.needsMapping) q = q.eq('needs_mapping', true)
  return check(await q) as Project[]
}

export type ProjectInput = Omit<Project, 'id' | 'needs_mapping'> & { id?: string }

/** Saving a project confirms its mapping, so it leaves the needs mapping list. */
export async function saveProject(p: ProjectInput) {
  const { id, ...rest } = p
  const body = { ...rest, needs_mapping: false }
  if (id) check(await supabase.from('dt_projects').update(body).eq('id', id))
  else check(await supabase.from('dt_projects').insert(body))
}

// ---- time entries ----------------------------------------------------------

export interface EntryFilter {
  from?: string
  to?: string
  project?: string
  activity?: string
  category?: string
  source?: string
}

const ENTRY_COLS = 'id, project_id, activity_id, entry_date, started_at, ended_at, minutes, description, category, source, external_id'

export async function listEntries(f: EntryFilter, page: number, perPage: number): Promise<{ rows: TimeEntry[]; total: number }> {
  let q = supabase.from('dt_time_entries').select(ENTRY_COLS, { count: 'exact' }).is('removed_at', null)
  if (f.from) q = q.gte('entry_date', f.from)
  if (f.to) q = q.lte('entry_date', f.to)
  if (f.project) q = q.eq('project_id', f.project)
  if (f.activity) q = q.eq('activity_id', f.activity)
  if (f.category) q = q.eq('category', f.category)
  if (f.source) q = q.eq('source', f.source)
  const start = (page - 1) * perPage
  const res = await q.order('entry_date', { ascending: false }).order('started_at', { ascending: false, nullsFirst: false }).range(start, start + perPage - 1)
  const rows = check(res) as TimeEntry[]
  return { rows: rows.map((r) => ({ ...r, minutes: Number(r.minutes) })), total: res.count ?? rows.length }
}

export interface EntryInput {
  entry_date: string
  project_id: string
  activity_id: string | null
  minutes: number
  category: Category | null
  description: string | null
}

/** Browser rows keep the defaults: source dtrack and no external id. */
export async function createEntry(e: EntryInput) {
  check(await supabase.from('dt_time_entries').insert(e))
}

export async function updateEntry(id: string, e: EntryInput) {
  check(await supabase.from('dt_time_entries').update(e).eq('id', id).is('external_id', null))
}

export async function deleteEntry(id: string) {
  check(await supabase.from('dt_time_entries').delete().eq('id', id).is('external_id', null))
}

// ---- flow blocks -----------------------------------------------------------

export async function listFlowBlocks(f: { from?: string; before?: string }, page: number, perPage: number): Promise<{ rows: FlowBlock[]; total: number }> {
  let q = supabase.from('dt_flow_blocks').select('*', { count: 'exact' })
  if (f.from) q = q.gte('started_at', f.from)
  if (f.before) q = q.lt('started_at', f.before)
  const start = (page - 1) * perPage
  const res = await q.order('started_at', { ascending: false }).range(start, start + perPage - 1)
  const rows = check(res) as FlowBlock[]
  return { rows, total: res.count ?? rows.length }
}

// ---- devices ---------------------------------------------------------------

export async function listDeviceTokens(): Promise<DeviceToken[]> {
  return check(await supabase.from('dt_device_tokens').select('id, name, created_at, last_used_at, revoked_at').order('created_at', { ascending: false }))
}

/** Returns the token once; only its hash is stored. */
export async function createDeviceToken(name: string): Promise<string> {
  return check(await supabase.rpc('dt_create_device_token', { p_name: name.trim() })) as string
}

export async function revokeDeviceToken(id: string) {
  check(await supabase.rpc('dt_revoke_device_token', { p_id: id }))
}

// ---- summaries -------------------------------------------------------------

export async function summary(axes: Axis[], from: string, to: string): Promise<SummaryRow[]> {
  if (!axes.length) return []
  const rows = check(await supabase.rpc('dt_summary', { p_axes: axes, p_from: from, p_to: to })) as SummaryRow[]
  return (rows ?? []).map((r) => ({ path: r.path.map((p) => p ?? 'None'), hours: Number(r.hours) }))
}

export async function billableVsInvoiced(from: string, to: string): Promise<ReconRow[]> {
  const rows = check(await supabase.rpc('dt_billable_vs_invoiced', { p_from: from, p_to: to })) as ReconRow[]
  return (rows ?? []).map((r) => ({ month: r.month, logged_hours: Number(r.logged_hours), invoiced_hours: Number(r.invoiced_hours) }))
}

// ---- work calendar ---------------------------------------------------------

export interface WorkCalendar { hoursPerDay: number | null; region: string | null; holidays: Set<string> }

/** Hours per day and holidays from the profile's calendar region. */
export async function loadWorkCalendar(): Promise<WorkCalendar> {
  const profile = await loadProfile()
  const region = profile?.work_calendar_region ?? null
  let holidays = new Set<string>()
  if (region) {
    const rows = check(await supabase.from('public_holidays').select('holiday_date').eq('region_code', region)) as { holiday_date: string }[]
    holidays = new Set(rows.map((h) => h.holiday_date))
  }
  return { hoursPerDay: profile?.standard_hours_per_day ?? null, region, holidays }
}
