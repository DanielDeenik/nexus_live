import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Card, CardHeader } from '../../components/ui/Card'
import { Chip, ErrorNote, Field, PageHeader, btnGhost, btnIcon, btnPrimary, input, td, th } from '../../components/time/ui'
import {
  type Area, type NamedRow, type Project, type ProjectInput,
  deleteNamed, listNamed, listProjects, saveNamed, saveProject,
} from '../../lib/time'

const empty: ProjectInput = {
  name: '', aow_id: null, client: null, billable: false, relay_key: null,
  start_date: null, end_date: null, description: null, archived_at: null,
}

function ProjectForm({ areas, editing, onDone, onCancel }: { areas: Area[]; editing: Project | null; onDone: () => void; onCancel: () => void }) {
  const [p, setP] = useState<ProjectInput>(() => {
    if (!editing) return empty
    const { needs_mapping: _skip, ...rest } = editing
    return rest
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = <K extends keyof ProjectInput>(k: K, v: ProjectInput[K]) => setP((x) => ({ ...x, [k]: v }))
  const text = (v: string) => (v.trim() ? v.trim() : null)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr('')
    try { await saveProject({ ...p, name: p.name.trim() }); onDone() } catch (x) { setErr((x as Error).message) } finally { setBusy(false) }
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name" className="sm:col-span-2"><input required value={p.name} onChange={(e) => set('name', e.target.value)} className={`${input} w-full`} /></Field>
        <Field label="Area of work">
          <select required value={p.aow_id ?? ''} onChange={(e) => set('aow_id', e.target.value || null)} className={`${input} w-full`}>
            <option value="">Choose an area</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Client"><input value={p.client ?? ''} onChange={(e) => set('client', text(e.target.value))} className={`${input} w-full`} /></Field>
        <Field label="Relay project"><input value={p.relay_key ?? ''} onChange={(e) => set('relay_key', text(e.target.value))} placeholder="Relay folder name" className={`${input} w-full`} /></Field>
        <Field label="Start date"><input type="date" value={p.start_date ?? ''} onChange={(e) => set('start_date', e.target.value || null)} className={`${input} w-full`} /></Field>
        <Field label="End date"><input type="date" value={p.end_date ?? ''} onChange={(e) => set('end_date', e.target.value || null)} className={`${input} w-full`} /></Field>
        <Field label="Archived on"><input type="date" value={p.archived_at?.slice(0, 10) ?? ''} onChange={(e) => set('archived_at', e.target.value || null)} className={`${input} w-full`} /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={p.billable} onChange={(e) => set('billable', e.target.checked)} className="rounded bg-card border-line text-lemon-ink" />
        Billable <span className="text-xs text-muted">(compared with what you invoiced)</span>
      </label>
      <Field label="Description"><textarea rows={2} value={p.description ?? ''} onChange={(e) => set('description', text(e.target.value))} className={`${input} w-full`} /></Field>
      <ErrorNote message={err} />
      <div className="flex gap-2">
        <button disabled={busy} className={btnPrimary}>{editing ? 'Save' : 'Add project'}</button>
        <button type="button" onClick={onCancel} className={btnGhost}>Cancel</button>
      </div>
    </form>
  )
}

/** A short named list (areas of work or activities) with add, rename and delete. */
function NamedPanel({ title, table, rows, onChange }: { title: string; table: 'dt_areas_of_work' | 'dt_activities'; rows: NamedRow[]; onChange: () => void }) {
  const [editId, setEditId] = useState<string | null>(null)
  const [draft, setDraft] = useState({ name: '', description: '' })
  const [adding, setAdding] = useState({ name: '', description: '' })
  const [err, setErr] = useState('')

  const run = async (fn: () => Promise<void>) => {
    setErr('')
    try { await fn(); onChange() } catch (x) { setErr((x as Error).message) }
  }

  return (
    <Card className="p-4 sm:p-6 min-w-0">
      <CardHeader title={title} />
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.id} className="py-2">
            {editId === r.id ? (
              <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); run(async () => { await saveNamed(table, { id: r.id, name: draft.name, description: draft.description }); setEditId(null) }) }}>
                <input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={`${input} w-full`} aria-label="Name" />
                <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Description" className={`${input} w-full`} aria-label="Description" />
                <div className="flex gap-1">
                  <button className={btnIcon} aria-label="Save"><Check size={16} /></button>
                  <button type="button" className={btnIcon} onClick={() => setEditId(null)} aria-label="Cancel"><X size={16} /></button>
                </div>
              </form>
            ) : (
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-ink break-words">{r.name}</p>
                  {r.description && <p className="text-xs text-muted break-words">{r.description}</p>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button className={btnIcon} onClick={() => { setEditId(r.id); setDraft({ name: r.name, description: r.description ?? '' }) }} aria-label={`Rename ${r.name}`}><Pencil size={15} /></button>
                  <button className={`${btnIcon} hover:text-bad`} onClick={() => window.confirm(`Delete ${r.name}?`) && run(() => deleteNamed(table, r.id))} aria-label={`Delete ${r.name}`}><Trash2 size={15} /></button>
                </div>
              </div>
            )}
          </li>
        ))}
        {rows.length === 0 && <li className="py-2 text-sm text-muted">None yet.</li>}
      </ul>
      <form
        className="mt-3 grid gap-2 grid-cols-1 sm:grid-cols-[1fr_1fr_auto]"
        onSubmit={(e) => { e.preventDefault(); run(async () => { await saveNamed(table, adding); setAdding({ name: '', description: '' }) }) }}
      >
        <input required value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="Name" className={`${input} w-full min-w-0`} aria-label="New name" />
        <input value={adding.description} onChange={(e) => setAdding({ ...adding, description: e.target.value })} placeholder="Description" className={`${input} w-full min-w-0`} aria-label="New description" />
        <button className={btnGhost}><Plus size={14} /> Add</button>
      </form>
      <div className="mt-2"><ErrorNote message={err} /></div>
    </Card>
  )
}

export function TimeProjects() {
  const [params, setParams] = useSearchParams()
  const onlyUnmapped = params.get('needs_mapping') === '1'
  const areaFilter = params.get('area') ?? ''
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [areas, setAreas] = useState<Area[]>([])
  const [activities, setActivities] = useState<NamedRow[]>([])
  const [form, setForm] = useState<{ editing: Project | null } | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setError('')
    Promise.all([listProjects(), listNamed('dt_areas_of_work'), listNamed('dt_activities')])
      .then(([p, a, c]) => { setProjects(p); setAreas(a); setActivities(c) })
      .catch((e) => setError((e as Error).message))
  }, [])
  useEffect(() => { load() }, [load])

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v); else next.delete(k)
    setParams(next)
  }

  const edit = (p: Project) => { setForm({ editing: p }); document.querySelector('main')?.scrollTo({ top: 0 }) }
  const areaName = useMemo(() => new Map(areas.map((a) => [a.id, a.name])), [areas])
  const shown = (projects ?? []).filter((p) => (!onlyUnmapped || p.needs_mapping) && (!areaFilter || p.aow_id === areaFilter))
  const unmappedCount = (projects ?? []).filter((p) => p.needs_mapping).length

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        subtitle="Saving a project confirms its area, so it leaves the needs mapping list."
        action={!form && <button onClick={() => setForm({ editing: null })} className={btnPrimary}><Plus size={14} /> New project</button>}
      />
      <ErrorNote message={error} />

      {form && (
        <Card className="p-4 sm:p-6">
          <h3 className="text-lg font-semibold text-ink mb-3">{form.editing ? `Edit ${form.editing.name}` : 'New project'}</h3>
          <ProjectForm key={form.editing?.id ?? 'new'} areas={areas} editing={form.editing} onDone={() => { setForm(null); load() }} onCancel={() => setForm(null)} />
        </Card>
      )}

      <Card className="p-4 sm:p-6">
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <Field label="Area of work">
            <select value={areaFilter} onChange={(e) => setParam('area', e.target.value)} className={input}>
              <option value="">All</option>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink pb-2">
            <input type="checkbox" checked={onlyUnmapped} onChange={(e) => setParam('needs_mapping', e.target.checked ? '1' : '')} className="rounded bg-card border-line text-lemon-ink" />
            Needs mapping only {unmappedCount > 0 && <Chip tone="warn">{unmappedCount}</Chip>}
          </label>
        </div>
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted border-b border-line">
              <tr>
                <th className={th}>Name</th><th className={th}>Area</th><th className={th}>Client</th><th className={th}>Billable</th>
                <th className={th}>Relay project</th><th className={th}><span className="sr-only">Edit</span></th>
              </tr>
            </thead>
            <tbody className="text-ink">
              {shown.map((p) => (
                <tr key={p.id} className="border-b border-line">
                  <td className={`${td} min-w-[9rem]`}>
                    <button onClick={() => edit(p)} className="text-left hover:text-ink">{p.name}</button>
                    {p.needs_mapping ? <div className="mt-1"><Chip tone="warn">Needs mapping</Chip></div> : p.archived_at ? <div className="mt-1"><Chip>Archived</Chip></div> : null}
                  </td>
                  <td className={`${td} whitespace-nowrap text-body`}>{p.aow_id ? areaName.get(p.aow_id) ?? '-' : '-'}</td>
                  <td className={`${td} whitespace-nowrap text-body`}>{p.client ?? '-'}</td>
                  <td className={td}>{p.billable ? <span className="text-good">Yes</span> : <span className="text-muted">No</span>}</td>
                  <td className={`${td} font-mono text-xs text-body whitespace-nowrap`}>{p.relay_key ?? '-'}</td>
                  <td className={`${td} text-right`}>
                    <button className={btnIcon} onClick={() => edit(p)} aria-label={`Edit ${p.name}`}><Pencil size={15} /></button>
                  </td>
                </tr>
              ))}
              {projects && shown.length === 0 && <tr><td className={`${td} text-muted`} colSpan={6}>No projects{onlyUnmapped || areaFilter ? ' match' : ' yet'}.</td></tr>}
              {!projects && !error && <tr><td className={`${td} text-muted`} colSpan={6}>Loading.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <NamedPanel title="Areas of work" table="dt_areas_of_work" rows={areas} onChange={load} />
        <NamedPanel title="Activities" table="dt_activities" rows={activities} onChange={load} />
      </div>
    </div>
  )
}
