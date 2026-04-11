import { useAuth } from '../context/AuthContext'

export default function FranchiseeDashboard() {
  const { user, signOut } = useAuth()

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-4 flex items-center justify-between">
        <h1 className="text-lg font-bold text-gray-900">Signwave</h1>
        <button
          onClick={signOut}
          className="text-sm text-gray-500 active:text-gray-800 px-3 py-2 rounded-lg"
        >
          Sign out
        </button>
      </header>

      <main className="px-4 py-6 max-w-lg mx-auto">
        <p className="text-gray-500 text-sm">Welcome, {user?.full_name ?? user?.email}</p>
        <h2 className="text-2xl font-bold text-gray-900 mt-1 mb-6">My Mockups</h2>

        {/* Placeholder — mockup list comes in later sessions */}
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-gray-400">
          <p className="text-sm">No mockups yet.</p>
          <p className="text-xs mt-1">Coming in session 2.</p>
        </div>
      </main>
    </div>
  )
}
