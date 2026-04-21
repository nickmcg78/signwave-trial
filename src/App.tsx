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

          {/* Franchisee dashboard — admins have their own home at /admin */}
          <Route
            element={
              <ProtectedRoute allowedRoles={['franchisee']}>
                <FranchiseeLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<FranchiseeDashboard />} />
          </Route>

          {/* Wizard — both franchisees AND admins can use it (admins for QA / demos) */}
          <Route
            path="/new"
            element={
              <ProtectedRoute allowedRoles={['franchisee', 'admin']}>
                <NewMockup />
              </ProtectedRoute>
            }
          />

          {/* Mockup result — both roles allowed so admins can review any mockup */}
          <Route
            path="/result/:jobId"
            element={
              <ProtectedRoute allowedRoles={['franchisee', 'admin']}>
                <ResultPage />
              </ProtectedRoute>
            }
          />

          {/* Admin area */}
          <Route
            element={
              <ProtectedRoute allowedRoles={['admin']}>
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
