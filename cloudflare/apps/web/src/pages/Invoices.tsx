import { useState } from 'react'
import { Plus, FileText } from 'lucide-react'
import { Card, CardHeader, CardContent } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { DataTable } from '../components/ui/DataTable'
import { StatusBadge } from '../components/ui/StatusBadge'
import { useQuery, useMutation } from '../hooks/useApi'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { formatCurrency, formatDate } from '../lib/format'

interface Invoice {
  id: string
  invoiceNumber: string
  client: string
  amount: number
  currency: string
  status: 'paid' | 'pending' | 'overdue'
  issueDate: string
  dueDate: string
  description: string
}

interface InvoiceResponse {
  invoices: Invoice[]
  totalOutstanding: number
  overdueCount: number
}

export function Invoices() {
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [formData, setFormData] = useState({
    invoiceNumber: '',
    client: '',
    amount: '',
    currency: 'EUR',
    dueDate: '',
    description: '',
  })

  const { data, isLoading, refetch } = useQuery<InvoiceResponse>(
    '/v1/finance/invoices',
    { refetchInterval: 60000 }
  )

  const { mutate: createInvoice, isLoading: isCreating } = useMutation<
    Invoice,
    Partial<Invoice>
  >('/v1/finance/invoices', 'POST')

  const handleAddInvoice = async () => {
    if (!formData.invoiceNumber || !formData.client || !formData.amount) return

    try {
      await createInvoice({
        invoiceNumber: formData.invoiceNumber,
        client: formData.client,
        amount: Number(formData.amount),
        currency: formData.currency,
        dueDate: formData.dueDate,
        description: formData.description,
      })
      setFormData({
        invoiceNumber: '',
        client: '',
        amount: '',
        currency: 'EUR',
        dueDate: '',
        description: '',
      })
      setIsAddModalOpen(false)
      refetch()
    } catch (error) {
      console.error('Failed to create invoice', error)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <LoadingSpinner text="Loading invoices..." />
      </div>
    )
  }

  if (!data) {
    return null
  }

  const columns = [
    { key: 'invoiceNumber' as const, label: 'Invoice #', sortable: true },
    { key: 'client' as const, label: 'Client', sortable: true },
    {
      key: 'amount' as const,
      label: 'Amount',
      sortable: true,
      render: (value: number, row: Invoice) =>
        formatCurrency(value, row.currency),
    },
    {
      key: 'status' as const,
      label: 'Status',
      render: (value: string) => (
        <StatusBadge status={value as 'paid' | 'pending' | 'overdue'} />
      ),
    },
    {
      key: 'dueDate' as const,
      label: 'Due Date',
      sortable: true,
      render: (value: string) => formatDate(value),
    },
    {
      key: 'issueDate' as const,
      label: 'Issue Date',
      sortable: true,
      render: (value: string) => formatDate(value),
    },
  ]

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-400 mb-1">Total Outstanding</p>
              <p className="text-3xl font-bold font-mono-num text-cyan-400">
                {formatCurrency(data.totalOutstanding)}
              </p>
            </div>
            <FileText className="text-cyan-500/50" size={32} />
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-400 mb-1">Total Invoices</p>
              <p className="text-3xl font-bold font-mono-num text-slate-50">
                {data.invoices.length}
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-400 mb-1">Overdue</p>
              <p className="text-3xl font-bold font-mono-num text-red-400">
                {data.overdueCount}
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* Invoice Table */}
      <Card>
        <CardHeader
          title="All Invoices"
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={() => setIsAddModalOpen(true)}
            >
              <Plus size={16} />
              New Invoice
            </Button>
          }
        />
        <CardContent>
          <DataTable
            columns={columns}
            data={data.invoices}
            searchable
            searchFields={['client', 'invoiceNumber']}
            pagination={{ pageSize: 10 }}
          />
        </CardContent>
      </Card>

      {/* Add Invoice Modal */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        title="Create Invoice"
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
              onClick={handleAddInvoice}
              isLoading={isCreating}
            >
              Create Invoice
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Invoice #
              </label>
              <input
                type="text"
                value={formData.invoiceNumber}
                onChange={(e) =>
                  setFormData({ ...formData, invoiceNumber: e.target.value })
                }
                placeholder="INV-001"
                className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-colors"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Client
              </label>
              <input
                type="text"
                value={formData.client}
                onChange={(e) =>
                  setFormData({ ...formData, client: e.target.value })
                }
                placeholder="ACME Inc"
                className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-colors"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Amount
              </label>
              <input
                type="number"
                value={formData.amount}
                onChange={(e) =>
                  setFormData({ ...formData, amount: e.target.value })
                }
                placeholder="5000"
                className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-colors font-mono-num"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Currency
              </label>
              <select
                value={formData.currency}
                onChange={(e) =>
                  setFormData({ ...formData, currency: e.target.value })
                }
                className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 focus:outline-none focus:border-cyan-500/50 transition-colors"
              >
                <option value="EUR">EUR (€)</option>
                <option value="USD">USD ($)</option>
                <option value="GBP">GBP (£)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Due Date
            </label>
            <input
              type="date"
              value={formData.dueDate}
              onChange={(e) =>
                setFormData({ ...formData, dueDate: e.target.value })
              }
              className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 focus:outline-none focus:border-cyan-500/50 transition-colors"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Description
            </label>
            <textarea
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
              placeholder="Services rendered..."
              rows={3}
              className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-colors resize-none"
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
