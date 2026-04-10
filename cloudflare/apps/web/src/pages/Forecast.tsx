import { useState } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Card, CardHeader, CardContent } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { useQuery, useMutation } from '../hooks/useApi'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { EmptyState } from '../components/ui/EmptyState'

interface ForecastData {
  date: string
  actual: number
  forecast: number
  upper: number
  lower: number
}

interface ForecastResponse {
  data: ForecastData[]
  horizon: number
  rSquared: number
  trend: 'up' | 'down' | 'stable'
  anomalies: Array<{ date: string; description: string }>
}

interface CommitmentForecastResponse {
  overlay: {
    weightedTotal: number
    byStage: Record<string, number>
  }
}

export function Forecast() {
  const [horizon, setHorizon] = useState(12)
  const { data, isLoading, error, refetch } = useQuery<ForecastResponse>(
    `/v1/finance/forecast?horizon=${horizon}`,
    { staleTime: 60000 }
  )

  const { data: commitmentForecast } = useQuery<CommitmentForecastResponse>(
    '/v1/commitments/pacing/forecast',
    { staleTime: 60000 }
  )

  const { mutate: recompute, isLoading: isRecomputing } = useMutation<
    ForecastResponse,
    { horizon: number }
  >('/v1/finance/forecast', 'POST')

  const handleRecompute = async () => {
    try {
      await recompute({ horizon })
      refetch()
    } catch (error) {
      console.error('Failed to recompute forecast', error)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <LoadingSpinner text="Loading forecast..." />
      </div>
    )
  }

  if (error) {
    return (
      <EmptyState
        icon={<AlertTriangle size={48} />}
        title="Failed to load forecast"
        description={error.message}
      />
    )
  }

  if (!data) {
    return (
      <EmptyState
        icon={<AlertTriangle size={48} />}
        title="No forecast data"
        description="Try adjusting the horizon or contacting support"
      />
    )
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <Card>
        <CardHeader title="Forecast Controls" />
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-2">
                Forecast Horizon (months)
              </label>
              <input
                type="range"
                min="3"
                max="24"
                value={horizon}
                onChange={(e) => setHorizon(Number(e.target.value))}
                className="w-full h-2 bg-slate-700/50 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
              <div className="text-sm text-slate-300 mt-2">
                {horizon} months
              </div>
            </div>

            <div className="flex flex-col justify-end">
              <Button
                variant="primary"
                onClick={handleRecompute}
                isLoading={isRecomputing}
                className="w-full"
              >
                <RotateCcw size={16} />
                Recompute
              </Button>
            </div>

            <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50 space-y-2">
              <div className="text-xs font-medium text-slate-400">
                Model Quality
              </div>
              <div className="text-2xl font-bold font-mono-num text-cyan-400">
                {(data.rSquared * 100).toFixed(1)}%
              </div>
              <div className="text-xs text-slate-500">R² Score</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Commitment-weighted revenue overlay */}
      {commitmentForecast && (
        <Card>
          <CardHeader title="Commitment-Weighted Revenue" subtitle="Stage-confidence weighted commitment pipeline" />
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
              <div className="rounded-lg border border-cyan-500/40 bg-cyan-900/20 p-3">
                <div className="text-slate-400">Weighted Total</div>
                <div className="mt-1 text-lg font-bold text-cyan-300 font-mono-num">
                  {commitmentForecast.overlay.weightedTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </div>
              </div>
              {Object.entries(commitmentForecast.overlay.byStage)
                .filter(([stage]) => stage !== 'abandoned')
                .map(([stage, weighted]) => (
                  <div key={stage} className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-3">
                    <div className="capitalize text-slate-400">{stage.replace('_', ' ')}</div>
                    <div className="mt-1 text-sm font-semibold text-slate-100 font-mono-num">
                      {weighted.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </div>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Anomalies */}
      {data.anomalies.length > 0 && (
        <Card>
          <CardHeader title="Detected Anomalies" />
          <CardContent className="space-y-3">
            {data.anomalies.map((anomaly, idx) => (
              <div
                key={idx}
                className="flex gap-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg"
              >
                <AlertTriangle className="text-red-400 flex-shrink-0" size={18} />
                <div>
                  <p className="text-sm text-slate-50 font-medium">
                    {anomaly.date}
                  </p>
                  <p className="text-xs text-red-300">{anomaly.description}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Forecast Chart */}
      <Card>
        <CardHeader
          title="Forecast with Confidence Band"
          subtitle={`${data.data.length} data points · Trend: ${data.trend}`}
        />
        <CardContent>
          <ResponsiveContainer width="100%" height={400}>
            <AreaChart data={data.data}>
              <defs>
                <linearGradient id="colorForecast" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorBand" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0e7490" stopOpacity={0.1} />
                  <stop offset="95%" stopColor="#0e7490" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(51, 65, 85, 0.3)"
              />
              <XAxis
                dataKey="date"
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

              {/* Confidence band */}
              <Area
                type="monotone"
                dataKey="upper"
                stroke="none"
                fill="url(#colorBand)"
                name="Upper Bound"
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="lower"
                stroke="none"
                fill="rgba(15, 23, 42, 1)"
                name="Lower Bound"
                isAnimationActive={false}
              />

              {/* Actual and Forecast */}
              <Area
                type="monotone"
                dataKey="actual"
                stroke="#10b981"
                fill="none"
                strokeWidth={2}
                name="Actual"
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="forecast"
                stroke="#06b6d4"
                fillOpacity={1}
                fill="url(#colorForecast)"
                name="Forecast"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  )
}
