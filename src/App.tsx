import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './stores/authStore'
import Layout from './components/Layout'
import LoginPage from './pages/LoginPage'
import AdminPage from './pages/AdminPage'
import ReplacementPage from './pages/ReplacementPage'
import SemaineTypePage from './pages/SemaineTypePage'
import PlanningPage from './pages/PlanningPage'
import CalcAnnuelPage from './pages/CalcAnnuelPage'
import CongesPage from './pages/CongesPage'
import RhRulesPage from './pages/RhRulesPage'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthStore()
  if (loading) return <div className="min-h-screen flex items-center justify-center text-gray-400 text-sm">Chargement...</div>
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  const { hydrate } = useAuthStore()
  useEffect(() => { hydrate() }, [])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth><Layout /></RequireAuth>}>
          <Route index element={<Navigate to="/admin" replace />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path="regles-rh" element={<RhRulesPage />} />
          <Route path="remplacement" element={<ReplacementPage />} />
          <Route path="semaine-type" element={<SemaineTypePage />} />
          <Route path="planning" element={<PlanningPage />} />
          <Route path="calcul-annuel" element={<CalcAnnuelPage />} />
          <Route path="conges" element={<CongesPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
