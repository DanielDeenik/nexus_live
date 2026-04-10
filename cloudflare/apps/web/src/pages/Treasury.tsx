import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import { Landmark, ArrowRightLeft } from 'lucide-react'
import { Card, CardHeader, CardContent } from '../components/ui/Card'
import { DataTable } from '../components/ui/DataTable'
import { useQuery } from '../hooks/useApi'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { formatCurrency } from '../lib/format'

interface Account {
  id: string
  currency: string
  balance: number
  jarLabel: string
  jarStatus: number
}

interface HedgeContract {
  id: string
  currency: string
  rate: number
  expiresAt: string
  notional: number
}

interface TreasuryResponse {
  accounts: Account[]
  hedgeContracts: HedgeContract[]
  exposureSummary: Array<{ currency: string; value: number }>
}

const COLORS = ['#06b6d4', '#0e7490', '#14b8a6', '#6366f1', '#f59e0b']

export function Treasury() {
  const { data, isLoading } = useQuery<TreasuryResponse>(
    '/v1/finance/treasury',
    { refetchInterval: 60000 }
  )

  const hedgeColumns = [
    { key: 'currency' as const, label: 'Currency', sortable: true },
    {
      key: 'rate' as const,
      label: 'Rate',
      sortable: true,
      render: (value: number) => `1 : ${value.toFixed(4)}`,
    },
    {
      key: 'notional' as const,
      label: 'Notional',
      render: (value: number) => formatCurrency(value),
    },
    { key: 'expiresAt' as const, label: 'Expires', sortable: true },
  ]

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <LoadingSpinner text="Loading treasury..." />
      </div>
    )
  }

  if (!data) {
    return null
  }

  return (
    <div className="space-y-6">
      {/* Account Cards */}
      <div>
        <h2 className="text-lg font-semibold text-slate-50 mb-4">Accounts</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {data.accounts.map((account) => (
            <Card key={account.id}>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="text-sm font-medium text-slate-400">
                    {account.currency}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    {account.jarLabel}
                  </p>
                </div>
                <div className="w-8 h-8 rounded-lg bg-cyan-500/20 flex items-center justify-center">
                  <Landmark size={16} className="text-cyan-400" />
                </div>
              </div>

              <div className="mb-4">
                <p className="text-2xl font-bold font-mono-num text-slate-50">
                  {formatCurrency(account.balance, account.currency)}
                </p>
              </div>

              {/* Jar Status Bar */}
              <div className="w-full h-2 bg-slate-700/50 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-teal-500"
                  style={{ width: `${Math.min(account.jarStatus, 100)}%` }}
                />
              </div>
              <p className="text-xs text-slate-400 mt-2">
                {account.jarStatus}% filled
              </p>
            </Card>
          ))}
        </div>
      </div>

      {/* FX Exposure */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title="Multi-Currency Exposure"
              subtitle="Current portfolio distribution"
            />
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={data.exposureSummary}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ currency, value }) =>
                      `${currency} ${(value / 1000).toFixed(0)}k`
                    }
                    outerRadius={100}
                    fill="#8884d8"
                    dataKey="value"
                  >
                    {data.exposureSummary.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => formatCurrency(value as number)} />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        {/* Currency Converter */}
        <Card>
          <CardHeader
            title="Quick Convert"
            action={<ArrowRightLeft size={18} className="text-cyan-400" />}
          />
          <CardContent className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-2">
                From
              </label>
              <div className="flex gap-2">
                <select className="flex-1 px-3 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 focus:outline-none focus:border-cyan-500/50">
                  <option>EUR</option>
                  <option>USD</option>
                  <option>GBP</option>
                </select>
                <input
                  type="number"
                  placeholder="1000"
                  className="flex-1 px-3 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
                />
              </div>
            </div>

            <div className="flex items-center justify-center py-2">
              <div className="w-8 h-8 rounded-full bg-slate-700/50 flex items-center justify-center">
                <ArrowRightLeft size={16} className="text-slate-400" />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-2">
                To
              </label>
              <div className="flex gap-2">
                <select className="flex-1 px-3 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 focus:outline-none focus:border-cyan-500/50">
                  <option>USD</option>
                  <option>EUR</option>
                  <option>GBP</option>
                </select>
                <input
                  type="text"
                  value="850.50"
                  readOnly
                  className="flex-1 px-3 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 cursor-not-allowed font-mono-num"
                />
              </div>
            </div>

            <p className="text-xs text-slate-400 text-center py-2">
              Rate: 1 EUR = 1.12 USD
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Hedge Contracts */}
      <Card>
        <CardHeader
          title="Hedging Contracts"
          subtitle="Active FX hedges"
        />
        <CardContent>
          <DataTable
            columns={hedgeColumns}
            data={data.hedgeContracts}
            searchable
            searchFields={['currency']}
          />
        </CardContent>
      </Card>
    </div>
  )
}
