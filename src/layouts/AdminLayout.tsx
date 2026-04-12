import { Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function AdminLayout() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()

  async function handleSignOut() {
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-gray-900">Signwave</h1>
          <span className="text-xs font-medium bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
            Admin
          </span>
        </div>
        <button
          onClick={handleSignOut}
          className="text-sm text-gray-500 active:text-gray-800 px-3 py-2 rounded-lg"
        >
          Sign out
        </button>
      </header>

      {/* Page content */}
      <main className="flex-1 px-4 py-6 max-w-lg w-full mx-auto">
        <p className="text-gray-500 text-xs">Signed in as {user?.email}</p>
        <Outlet />
      </main>
    </div>
  )
}
