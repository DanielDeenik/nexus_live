import { useState, useEffect } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Forecast } from './pages/Forecast'
import { Look } from './pages/Look'
import { Settings } from './pages/Settings'
import { IncomeTax } from './pages/IncomeTax'
import { Review } from './pages/Review'
import { Expenses } from './pages/Expenses'
import { TaxFilings } from './pages/TaxFilings'
import { TimeDashboard } from './pages/time/TimeDashboard'
import { TimeEntries } from './pages/time/TimeEntries'
import { TimeProjects } from './pages/time/TimeProjects'
import { FlowBlocks } from './pages/time/FlowBlocks'
import { ensureBootstrap } from './lib/time'
import { RecruiterOverview } from './pages/recruiter/RecruiterOverview'
import { FitReports } from './pages/recruiter/FitReports'
import { Applications } from './pages/recruiter/Applications'
import { Roles } from './pages/recruiter/Roles'
import { LinkedInOverview } from './pages/linkedin/LinkedInOverview'
import { SignIn } from './pages/SignIn'
import { OAuthConsent } from './pages/OAuthConsent'
import { keepConsentPath, takeConsentPath } from './lib/claudeAccess'
import { LoadingSpinner } from './components/ui/LoadingSpinner'
import { useAuthProvider } from './hooks/useAuth'
import { AuthContext } from './stores/auth'

/** Redirect that carries the query string along to the new address. */
function RedirectKeepQuery({ to, hash }: { to: string; hash?: string }) {
  const { search } = useLocation()
  return <Navigate to={{ pathname: to, search, hash: hash ? `#${hash}` : '' }} replace />
}

function App() {
  const authProvider = useAuthProvider()
  const location = useLocation()
  const navigate = useNavigate()
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

  // A consent request from Claude Code that arrived before sign-in comes back
  // once signed in; sign-in itself returns to the start page.
  const signedIn = authProvider.isAuthenticated
  useEffect(() => {
    if (!signedIn) { keepConsentPath(location.pathname, location.search, sessionStorage); return }
    const kept = takeConsentPath(sessionStorage)
    if (kept && kept !== `${location.pathname}${location.search}`) navigate(kept, { replace: true })
  }, [signedIn, location.pathname, location.search, navigate])

  const handleLogout = () => {
    authProvider.logout()
  }

  if (authProvider.isLoading) {
    return <div className="min-h-screen bg-slate-950 flex items-center justify-center"><LoadingSpinner /></div>
  }
  if (!authProvider.isAuthenticated) return <SignIn />
  if (location.pathname === '/oauth/consent') {
    return <AuthContext.Provider value={authProvider}><OAuthConsent /></AuthContext.Provider>
  }
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
          <Route path="/look" element={<Look />} />
          <Route path="/forecast" element={<Forecast />} />
          <Route path="/review" element={<Review />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/tax" element={<TaxFilings />} />
          <Route path="/time" element={<TimeDashboard />} />
          <Route path="/time/entries" element={<TimeEntries />} />
          <Route path="/time/projects" element={<TimeProjects />} />
          <Route path="/time/flow" element={<FlowBlocks />} />
          <Route path="/recruiter" element={<RecruiterOverview />} />
          <Route path="/recruiter/fit" element={<FitReports />} />
          <Route path="/recruiter/applications" element={<Applications />} />
          <Route path="/recruiter/roles" element={<Roles />} />
          <Route path="/linkedin" element={<LinkedInOverview />} />
          <Route path="/settings" element={<Settings />} />
          {/* Old addresses. /agent-settings keeps its query string: the Google
              sign-in callback still returns there with the code to finish. */}
          <Route path="/agent-settings" element={<RedirectKeepQuery to="/settings" hash="agents" />} />
          <Route path="/time/devices" element={<RedirectKeepQuery to="/settings" hash="devices" />} />
          <Route path="/linkedin/imports" element={<RedirectKeepQuery to="/linkedin" hash="import-history" />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </AuthContext.Provider>
  )
}

export default App
