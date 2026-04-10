import React from 'react'
import { TrendingUp, TrendingDown } from 'lucide-react'
import { formatCurrency, formatNumber } from '../../lib/format'
import { Card } from './Card'

interface KPICardProps {
  label: string
  value: number
  currency?: string
  format?: 'currency' | 'number' | 'percent'
  trend?: number
  trendLabel?: string
  sparkline?: number[]
  icon?: React.ReactNode
  className?: string
}

export function KPICard({
  label,
  value,
  currency,
  format = 'currency',
  trend,
  trendLabel,
  sparkline,
  icon,
  className = '',
}: KPICardProps) {
  let formattedValue: string

  if (format === 'currency') {
    formattedValue = formatCurrency(value, currency || 'USD')
  } else if (format === 'percent') {
    formattedValue = `${value.toFixed(1)}%`
  } else {
    formattedValue = formatNumber(value)
  }

  const trendColor = trend === undefined ? '' : trend > 0 ? 'text-emerald-400' : trend < 0 ? 'text-red-400' : 'text-slate-400'
  const trendIcon = trend === undefined ? null : trend > 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />

  return (
    <Card className={className}>
      <div className="flex items-start justify-between mb-3">
        <p className="text-sm font-medium text-slate-400">{label}</p>
        {icon && <div className="text-slate-500">{icon}</div>}
      </div>

      <div className="mb-3">
        <div className="text-3xl font-bold font-mono-num text-slate-50 mb-2">
          {formattedValue}
        </div>

        {trend !== undefined && (
          <div className={`flex items-center gap-1 ${trendColor}`}>
            {trendIcon}
            <span className="text-xs font-medium">
              {trend > 0 ? '+' : ''}{trend.toFixed(1)}%
            </span>
            {trendLabel && (
              <span className="text-xs text-slate-500 ml-1">{trendLabel}</span>
            )}
          </div>
        )}
      </div>

      {sparkline && sparkline.length > 0 && (
        <div className="flex items-end gap-0.5 h-8">
          {sparkline.map((point, i) => {
            const max = Math.max(...sparkline)
            const min = Math.min(...sparkline)
            const height =
              max === min ? 50 : ((point - min) / (max - min)) * 100
            return (
              <div
                key={i}
                className="flex-1 rounded-sm bg-gradient-to-t from-cyan-500/40 to-cyan-400/40"
                style={{
                  height: `${height}%`,
                  minHeight: '4px',
                }}
              />
            )
          })}
        </div>
      )}
    </Card>
  )
}
