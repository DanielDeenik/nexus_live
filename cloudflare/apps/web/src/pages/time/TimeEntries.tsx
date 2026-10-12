import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { Chip, ErrorNote, Field, PageHeader, Pager, btnGhost, btnIcon, btnPrimary, input, td, th } from '../../components/time/ui'
import { today } from '../../lib/period'
import {
  type Activity, CATEGORIES, type Category, type EntryFilter, type EntryInput, type Project, SOURCES, type TimeEntry,
  createEntry, deleteEntry, fromRelay, hoursLabel, listEntries, listNamed, listProjects, updateEntry,
} from '../../lib/time'

const PER_PAGE = 50
const FILTER_KEYS = ['from', 'to', 'project', 'activity', 'category', 'source'] as const

function EntryForm({ projects, activities, editing, onDone, onCancel }: {
  projects: Project[]
  activities: Activity[]
  editing: TimeEntry | null
  onDone: () => void
  onCancel: () => void
}) {
  const [date, setDate] = useState(editing?.entry_date ?? today())
  const [project, setProject] = useState(editing?.project_id ?? '')
  const [activity, setActivity] = useState(editing?.activity_id ?? '')
  const [hours, setHours] = useState(editing ? String(editing.minutes / 60) : '')
  const [category, setCategory] = useState<string>(editing?.category ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Archived projects are hidden when logging, but an edited row keeps its own.
  const choices = projects.filter((p) => !p.archived_at || p.id === editing?.project_id)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const h = Number(hours)
    if (!(h > 0 && h <= 24)) { setErr('Hours must be between 0 and 24.'); return }
    setBusy(true); setErr('')
    const body: EntryInput = {
      entry_date: date,
      project_id: project,
      activity_id: activity || null,
      minutes: Math.round(h * 60),
      category: (category || null) as Category | null,
      description: description.trim() || null,
    }
    try {
      if (editing) await updateEntry(editing.id, body)
      else await createEntry(body)
      onDone()
    } catch (x) { setErr((x as Error).message) } finally { setBusy(false) }
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-6">
        <Field label="Date"><input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className={`${input} w-full`} /></Field>
        <Field label="Hours"><input type="number" required step="0.25" min="0.25" max="24" value={hours} onChange={(e) => setHours(e.target.value)} className={`${input} w-full`} /></Field>
        <Field label="Project" className="col-span-2">
          <select required value={project} onChange={(e) => setProject(e.target.value)} className={`${input} w-full`}>
            <option value="">Choose a project</option>
            {choices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Activity">
          <select value={activity} onChange={(e) => setActivity(e.target.value)} className={`${input} w-full`}>
            <option value="">None</option>
            {activities.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Category">
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={`${input} w-full`}>
            <option value="">None</option>
            {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Description">
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={`${input} w-full`} />
      </Field>
      <ErrorNote message={err} />
      <div className="flex gap-2">
        <button disabled={busy} className={btnPrimary}>{editing ? 'Save changes' : 'Log time'}</button>
        <button type="button" onClick={onCancel} className={btnGhost}>Cancel</button>
      </div>
    </form>
  )
}

export function TimeEntries() {
  const [params, setParams] = useSearchParams()
  const filter: EntryFilter = useMemo(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? undefined])), [params])
  const page = Math.max(1, Number(params.get('page') ?? 1))

  const [projects, setProjects] = useState<Project[]>([])
  const [activities, setActivities] = useState<Activity[]>([])
  const [data, setData] = useState<{ rows: TimeEntry[]; total: number } | null>(null)
  const [form, setForm] = useState<{ editing: TimeEntry | null } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([listProjects(), listNamed('dt_activities')])
      .then(([p, a]) => { setProjects(p); setActivities(a) })
      .catch((e) => setError((e as Error).message))
  }, [])

  const load = useCallback(() => {
    setError('')
    listEntries(filter, page, PER_PAGE).then(setData).catch((e) => setError((e as Error).message))
  }, [filter, page])
  useEffect(() => { load() }, [load])

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value); else next.delete(key)
    next.delete('page')
    setParams(next)
  }
  const setPage = (p: number) => { const next = new URLSearchParams(params); next.set('page', String(p)); setParams(next) }
  const clear = () => setParams(new URLSearchParams())
  const anyFilter = FILTER_KEYS.some((k) => params.get(k))

  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])
  const activityName = useMemo(() => new Map(activities.map((a) => [a.id, a.name])), [activities])
  const sourceName = (s: string) => SOURCES.find((x) => x.id === s)?.name ?? s

  const remove = async (row: TimeEntry) => {
    if (!window.confirm(`Delete ${hoursLabel(row.minutes / 60)} on ${row.entry_date}?`)) return
    try { await deleteEntry(row.id); load() } catch (e) { setError((e as Error).message) }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Time entries"
        subtitle="Rows from Relay are changed in Relay."
        action={!form && <button onClick={() => setForm({ editing: null })} className={btnPrimary}><Plus size={14} /> Log time</button>}
      />

      {form && (
        <Card className="p-4 sm:p-6">
          <h3 className="text-lg font-semibold text-slate-50 mb-3">{form.editing ? 'Edit time' : 'Log time'}</h3>
          <EntryForm
            key={form.editing?.id ?? 'new'}
            projects={projects}
            activities={activities}
            editing={form.editing}
            onDone={() => { setForm(null); load() }}
            onCancel={() => setForm(null)}
          />
        </Card>
      )}

      <Card className="p-4 sm:p-6">
        <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6 mb-4">
          <Field label="From"><input type="date" value={filter.from ?? ''} onChange={(e) => setFilter('from', e.target.value)} className={`${input} w-full`} /></Field>
          <Field label="To"><input type="date" value={filter.to ?? ''} onChange={(e) => setFilter('to', e.target.value)} className={`${input} w-full`} /></Field>
          <Field label="Project">
            <select value={filter.project ?? ''} onChange={(e) => setFilter('project', e.target.value)} className={`${input} w-full`}>
              <option value="">All</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Activity">
            <select value={filter.activity ?? ''} onChange={(e) => setFilter('activity', e.target.value)} className={`${input} w-full`}>
              <option value="">All</option>
              {activities.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Category">
            <select value={filter.category ?? ''} onChange={(e) => setFilter('category', e.target.value)} className={`${input} w-full`}>
              <option value="">All</option>
              {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Source">
            <select value={filter.source ?? ''} onChange={(e) => setFilter('source', e.target.value)} className={`${input} w-full`}>
              <option value="">All</option>
              {SOURCES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        </div>
        {anyFilter && <button onClick={clear} className="mb-3 text-xs text-slate-400 hover:text-slate-200 inline-flex items-center gap-1"><X size={12} /> Clear filters</button>}
        <ErrorNote message={error} />

        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-400 border-b border-slate-700/50">
              <tr>
                <th className={th}>Date</th><th className={`${th} text-right`}>Hours</th><th className={th}>Project</th><th className={th}>Activity</th>
                <th className={th}>Category</th><th className={th}>Description</th>
                <th className={th}>Source</th><th className={th}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="text-slate-200">
              {data?.rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-800/60">
                  <td className={`${td} whitespace-nowrap tabular-nums`}>{r.entry_date}</td>
                  <td className={`${td} text-right tabular-nums whitespace-nowrap`}>{hoursLabel(r.minutes / 60)}</td>
                  <td className={`${td} min-w-[8rem]`}>{projectName.get(r.project_id) ?? '-'}</td>
                  <td className={`${td} min-w-[7rem] text-slate-300`}>{r.activity_id ? activityName.get(r.activity_id) ?? '-' : '-'}</td>
                  <td className={`${td} text-slate-300`}>{r.category ?? '-'}</td>
                  <td className={`${td} text-slate-300 min-w-[10rem]`}>{r.description ?? ''}</td>
                  <td className={`${td} whitespace-nowrap text-slate-400`}>{sourceName(r.source)}</td>
                  <td className={`${td} whitespace-nowrap text-right`}>
                    {fromRelay(r) ? <Chip>from Relay</Chip> : (
                      <span className="inline-flex gap-1">
                        <button className={btnIcon} onClick={() => { setForm({ editing: r }); document.querySelector('main')?.scrollTo({ top: 0 }) }} aria-label="Edit"><Pencil size={15} /></button>
                        <button className={`${btnIcon} hover:text-danger-400`} onClick={() => remove(r)} aria-label="Delete"><Trash2 size={15} /></button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {data && data.rows.length === 0 && <tr><td className={`${td} text-slate-400`} colSpan={8}>No time entries{anyFilter ? ' match these filters' : ' yet'}.</td></tr>}
              {!data && !error && <tr><td className={`${td} text-slate-400`} colSpan={8}>Loading.</td></tr>}
            </tbody>
          </table>
        </div>
        {data && <Pager page={page} perPage={PER_PAGE} total={data.total} onPage={setPage} />}
        {data && data.rows.length > 0 && (
          <p className="mt-1 text-xs text-slate-400">This page: {hoursLabel(data.rows.reduce((s, r) => s + r.minutes, 0) / 60)}</p>
        )}
      </Card>
    </div>
  )
}
