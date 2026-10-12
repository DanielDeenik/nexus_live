import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { PageHeader } from '../components/time/ui'
import { AgentsSection } from './settings/AgentsSection'
import { DevicesSection } from './settings/DevicesSection'

const SECTIONS = [
  { id: 'agents', label: 'Agents' },
  { id: 'devices', label: 'Devices' },
]

// One place for settings: the agents (calendar, Google, Wise) and the devices
// that push time from Relay. The old /agent-settings and /time/devices
// addresses redirect here.
export function Settings() {
  const { hash } = useLocation()
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView()
  }, [hash])

  return (
    <div className="space-y-8 max-w-4xl">
      <PageHeader
        title="Settings"
        subtitle="Agents and connected devices."
        action={
          <nav className="flex gap-2" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth' }) }}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">{s.label}</a>
            ))}
          </nav>
        }
      />
      <AgentsSection />
      <div className="border-t border-slate-700/50" />
      <DevicesSection />
    </div>
  )
}
