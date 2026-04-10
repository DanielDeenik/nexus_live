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
import { useAuthProvider } from './hooks/useAuth'
import { AuthContext } from './stores/auth'

function App() {
  const authProvider = useAuthProvider()
  const [userName] = useState('Dan')
  const [userRole] = useState('Founder')
  const [notificationCount] = useState(2)

  useEffect(() => {
    // Initialize auth on mount
    if (authProvider.token) {
      authProvider.getCurrentUser()
    }
  }, [])

  const handleLogout = () => {
    authProvider.logout()
  }

  return (
    <AuthContext.Provider value={authProvider}>
      <Layout
        userName={userName}
        userRole={userRole}
        notificationCount={notificationCount}
        onLogout={handleLogout}
      >
        <Routes>
          <Route path="/" element={<Dashboard />} />
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
