import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import type { UserRole } from '../lib/types'

interface Props {
  children: ReactNode
  /**
   * Roles allowed to access this route. If omitted, any authenticated
   * user is allowed. If provided, the current user's role must be in
   * the list. (Use a single-element array for the common single-role case.)
   */
  allowedRoles?: UserRole[]
}

export default function ProtectedRoute({ children, allowedRoles }: Props) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!user) {
    // Send unauthenticated users to login, remembering where they were trying to go
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    // Wrong role — bounce them to their own home
    const home = user.role === 'admin' ? '/admin' : '/'
    return <Navigate to={home} replace />
  }

  return <>{children}</>
}
