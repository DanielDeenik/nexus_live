import { supabase } from './supabase'
import { callNexus } from './nexus'

// Typed data access for the recruiter agent. Tables are select only for the
// owner under RLS; every change goes through the nexus Edge Function.

export type SubmissionKind = 'spec' | 'question' | 'call'
export type SubmissionStatus = 'new' | 'drafted' | 'no_match' | 'scheduled' | 'failed' | 'skipped'
export type RoleTier = 'HOT' | 'WARM' | 'MONITOR' | 'COLD'
export type RoleStatus = 'new' | 'shortlisted' | 'dismissed' | 'applied'

export interface Submission {
  id: string
  gmail_message_id: string | null
  received_at: string
  kind: SubmissionKind
  name: string | null
  email: string | null
  company: string | null
  role: string | null
  call_preference: string | null
  question: string | null
  spec: string | null
  status: SubmissionStatus
  outcome: { drafts?: { to: string; subject: string; id: string }[]; call_at?: string | null; score?: number | null; answer?: string | null } | null
  gmail_draft_id: string | null
  calendar_event_id: string | null
  error: string | null
  handled_at: string | null
  agent_run_id: string | null
}

export interface Requirement {
  text: string
  must_have: boolean
  area_id: string | null
  area_label: string | null
  tier: string | null
  tier_weight: number | null
  importance: number | null
  line: number | null
}

export interface FitReport {
  id: string
  submission_id: string | null
  role_title: string | null
  company: string | null
  score: number
  verdict: string | null
  is_match: boolean
  centre_of_gravity: string | null
  requirements: Requirement[] | null
  gaps: Requirement[] | null
  report: string | null
  created_at: string
}

export interface Application {
  id: string
  submission_id: string | null
  fit_report_id: string | null
  role_title: string | null
  company: string | null
  recipient_email: string | null
  cv_markdown: string | null
  cover_letter: string | null
  cv_path: string | null
  gmail_draft_id: string | null
  status: 'drafted' | 'sent' | 'withdrawn'
  created_at: string
}

export interface Role {
  id: string
  title: string
  company: string | null
  link: string | null
  posted_at: string | null
  snippet: string | null
  score: number
  tier: RoleTier
  matched: { keyword: string; pts: number; tier: string }[] | null
  source_ids: string[] | null
  status: RoleStatus
  first_seen_at: string
  last_seen_at: string
}

export interface AgentRun {
  id: string
  agent_id: string
  trigger: string | null
  status: string
  started_at: string
  finished_at: string | null
  steps: { name: string; ok: boolean; ms: number; error?: string }[] | null
  metrics: Record<string, unknown> | null
  error_message: string | null
}

export const TIERS: RoleTier[] = ['HOT', 'WARM', 'MONITOR', 'COLD']
export const ROLE_STATUSES: RoleStatus[] = ['new', 'shortlisted', 'dismissed', 'applied']

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return (res.data ?? []) as T
}

export async function listSubmissions(limit = 200): Promise<Submission[]> {
  return check(await supabase.from('rec_submissions').select('*').order('received_at', { ascending: false }).limit(limit)) as Submission[]
}

export async function countSubmissionsSince(since: string): Promise<number> {
  const res = await supabase.from('rec_submissions').select('id', { count: 'exact', head: true }).gte('received_at', since)
  if (res.error) throw new Error(res.error.message)
  return res.count ?? 0
}

export async function listFitReports(limit = 100): Promise<FitReport[]> {
  const rows = check(await supabase.from('rec_fit_reports').select('*').order('created_at', { ascending: false }).limit(limit)) as FitReport[]
  return rows.map((r) => ({ ...r, score: Number(r.score) }))
}

export async function listApplications(): Promise<Application[]> {
  return check(await supabase.from('rec_applications').select('*').order('created_at', { ascending: false })) as Application[]
}

export async function listRoles(f: { tier?: string; status?: string; minScore?: number } = {}): Promise<Role[]> {
  let q = supabase.from('rec_roles').select('*')
  if (f.tier) q = q.eq('tier', f.tier)
  if (f.status) q = q.eq('status', f.status)
  if (f.minScore != null && !Number.isNaN(f.minScore)) q = q.gte('score', f.minScore)
  const rows = check(await q.order('score', { ascending: false }).order('last_seen_at', { ascending: false }).limit(500)) as Role[]
  return rows.map((r) => ({ ...r, score: Number(r.score) }))
}

/** Latest run of an agent, or null when it never ran. */
export async function latestRun(agentId: 'recruiter' | 'role_monitor'): Promise<AgentRun | null> {
  const rows = check(await supabase.from('agent_runs').select('*').eq('agent_id', agentId).order('started_at', { ascending: false }).limit(1)) as AgentRun[]
  return rows[0] ?? null
}

/** Signed link to a CV in the private recruiter bucket, valid for a minute. */
export async function cvUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from('recruiter').createSignedUrl(path, 60)
  if (error || !data) throw new Error(error?.message ?? 'No link for this CV')
  return data.signedUrl
}

// ---- actions through the Edge Function -------------------------------------

export const runIntake = () => callNexus<{ results: { run_id: string; metrics: Record<string, unknown> }[] }>('recruiter', { mode: 'intake' })
export const scanRoles = () => callNexus<{ results?: { run_id: string; metrics: Record<string, unknown> }[] } & Record<string, unknown>>('recruiter', { mode: 'roles' })
export const assessSpec = (spec: string, role?: string, company?: string) =>
  callNexus<{ fit_report_id: string; score: number; is_match: boolean; verdict: string; report: string }>('recruiter', {
    mode: 'assess', spec, ...(role ? { role } : {}), ...(company ? { company } : {}),
  })
export const setRoleStatus = (role_id: string, status: RoleStatus) => callNexus('recruiter', { mode: 'role_status', role_id, status })

/** Short plain text for a metrics object returned by a run. */
export function metricsText(m: Record<string, unknown> | null | undefined): string {
  if (!m) return ''
  return Object.entries(m).filter(([, v]) => typeof v === 'number' || typeof v === 'string').map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ')
}

export const when = (s: string | null | undefined) => (s ? new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-')
export const day = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '-')
