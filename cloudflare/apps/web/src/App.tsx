import { useState, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Dashboard } from './pages/Dashboard'
import { Forecast } from './pages/Forecast'
import { Budget } from './pages/Budget'
import { Scenarios } from './pages/Scenarios'
import { Treasury } from './pages/Treasury'
import { Invoices } from './pages/Invoices'
import { Market } from './pages/Market'
import { Insights } from './pages/Insights'
import { Commitments } from './pages/Commitments'
import { Settings } from './pages/Settings'
import { IncomeTax } from './pages/IncomeTax'
import { Review } from './pages/Review'
import { Expenses } from './pages/Expenses'
import { TaxFilings } from './pages/TaxFilings'
import { AgentSettings } from './pages/AgentSettings'
import { TimeDashboard } from './pages/time/TimeDashboard'
import { TimeEntries } from './pages/time/TimeEntries'
import { TimeProjects } from './pages/time/TimeProjects'
import { FlowBlocks } from './pages/time/FlowBlocks'
import { Devices } from './pages/time/Devices'
import { ensureBootstrap } from './lib/time'
import { RecruiterOverview } from './pages/recruiter/RecruiterOverview'
import { FitReports } from './pages/recruiter/FitReports'
import { Applications } from './pages/recruiter/Applications'
import { Roles } from './pages/recruiter/Roles'
import { LinkedInOverview } from './pages/linkedin/LinkedInOverview'
import { LinkedInImports } from './pages/linkedin/LinkedInImports'
import { SignIn } from './pages/SignIn'
import { LoadingSpinner } from './components/ui/LoadingSpinner'
import { useAuthProvider } from './hooks/useAuth'
import { AuthContext } from './stores/auth'

function App() {
  const authProvider = useAuthProvider()
  const [userRole] = useState('Founder')
  const [notificationCount] = useState(0)

  useEffect(() => {
    // Initialize auth on mount
    if (authProvider.token) {
      authProvider.getCurrentUser()
    }
  }, [])

  // Time tracking: create the configured areas, projects and activities once
  // per session after sign-in.
  const userId = authProvider.user?.id
  useEffect(() => {
    if (userId) ensureBootstrap(userId).catch((e) => console.error('time bootstrap failed', e))
  }, [userId])

  const handleLogout = () => {
    authProvider.logout()
  }

  if (authProvider.isLoading) {
    return <div className="min-h-screen bg-slate-950 flex items-center justify-center"><LoadingSpinner /></div>
  }
  if (!authProvider.isAuthenticated) return <SignIn />
  const userName = authProvider.user?.name || authProvider.user?.email || ''

  return (
    <AuthContext.Provider value={authProvider}>
      <Layout
        userName={userName}
        userRole={userRole}
        notificationCount={notificationCount}
        onLogout={handleLogout}
      >
        <Routes>
          <Route path="/" element={<IncomeTax />} />
          <Route path="/time" element={<TimeDashboard />} />
          <Route path="/time/entries" element={<TimeEntries />} />
          <Route path="/time/projects" element={<TimeProjects />} />
          <Route path="/time/flow" element={<FlowBlocks />} />
          <Route path="/time/devices" element={<Devices />} />
          <Route path="/recruiter" element={<RecruiterOverview />} />
          <Route path="/recruiter/fit" element={<FitReports />} />
          <Route path="/recruiter/applications" element={<Applications />} />
          <Route path="/recruiter/roles" element={<Roles />} />
          <Route path="/linkedin" element={<LinkedInOverview />} />
          <Route path="/linkedin/imports" element={<LinkedInImports />} />
          <Route path="/review" element={<Review />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/tax" element={<TaxFilings />} />
          <Route path="/agent-settings" element={<AgentSettings />} />
          <Route path="/overview" element={<Dashboard />} />
          <Route path="/forecast" element={<Forecast />} />
          <Route path="/budget" element={<Budget />} />
          <Route path="/scenarios" element={<Scenarios />} />
          <Route path="/treasury" element={<Treasury />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/market" element={<Market />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/commitments" element={<Commitments />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </AuthContext.Provider>
  )
}

export default App
