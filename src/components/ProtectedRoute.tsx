import type { ReactNode } from 'react'
import { useAuth } from '../context/AuthContext'
import type { UserRole } from '../lib/types'
import LoginPage from '../pages/LoginPage'

interface Props {
  children: ReactNode
  requiredRole?: UserRole
}

export default function ProtectedRoute({ children, requiredRole }: Props) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!user) return <LoginPage />

  if (requiredRole && user.role !== requiredRole) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 px-5 text-center">
        <p className="text-lg font-semibold text-gray-900">Access denied</p>
        <p className="text-sm text-gray-500 mt-1">You don't have permission to view this page.</p>
      </div>
    )
  }

  return <>{children}</>
}
