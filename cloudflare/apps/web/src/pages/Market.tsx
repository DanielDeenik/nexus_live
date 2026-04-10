import { useState } from 'react'
import {
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Area,
} from 'recharts'
import { RefreshCw } from 'lucide-react'
import { Card, CardHeader, CardContent } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { StatusBadge } from '../components/ui/StatusBadge'
import { useQuery } from '../hooks/useApi'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'

interface Signal {
  id: string
  market: string
  tier: 'HOT' | 'WARM' | 'MONITOR' | 'COLD'
  description: string
  confidence: number
  source: string
}

interface SeasonalityData {
  month: string
  demand: number
  trend: number
}

interface MarketResponse {
  signals: Signal[]
  seasonalityData: SeasonalityData[]
  lastUpdated: string
}

const tierBadgeMap = {
  HOT: { status: 'overdue' as const, label: 'HOT' },
  WARM: { status: 'pending' as const, label: 'WARM' },
  MONITOR: { status: 'proposed' as const, label: 'MONITOR' },
  COLD: { status: 'cold' as const, label: 'COLD' },
}

export function Market() {
  const [filter, setFilter] = useState<'all' | 'HOT' | 'WARM' | 'MONITOR' | 'COLD'>('all')
  const [_jurisdiction] = useState('all')

  const { data, isLoading, refetch } = useQuery<MarketResponse>(
    '/v1/market/signals',
    { refetchInterval: 300000 } // 5 minutes
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <LoadingSpinner text="Loading market data..." />
      </div>
    )
  }

  if (!data) {
    return null
  }

  const filteredSignals = data.signals.filter(
    (signal) => filter === 'all' || signal.tier === filter
  )

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex gap-3 items-center">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => refetch()}
          className="gap-2"
        >
          <RefreshCw size={16} />
          Refresh
        </Button>

        <div className="flex gap-2">
          {(['all', 'HOT', 'WARM', 'MONITOR', 'COLD'] as const).map((tier) => (
            <button
              key={tier}
              onClick={() => setFilter(tier)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                filter === tier
                  ? 'bg-cyan-600 text-slate-950'
                  : 'bg-slate-800/50 text-slate-400 hover:bg-slate-700/50'
              }`}
            >
              {tier === 'all' ? 'All Signals' : tier}
            </button>
          ))}
        </div>
      </div>

      {/* Signals Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredSignals.map((signal) => {
          const badgeInfo = tierBadgeMap[signal.tier]
          return (
            <Card key={signal.id} className="hover:border-cyan-500/50 transition-all">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-slate-50">{signal.market}</h3>
                  <p className="text-xs text-slate-500 mt-1">{signal.source}</p>
                </div>
                <StatusBadge status={badgeInfo.status} label={badgeInfo.label} />
              </div>

              <p className="text-sm text-slate-300 mb-3 leading-relaxed">
                {signal.description}
              </p>

              <div className="pt-3 border-t border-slate-700/50">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">Confidence</span>
                  <span className="text-sm font-semibold text-cyan-400">
                    {(signal.confidence * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="mt-2 w-full h-1.5 bg-slate-700/50 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-cyan-500 to-teal-500"
                    style={{ width: `${signal.confidence * 100}%` }}
                  />
                </div>
              </div>
            </Card>
          )
        })}
      </div>

      {/* Seasonality Chart */}
      <Card>
        <CardHeader
          title="Hiring Market Seasonality"
          subtitle="12-month trend analysis"
        />
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={data.seasonalityData}>
              <defs>
                <linearGradient id="colorDemand" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                </linearGradient>
              </defs>
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

              <Area
                type="monotone"
                dataKey="demand"
                stroke="#06b6d4"
                fillOpacity={1}
                fill="url(#colorDemand)"
                name="Demand"
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="trend"
                stroke="#10b981"
                strokeWidth={2}
                name="Trend"
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Last Updated */}
      <p className="text-xs text-slate-500 text-center">
        Last updated: {new Date(data.lastUpdated).toLocaleString()}
      </p>
    </div>
  )
}
