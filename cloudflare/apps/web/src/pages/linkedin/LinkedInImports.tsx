import { useCallback, useEffect, useState } from 'react'
import { Card, CardHeader } from '../../components/ui/Card'
import { ErrorNote, PageHeader, td, th } from '../../components/time/ui'
import { ImportCard, ImportChip } from '../../components/linkedin/bits'
import { type ImportRow, countsText, listImports, shortDay } from '../../lib/linkedin'
import { when } from '../../lib/recruiter'

export function LinkedInImports() {
  const [rows, setRows] = useState<ImportRow[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setError('')
    listImports().then(setRows).catch((e) => setError((e as Error).message))
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-6">
      <PageHeader title="LinkedIn imports" subtitle="Every file imported, what it held and how it went." />
      <ImportCard onDone={load} />
      <ErrorNote message={error} />
      <Card className="p-4 sm:p-6">
        <CardHeader title="History" subtitle="Newest first; a file imported again updates its row" />
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-400 border-b border-slate-700/50">
              <tr><th className={th}>Imported</th><th className={th}>Kind</th><th className={th}>Status</th><th className={th}>Covers</th><th className={th}>File</th><th className={th}>Result</th></tr>
            </thead>
            <tbody className="text-slate-200">
              {rows?.map((r) => (
                <tr key={r.id} className="border-b border-slate-800/60">
                  <td className={`${td} whitespace-nowrap tabular-nums`}>{when(r.imported_at)}</td>
                  <td className={`${td} whitespace-nowrap`}>{r.kind}</td>
                  <td className={td}><ImportChip status={r.status} /></td>
                  <td className={`${td} whitespace-nowrap tabular-nums`}>{r.period_from || r.period_to ? `${shortDay(r.period_from)} to ${shortDay(r.period_to)}` : '-'}</td>
                  <td className={`${td} max-w-[14rem] truncate`} title={r.path}>{r.path.split('/').pop()?.replace(/^\d+_/, '')}</td>
                  <td className={`${td} min-w-[16rem] break-words text-slate-300`}>
                    {r.error ? <span className="text-danger-300">{r.error}</span> : countsText(r.counts)}
                    {(r.warnings ?? []).map((w) => <div key={w} className="text-xs text-warning-300">{w}</div>)}
                  </td>
                </tr>
              ))}
              {rows && rows.length === 0 && <tr><td className={`${td} text-slate-400`} colSpan={6}>Nothing imported yet.</td></tr>}
              {!rows && !error && <tr><td className={`${td} text-slate-400`} colSpan={6}>Loading.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
