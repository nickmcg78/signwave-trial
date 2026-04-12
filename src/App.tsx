import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import FranchiseeLayout from './layouts/FranchiseeLayout'
import AdminLayout from './layouts/AdminLayout'
import LoginPage from './pages/LoginPage'
import FranchiseeDashboard from './pages/FranchiseeDashboard'
import AdminDashboard from './pages/AdminDashboard'
import NewMockup from './pages/NewMockup'
import ResultPage from './pages/ResultPage'

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Public */}
          <Route path="/login" element={<LoginPage />} />

          {/* Franchisee area — wrapped in FranchiseeLayout shell */}
          <Route
            element={
              <ProtectedRoute requiredRole="franchisee">
                <FranchiseeLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<FranchiseeDashboard />} />
          </Route>

          {/* Franchisee wizard — protected, but no layout chrome (full-screen) */}
          <Route
            path="/new"
            element={
              <ProtectedRoute requiredRole="franchisee">
                <NewMockup />
              </ProtectedRoute>
            }
          />

          {/* Mockup result — polling screen after the wizard's Generate */}
          <Route
            path="/result/:jobId"
            element={
              <ProtectedRoute requiredRole="franchisee">
                <ResultPage />
              </ProtectedRoute>
            }
          />

          {/* Admin area */}
          <Route
            element={
              <ProtectedRoute requiredRole="admin">
                <AdminLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/admin" element={<AdminDashboard />} />
          </Route>

          {/* Anything else → home */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
