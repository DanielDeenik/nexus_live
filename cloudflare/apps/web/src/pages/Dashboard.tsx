import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import { TrendingUp, AlertCircle } from 'lucide-react'
import { Card, CardHeader, CardContent } from '../components/ui/Card'
import { KPICard } from '../components/ui/KPICard'
import { DataTable } from '../components/ui/DataTable'
import { StatusBadge } from '../components/ui/StatusBadge'
import { EmptyState } from '../components/ui/EmptyState'
import { useQuery } from '../hooks/useApi'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { formatCurrency, formatDate } from '../lib/format'

interface Invoice {
  id: string
  client: string
  amount: number
  status: 'paid' | 'pending' | 'overdue'
  dueDate: string
}

interface BurnData {
  month: string
  actual: number
  forecast: number
}

interface DashboardSummary {
  cashPaid: number
  cashPending: number
  monthlyBurn: number
  taxReserve: number
  runwayMonths: number
  burnHistory: BurnData[]
  recentInvoices: Invoice[]
  marketSentiment: string
  latestInsight: string
}

export function Dashboard() {
  const { data, isLoading, error } = useQuery<DashboardSummary>(
    '/v1/finance/summary',
    { refetchInterval: 30000 } // Refresh every 30 seconds
  )

  const invoiceColumns = [
    { key: 'client' as const, label: 'Client', sortable: true },
    {
      key: 'amount' as const,
      label: 'Amount',
      sortable: true,
      render: (value: number) => formatCurrency(value),
    },
    {
      key: 'status' as const,
      label: 'Status',
      render: (value: string) => (
        <StatusBadge
          status={value as 'paid' | 'pending' | 'overdue'}
        />
      ),
    },
    {
      key: 'dueDate' as const,
      label: 'Due Date',
      sortable: true,
      render: (value: string) => formatDate(value),
    },
  ]

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <LoadingSpinner text="Loading dashboard..." />
      </div>
    )
  }

  if (error) {
    return (
      <EmptyState
        icon={<AlertCircle size={48} />}
        title="Failed to load dashboard"
        description={error.message}
      />
    )
  }

  if (!data) {
    return (
      <EmptyState
        icon={<AlertCircle size={48} />}
        title="No data available"
        description="Try refreshing the page or contacting support"
      />
    )
  }

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <KPICard
          label="Cash Paid"
          value={data.cashPaid}
          format="currency"
          trend={12}
          trendLabel="vs last month"
        />
        <KPICard
          label="Cash Pending"
          value={data.cashPending}
          format="currency"
          trend={-5}
          trendLabel="vs last month"
        />
        <KPICard
          label="Monthly Burn"
          value={data.monthlyBurn}
          format="currency"
          trend={8}
          trendLabel="vs last month"
        />
        <KPICard
          label="Tax Reserve"
          value={data.taxReserve}
          format="currency"
          trend={0}
          trendLabel="target met"
        />
        <KPICard
          label="Runway Months"
          value={data.runwayMonths}
          format="number"
          trend={2}
          trendLabel="months added"
        />
      </div>

      {/* Charts and Recent Data */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Burn History */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title="Burn History"
              subtitle="Last 12 months trend"
            />
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={data.burnHistory}>
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
                  <Bar dataKey="actual" fill="#06b6d4" radius={[8, 8, 0, 0]} />
                  <Bar
                    dataKey="forecast"
                    fill="#0e7490"
                    radius={[8, 8, 0, 0]}
                    opacity={0.6}
                  />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        {/* Market Sentiment & Insights */}
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Market Sentiment"
              subtitle="Current status"
            />
            <CardContent>
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-lg bg-amber-500/20 flex items-center justify-center">
                  <TrendingUp className="text-amber-400" size={24} />
                </div>
                <div>
                  <p className="font-semibold text-slate-50">
                    {data.marketSentiment}
                  </p>
                  <p className="text-xs text-slate-400">Last updated 2h ago</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader
              title="Latest Insight"
              subtitle="AI Agent"
            />
            <CardContent>
              <p className="text-sm text-slate-300 leading-relaxed">
                {data.latestInsight}
              </p>
              <button className="mt-4 text-xs text-cyan-400 hover:text-cyan-300 transition-colors font-medium">
                View all insights →
              </button>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Recent Invoices */}
      <Card>
        <CardHeader
          title="Recent Invoices"
          subtitle="Last 5 invoices"
          action={
            <button className="text-sm text-cyan-400 hover:text-cyan-300 transition-colors font-medium">
              View all
            </button>
          }
        />
        <CardContent>
          {data.recentInvoices.length > 0 ? (
            <DataTable
              columns={invoiceColumns}
              data={data.recentInvoices}
              searchable
              searchFields={['client']}
            />
          ) : (
            <EmptyState
              title="No recent invoices"
              description="Your recent invoices will appear here"
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
