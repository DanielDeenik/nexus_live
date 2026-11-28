import { Chip } from '../time/ui'
import type { RoleStatus, RoleTier, SubmissionStatus } from '../../lib/recruiter'

// Small display pieces shared by the recruiter pages.

const SUBMISSION_TONE: Record<SubmissionStatus, 'muted' | 'warn' | 'info' | 'good' | 'bad'> = {
  new: 'info', drafted: 'good', scheduled: 'good', no_match: 'muted', skipped: 'muted', failed: 'bad',
}
export const SubmissionChip = ({ status }: { status: SubmissionStatus }) => <Chip tone={SUBMISSION_TONE[status] ?? 'muted'}>{status.replace(/_/g, ' ')}</Chip>

const TIER_TONE: Record<RoleTier, 'muted' | 'warn' | 'info' | 'good' | 'bad'> = { HOT: 'bad', WARM: 'warn', MONITOR: 'info', COLD: 'muted' }
export const TierChip = ({ tier }: { tier: RoleTier }) => <Chip tone={TIER_TONE[tier] ?? 'muted'}>{tier}</Chip>

const ROLE_TONE: Record<RoleStatus, 'muted' | 'warn' | 'info' | 'good' | 'bad'> = { new: 'info', shortlisted: 'warn', applied: 'good', dismissed: 'muted' }
export const RoleStatusChip = ({ status }: { status: RoleStatus }) => <Chip tone={ROLE_TONE[status] ?? 'muted'}>{status}</Chip>

const APP_TONE: Record<string, 'muted' | 'warn' | 'info' | 'good' | 'bad'> = { drafted: 'info', sent: 'good', withdrawn: 'muted' }
export const ApplicationChip = ({ status }: { status: string }) => <Chip tone={APP_TONE[status] ?? 'muted'}>{status}</Chip>

/** Score 0 to 100 as a bar with the number. */
export function ScoreBar({ score, match }: { score: number | null | undefined; match?: boolean }) {
  if (score == null) return <span className="text-muted">-</span>
  const pct = Math.max(0, Math.min(100, score))
  return (
    <div className="flex items-center gap-2 min-w-[7rem]">
      <div className="h-2 flex-1 rounded-full bg-chip overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full ${match === false ? 'bg-chip' : 'bg-ink'}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-sm text-ink w-8 text-right">{Math.round(pct)}</span>
    </div>
  )
}

/** Long text such as a CV or report, kept as written. */
export function Prose({ text }: { text: string | null | undefined }) {
  if (!text) return <p className="text-sm text-muted">Empty.</p>
  return <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink rounded-lg bg-paper border border-line p-3 max-h-[28rem] overflow-y-auto">{text}</pre>
}
