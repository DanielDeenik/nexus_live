import { useState } from 'react'
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
import { AlertTriangle, Plus } from 'lucide-react'
import { Card, CardHeader, CardContent } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { DataTable } from '../components/ui/DataTable'
import { useQuery, useMutation } from '../hooks/useApi'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { EmptyState } from '../components/ui/EmptyState'
import { formatCurrency } from '../lib/format'

interface BudgetCategory {
  id: string
  name: string
  budgeted: number
  actual: number
  variance: number
  month: string
}

interface BudgetResponse {
  categories: BudgetCategory[]
  overBudgetCount: number
  monthlyData: Array<{
    month: string
    budgeted: number
    actual: number
  }>
}

export function Budget() {
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [categoryName, setCategoryName] = useState('')
  const [budgetAmount, setBudgetAmount] = useState('')

  const { data, isLoading, error, refetch } = useQuery<BudgetResponse>(
    '/v1/finance/budget',
    { refetchInterval: 60000 }
  )

  const { mutate: addCategory, isLoading: isAdding } = useMutation<
    BudgetCategory,
    { name: string; amount: number }
  >('/v1/finance/budget/categories', 'POST')

  const handleAddCategory = async () => {
    if (!categoryName || !budgetAmount) return

    try {
      await addCategory({
        name: categoryName,
        amount: Number(budgetAmount),
      })
      setCategoryName('')
      setBudgetAmount('')
      setIsAddModalOpen(false)
      refetch()
    } catch (error) {
      console.error('Failed to add category', error)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <LoadingSpinner text="Loading budget..." />
      </div>
    )
  }

  if (error) {
    return (
      <EmptyState
        icon={<AlertTriangle size={48} />}
        title="Failed to load budget"
        description={error.message}
      />
    )
  }

  if (!data) {
    return (
      <EmptyState
        icon={<AlertTriangle size={48} />}
        title="No budget data"
        description="Create your first budget to get started"
        action={{
          label: 'Create Budget',
          onClick: () => setIsAddModalOpen(true),
        }}
      />
    )
  }

  const budgetColumns = [
    { key: 'name' as const, label: 'Category', sortable: true },
    {
      key: 'budgeted' as const,
      label: 'Budgeted',
      sortable: true,
      render: (value: number) => formatCurrency(value),
    },
    {
      key: 'actual' as const,
      label: 'Actual',
      sortable: true,
      render: (value: number) => formatCurrency(value),
    },
    {
      key: 'variance' as const,
      label: 'Variance',
      sortable: true,
      render: (value: number) => (
        <span
          className={
            value > 0 ? 'text-emerald-400' : value < 0 ? 'text-red-400' : ''
          }
        >
          {formatCurrency(value)}
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-400 mb-1">Over Budget</p>
              <p className="text-3xl font-bold font-mono-num text-red-400">
                {data.overBudgetCount}
              </p>
            </div>
            <div className="w-12 h-12 rounded-lg bg-red-500/20 flex items-center justify-center">
              <AlertTriangle className="text-red-400" size={24} />
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-400 mb-1">Total Categories</p>
              <p className="text-3xl font-bold font-mono-num text-cyan-400">
                {data.categories.length}
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* Monthly Trend */}
      <Card>
        <CardHeader
          title="Budget vs Actual"
          subtitle="Monthly comparison"
        />
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart
              data={data.monthlyData}
              layout="vertical"
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(51, 65, 85, 0.3)"
              />
              <XAxis
                type="number"
                stroke="rgba(148, 163, 184, 0.5)"
                style={{ fontSize: '12px' }}
              />
              <YAxis
                dataKey="month"
                type="category"
                stroke="rgba(148, 163, 184, 0.5)"
                style={{ fontSize: '12px' }}
                width={80}
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
              <Bar dataKey="budgeted" fill="#06b6d4" radius={[0, 8, 8, 0]} />
              <Bar dataKey="actual" fill="#ef4444" radius={[0, 8, 8, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Categories Table */}
      <Card>
        <CardHeader
          title="Budget Categories"
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={() => setIsAddModalOpen(true)}
            >
              <Plus size={16} />
              Add Category
            </Button>
          }
        />
        <CardContent>
          <DataTable
            columns={budgetColumns}
            data={data.categories}
            searchable
            searchFields={['name']}
          />
        </CardContent>
      </Card>

      {/* Add Category Modal */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        title="Add Budget Category"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setIsAddModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleAddCategory}
              isLoading={isAdding}
            >
              Add Category
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Category Name
            </label>
            <input
              type="text"
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
              placeholder="e.g., Software Licenses"
              className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-colors"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Monthly Budget
            </label>
            <input
              type="number"
              value={budgetAmount}
              onChange={(e) => setBudgetAmount(e.target.value)}
              placeholder="0.00"
              className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-colors font-mono-num"
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
