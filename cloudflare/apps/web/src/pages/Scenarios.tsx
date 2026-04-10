import { useState } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import { Plus, Trash2 } from 'lucide-react'
import { Card, CardHeader, CardContent, CardFooter } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { useQuery, useMutation } from '../hooks/useApi'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { formatCurrency } from '../lib/format'

interface Scenario {
  id: string
  name: string
  hourlyRate: number
  hoursPerWeek: number
  workDaysPerMonth: number
  baseCurrency: string
  startDate: string
  projectedRevenue: number
  taxBreakdown: {
    incomeTax: number
    socialSecurity: number
    vat: number
  }
}

interface ScenarioResponse {
  scenarios: Scenario[]
  cashflowData: Array<{ month: string; revenue: number }>
}

export function Scenarios() {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [scenarioName, setScenarioName] = useState('')
  const [hourlyRate, setHourlyRate] = useState('')
  const [hoursPerWeek, setHoursPerWeek] = useState('40')
  const [workDaysPerMonth, setWorkDaysPerMonth] = useState('20')
  const [baseCurrency, setBaseCurrency] = useState('EUR')
  const [selectedScenarios, setSelectedScenarios] = useState<string[]>([])

  const { data, isLoading, refetch } = useQuery<ScenarioResponse>(
    '/v1/finance/scenarios',
    { refetchInterval: 60000 }
  )

  const { mutate: createScenario, isLoading: isCreating } = useMutation<
    Scenario,
    Partial<Scenario>
  >('/v1/finance/scenarios', 'POST')

  const { mutate: deleteScenario } = useMutation<void, void>(
    '/v1/finance/scenarios/{id}',
    'DELETE'
  )

  const handleCreateScenario = async () => {
    if (!scenarioName || !hourlyRate) return

    try {
      await createScenario({
        name: scenarioName,
        hourlyRate: Number(hourlyRate),
        hoursPerWeek: Number(hoursPerWeek),
        workDaysPerMonth: Number(workDaysPerMonth),
        baseCurrency,
        startDate: new Date().toISOString(),
      })
      setScenarioName('')
      setHourlyRate('')
      setIsCreateModalOpen(false)
      refetch()
    } catch (error) {
      console.error('Failed to create scenario', error)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <LoadingSpinner text="Loading scenarios..." />
      </div>
    )
  }

  if (!data) {
    return null
  }

  const scenarioCards = data.scenarios.slice(0, 3)

  return (
    <div className="space-y-6">
      {/* Create New Scenario */}
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-slate-50">Scenario Planner</h2>
        <Button
          variant="primary"
          onClick={() => setIsCreateModalOpen(true)}
        >
          <Plus size={16} />
          New Scenario
        </Button>
      </div>

      {/* Scenario Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {scenarioCards.map((scenario) => (
          <Card key={scenario.id}>
            <CardHeader
              title={scenario.name}
              subtitle={`${formatCurrency(scenario.projectedRevenue)} projected`}
            />
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-400">Hourly Rate</span>
                <span className="text-slate-50 font-mono-num">
                  {formatCurrency(scenario.hourlyRate, scenario.baseCurrency)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Hours/Week</span>
                <span className="text-slate-50 font-mono-num">
                  {scenario.hoursPerWeek}h
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Days/Month</span>
                <span className="text-slate-50 font-mono-num">
                  {scenario.workDaysPerMonth}d
                </span>
              </div>

              <div className="pt-3 border-t border-slate-700/50">
                <p className="text-xs text-slate-400 mb-2 font-medium">
                  Tax Breakdown
                </p>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">Income Tax</span>
                    <span className="text-red-400">
                      {formatCurrency(scenario.taxBreakdown.incomeTax)}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">Social Security</span>
                    <span className="text-red-400">
                      {formatCurrency(scenario.taxBreakdown.socialSecurity)}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">VAT</span>
                    <span className="text-red-400">
                      {formatCurrency(scenario.taxBreakdown.vat)}
                    </span>
                  </div>
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedScenarios([...selectedScenarios, scenario.id])}
              >
                Compare
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => deleteScenario()}
              >
                <Trash2 size={14} />
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>

      {/* Cashflow Chart */}
      {data.cashflowData.length > 0 && (
        <Card>
          <CardHeader
            title="Revenue Projection"
            subtitle="12-month cashflow forecast"
          />
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={data.cashflowData}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="rgba(51, 65, 85, 0.3)"
                />
                <XAxis
                  dataKey="month"
                  stroke="rgba(148, 163, 184, 0.5)"
                  style={{ fontSize: '12px' }}
                />
                <YAxis
                  stroke="rgba(148, 163, 184, 0.5)"
                  style={{ fontSize: '12px' }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                    border: '1px solid rgba(51, 65, 85, 0.5)',
                    borderRadius: '8px',
                  }}
                  labelStyle={{ color: '#94a3b8' }}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="revenue"
                  stroke="#06b6d4"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Create Scenario Modal */}
      <Modal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        title="Create New Scenario"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setIsCreateModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreateScenario}
              isLoading={isCreating}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Scenario Name
            </label>
            <input
              type="text"
              value={scenarioName}
              onChange={(e) => setScenarioName(e.target.value)}
              placeholder="e.g., Conservative Growth"
              className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-colors"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Hourly Rate
              </label>
              <input
                type="number"
                value={hourlyRate}
                onChange={(e) => setHourlyRate(e.target.value)}
                placeholder="50"
                className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-colors font-mono-num"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Hours/Week
              </label>
              <input
                type="number"
                value={hoursPerWeek}
                onChange={(e) => setHoursPerWeek(e.target.value)}
                placeholder="40"
                className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-colors font-mono-num"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Work Days/Month
            </label>
            <input
              type="number"
              value={workDaysPerMonth}
              onChange={(e) => setWorkDaysPerMonth(e.target.value)}
              placeholder="20"
              className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-colors font-mono-num"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Base Currency
            </label>
            <select
              value={baseCurrency}
              onChange={(e) => setBaseCurrency(e.target.value)}
              className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 focus:outline-none focus:border-cyan-500/50 transition-colors"
            >
              <option value="EUR">EUR (€)</option>
              <option value="USD">USD ($)</option>
              <option value="GBP">GBP (£)</option>
              <option value="CHF">CHF (CHF)</option>
            </select>
          </div>
        </div>
      </Modal>
    </div>
  )
}
