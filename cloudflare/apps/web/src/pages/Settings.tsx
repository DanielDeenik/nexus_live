import { useState } from 'react'
import { Plus, Trash2, Copy } from 'lucide-react'
import { Card, CardHeader, CardContent } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { useQuery, useMutation } from '../hooks/useApi'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'

interface SettingsData {
  profile: {
    name: string
    email: string
    baseCurrency: string
    monthlyBurn: number
  }
  dataSources: Array<{
    id: string
    name: string
    status: 'connected' | 'syncing' | 'error'
    lastSync: string
  }>
  apiTokens: Array<{
    id: string
    name: string
    createdAt: string
    lastUsed?: string
    prefix: string
  }>
  stakeholders: Array<{
    id: string
    email: string
    role: string
    invitedAt: string
  }>
  agents: Array<{
    id: string
    name: string
    enabled: boolean
    model: string
  }>
}

const tabs = ['Profile', 'Data Sources', 'API Tokens', 'Stakeholders', 'Agents']

export function Settings() {
  const [activeTab, setActiveTab] = useState(0)
  const [isAddTokenModalOpen, setIsAddTokenModalOpen] = useState(false)
  const [isAddStakeholderModalOpen, setIsAddStakeholderModalOpen] =
    useState(false)
  const [tokenName, setTokenName] = useState('')
  const [stakeholderEmail, setStakeholderEmail] = useState('')
  const [_visibleTokens] = useState<Set<string>>(new Set())

  const { data, isLoading, refetch } = useQuery<SettingsData>(
    '/v1/settings',
    { refetchInterval: 120000 }
  )

  const { mutate: createToken, isLoading: isCreatingToken } = useMutation<
    { token: string; id: string },
    { name: string }
  >('/v1/settings/api-tokens', 'POST')

  const { mutate: addStakeholder, isLoading: isAddingStakeholder } =
    useMutation<void, { email: string }>('/v1/settings/stakeholders', 'POST')

  const handleCreateToken = async () => {
    if (!tokenName) return
    try {
      await createToken({ name: tokenName })
      setTokenName('')
      setIsAddTokenModalOpen(false)
      refetch()
    } catch (error) {
      console.error('Failed to create token', error)
    }
  }

  const handleAddStakeholder = async () => {
    if (!stakeholderEmail) return
    try {
      await addStakeholder({ email: stakeholderEmail })
      setStakeholderEmail('')
      setIsAddStakeholderModalOpen(false)
      refetch()
    } catch (error) {
      console.error('Failed to add stakeholder', error)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <LoadingSpinner text="Loading settings..." />
      </div>
    )
  }

  if (!data) {
    return null
  }

  return (
    <div className="max-w-4xl space-y-6">
      {/* Tab Navigation */}
      <div className="flex gap-2 border-b border-slate-700/50 overflow-x-auto">
        {tabs.map((tab, idx) => (
          <button
            key={tab}
            onClick={() => setActiveTab(idx)}
            className={`px-4 py-3 font-medium text-sm whitespace-nowrap border-b-2 transition-all ${
              activeTab === idx
                ? 'border-cyan-500 text-cyan-400'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div>
        {/* Profile Tab */}
        {activeTab === 0 && (
          <Card>
            <CardHeader title="Profile Settings" />
            <CardContent className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Full Name
                </label>
                <input
                  type="text"
                  defaultValue={data.profile.name}
                  className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 focus:outline-none focus:border-cyan-500/50 transition-colors"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Email
                </label>
                <input
                  type="email"
                  defaultValue={data.profile.email}
                  className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 focus:outline-none focus:border-cyan-500/50 transition-colors"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    Base Currency
                  </label>
                  <select
                    defaultValue={data.profile.baseCurrency}
                    className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 focus:outline-none focus:border-cyan-500/50 transition-colors"
                  >
                    <option value="EUR">EUR (€)</option>
                    <option value="USD">USD ($)</option>
                    <option value="GBP">GBP (£)</option>
                    <option value="CHF">CHF (CHF)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    Monthly Burn
                  </label>
                  <input
                    type="number"
                    defaultValue={data.profile.monthlyBurn}
                    className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 focus:outline-none focus:border-cyan-500/50 transition-colors font-mono-num"
                  />
                </div>
              </div>

              <Button variant="primary">Save Changes</Button>
            </CardContent>
          </Card>
        )}

        {/* Data Sources Tab */}
        {activeTab === 1 && (
          <Card>
            <CardHeader
              title="Connected Data Sources"
              action={
                <Button variant="primary" size="sm">
                  <Plus size={16} />
                  Add Source
                </Button>
              }
            />
            <CardContent className="space-y-3">
              {data.dataSources.map((source) => (
                <div
                  key={source.id}
                  className="p-4 rounded-lg bg-slate-800/50 border border-slate-700/50 flex items-center justify-between"
                >
                  <div>
                    <h4 className="font-semibold text-slate-50">{source.name}</h4>
                    <p className="text-xs text-slate-400 mt-1">
                      Last synced: {new Date(source.lastSync).toLocaleDateString()}
                    </p>
                  </div>
                  <span
                    className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                      source.status === 'connected'
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : source.status === 'syncing'
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-red-500/20 text-red-300'
                    }`}
                  >
                    {source.status}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* API Tokens Tab */}
        {activeTab === 2 && (
          <Card>
            <CardHeader
              title="API Tokens"
              action={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setIsAddTokenModalOpen(true)}
                >
                  <Plus size={16} />
                  Create Token
                </Button>
              }
            />
            <CardContent className="space-y-3">
              {data.apiTokens.map((token) => (
                <div
                  key={token.id}
                  className="p-4 rounded-lg bg-slate-800/50 border border-slate-700/50 flex items-center justify-between"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-semibold text-slate-50">
                        {token.name}
                      </h4>
                      <code className="text-xs bg-slate-900/50 px-2 py-1 rounded text-slate-400">
                        {token.prefix}...
                      </code>
                    </div>
                    <p className="text-xs text-slate-400">
                      Created: {new Date(token.createdAt).toLocaleDateString()}
                      {token.lastUsed &&
                        ` • Last used: ${new Date(token.lastUsed).toLocaleDateString()}`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm">
                      <Copy size={14} />
                    </Button>
                    <Button variant="danger" size="sm">
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Stakeholders Tab */}
        {activeTab === 3 && (
          <Card>
            <CardHeader
              title="Stakeholders"
              action={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setIsAddStakeholderModalOpen(true)}
                >
                  <Plus size={16} />
                  Invite
                </Button>
              }
            />
            <CardContent className="space-y-3">
              {data.stakeholders.map((stakeholder) => (
                <div
                  key={stakeholder.id}
                  className="p-4 rounded-lg bg-slate-800/50 border border-slate-700/50 flex items-center justify-between"
                >
                  <div className="flex-1">
                    <h4 className="font-semibold text-slate-50">
                      {stakeholder.email}
                    </h4>
                    <p className="text-xs text-slate-400 mt-1">
                      {stakeholder.role} • Invited{' '}
                      {new Date(stakeholder.invitedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Button variant="danger" size="sm">
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Agents Tab */}
        {activeTab === 4 && (
          <Card>
            <CardHeader title="AI Agents" subtitle="MiroFish Agent Configuration" />
            <CardContent className="space-y-4">
              {data.agents.map((agent) => (
                <div
                  key={agent.id}
                  className="p-4 rounded-lg bg-slate-800/50 border border-slate-700/50"
                >
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-semibold text-slate-50">
                      {agent.name}
                    </h4>
                    <button
                      className={`px-3 py-1 rounded text-sm font-medium transition-all ${
                        agent.enabled
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : 'bg-slate-700/50 text-slate-400'
                      }`}
                    >
                      {agent.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>
                  <p className="text-xs text-slate-400">
                    Model: {agent.model}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Modals */}
      <Modal
        isOpen={isAddTokenModalOpen}
        onClose={() => setIsAddTokenModalOpen(false)}
        title="Create API Token"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setIsAddTokenModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreateToken}
              isLoading={isCreatingToken}
            >
              Create Token
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Token Name
            </label>
            <input
              type="text"
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
              placeholder="e.g., Mobile App"
              className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-colors"
            />
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isAddStakeholderModalOpen}
        onClose={() => setIsAddStakeholderModalOpen(false)}
        title="Invite Stakeholder"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setIsAddStakeholderModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleAddStakeholder}
              isLoading={isAddingStakeholder}
            >
              Send Invite
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Email Address
            </label>
            <input
              type="email"
              value={stakeholderEmail}
              onChange={(e) => setStakeholderEmail(e.target.value)}
              placeholder="user@example.com"
              className="w-full px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-colors"
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
