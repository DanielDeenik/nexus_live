import { useState, useRef, useEffect } from 'react'
import { Send, MessageCircle } from 'lucide-react'
import { Card, CardHeader, CardContent } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { useQuery, useMutation } from '../hooks/useApi'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { formatDate } from '../lib/format'

interface Agent {
  id: string
  name: string
  lastActive: string
  insightCount: number
  enabled: boolean
}

interface Insight {
  id: string
  timestamp: string
  agent: string
  content: string
  confidence: number
}

interface InsightsResponse {
  agents: Agent[]
  insights: Insight[]
}

export function Insights() {
  const [messages, setMessages] = useState<
    Array<{ role: 'user' | 'agent'; content: string; agent?: string }>
  >([])
  const [query, setQuery] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const { data } = useQuery<InsightsResponse>('/v1/insights/summary', {
    refetchInterval: 60000,
  })

  const { mutate: queryAgents } = useMutation<
    { agent: string; response: string },
    { query: string }
  >('/v1/insights/query', 'POST')

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const handleSendQuery = async () => {
    if (!query.trim()) return

    setMessages((prev) => [...prev, { role: 'user', content: query }])
    setQuery('')
    setIsLoading(true)

    try {
      const response = await queryAgents({ query })
      setMessages((prev) => [
        ...prev,
        {
          role: 'agent',
          content: response.response,
          agent: response.agent,
        },
      ])
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'agent',
          content: 'Sorry, I encountered an error processing your query.',
        },
      ])
    } finally {
      setIsLoading(false)
    }
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full">
        <LoadingSpinner text="Loading insights..." />
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-full">
      {/* Agent Status Sidebar */}
      <div className="lg:col-span-1">
        <Card>
          <CardHeader title="Agents" subtitle="MiroFish Swarm" />
          <CardContent className="space-y-2">
            {data.agents.map((agent) => (
              <div
                key={agent.id}
                className="p-3 rounded-lg bg-slate-800/50 border border-slate-700/50 hover:border-slate-600/50 transition-all cursor-pointer"
              >
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-semibold text-slate-50">
                    {agent.name}
                  </h4>
                  <div
                    className={`w-2 h-2 rounded-full ${
                      agent.enabled ? 'bg-emerald-500' : 'bg-slate-600'
                    }`}
                  />
                </div>
                <p className="text-xs text-slate-400">
                  {agent.insightCount} insights
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  Last active: {formatDate(agent.lastActive)}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Quick Insights */}
        <Card className="mt-4">
          <CardHeader title="Latest Insights" />
          <CardContent className="space-y-2 max-h-96 overflow-y-auto">
            {data.insights.slice(0, 5).map((insight) => (
              <div
                key={insight.id}
                className="p-2 rounded text-xs bg-slate-800/30 border border-slate-700/30"
              >
                <p className="font-medium text-slate-300 mb-1">
                  {insight.agent}
                </p>
                <p className="text-slate-400 line-clamp-2">{insight.content}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Chat Interface */}
      <div className="lg:col-span-3 flex flex-col">
        <Card className="flex-1 flex flex-col">
          <CardHeader
            title="Ask the Swarm"
            subtitle="Get insights from all agents"
          />

          {/* Messages */}
          <CardContent className="flex-1 overflow-y-auto space-y-4 mb-4">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center py-12">
                <MessageCircle className="text-slate-600 mb-3" size={32} />
                <p className="text-slate-400 text-sm">
                  Ask the swarm anything about your finances.
                </p>
                <p className="text-slate-500 text-xs mt-2">
                  Example: "What are my top spending categories?"
                </p>
              </div>
            ) : (
              messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex ${
                    msg.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  <div
                    className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
                      msg.role === 'user'
                        ? 'bg-cyan-600/20 border border-cyan-500/30 text-slate-50'
                        : 'bg-slate-800/50 border border-slate-700/50 text-slate-300'
                    }`}
                  >
                    {msg.agent && (
                      <p className="text-xs font-semibold text-cyan-400 mb-1">
                        {msg.agent}
                      </p>
                    )}
                    <p className="text-sm leading-relaxed">{msg.content}</p>
                  </div>
                </div>
              ))
            )}

            {isLoading && (
              <div className="flex justify-start">
                <div className="flex gap-1">
                  <div className="w-2 h-2 bg-slate-500 rounded-full animate-pulse-soft" />
                  <div className="w-2 h-2 bg-slate-500 rounded-full animate-pulse-soft animation-delay-200" />
                  <div className="w-2 h-2 bg-slate-500 rounded-full animate-pulse-soft animation-delay-400" />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </CardContent>

          {/* Input */}
          <div className="border-t border-slate-700/50 pt-4">
            <div className="flex gap-2">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === 'Enter') {
                    handleSendQuery()
                  }
                }}
                placeholder="Ask a question..."
                disabled={isLoading}
                className="flex-1 px-4 py-2 bg-slate-800/50 border border-slate-700/50 rounded-lg text-slate-50 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <Button
                variant="primary"
                onClick={handleSendQuery}
                isLoading={isLoading}
              >
                <Send size={16} />
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
